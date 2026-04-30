/**
 * HTTP polling transport — drop-in replacement for ws-client.ts.
 *
 * PoC decision (see app/features/codewriter/README.md): Vercel serverless
 * cannot hold raw WebSocket connections. Daemon long-polls the server every
 * ~2s for new dispatches.
 *
 * Protocol envelope shapes (daemon-protocol.md §1.3) are unchanged.
 *
 * Endpoints (HTTPS):
 *   GET  <baseUrl>/api/codewriter/dispatch?wait=25  (200 envelope | 204 none)
 *   POST <baseUrl>/api/codewriter/callback          (callback, dispatch-ack, dispatch-reject)
 *   POST <baseUrl>/api/codewriter/heartbeat         (heartbeat — every 10s)
 *
 * Authorization: Bearer <sessionToken>
 */

import os from 'node:os';
import { createRequire } from 'node:module';
import chalk from 'chalk';

import {
  makeEnvelope,
  HEARTBEAT_INTERVAL_MS,
} from './protocol.js';
import { validateDispatch, spawnCli } from './dispatcher.js';
import { buildCallbackPayload } from './reporter.js';
import { readState, updateState, markTaskSeen, hasSeenTask } from './state.js';
import type {
  AnyEnvelope,
  DispatchEnvelope,
  CallbackPayload,
} from './types.js';

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
const pkg = require('../package.json') as { version: string };
const AGENT_VERSION: string = pkg.version;

const POLL_WAIT_SEC = 25;
const POLL_INTERVAL_BETWEEN_REQUESTS_MS = 2000;
const BACKOFF_SEQUENCE_MS = [1000, 2000, 4000, 8000, 16000, 32000, 60000];

export interface PollingClientOptions {
  /** Server base URL (https://livemerge.dev). Trailing slash stripped. */
  baseUrl: string;
  /** Long-lived session token (24h JWT). */
  sessionToken: string;
  /** Optional override for project directory the CLI runs in. */
  projectDir?: string;
  /** Trusted pubkeys for signature verification (injected for testing). */
  trustedPubkeys?: string[];
  /** Called when a pairing is revoked (HTTP 401). */
  onRevoked?: () => void;
  /** Optional fetch override (tests). */
  fetchImpl?: typeof fetch;
}

