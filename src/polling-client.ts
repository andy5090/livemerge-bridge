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
import {
  isGitRepo,
  createTaskWorktree,
  finalizeTaskWorktree,
  type TaskWorktree,
} from './worktree.js';
import { uiEvents } from './ui-events.js';
import {
  KeysetClient,
  keysetResolver,
  staticKeyResolver,
  type KeyResolver,
} from './keyset.js';
import { ROOT_PUBKEY_HEX } from './trusted-keys.js';
import type {
  AnyEnvelope,
  DispatchEnvelope,
  DispatchRejectReason,
  CallbackPayload,
  CliBinary,
} from './types.js';

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
const pkg = require('../package.json') as { version: string };
const AGENT_VERSION: string = pkg.version;

const POLL_WAIT_SEC = 25;
const POLL_INTERVAL_BETWEEN_REQUESTS_MS = 2000;
const BACKOFF_SEQUENCE_MS = [1000, 2000, 4000, 8000, 16000, 32000, 60000];

const DEFAULT_MAX_CONCURRENT = 3;

export function resolveMaxConcurrent(): number {
  const raw = Number(process.env['LIVEMERGE_MAX_CONCURRENT']);
  return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : DEFAULT_MAX_CONCURRENT;
}

interface RunningTask {
  /** Primary tasks run directly in the project dir; others in a worktree. */
  isPrimary: boolean;
  worktree: TaskWorktree | null;
}

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
  /** Called when the server requests a project-card re-sync. */
  onCardRefresh?: () => void;
  /** Optional fetch override (tests). */
  fetchImpl?: typeof fetch;
}

export class PollingClient {
  private stopped = false;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private readonly runningTasks = new Map<string, RunningTask>();
  private readonly maxConcurrent = resolveMaxConcurrent();
  private idleSince: string | null = new Date().toISOString();
  private reconnectAttempt = 0;
  private readonly fetchImpl: typeof fetch;
  private readonly keyResolver: KeyResolver;

