/**
 * Vitest test: 100-cycle dispatch/ack/callback integration test.
 * daemon-protocol.md §8 "Lock criterion: 100-cycle dispatch/callback test passes"
 *
 * Uses an embedded ws server (no external network required).
 */

import { describe, it, expect } from 'vitest';
import { signAsync } from '@noble/ed25519';
import { runDaemonStub } from './daemon-stub.js';
import { validateDispatch } from './dispatcher.js';
import { mapExitCodeToStatus, buildCallbackPayload } from './reporter.js';
import { parseEnvelope, makeEnvelope, canonicalDispatchJson } from './protocol.js';
import { getDevPubkeys, DEV_PUBKEY_HEX } from './trusted-keys.js';
import type { DispatchEnvelope } from './types.js';

// Dev private key — priv key corresponding to DEV_PUBKEY_HEX
const DEV_PRIV_KEY_HEX = '0000000000000000000000000000000000000000000000000000000000000001';

describe('daemon-stub 100-cycle integration test', () => {
  it('passes 100/100 dispatch → dispatch-ack → callback → callback-ack cycles', async () => {
    const result = await runDaemonStub(100);

    expect(result.total).toBe(100);
    expect(result.passed).toBe(100);
    expect(result.failed).toBe(0);
    expect(result.durationMs).toBeGreaterThan(0);
    expect(result.cycleLatencies).toHaveLength(100);

    // Each cycle should be reasonably fast (< 5s in the worst case on slow CI)
    for (const latency of result.cycleLatencies) {
      expect(latency).toBeLessThan(5000);
    }

    const avgLatency = result.cycleLatencies.reduce((a, b) => a + b, 0) / result.cycleLatencies.length;
    console.log(`Average cycle latency: ${avgLatency.toFixed(1)}ms`);
    console.log(`Total duration: ${result.durationMs}ms`);
  }, 60_000); // 60s timeout for 100 cycles
});

describe('dispatcher unit tests', () => {
  it('rejects unknown binary', async () => {
    const dispatchEnv = makeEnvelope('dispatch', {
      taskDescription: 'test',
      cwd: process.cwd(),
      cliBinary: 'bash' as 'claude', // intentionally invalid
      cliArgs: [],
      signature: 'invalid',
    }, 'test-task-1') as DispatchEnvelope;

    const result = await validateDispatch(dispatchEnv, null, getDevPubkeys());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('unknown-binary');
    }
  });

  it('rejects when busy', async () => {
    const taskRunId = 'test-task-busy-new';
    const ts = new Date().toISOString();
    const canonical = canonicalDispatchJson({
      taskRunId,
      taskDescription: 'test',
      cwd: process.cwd(),
      cliBinary: 'claude',
      cliArgs: [],
      ts,
    });
    const msgBytes = new TextEncoder().encode(canonical);
    const sig = await signAsync(msgBytes, Buffer.from(DEV_PRIV_KEY_HEX, 'hex'));
    const signature = Buffer.from(sig).toString('base64');

    const dispatchEnv = makeEnvelope('dispatch', {
      taskDescription: 'test',
      cwd: process.cwd(),
      cliBinary: 'claude',
      cliArgs: [],
      signature,
    }, taskRunId) as DispatchEnvelope;
    (dispatchEnv as { ts: string }).ts = ts;

    // currentTaskRunId is something else → busy
    const result = await validateDispatch(dispatchEnv, 'other-task-id', getDevPubkeys());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('busy');
    }
  });

  it('rejects with signature-invalid when signature is wrong', async () => {
    const taskRunId = 'test-task-sig-invalid';
    const ts = new Date().toISOString();

    const dispatchEnv = makeEnvelope('dispatch', {
      taskDescription: 'test',
      cwd: process.cwd(),
      cliBinary: 'claude',
      cliArgs: [],
      signature: Buffer.from('bad signature padding===').toString('base64'),
    }, taskRunId) as DispatchEnvelope;
    (dispatchEnv as { ts: string }).ts = ts;

    const result = await validateDispatch(dispatchEnv, null, getDevPubkeys());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('signature-invalid');
    }
  });

  it('accepts valid signed dispatch', async () => {
    const taskRunId = 'test-task-valid';
    const ts = new Date().toISOString();
    const cwd = process.cwd();
    const canonical = canonicalDispatchJson({
      taskRunId,
      taskDescription: 'test task',
      cwd,
      cliBinary: 'claude',
      cliArgs: [],
      ts,
    });
    const msgBytes = new TextEncoder().encode(canonical);
    const sig = await signAsync(msgBytes, Buffer.from(DEV_PRIV_KEY_HEX, 'hex'));
    const signature = Buffer.from(sig).toString('base64');

    const dispatchEnv = makeEnvelope('dispatch', {
      taskDescription: 'test task',
      cwd,
      cliBinary: 'claude',
      cliArgs: [],
      signature,
    }, taskRunId) as DispatchEnvelope;
    (dispatchEnv as { ts: string }).ts = ts;

    const result = await validateDispatch(dispatchEnv, null, getDevPubkeys());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.binary).toBe('claude');
    }
  });
});

