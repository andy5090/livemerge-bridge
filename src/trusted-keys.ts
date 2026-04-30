/**
 * Embedded server Ed25519 public key constant.
 *
 * This key is shipped at build time (hard-coded in the package).
 * The corresponding private key lives in Vercel env DISPATCH_SIGNING_PRIVATE_KEY.
 *
 * For the PoC, a single key is sufficient.
 * Post-PoC follow-up (daemon-protocol.md §3.4): adopt JWKS-based key rotation.
 * The embedded constant below then becomes a bootstrap pubkey used to verify
 * the JWKS endpoint URL itself.
 *
 * To generate a real keypair:
 *   node -e "
 *     import('@noble/ed25519').then(async ed => {
 *       const privKey = ed.utils.randomPrivateKey();
 *       const pubKey = await ed.getPublicKeyAsync(privKey);
 *       console.log('priv:', Buffer.from(privKey).toString('hex'));
 *       console.log('pub:', Buffer.from(pubKey).toString('hex'));
 *     });
 *   "
 *
 * Replace SERVER_PUBKEY_HEX with the resulting public key before shipping.
 */

/**
 * Production server public key (Ed25519, hex-encoded, 32 bytes = 64 hex chars).
 * Replace this placeholder with the real key before any non-demo distribution.
 */
export const SERVER_PUBKEY_HEX =
  'fa25239145d67bd068008e5c76fa887c8a82ddfecf8f0d1f582bc5097cba6be1';

/**
 * Dev/test public key — used by daemon-stub.ts and tests.
 * Generated deterministically for test fixtures:
 *   privKey = 0x00...01 (for test only, NOT secure)
 */
export const DEV_PUBKEY_HEX =
  '4cb5abf6ad79fbf5abbccafcc269d85cd2651ed4b885b5869f241aedf0a5ba29';

/**
 * Returns the list of trusted public keys.
 * The daemon accepts a dispatch signature that verifies under ANY key in this list.
 * (Allows future key rotation without breaking old daemons.)
 */
export function getTrustedPubkeys(): string[] {
  return [SERVER_PUBKEY_HEX];
}

/**
 * Returns trusted keys for dev/test mode.
 */
export function getDevPubkeys(): string[] {
  return [DEV_PUBKEY_HEX];
}
