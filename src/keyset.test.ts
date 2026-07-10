/**
 * Key-set (JWKS rotation) tests: root-signature verification, kid-based
 * dispatch verification, unknown-kid refetch, tamper rejection, cache fallback.
 */

import { describe, it, expect } from 'vitest';
import { getPublicKeyAsync, signAsync, utils } from '@noble/ed25519';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  canonicalKeySetJson,
  verifyKeySet,
  KeysetClient,
  keysetResolver,
  type SignedKeySet,
  type KeySetEntry,
} from './keyset.js';
import { validateDispatch } from './dispatcher.js';
import { makeEnvelope, canonicalDispatchJson } from './protocol.js';
import type { DispatchEnvelope } from './types.js';

async function makeKeypair() {
  const priv = utils.randomPrivateKey();
  const pub = await getPublicKeyAsync(priv);
  return { priv, pubHex: Buffer.from(pub).toString('hex') };
}

async function makeSignedKeySet(
  keys: KeySetEntry[],
  rootPriv: Uint8Array,
): Promise<SignedKeySet> {
  const issuedAt = new Date().toISOString();
  const sig = await signAsync(
    new TextEncoder().encode(canonicalKeySetJson({ keys, issuedAt })),
    rootPriv,
  );
  return { keys, issuedAt, sig: Buffer.from(sig).toString('base64') };
}

function fetchReturning(set: () => SignedKeySet): typeof fetch {
  return (() =>
    Promise.resolve(
      new Response(JSON.stringify(set()), { status: 200 }),
    )) as unknown as typeof fetch;
}

describe('verifyKeySet', () => {
  it('accepts a root-signed set and rejects tampering', async () => {
    const root = await makeKeypair();
    const dispatchKey = await makeKeypair();
    const set = await makeSignedKeySet(
      [{ kid: 'k-1', publicKeyHex: dispatchKey.pubHex }],
      root.priv,
    );
    expect(await verifyKeySet(set, root.pubHex)).toBe(true);

    // attacker swaps in their own key without the root private key
    const attacker = await makeKeypair();
    const tampered: SignedKeySet = {
      ...set,
      keys: [{ kid: 'k-1', publicKeyHex: attacker.pubHex }],
    };
    expect(await verifyKeySet(tampered, root.pubHex)).toBe(false);

    // wrong root
    expect(await verifyKeySet(set, attacker.pubHex)).toBe(false);
  });
});