export class PollingClient {
  private stopped = false;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private currentTaskRunId: string | null = null;
  private idleSince: string | null = new Date().toISOString();
  private reconnectAttempt = 0;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: PollingClientOptions) {
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    if (typeof this.fetchImpl !== 'function') {
      throw new Error('Global fetch is required (Node >= 18). No fetch impl found.');
    }
  }

  start(): void {
    this.stopped = false;
    void this.greet();
    this.startHeartbeat();
    void this.pollLoop();
  }

  stop(): void {
    this.stopped = true;
    this.clearHeartbeat();
  }

  private get sessionToken(): string {
    const state = readState();
    return state?.sessionToken ?? this.opts.sessionToken;
  }

  private get baseUrl(): string {
    return this.opts.baseUrl.replace(/\/$/, '');
  }

  private async greet(): Promise<void> {
    const state = readState();
    const lastTaskRunId = state?.currentTaskRunId ?? this.currentTaskRunId;

    const hello = makeEnvelope('hello', {
      agentVersion: AGENT_VERSION,
      os: os.platform(),
      node: process.version,
      supportedVersions: [1],
      lastTaskRunId: lastTaskRunId ?? null,
    });

    // Send hello as a heartbeat — server treats it as liveness signal.
    await this.send(`/api/codewriter/heartbeat`, hello as AnyEnvelope, true);
    console.log(chalk.green('[poll] Hello sent — daemon registered.'));
  }

  private startHeartbeat(): void {
    this.clearHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      const hb = makeEnvelope('heartbeat', {
        lastTaskRunId: this.currentTaskRunId,
        idleSince: this.idleSince,
      });
      void this.send(`/api/codewriter/heartbeat`, hb as AnyEnvelope, true);
    }, HEARTBEAT_INTERVAL_MS);
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private async pollLoop(): Promise<void> {
    while (!this.stopped) {
      try {
        const envelope = await this.poll();
        if (envelope && envelope.type === 'dispatch') {
          await this.handleDispatch(envelope as DispatchEnvelope);
        }
        // success → reset backoff
        this.reconnectAttempt = 0;
        await this.sleep(POLL_INTERVAL_BETWEEN_REQUESTS_MS);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(chalk.yellow(`[poll] poll failed: ${msg}`));
        const delay =
          BACKOFF_SEQUENCE_MS[
            Math.min(this.reconnectAttempt, BACKOFF_SEQUENCE_MS.length - 1)
          ] ?? 60_000;
        this.reconnectAttempt++;
        await this.sleep(delay);
      }
    }
  }

  private async poll(): Promise<AnyEnvelope | null> {
    const url = `${this.baseUrl}/api/codewriter/dispatch?wait=${POLL_WAIT_SEC}`;
    const res = await this.fetchImpl(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${this.sessionToken}` },
    });

    if (res.status === 204) return null;
    if (res.status === 401) {
      console.error(chalk.red('[poll] Session token invalid (401). Stopping.'));
      this.stopped = true;
      this.opts.onRevoked?.();
      return null;
    }
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} from /api/codewriter/dispatch`);
    }
    const json = (await res.json()) as AnyEnvelope;
    return json;
  }

  private async send(
    path: string,
    envelope: AnyEnvelope,
    silentFail = false,
  ): Promise<void> {
    const url = `${this.baseUrl}${path}`;
    try {
      const res = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.sessionToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(envelope),
      });
      if (res.status === 401) {
        console.error(chalk.red('[poll] Session token invalid (401). Stopping.'));
        this.stopped = true;
        this.opts.onRevoked?.();
        return;
      }
      if (!res.ok && !silentFail) {
        throw new Error(`HTTP ${res.status} from ${path}`);
      }
    } catch (err) {
      if (!silentFail) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(chalk.yellow(`[poll] send to ${path} failed (silent): ${msg}`));
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // ─── Dispatch handling (mirrors ws-client.ts) ──────────────────────────────

  private async handleDispatch(envelope: DispatchEnvelope): Promise<void> {
    const taskRunId = envelope.taskRunId;
    if (!taskRunId) {
      console.warn('[poll] dispatch with null taskRunId — ignoring');
      return;
    }

    // Idempotency: duplicate dispatch for current task → re-ack, don't re-spawn
    if (this.currentTaskRunId === taskRunId) {
      const ack = makeEnvelope(
        'dispatch-ack',
        {
          ackedAt: new Date().toISOString(),
          willStartAt: new Date().toISOString(),
        },
        taskRunId,
      );
      await this.send('/api/codewriter/callback', ack as AnyEnvelope);
      return;
    }

    // Resolve cwd locally — daemon's --project-dir or current dir wins over
    // whatever the server signed (Vercel's serverless cwd is meaningless here).
    const effectiveCwd = this.opts.projectDir ?? envelope.payload.cwd;
    const validation = await validateDispatch(
      envelope,
      this.currentTaskRunId,
      this.opts.trustedPubkeys,
      effectiveCwd,
    );
    if (!validation.ok) {
      const reject = makeEnvelope(
        'dispatch-reject',
        {
          reason: validation.reason,
          ...(validation.reason === 'busy' && this.currentTaskRunId
            ? { currentTaskRunId: this.currentTaskRunId }
            : {}),
        },
        taskRunId,
      );
      await this.send('/api/codewriter/callback', reject as AnyEnvelope);
      console.warn(
        chalk.yellow(`[poll] Rejected dispatch ${taskRunId}: ${validation.reason}`),
      );
      return;
    }

    if (hasSeenTask(taskRunId)) {
      const ack = makeEnvelope(
        'dispatch-ack',
        {
          ackedAt: new Date().toISOString(),
          willStartAt: new Date().toISOString(),
        },
        taskRunId,
      );
      await this.send('/api/codewriter/callback', ack as AnyEnvelope);
      return;
    }

    // ACK immediately (within 1s).
    const now = new Date().toISOString();
    const ack = makeEnvelope(
      'dispatch-ack',
      { ackedAt: now, willStartAt: now },
      taskRunId,
    );
    await this.send('/api/codewriter/callback', ack as AnyEnvelope);

    this.currentTaskRunId = taskRunId;
    this.idleSince = null;
    updateState({ currentTaskRunId: taskRunId });

    const cwd = this.opts.projectDir ?? envelope.payload.cwd;
    const agent = envelope.payload.cliBinary;
    const agentTag = chalk.bold(
      agent === 'codex' ? chalk.magenta('CODEX') : chalk.blue('CLAUDE'),
    );
    const taskShort = taskRunId.slice(0, 8);
    console.log("");
    console.log(chalk.dim('─'.repeat(60)));
    console.log(`${chalk.bold.cyan('▶ Dispatch')}   ${chalk.dim('task')} ${taskShort}`);
    console.log(`  ${chalk.dim('agent ')}  ${agentTag}`);
    console.log(`  ${chalk.dim('cwd   ')}  ${cwd}`);
    console.log(
      `  ${chalk.dim('prompt')}  "${envelope.payload.taskDescription.slice(0, 100)}${envelope.payload.taskDescription.length > 100 ? '…' : ''}"`,
    );
    console.log(chalk.dim('─'.repeat(60)));

    try {
      const result = await spawnCli(
        validation.binary,
        envelope.payload.taskDescription,
        envelope.payload.cliArgs,
        cwd,
      );
      const callbackPayload: CallbackPayload = buildCallbackPayload({
        taskRunId,
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        durationMs: result.durationMs,
        cwd,
      });
      const callback = makeEnvelope('callback', callbackPayload, taskRunId);
      await this.send('/api/codewriter/callback', callback as AnyEnvelope);

      console.log(
        result.exitCode === 0
          ? `${agentTag} ${chalk.green(`✓ task ${taskShort} done`)} ${chalk.dim(`(${result.durationMs}ms, ${callbackPayload.changedFiles.length} files)`)}`
          : `${agentTag} ${chalk.red(`✗ task ${taskShort} failed`)} ${chalk.dim(`(exit=${result.exitCode})`)}`,
      );
    } finally {
      markTaskSeen(taskRunId);
      this.currentTaskRunId = null;
      this.idleSince = new Date().toISOString();
      updateState({ currentTaskRunId: null });
    }
  }
}
