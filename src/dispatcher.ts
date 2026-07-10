/**
 * Dispatcher — receives dispatch envelopes, verifies signatures,
 * enforces backpressure, and spawns subprocesses.
 *
 * daemon-protocol.md §3 (signature verification)
 * daemon-protocol.md §4 (backpressure REJECT)
 */

import { verifyAsync } from '@noble/ed25519';
import spawn from 'cross-spawn';
import type {
  DispatchEnvelope,
  DispatchRejectReason,
  CliBinary,
} from './types.js';
import { canonicalDispatchJson } from './protocol.js';
import { getTrustedPubkeys } from './trusted-keys.js';
import { staticKeyResolver, type KeyResolver } from './keyset.js';
import { createLiveParser, type LiveAgentEvent } from './agent-output.js';

const ALLOWED_BINARIES: Set<string> = new Set<CliBinary>(['claude', 'codex']);

/** Default wall-clock limit per task; override with LIVEMERGE_TASK_TIMEOUT_MS. */
const DEFAULT_TASK_TIMEOUT_MS = 30 * 60_000;
const SIGKILL_GRACE_MS = 10_000;

export interface BuildArgsOptions {
  /** claude --permission-mode value (default: acceptEdits). */
  permissionMode?: string;
  /** codex --sandbox value (default: workspace-write). */
  sandbox?: string;
}

/** Server-supplied cliArgs may carry `--resume <agentSessionId>`; each binary
 * expresses resume differently, so it's extracted here and re-injected. */
function extractResume(extraArgs: string[]): { resumeSessionId: string | null; rest: string[] } {
  const idx = extraArgs.indexOf('--resume');
  if (idx === -1 || idx === extraArgs.length - 1) {
    return { resumeSessionId: null, rest: extraArgs };
  }
  const rest = [...extraArgs.slice(0, idx), ...extraArgs.slice(idx + 2)];
  return { resumeSessionId: extraArgs[idx + 1] ?? null, rest };
}

/**
 * Build CLI args array — NO shell expansion, NO env injection from server.
 *
 * Both binaries run headless: without an explicit permission/sandbox policy a
 * non-interactive run can silently make zero edits (prompts auto-deny), so
 * defaults are applied here unless the server's cliArgs already override them.
 * Structured output (stream-json / --json) is always on — the reporter parses
 * it for session id, usage, and the final message.
 */
export function buildArgs(
  binary: CliBinary,
  taskDescription: string,
  extraArgs: string[],
  opts: BuildArgsOptions = {},
): string[] {
  const { resumeSessionId, rest } = extractResume(extraArgs);
  switch (binary) {
    case 'claude': {
      const args = ['--print', '--output-format', 'stream-json', '--verbose'];
      if (!rest.includes('--permission-mode')) {
        args.push('--permission-mode', opts.permissionMode ?? 'acceptEdits');
      }
      if (resumeSessionId) args.push('--resume', resumeSessionId);
      return [...args, ...rest, taskDescription];
    }
    case 'codex': {
      const args = ['exec'];
      if (resumeSessionId) args.push('resume', resumeSessionId);
      args.push('--json');
      if (!rest.includes('--sandbox')) {
        args.push('--sandbox', opts.sandbox ?? 'workspace-write');
      }
      if (!rest.includes('--ask-for-approval')) {
        args.push('--ask-for-approval', 'never');
      }
      return [...args, ...rest, taskDescription];
    }
  }
}

/**
 * Verify Ed25519 signature against the trusted keys for the envelope's kid.
 * Returns true if ANY candidate key verifies the signature.
 */
async function verifySignature(
  envelope: DispatchEnvelope,
  resolveKeys: KeyResolver,
): Promise<boolean> {
  const { taskDescription, cwd, cliBinary, cliArgs, signature, kid } = envelope.payload;
  const taskRunId = envelope.taskRunId;
  const ts = envelope.ts;

  if (!taskRunId) return false;

  let trustedPubkeys: string[];
  try {
    trustedPubkeys = await resolveKeys(kid ?? null);
  } catch {
    return false;
  }
  if (trustedPubkeys.length === 0) return false;

  const canonical = canonicalDispatchJson({
    taskRunId,
    taskDescription,
    cwd,
    cliBinary,
    cliArgs,
    ts,
    ...(kid ? { kid } : {}),
  });

  const msgBytes = new TextEncoder().encode(canonical);

  let sigBytes: Uint8Array;
  try {
    sigBytes = Buffer.from(signature, 'base64');
  } catch {
    return false;
  }

  for (const pubkeyHex of trustedPubkeys) {
    try {
      const pubBytes = Buffer.from(pubkeyHex, 'hex');
      const valid = await verifyAsync(sigBytes, msgBytes, pubBytes);
      if (valid) return true;
    } catch {
      // try next key
    }
  }

  return false;
}

export interface SpawnResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
}

function resolveTaskTimeoutMs(): number {
  const raw = Number(process.env['LIVEMERGE_TASK_TIMEOUT_MS']);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TASK_TIMEOUT_MS;
}

/**
 * Spawn the CLI subprocess and collect output.
 * Uses cross-spawn — no shell, no env from server payload.
 * A hung agent would otherwise wedge the daemon in `busy` forever, so every
 * task gets a wall-clock limit (SIGTERM, then SIGKILL after a grace period).
 */