describe('KeysetClient + kid dispatch verification', () => {
  it('verifies a kid-signed dispatch end-to-end via the fetched key set', async () => {
    const root = await makeKeypair();
    const dispatchKey = await makeKeypair();
    const set = await makeSignedKeySet(
      [{ kid: 'k-active', publicKeyHex: dispatchKey.pubHex }],
      root.priv,
    );
    const client = new KeysetClient({
      baseUrl: 'https://example.test',
      rootPubkeyHex: root.pubHex,
      fetchImpl: fetchReturning(() => set),
      cachePath: join(mkdtempSync(join(tmpdir(), 'lm-ks-')), 'keyset.json'),
    });

    const taskRunId = 'task-kid-1';
    const ts = new Date().toISOString();
    const cwd = process.cwd();
    const canonical = canonicalDispatchJson({
      taskRunId,
      taskDescription: 't',
      cwd,
      cliBinary: 'claude',
      cliArgs: [],
      ts,
      kid: 'k-active',
    });
    const sig = await signAsync(new TextEncoder().encode(canonical), dispatchKey.priv);

    const envelope = makeEnvelope(
      'dispatch',
      {
        taskDescription: 't',
        cwd,
        cliBinary: 'claude' as const,
        cliArgs: [],
        signature: Buffer.from(sig).toString('base64'),
        kid: 'k-active',
      },
      taskRunId,
    ) as DispatchEnvelope;
    (envelope as { ts: string }).ts = ts;

    const result = await validateDispatch(envelope, null, keysetResolver(client));
    expect(result.ok).toBe(true);

    // same envelope but with a kid the set doesn't contain → rejected
    const unknownKid = { ...envelope, payload: { ...envelope.payload, kid: 'k-ghost' } };
    const rejected = await validateDispatch(unknownKid, null, keysetResolver(client));
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.reason).toBe('signature-invalid');
  });

  it('rejects a kid-less envelope in keyset mode', async () => {
    const root = await makeKeypair();
    const dispatchKey = await makeKeypair();
    const set = await makeSignedKeySet(
      [{ kid: 'k-1', publicKeyHex: dispatchKey.pubHex }],
      root.priv,
    );
    const client = new KeysetClient({
      baseUrl: 'https://example.test',
      rootPubkeyHex: root.pubHex,
      fetchImpl: fetchReturning(() => set),
      cachePath: join(mkdtempSync(join(tmpdir(), 'lm-ks-')), 'keyset.json'),
    });

    const ts = new Date().toISOString();
    const canonical = canonicalDispatchJson({
      taskRunId: 'task-legacy',
      taskDescription: 't',
      cwd: process.cwd(),
      cliBinary: 'claude',
      cliArgs: [],
      ts,
    });
    const sig = await signAsync(new TextEncoder().encode(canonical), dispatchKey.priv);
    const envelope = makeEnvelope(
      'dispatch',
      {
        taskDescription: 't',
        cwd: process.cwd(),
        cliBinary: 'claude' as const,
        cliArgs: [],
        signature: Buffer.from(sig).toString('base64'),
      },
      'task-legacy',
    ) as DispatchEnvelope;
    (envelope as { ts: string }).ts = ts;

    const result = await validateDispatch(envelope, null, keysetResolver(client));
    expect(result.ok).toBe(false);
  });

  it('ignores a key set not signed by the trusted root', async () => {
    const root = await makeKeypair();
    const evilRoot = await makeKeypair();
    const dispatchKey = await makeKeypair();
    const evilSet = await makeSignedKeySet(
      [{ kid: 'k-evil', publicKeyHex: dispatchKey.pubHex }],
      evilRoot.priv,
    );
    const client = new KeysetClient({
      baseUrl: 'https://example.test',
      rootPubkeyHex: root.pubHex, // trusts the REAL root
      fetchImpl: fetchReturning(() => evilSet),
      cachePath: join(mkdtempSync(join(tmpdir(), 'lm-ks-')), 'keyset.json'),
    });
    expect(await client.resolveKey('k-evil')).toBeNull();
  });

  it('falls back to the disk cache when fetch fails', async () => {
    const root = await makeKeypair();
    const dispatchKey = await makeKeypair();
    const set = await makeSignedKeySet(
      [{ kid: 'k-cached', publicKeyHex: dispatchKey.pubHex }],
      root.priv,
    );
    const cachePath = join(mkdtempSync(join(tmpdir(), 'lm-ks-')), 'keyset.json');

    // first client: successful fetch populates the disk cache
    const online = new KeysetClient({
      baseUrl: 'https://example.test',
      rootPubkeyHex: root.pubHex,
      fetchImpl: fetchReturning(() => set),
      cachePath,
    });
    expect(await online.resolveKey('k-cached')).toBe(dispatchKey.pubHex);

    // second client: endpoint down — must still resolve from disk
    const failingFetch = (() =>
      Promise.reject(new Error('network down'))) as unknown as typeof fetch;
    const offline = new KeysetClient({
      baseUrl: 'https://example.test',
      rootPubkeyHex: root.pubHex,
      fetchImpl: failingFetch,
      cachePath,
    });
    // disk load verification is async — allow it to settle
    await new Promise((r) => setTimeout(r, 50));
    expect(await offline.resolveKey('k-cached')).toBe(dispatchKey.pubHex);
  });
});
