/**
 * Daemon stub — Phase 1 day 3-4 contract validator.
 *
 * A slim test harness that:
 * 1. Connects to a test WS server (or runs embedded)
 * 2. Performs hello → hello-ack exchange
 * 3. Receives N fake dispatch envelopes (signed with dev-mode key)
 * 4. Verifies signature, emits dispatch-ack, then immediately emits callback
 *    with exitCode: 0, changedFiles: [], emptyDiff: true
 * 5. Tracks per-cycle latency
 * 6. Exits with summary: "N/N cycles passed in Xms"
 *
 * Lock criterion: 100-cycle dispatch/callback test passes.
 * daemon-protocol.md §8
 */

import { WebSocket, WebSocketServer } from 'ws';
import { signAsync } from '@noble/ed25519';
import { makeEnvelope, parseEnvelope, serializeEnvelope } from './protocol.js';
import { getDevPubkeys, DEV_PUBKEY_HEX } from './trusted-keys.js';
import { canonicalDispatchJson } from './protocol.js';
import { validateDispatch } from './dispatcher.js';
import type {
  AnyEnvelope,
  HelloEnvelope,
  DispatchEnvelope,
  DispatchAckEnvelope,
  CallbackEnvelope,
  HelloAckPayload,
} from './types.js';

// Dev private key — deterministic test fixture only, NOT secure
// Private key: 32-byte little-endian scalar = 0x000...001
// Corresponding public key is DEV_PUBKEY_HEX in trusted-keys.ts:
//   4cb5abf6ad79fbf5abbccafcc269d85cd2651ed4b885b5869f241aedf0a5ba29
const DEV_PRIV_KEY_HEX = '0000000000000000000000000000000000000000000000000000000000000001';

export interface StubRunResult {
  total: number;
  passed: number;
  failed: number;
  durationMs: number;
  cycleLatencies: number[];
}

/**
 * Sign a dispatch payload with the dev private key.
 */
async function signDispatch(opts: {
  taskRunId: string;
  taskDescription: string;
  cwd: string;
  cliBinary: string;
  cliArgs: string[];
  ts: string;
}): Promise<string> {
  const canonical = canonicalDispatchJson(opts);
  const msgBytes = new TextEncoder().encode(canonical);
  const privKey = Buffer.from(DEV_PRIV_KEY_HEX, 'hex');
  const sig = await signAsync(msgBytes, privKey);
  return Buffer.from(sig).toString('base64');
}

/**
 * Run N dispatch/ack/callback cycles through an embedded WS server.
 * Returns a result summary.
 */