describe('reporter unit tests', () => {
  it('maps exit 0 to completed', () => {
    expect(mapExitCodeToStatus(0)).toBe('completed');
  });

  it('maps exit 1 to failed', () => {
    expect(mapExitCodeToStatus(1)).toBe('failed');
  });

  it('maps exit 124 (timeout) to failed', () => {
    expect(mapExitCodeToStatus(124)).toBe('failed');
  });

  it('maps any non-zero to failed', () => {
    expect(mapExitCodeToStatus(2)).toBe('failed');
    expect(mapExitCodeToStatus(-1)).toBe('failed');
    expect(mapExitCodeToStatus(255)).toBe('failed');
  });

  it('builds callback payload with emptyDiff metadata on exit 0 + no changes', () => {
    const result = buildCallbackPayload({
      taskRunId: 'test-1',
      exitCode: 0,
      stdout: 'done',
      stderr: '',
      durationMs: 100,
      cwd: '/tmp',
    });
    expect(result.status).toBe('completed');
    expect(result.exitCode).toBe(0);
    // /tmp is not a git repo → changedFiles = [] → emptyDiff = true
    if (result.changedFiles.length === 0) {
      expect(result.metadata?.['emptyDiff']).toBe(true);
    }
  });

  it('builds callback payload with failed status on non-zero exit', () => {
    const result = buildCallbackPayload({
      taskRunId: 'test-2',
      exitCode: 1,
      stdout: '',
      stderr: 'error output',
      durationMs: 50,
      cwd: '/tmp',
    });
    expect(result.status).toBe('failed');
    expect(result.exitCode).toBe(1);
    expect(result.stderrTail).toBe('error output');
    expect(result.metadata?.['emptyDiff']).toBeUndefined();
  });
});

describe('protocol unit tests', () => {
  it('drops messages with unknown envelope version', () => {
    const msg = JSON.stringify({ v: 99, type: 'hello', taskRunId: null, payload: {}, ts: '' });
    const result = parseEnvelope(msg);
    expect(result).toBeNull();
  });

  it('parses valid v=1 envelope', () => {
    const msg = JSON.stringify({
      v: 1,
      type: 'hello-ack',
      taskRunId: null,
      payload: { chosenVersion: 1 },
      ts: new Date().toISOString(),
    });
    const result = parseEnvelope(msg);
    expect(result).not.toBeNull();
    expect(result?.type).toBe('hello-ack');
  });

  it('returns null for malformed JSON', () => {
    expect(parseEnvelope('not json')).toBeNull();
    expect(parseEnvelope('{}')).toBeNull();
  });

  it('makeEnvelope produces correct structure', () => {
    const env = makeEnvelope('heartbeat', { lastTaskRunId: null, idleSince: null });
    expect(env.v).toBe(1);
    expect(env.type).toBe('heartbeat');
    expect(env.taskRunId).toBeNull();
    expect(env.payload).toEqual({ lastTaskRunId: null, idleSince: null });
    expect(typeof env.ts).toBe('string');
  });
});
