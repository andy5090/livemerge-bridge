/**
 * Persistent WebSocket client with:
 * - Handshake: hello → hello-ack (daemon-protocol.md §1)
 * - Envelope versioning negotiation (§1.2)
 * - Session token rotation (§2.2)
 * - Heartbeat: every 10s, server-side timeout 30s (§1.3)
 * - Reconnect: exponential backoff 1s→2s→4s→8s→max 60s (§6.2)
 */

import { WebSocket } from 'ws';
import os from 'node:os';
import { createRequire } from 'node:module';
import chalk from 'chalk';

import {
  makeEnvelope,
  parseEnvelope,
  serializeEnvelope,
  HEARTBEAT_INTERVAL_MS,
} from './protocol.js';
import {
  validateDispatch,
  spawnCli,
} from './dispatcher.js';
import { buildCallbackPayload } from './reporter.js';
import { readState, updateState, markTaskSeen, hasSeenTask } from './state.js';
import type {
  AnyEnvelope,
  DispatchEnvelope,
  HelloAckPayload,
} from './types.js';

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
const pkg = require('../package.json') as { version: string };
const AGENT_VERSION: string = pkg.version;

const BACKOFF_SEQUENCE_MS = [1000, 2000, 4000, 8000, 16000, 32000, 60000];

export interface WsClientOptions {
  /** WebSocket URL from /api/pairing/handshake */
  wsUrl: string;
  /** Long-lived session token */
  sessionToken: string;
  /** Optional override for project directory */
  projectDir?: string;
  /** Trusted pubkeys for signature verification (injected for testing) */
  trustedPubkeys?: string[];
  /** Called when the session token is rotated */
  onTokenRotated?: (newToken: string) => void;
  /** Called when a pairing is revoked (WS 4401) */
  onRevoked?: () => void;
}

export class WsClient {
  private ws: WebSocket | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectAttempt = 0;
  private stopped = false;
  private currentTaskRunId: string | null = null;
  private idleSince: string | null = new Date().toISOString();
  private chosenVersion = 1;

  constructor(private readonly opts: WsClientOptions) {}

  start(): void {
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.clearHeartbeat();
    if (this.ws) {
      const bye = makeEnvelope('bye', { reason: 'daemon-stopped' });
      try {
        this.ws.send(serializeEnvelope(bye as AnyEnvelope));
      } catch {
        // ignore send errors during shutdown
      }
      this.ws.close();
      this.ws = null;
    }
  }

  private connect(): void {
    if (this.stopped) return;

    const state = readState();
    const token = state?.sessionToken ?? this.opts.sessionToken;

    console.log(chalk.cyan(`[ws] Connecting to ${this.opts.wsUrl} ...`));

    this.ws = new WebSocket(this.opts.wsUrl, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    this.ws.on('open', () => {
      this.reconnectAttempt = 0;
      this.sendHello();
    });

    this.ws.on('message', (data: WebSocket.RawData) => {
      const raw = data.toString();
      const envelope = parseEnvelope(raw);
      if (!envelope) {
        console.warn(chalk.yellow('[ws] Dropping unparseable message'));
        return;
      }
      this.handleEnvelope(envelope).catch((err: unknown) => {
        console.error(chalk.red('[ws] Error handling envelope:'), err);
      });
    });

    this.ws.on('close', (code: number, reason: Buffer) => {
      this.clearHeartbeat();

      if (code === 4401) {
        console.error(chalk.red('[ws] Pairing revoked. Please re-pair with livemerge-bridge connect <token>'));
        this.opts.onRevoked?.();
        this.stopped = true;
        return;
      }

      if (this.stopped) return;

      const reasonStr = reason.toString() || 'unknown';
      console.warn(chalk.yellow(`[ws] Disconnected (code=${code}, reason=${reasonStr}). Reconnecting...`));
      this.scheduleReconnect();
    });

    this.ws.on('error', (err: Error) => {
      console.error(chalk.red('[ws] WebSocket error:'), err.message);
      // close event will fire after error, triggering reconnect
    });
  }

  private sendHello(): void {
    const state = readState();
    const lastTaskRunId = state?.currentTaskRunId ?? this.currentTaskRunId;

    const hello = makeEnvelope('hello', {
      agentVersion: AGENT_VERSION,
      os: os.platform(),
      node: process.version,
      supportedVersions: [1],
      lastTaskRunId: lastTaskRunId ?? null,
    });

    this.send(hello as AnyEnvelope);
    console.log(chalk.green('[ws] Sent hello'));
  }

  private startHeartbeat(): void {
    this.clearHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        const hb = makeEnvelope('heartbeat', {
          lastTaskRunId: this.currentTaskRunId,
          idleSince: this.idleSince,
        });
        this.send(hb as AnyEnvelope);
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private scheduleReconnect(): void {
    const delayMs = BACKOFF_SEQUENCE_MS[
      Math.min(this.reconnectAttempt, BACKOFF_SEQUENCE_MS.length - 1)
    ] ?? 60_000;
    this.reconnectAttempt++;
    console.log(chalk.yellow(`[ws] Reconnecting in ${delayMs}ms (attempt ${this.reconnectAttempt})`));
    setTimeout(() => this.connect(), delayMs);
  }

  private send(envelope: AnyEnvelope): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(serializeEnvelope(envelope));
    } else {
      console.warn(chalk.yellow('[ws] Cannot send — socket not open'));
    }
  }

