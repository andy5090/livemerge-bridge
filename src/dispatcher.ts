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

const ALLOWED_BINARIES: Set<string> = new Set<CliBinary>(['claude', 'codex']);

/** Build CLI args array — NO shell expansion, NO env injection from server */
function buildArgs(binary: CliBinary, taskDescription: string, extraArgs: string[]): string[] {
  switch (binary) {
    case 'claude':
      return ['--print', taskDescription, ...extraArgs];
    case 'codex':
      return ['exec', taskDescription, ...extraArgs];
  }
}

/**
 * Verify Ed25519 signature against all trusted pubkeys.
 * Returns true if ANY trusted key verifies the signature.
 */
async function verifySignature(
  envelope: DispatchEnvelope,
  trustedPubkeys: string[],
): Promise<boolean> {
  const { taskDescription, cwd, cliBinary, cliArgs, signature } = envelope.payload;
  const taskRunId = envelope.taskRunId;
  const ts = envelope.ts;

  if (!taskRunId) return false;

  const canonical = canonicalDispatchJson({
    taskRunId,
    taskDescription,
    cwd,
    cliBinary,
    cliArgs,
    ts,
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
}

/**
 * Spawn the CLI subprocess and collect output.
 * Uses cross-spawn — no shell, no env from server payload.
 */
export function spawnCli(
  binary: CliBinary,
  taskDescription: string,
  extraArgs: string[],
  cwd: string,
): Promise<SpawnResult> {
  return new Promise((resolve) => {
    const args = buildArgs(binary, taskDescription, extraArgs);
    const start = Date.now();

    // Inherit process env (PO's machine env) but never merge server-supplied env
    const child = spawn(binary, args, {
      cwd,
      env: process.env as Record<string, string>,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    child.stdout?.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr?.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

    child.on('close', (code: number | null) => {
      resolve({
        exitCode: code ?? -1,
        stdout: Buffer.concat(stdoutChunks).toString('utf-8'),
        stderr: Buffer.concat(stderrChunks).toString('utf-8'),
        durationMs: Date.now() - start,
      });
    });

    child.on('error', (err: Error) => {
      resolve({
        exitCode: -1,
        stdout: '',
        stderr: err.message,
        durationMs: Date.now() - start,
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
 */
export async function validateDispatch(
  envelope: DispatchEnvelope,
  currentTaskRunId: string | null,
  trustedPubkeys?: string[],
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
  const keys = trustedPubkeys ?? getTrustedPubkeys();
  const sigValid = await verifySignature(envelope, keys);
  if (!sigValid) {
    return { ok: false, reason: 'signature-invalid' };
  }

  return { ok: true, binary: cliBinary as CliBinary };
}
