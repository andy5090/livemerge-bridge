/**
 * Protocol version constants and envelope serialization helpers.
 * daemon-protocol.md §1
 */

import type { AnyEnvelope, MessageType } from './types.js';

export const PROTOCOL_VERSION = 1;
export const SUPPORTED_VERSIONS = [1];

export const HEARTBEAT_INTERVAL_MS = 10_000; // 10s
export const SERVER_TIMEOUT_MS = 30_000;     // 30s — server marks disconnected

// ─── Serialization ────────────────────────────────────────────────────────────

export function serializeEnvelope(envelope: AnyEnvelope): string {
  return JSON.stringify(envelope);
}

export function parseEnvelope(raw: string): AnyEnvelope | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof (parsed as Record<string, unknown>)['v'] !== 'number' ||
    typeof (parsed as Record<string, unknown>)['type'] !== 'string'
  ) {
    return null;
  }

  const env = parsed as AnyEnvelope;

  // Drop messages with unknown envelope version
  if (!SUPPORTED_VERSIONS.includes(env.v)) {
    console.warn(`[protocol] Dropping message with unknown envelope version v=${env.v}`);
    return null;
  }

  return env;
}

// ─── Envelope factory ─────────────────────────────────────────────────────────

export function makeEnvelope<T extends MessageType, P>(
  type: T,
  payload: P,
  taskRunId: string | null = null,
): { v: number; type: T; taskRunId: string | null; payload: P; ts: string } {
  return {
    v: PROTOCOL_VERSION,
    type,
    taskRunId,
    payload,
    ts: new Date().toISOString(),
  };
}

/**
 * Canonical JSON for signing — must match server-side encoding exactly.
 * Signed fields per daemon-protocol.md §3.2:
 *   { taskRunId, taskDescription, cwd, cliBinary, cliArgs, ts, kid? }
 *
 * `kid` (key id, §3.4 rotation) is part of the signed content when present so
 * an attacker can't swap it to point verification at a different key. It is
 * appended last and omitted entirely for legacy envelopes to keep old
 * signatures byte-identical.
 */
export function canonicalDispatchJson(opts: {
  taskRunId: string;
  taskDescription: string;
  cwd: string;
  cliBinary: string;
  cliArgs: string[];
  ts: string;
  kid?: string | undefined;
}): string {
  return JSON.stringify({
    taskRunId: opts.taskRunId,
    taskDescription: opts.taskDescription,
    cwd: opts.cwd,
    cliBinary: opts.cliBinary,
    cliArgs: opts.cliArgs,
    ts: opts.ts,
    ...(opts.kid ? { kid: opts.kid } : {}),
  });
}