  private async handleEnvelope(envelope: AnyEnvelope): Promise<void> {
    switch (envelope.type) {
      case 'hello-ack':
        this.handleHelloAck(envelope.payload as HelloAckPayload);
        break;

      case 'heartbeat-ack':
        // nothing to do
        break;

      case 'dispatch':
        await this.handleDispatch(envelope as DispatchEnvelope);
        break;

      case 'callback-ack':
        // Task fully acknowledged by server
        console.log(chalk.green(`[ws] callback-ack received for task ${envelope.taskRunId}`));
        break;

      case 'error': {
        const errPayload = envelope.payload as { code: string; message: string; retryable: boolean };
        console.error(chalk.red(`[ws] Server error: ${errPayload.code} — ${errPayload.message}`));
        break;
      }

      case 'bye': {
        const byePayload = envelope.payload as { reason: string };
        console.log(chalk.yellow(`[ws] Server sent bye: ${byePayload.reason}`));
        this.stopped = true;
        this.ws?.close();
        break;
      }

      default:
        console.warn(chalk.yellow(`[ws] Unknown message type: ${(envelope as AnyEnvelope).type}`));
    }
  }

  private handleHelloAck(payload: HelloAckPayload): void {
    this.chosenVersion = payload.chosenVersion;
    console.log(chalk.green(`[ws] hello-ack received. Chosen version: ${this.chosenVersion}`));
    console.log(chalk.green(`[ws] Dispatch policy: maxConcurrent=${payload.dispatchPolicy.maxConcurrent}, queueDepth=${payload.dispatchPolicy.queueDepth}`));

    // Session token rotation (§2.2)
    if (payload.rotatedSessionToken) {
      console.log(chalk.cyan('[ws] Session token rotated by server'));
      updateState({
        sessionToken: payload.rotatedSessionToken,
        lastRotatedAt: new Date().toISOString(),
      });
      this.opts.onTokenRotated?.(payload.rotatedSessionToken);
    }

    this.startHeartbeat();
    console.log(chalk.green('[ws] Ready — waiting for dispatch'));
  }

  private async handleDispatch(envelope: DispatchEnvelope): Promise<void> {
    const taskRunId = envelope.taskRunId;
    if (!taskRunId) {
      console.warn('[ws] Received dispatch with null taskRunId — ignoring');
      return;
    }

    // Idempotency: duplicate dispatch for current task → re-ack, don't re-spawn (§6.3)
    if (this.currentTaskRunId === taskRunId) {
      console.log(chalk.cyan(`[ws] Duplicate dispatch for ${taskRunId} — re-sending dispatch-ack`));
      const ack = makeEnvelope('dispatch-ack', {
        ackedAt: new Date().toISOString(),
        willStartAt: new Date().toISOString(),
      }, taskRunId);
      this.send(ack as AnyEnvelope);
      return;
    }

    // Resolve cwd locally — daemon's --project-dir or current dir wins over
    // whatever the server signed (Vercel's serverless cwd is meaningless here).
    const effectiveCwd = this.opts.projectDir ?? envelope.payload.cwd;
    // Validate: allowlist, cwd, backpressure, signature
    const validation = await validateDispatch(
      envelope,
      this.currentTaskRunId,
      this.opts.trustedPubkeys,
      effectiveCwd,
    );

    if (!validation.ok) {
      const reject = makeEnvelope('dispatch-reject', {
        reason: validation.reason,
        ...(validation.reason === 'busy' ? { currentTaskRunId: this.currentTaskRunId ?? undefined } : {}),
      }, taskRunId);
      this.send(reject as AnyEnvelope);
      console.warn(chalk.yellow(`[ws] Rejected dispatch ${taskRunId}: ${validation.reason}`));
      return;
    }

    // Idempotency: already completed previously (daemon-stub supports this)
    if (hasSeenTask(taskRunId)) {
      console.log(chalk.cyan(`[ws] Already seen taskRunId ${taskRunId} — sending duplicate callback-ack`));
      const ack = makeEnvelope('dispatch-ack', {
        ackedAt: new Date().toISOString(),
        willStartAt: new Date().toISOString(),
      }, taskRunId);
      this.send(ack as AnyEnvelope);
      return;
    }

    // ACK immediately (within 1s of receipt per protocol)
    const now = new Date().toISOString();
    const ack = makeEnvelope('dispatch-ack', {
      ackedAt: now,
      willStartAt: now,
    }, taskRunId);
    this.send(ack as AnyEnvelope);

    // Mark as current task
    this.currentTaskRunId = taskRunId;
    this.idleSince = null;
    updateState({ currentTaskRunId: taskRunId });

    console.log(chalk.cyan(`[ws] Starting task ${taskRunId}: ${envelope.payload.cliBinary} "${envelope.payload.taskDescription.slice(0, 80)}..."`));

    const cwd = this.opts.projectDir ?? envelope.payload.cwd;

    try {
      const result = await spawnCli(
        validation.binary,
        envelope.payload.taskDescription,
        envelope.payload.cliArgs,
        cwd,
      );

      const callbackPayload = buildCallbackPayload({
        taskRunId,
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        durationMs: result.durationMs,
        cwd,
        binary: validation.binary,
        timedOut: result.timedOut,
      });

      const callback = makeEnvelope('callback', callbackPayload, taskRunId);
      this.send(callback as AnyEnvelope);

      console.log(
        result.exitCode === 0
          ? chalk.green(`[ws] Task ${taskRunId} completed (${result.durationMs}ms, ${callbackPayload.changedFiles.length} files changed)`)
          : chalk.red(`[ws] Task ${taskRunId} failed with exit code ${result.exitCode}`)
      );
    } finally {
      markTaskSeen(taskRunId);
      this.currentTaskRunId = null;
      this.idleSince = new Date().toISOString();
      updateState({ currentTaskRunId: null });
    }
  }
}
