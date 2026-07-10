/**
 * Signed dispatch-key set — JWKS-style key rotation (daemon-protocol.md §3.4).
 *
 * Trust model: the npm package embeds ONE long-lived root public key
 * (trusted-keys.ts ROOT_PUBKEY_HEX). The server publishes its rotatable
 * dispatch-signing public keys at GET /api/codewriter/jwks as a key set
 * document signed by the root key. The daemon verifies the document against
 * the embedded root before trusting any key in it, so a hostile server (or a
 * daemon tricked into pairing with one) cannot inject its own keys — it would
 * need the root private key, which never leaves offline storage.
 *
 * Rotation therefore never requires an npm republish: publish a new signed
 * set containing the new key, wait out the cache TTL, drop the old key.
 */

import { verifyAsync } from '@noble/ed25519';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export interface KeySetEntry {
  kid: string;
  publicKeyHex: string;
}

export interface SignedKeySet {
  keys: KeySetEntry[];
  issuedAt: string; // ISO-8601
  /** Base64 Ed25519 signature by the root key over canonicalKeySetJson. */
  sig: string;
}

const FETCH_TTL_MS = 6 * 60 * 60 * 1000; // refresh every 6h
const MIN_REFETCH_INTERVAL_MS = 60_000; // unknown-kid refetch throttle

/**
 * Canonical JSON for key-set signing. MUST match the encoder in
 * scripts/rotate-dispatch-keys.ts (same fields, same order).
 */
export function canonicalKeySetJson(set: { keys: KeySetEntry[]; issuedAt: string }): string {
  return JSON.stringify({
    keys: set.keys.map((k) => ({ kid: k.kid, publicKeyHex: k.publicKeyHex })),
    issuedAt: set.issuedAt,
  });
}

export async function verifyKeySet(set: SignedKeySet, rootPubkeyHex: string): Promise<boolean> {
  try {
    if (!Array.isArray(set.keys) || typeof set.issuedAt !== 'string' || typeof set.sig !== 'string') {
      return false;
    }
    const msg = new TextEncoder().encode(canonicalKeySetJson(set));
    const sig = Buffer.from(set.sig, 'base64');
    const root = Buffer.from(rootPubkeyHex, 'hex');
    return await verifyAsync(sig, msg, root);
  } catch {
    return false;
  }
}

function defaultCachePath(): string {
  const agentDir = process.env['LIVEMERGE_AGENT_DIR'] ?? join(homedir(), '.livemerge-bridge');
  return join(agentDir, 'keyset.json');
}

export interface KeysetClientOptions {
  /** Server base URL, e.g. https://livemerge.dev */
  baseUrl: string;
  /** Embedded root public key used to verify the fetched set. */
  rootPubkeyHex: string;
  fetchImpl?: typeof fetch;
  cachePath?: string;
}

/**
 * Resolves dispatch-signing public keys by kid.
 *
 * Freshness: refetch after TTL, or immediately on an unknown kid (throttled)
 * so a just-rotated key is honored without waiting for the TTL. Resilience:
 * the last verified set is persisted to disk and used when the endpoint is
 * unreachable — a JWKS outage degrades to "no rotation visibility", never to
 * "daemon can't verify anything".
 */
export class KeysetClient {
  private keyset: SignedKeySet | null = null;
  private fetchedAt = 0;
  private lastAttemptAt = 0;
  private readonly fetchImpl: typeof fetch;
  private readonly cachePath: string;

  constructor(private readonly opts: KeysetClientOptions) {
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    this.cachePath = opts.cachePath ?? defaultCachePath();
    this.loadDiskCache();
  }

  /** Returns the pubkey for kid, or null when it isn't in the trusted set. */
  async resolveKey(kid: string): Promise<string | null> {
    const stale = Date.now() - this.fetchedAt > FETCH_TTL_MS;
    if (!this.keyset || stale) await this.refresh();

    let found = this.keyset?.keys.find((k) => k.kid === kid);
    if (!found) {
      // Possibly rotated moments ago — one throttled refetch before giving up.
      await this.refresh();
      found = this.keyset?.keys.find((k) => k.kid === kid);
    }
    return found?.publicKeyHex ?? null;
  }

  private async refresh(): Promise<void> {
    const now = Date.now();
    if (now - this.lastAttemptAt < MIN_REFETCH_INTERVAL_MS) return;
    this.lastAttemptAt = now;
    try {
      const url = `${this.opts.baseUrl.replace(/\/$/, '')}/api/codewriter/jwks`;
      const res = await this.fetchImpl(url, { method: 'GET' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const set = (await res.json()) as SignedKeySet;
      if (!(await verifyKeySet(set, this.opts.rootPubkeyHex))) {
        console.warn('[keyset] fetched key set failed root-signature verification — ignoring');
        return;
      }
      this.keyset = set;
      this.fetchedAt = now;
      this.saveDiskCache(set);
    } catch (err) {
      console.warn(
        `[keyset] fetch failed (${err instanceof Error ? err.message : String(err)}) — using cached set`,
      );
    }
  }

  private loadDiskCache(): void {
    try {
      const raw = readFileSync(this.cachePath, 'utf-8');
      const set = JSON.parse(raw) as SignedKeySet;
      // Disk contents are attacker-writable in theory — verify like a fetch.
      void verifyKeySet(set, this.opts.rootPubkeyHex).then((ok) => {
        if (ok && !this.keyset) this.keyset = set;
      });
    } catch {
      // no cache yet
    }
  }

  private saveDiskCache(set: SignedKeySet): void {
    try {
      mkdirSync(dirname(this.cachePath), { recursive: true });
      writeFileSync(this.cachePath, JSON.stringify(set), 'utf-8');
    } catch {
      // cache write failure is non-fatal
    }
  }
}

/** Test/dev resolver: accepts ANY kid (and no kid) against a static key list. */
export type KeyResolver = (kid: string | null) => Promise<string[]>;

export function staticKeyResolver(pubkeysHex: string[]): KeyResolver {
  return () => Promise.resolve(pubkeysHex);
}

export function keysetResolver(client: KeysetClient): KeyResolver {
  return async (kid) => {
    if (!kid) return []; // keyset mode requires kid — legacy envelopes rejected
    const key = await client.resolveKey(kid);
    return key ? [key] : [];
  };
}