export function spawnCli(
  binary: CliBinary,
  taskDescription: string,
  extraArgs: string[],
  cwd: string,
  timeoutMs?: number,
  onEvent?: (event: LiveAgentEvent) => void,
): Promise<SpawnResult> {
  return new Promise((resolve) => {
    const buildOpts: BuildArgsOptions = {};
    const envPermissionMode = process.env['LIVEMERGE_CLAUDE_PERMISSION_MODE'];
    const envSandbox = process.env['LIVEMERGE_CODEX_SANDBOX'];
    if (envPermissionMode) buildOpts.permissionMode = envPermissionMode;
    if (envSandbox) buildOpts.sandbox = envSandbox;
    const args = buildArgs(binary, taskDescription, extraArgs, buildOpts);
    const start = Date.now();
    const limitMs = timeoutMs ?? resolveTaskTimeoutMs();
    let timedOut = false;

    // Inherit process env (PO's machine env) but never merge server-supplied env.
    // detached → own process group, so a timeout kill reaps the CLI's children
    // too (they hold the stdio pipes; killing only the parent leaves 'close'
    // waiting forever).
    const child = spawn(binary, args, {
      cwd,
      env: process.env as Record<string, string>,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    let settled = false;
    const settle = (result: SpawnResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const currentResult = (exitCode: number): SpawnResult => ({
      exitCode,
      stdout: Buffer.concat(stdoutChunks).toString('utf-8'),
      stderr: Buffer.concat(stderrChunks).toString('utf-8'),
      durationMs: Date.now() - start,
      timedOut,
    });

    const killTree = (signal: NodeJS.Signals) => {
      try {
        if (child.pid && process.platform !== 'win32') {
          process.kill(-child.pid, signal); // whole process group
          return;
        }
      } catch {
        // group already gone or unsupported — fall through to direct kill
      }
      child.kill(signal);
    };

    const killTimer = setTimeout(() => {
      timedOut = true;
      killTree('SIGTERM');
      setTimeout(() => {
        killTree('SIGKILL');
        // Last resort: if some orphan still pins the pipes, report with what
        // we have rather than wedging the daemon.
        setTimeout(() => settle(currentResult(124)), 2_000).unref();
      }, SIGKILL_GRACE_MS).unref();
    }, limitMs);
    killTimer.unref();

    const liveParser = onEvent ? createLiveParser(binary, onEvent) : null;

    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutChunks.push(chunk);
      liveParser?.push(chunk.toString('utf-8'));
    });
    child.stderr?.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

    child.on('close', (code: number | null) => {
      clearTimeout(killTimer);
      liveParser?.flush();
      settle(currentResult(timedOut ? 124 : code ?? -1));
    });

    child.on('error', (err: Error) => {
      clearTimeout(killTimer);
      settle({
        exitCode: -1,
        stdout: '',
        stderr: err.message,
        durationMs: Date.now() - start,
        timedOut,
      });
    });
  });
}

export type DispatchValidation =
  | { ok: true; binary: CliBinary }
  | { ok: false; reason: DispatchRejectReason };

/**
 * Validate a dispatch envelope before spawning.
 * Returns either { ok: true, binary } or { ok: false, reason }.
 *
 * `keys` accepts a static pubkey list (tests/dev) or a KeyResolver (prod —
 * kid-based lookup against the root-verified key set from the server's JWKS
 * endpoint). Omitted → resolves via the embedded root through getTrustedPubkeys,
 * which returns [] and thus rejects; transports are expected to pass a resolver.
 */
export async function validateDispatch(
  envelope: DispatchEnvelope,
  currentTaskRunId: string | null,
  keys?: string[] | KeyResolver,
  effectiveCwd?: string,
): Promise<DispatchValidation> {
  const { cliBinary } = envelope.payload;
  // The daemon's locally-resolved cwd (--project-dir or process.cwd) takes
  // precedence over the envelope's cwd, since the server may not know what
  // path exists on the PO machine. Falls back to envelope.payload.cwd for
  // back-compat with daemon-stub tests that pass real local paths.
  const cwdToCheck = effectiveCwd ?? envelope.payload.cwd;

  // 1. Allowlist check
  if (!ALLOWED_BINARIES.has(cliBinary)) {
    return { ok: false, reason: 'unknown-binary' };
  }

  // 2. cwd existence check
  const { existsSync } = await import('node:fs');
  if (!existsSync(cwdToCheck)) {
    return { ok: false, reason: 'cwd-missing' };
  }

  // 3. Backpressure: busy check
  if (currentTaskRunId !== null && currentTaskRunId !== envelope.taskRunId) {
    return { ok: false, reason: 'busy' };
  }

  // 4. Signature verification
  const resolver: KeyResolver =
    typeof keys === 'function'
      ? keys
      : staticKeyResolver(keys ?? getTrustedPubkeys());
  const sigValid = await verifySignature(envelope, resolver);
  if (!sigValid) {
    return { ok: false, reason: 'signature-invalid' };
  }

  return { ok: true, binary: cliBinary as CliBinary };
}
