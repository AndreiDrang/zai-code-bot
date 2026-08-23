/**
 * Web Crypto utilities for Cloudflare Workers.
 *
 * Replaces the earlier Node-style `crypto.createHmac` / `crypto.timingSafeEqual`
 * / `Buffer` webhook-signature verification, which required the
 * `nodejs_compat` flag. This implementation uses the standard Web Crypto API
 * (`crypto.subtle`) and runs on Workers with no compatibility flags.
 */

const encoder = new TextEncoder();

/**
 * Computes the HMAC-SHA256 hex digest of `message` keyed with `secret`.
 * @param {string} secret
 * @param {string} message
 * @returns {Promise<string>} lowercase hex digest
 */
export async function hmacSha256Hex(secret, message) {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(message));
  return bufToHex(signature);
}

/**
 * Constant-time-ish comparison of two hex strings of equal length.
 * Falls back to a plain loop if lengths differ (which already signals a mismatch).
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
export function timingSafeEqualStr(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

/**
 * Verifies a GitHub webhook `x-hub-signature-256` header against the raw body.
 *
 * @param {Request} request - the original Worker request (body read via clone)
 * @param {string} secret   - the shared webhook secret
 * @returns {Promise<boolean>}
 */
export async function verifyWebhookSignature(request, secret) {
  const signature = request.headers.get('x-hub-signature-256');
  if (!signature || !secret) return false;

  // Clone so the body can still be read downstream after verification.
  const payload = await request.clone().text();
  const expected = `sha256=${await hmacSha256Hex(secret, payload)}`;
  return timingSafeEqualStr(signature, expected);
}

/**
 * Constant-time comparison of two hex digests.
 */
export function timingSafeEqualHex(a, b) {
  return timingSafeEqualStr(a, b);
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
function bufToHex(buffer) {
  const bytes = new Uint8Array(buffer);
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, '0');
  }
  return out;
}