export async function runDaemonStub(totalCycles = 100): Promise<StubRunResult> {
  const start = Date.now();
  const cycleLatencies: number[] = [];
  let passed = 0;
  let failed = 0;

  await new Promise<void>((resolve, reject) => {
    // Spin up an embedded WS server on a random port
    const wss = new WebSocketServer({ port: 0 });

    wss.on('listening', () => {
      const addr = wss.address() as { port: number };
      const port = addr.port;

      // ── Server side ─────────────────────────────────────────────────────────
      wss.on('connection', (serverSocket) => {
        let cycleIndex = 0;
        let helloReceived = false;

        const pendingCycles = new Map<string, {
          resolve: () => void;
          reject: (err: Error) => void;
          startMs: number;
        }>();

        serverSocket.on('message', async (data) => {
          const raw = data.toString();
          const envelope = parseEnvelope(raw);
          if (!envelope) return;

          if (envelope.type === 'hello') {
            helloReceived = true;
            // Send hello-ack
            const ack = makeEnvelope<'hello-ack', HelloAckPayload>('hello-ack', {
              chosenVersion: 1,
              serverTime: new Date().toISOString(),
              dispatchPolicy: { maxConcurrent: 1, queueDepth: 0 },
            });
            serverSocket.send(serializeEnvelope(ack as AnyEnvelope));

            // Begin dispatching cycles sequentially
            (async () => {
              for (let i = 0; i < totalCycles; i++) {
                cycleIndex = i;
                const taskRunId = `stub-task-${i}-${Date.now()}`;
                const ts = new Date().toISOString();
                const cwd = process.cwd();
                const taskDescription = `Stub task #${i}`;
                const cliBinary = 'claude';
                const cliArgs: string[] = [];

                const signature = await signDispatch({
                  taskRunId,
                  taskDescription,
                  cwd,
                  cliBinary,
                  cliArgs,
                  ts,
                });

                const dispatchEnv = makeEnvelope<'dispatch', DispatchEnvelope['payload']>(
                  'dispatch',
                  { taskDescription, cwd, cliBinary: 'claude', cliArgs, signature },
                  taskRunId,
                );
                (dispatchEnv as { ts: string }).ts = ts;

                const cycleStart = Date.now();
                await new Promise<void>((res, rej) => {
                  pendingCycles.set(taskRunId, {
                    resolve: res,
                    reject: rej,
                    startMs: cycleStart,
                  });
                  serverSocket.send(serializeEnvelope(dispatchEnv as AnyEnvelope));
                });
              }

              // All cycles done — close server
              serverSocket.close();
              wss.close(() => resolve());
            })().catch(reject);
          }

          if (envelope.type === 'dispatch-ack') {
            // dispatch-ack is expected but cycle completes on callback
          }

          if (envelope.type === 'callback') {
            const taskRunId = envelope.taskRunId;
            if (!taskRunId) return;
            const pending = pendingCycles.get(taskRunId);
            if (!pending) return;

            const latency = Date.now() - pending.startMs;
            cycleLatencies.push(latency);

            const cb = envelope as CallbackEnvelope;
            if (cb.payload.exitCode === 0 && cb.payload.status === 'completed') {
              passed++;
            } else {
              failed++;
            }

            // Send callback-ack
            const cbAck = makeEnvelope('callback-ack', {}, taskRunId);
            serverSocket.send(serializeEnvelope(cbAck as AnyEnvelope));

            pending.resolve();
            pendingCycles.delete(taskRunId);
          }

          if (envelope.type === 'dispatch-reject') {
            const taskRunId = envelope.taskRunId;
            if (!taskRunId) return;
            const pending = pendingCycles.get(taskRunId);
            if (pending) {
              failed++;
              pending.reject(new Error(`dispatch-reject: ${JSON.stringify(envelope.payload)}`));
              pendingCycles.delete(taskRunId);
            }
          }
        });

        serverSocket.on('error', reject);
      });

      // ── Client (daemon) side ─────────────────────────────────────────────────
      const clientWs = new WebSocket(`ws://localhost:${port}`, {
        headers: { Authorization: 'Bearer stub-session-token' },
      });

      clientWs.on('open', () => {
        const hello = makeEnvelope('hello', {
          agentVersion: '0.1.0',
          os: process.platform,
          node: process.version,
          supportedVersions: [1],
          lastTaskRunId: null,
        });
        clientWs.send(serializeEnvelope(hello as AnyEnvelope));
      });

      clientWs.on('message', async (data) => {
        const raw = data.toString();
        const envelope = parseEnvelope(raw);
        if (!envelope) return;

        if (envelope.type === 'hello-ack') {
          // Ready — server will start sending dispatches
          return;
        }

        if (envelope.type === 'dispatch') {
          const dispatchEnv = envelope as DispatchEnvelope;
          const taskRunId = dispatchEnv.taskRunId;
          if (!taskRunId) return;

          // Validate with dev pubkeys
          const validation = await validateDispatch(dispatchEnv, null, getDevPubkeys());

          if (!validation.ok) {
            const reject = makeEnvelope('dispatch-reject', { reason: validation.reason }, taskRunId);
            clientWs.send(serializeEnvelope(reject as AnyEnvelope));
            return;
          }

          // Send dispatch-ack immediately
          const ack = makeEnvelope('dispatch-ack', {
            ackedAt: new Date().toISOString(),
            willStartAt: new Date().toISOString(),
          }, taskRunId);
          clientWs.send(serializeEnvelope(ack as AnyEnvelope));

          // Immediately emit callback (stub — no real subprocess)
          const callback = makeEnvelope('callback', {
            exitCode: 0,
            changedFiles: [],
            summary: 'Stub task completed (no subprocess)',
            durationMs: 0,
            stdoutTail: '',
            stderrTail: '',
            status: 'completed' as const,
            metadata: { emptyDiff: true },
          }, taskRunId);
          clientWs.send(serializeEnvelope(callback as AnyEnvelope));
        }

        if (envelope.type === 'callback-ack') {
          // acknowledged
        }
      });

      clientWs.on('error', reject);
    });

    wss.on('error', reject);
  });

  return {
    total: totalCycles,
    passed,
    failed,
    durationMs: Date.now() - start,
    cycleLatencies,
  };
}

/**
 * CLI entry point for running the stub standalone.
 * node dist/daemon-stub.js [--cycles 100]
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const cyclesIdx = args.indexOf('--cycles');
  const cycles = cyclesIdx >= 0 ? parseInt(args[cyclesIdx + 1] ?? '100', 10) : 100;

  console.log(`Running daemon stub: ${cycles} dispatch/callback cycles...`);

  try {
    const result = await runDaemonStub(cycles);
    const avgLatency = result.cycleLatencies.length > 0
      ? Math.round(result.cycleLatencies.reduce((a, b) => a + b, 0) / result.cycleLatencies.length)
      : 0;

    console.log(`\n${result.passed}/${result.total} cycles passed in ${result.durationMs}ms`);
    console.log(`Average cycle latency: ${avgLatency}ms`);

    if (result.failed > 0) {
      console.error(`FAILED: ${result.failed} cycles failed`);
      process.exit(1);
    }
  } catch (err) {
    console.error('Daemon stub error:', err);
    process.exit(1);
  }
}

// Run if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