  constructor(private readonly opts: PollingClientOptions) {
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    if (typeof this.fetchImpl !== 'function') {
      throw new Error('Global fetch is required (Node >= 18). No fetch impl found.');
    }
    // Static keys are a test/dev injection; production resolves signing keys
    // by kid from the server's root-signed key set (JWKS rotation, §3.4).
    this.keyResolver = opts.trustedPubkeys
      ? staticKeyResolver(opts.trustedPubkeys)
      : keysetResolver(
          new KeysetClient({
            baseUrl: this.opts.baseUrl.replace(/\/$/, ''),
            rootPubkeyHex: ROOT_PUBKEY_HEX,
            fetchImpl: this.fetchImpl,
          }),
        );
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

  /** Task id reported in heartbeats — the primary (main-tree) task if any. */
  private primaryTaskRunId(): string | null {
    for (const [id, task] of this.runningTasks) {
      if (task.isPrimary) return id;
    }
    return this.runningTasks.keys().next().value ?? null;
  }

  private hasPrimaryTask(): boolean {
    for (const task of this.runningTasks.values()) {
      if (task.isPrimary) return true;
    }
    return false;
  }

  private async greet(): Promise<void> {
    const state = readState();
    const lastTaskRunId = state?.currentTaskRunId ?? this.primaryTaskRunId();

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
    uiEvents.emit('connection', { status: 'polling' });
  }

  private startHeartbeat(): void {
    this.clearHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      const hb = makeEnvelope('heartbeat', {
        lastTaskRunId: this.primaryTaskRunId(),
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
        // At capacity → don't dequeue new dispatches; they stay queued
        // server-side (same net behavior as the old serial daemon, which
        // simply didn't poll while busy).
        if (this.runningTasks.size >= this.maxConcurrent) {
          await this.sleep(POLL_INTERVAL_BETWEEN_REQUESTS_MS);
          continue;
        }
        const envelope = await this.poll();
        if (envelope && envelope.type === 'dispatch') {
          await this.handleDispatch(envelope as DispatchEnvelope);
        } else if (envelope && envelope.type === 'card-refresh') {
          // Session-start / manual Re-sync request. Passive layer: rebuilds
          // and re-uploads the project card — never touches task dispatch.
          this.opts.onCardRefresh?.();
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
      uiEvents.emit('connection', { status: 'revoked', detail: 'session revoked (401)' });
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

  private async sendAck(taskRunId: string): Promise<void> {
    const now = new Date().toISOString();
    const ack = makeEnvelope(
      'dispatch-ack',
      { ackedAt: now, willStartAt: now },
      taskRunId,
    );
    await this.send('/api/codewriter/callback', ack as AnyEnvelope);
  }

  private async sendReject(taskRunId: string, reason: DispatchRejectReason): Promise<void> {
    const primary = this.primaryTaskRunId();
    const reject = makeEnvelope(
      'dispatch-reject',
      {
        reason,
        ...(reason === 'busy' && primary ? { currentTaskRunId: primary } : {}),
      },
      taskRunId,
    );
    await this.send('/api/codewriter/callback', reject as AnyEnvelope);
    console.warn(chalk.yellow(`[poll] Rejected dispatch ${taskRunId}: ${reason}`));
  }

  /**
   * Validate + slot a dispatch, then run it WITHOUT blocking the poll loop.
   *
   * Hybrid concurrency (daemon-protocol.md §4 amended): the first task runs
   * directly in the project dir exactly like the serial daemon. While it's
   * busy, up to maxConcurrent-1 additional tasks each run in an isolated git
   * worktree on a livemerge/task-<id> branch. Beyond capacity (or when the
   * project isn't a git repo) dispatches are rejected `busy` as before.
   */
  private async handleDispatch(envelope: DispatchEnvelope): Promise<void> {
    const taskRunId = envelope.taskRunId;
    if (!taskRunId) {
      console.warn('[poll] dispatch with null taskRunId — ignoring');
      return;
    }

    // Idempotency: duplicate dispatch for a running or already-seen task →
    // re-ack, don't re-spawn.
    if (this.runningTasks.has(taskRunId) || hasSeenTask(taskRunId)) {
      await this.sendAck(taskRunId);
      return;
    }

    // Resolve cwd locally — daemon's --project-dir or current dir wins over
    // whatever the server signed (Vercel's serverless cwd is meaningless here).
    const projectDir = this.opts.projectDir ?? envelope.payload.cwd;
    // validateDispatch's busy semantics are per-slot: report busy only when
    // the daemon is at capacity.
    const atCapacity = this.runningTasks.size >= this.maxConcurrent;
    const validation = await validateDispatch(
      envelope,
      atCapacity ? this.primaryTaskRunId() : null,
      this.keyResolver,
      projectDir,
    );
    if (!validation.ok) {
      await this.sendReject(taskRunId, validation.reason);
      return;
    }

    // Slot assignment: primary (main tree) if free, otherwise a worktree.
    const isPrimary = !this.hasPrimaryTask();
    let worktree: TaskWorktree | null = null;
    if (!isPrimary) {
      if (!isGitRepo(projectDir)) {
        await this.sendReject(taskRunId, 'busy');
        return;
      }
      worktree = createTaskWorktree(projectDir, taskRunId);
      if (!worktree) {
        await this.sendReject(taskRunId, 'busy');
        return;
      }
    }

    await this.sendAck(taskRunId);

    this.runningTasks.set(taskRunId, { isPrimary, worktree });
    this.idleSince = null;
    if (isPrimary) updateState({ currentTaskRunId: taskRunId });

    this.logDispatchStart(envelope, taskRunId, worktree);
    uiEvents.emit('taskStarted', {
      taskRunId,
      binary: validation.binary,
      cwd: worktree?.dir ?? projectDir,
      ...(worktree ? { branch: worktree.branch } : {}),
      prompt: envelope.payload.taskDescription,
    });

    // Fire and forget — the poll loop keeps fetching further dispatches.
    void this.runTask(envelope, taskRunId, validation.binary, projectDir, worktree);
  }

  private logDispatchStart(
    envelope: DispatchEnvelope,
    taskRunId: string,
    worktree: TaskWorktree | null,
  ): void {
    const agent = envelope.payload.cliBinary;
    const agentTag = chalk.bold(
      agent === 'codex' ? chalk.magenta('CODEX') : chalk.blue('CLAUDE'),
    );
    const taskShort = taskRunId.slice(0, 8);
    console.log('');
    console.log(chalk.dim('─'.repeat(60)));
    console.log(`${chalk.bold.cyan('▶ Dispatch')}   ${chalk.dim('task')} ${taskShort}`);
    console.log(`  ${chalk.dim('agent ')}  ${agentTag}`);
    console.log(
      `  ${chalk.dim('cwd   ')}  ${worktree ? `${worktree.dir} ${chalk.dim(`(worktree → ${worktree.branch})`)}` : this.opts.projectDir ?? envelope.payload.cwd}`,
    );
    console.log(
      `  ${chalk.dim('prompt')}  "${envelope.payload.taskDescription.slice(0, 100)}${envelope.payload.taskDescription.length > 100 ? '…' : ''}"`,
    );
    console.log(chalk.dim('─'.repeat(60)));
  }

  private async runTask(
    envelope: DispatchEnvelope,
    taskRunId: string,
    binary: CliBinary,
    projectDir: string,
    worktree: TaskWorktree | null,
  ): Promise<void> {
    const cwd = worktree?.dir ?? projectDir;
    const agentTag = chalk.bold(
      binary === 'codex' ? chalk.magenta('CODEX') : chalk.blue('CLAUDE'),
    );
    const taskShort = taskRunId.slice(0, 8);

    try {
      const result = await spawnCli(
        binary,
        envelope.payload.taskDescription,
        envelope.payload.cliArgs,
        cwd,
        undefined,
        (event) => uiEvents.emit('taskActivity', taskRunId, event),
      );
      // Capture changed files from the task's own tree BEFORE the worktree
      // commit sweeps them up.
      const callbackPayload: CallbackPayload = buildCallbackPayload({
        taskRunId,
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        durationMs: result.durationMs,
        cwd,
        binary,
        timedOut: result.timedOut,
      });

      if (worktree) {
        const finalized = finalizeTaskWorktree(
          projectDir,
          worktree,
          taskRunId,
          envelope.payload.taskDescription,
        );
        callbackPayload.metadata = {
          ...callbackPayload.metadata,
          worktree: true,
          ...(finalized.committed ? { branch: finalized.branch } : {}),
        };
      }

      const callback = makeEnvelope('callback', callbackPayload, taskRunId);
      await this.send('/api/codewriter/callback', callback as AnyEnvelope);

      uiEvents.emit('taskCompleted', {
        taskRunId,
        status: callbackPayload.status,
        durationMs: result.durationMs,
        changedFiles: callbackPayload.changedFiles.length,
        ...(callbackPayload.metadata?.costUsd !== undefined
          ? { costUsd: callbackPayload.metadata.costUsd }
          : {}),
        ...(typeof callbackPayload.metadata?.['branch'] === 'string'
          ? { branch: callbackPayload.metadata['branch'] }
          : {}),
      });

      console.log(
        result.exitCode === 0
          ? `${agentTag} ${chalk.green(`✓ task ${taskShort} done`)} ${chalk.dim(`(${result.durationMs}ms, ${callbackPayload.changedFiles.length} files${worktree && callbackPayload.metadata?.['branch'] ? `, branch ${String(callbackPayload.metadata['branch'])}` : ''})`)}`
          : `${agentTag} ${chalk.red(`✗ task ${taskShort} failed`)} ${chalk.dim(`(exit=${result.exitCode})`)}`,
      );
    } finally {
      markTaskSeen(taskRunId);
      const wasPrimary = this.runningTasks.get(taskRunId)?.isPrimary ?? false;
      this.runningTasks.delete(taskRunId);
      if (this.runningTasks.size === 0) {
        this.idleSince = new Date().toISOString();
      }
      if (wasPrimary) updateState({ currentTaskRunId: null });
    }
  }
}
