import { describe, expect, it } from 'vitest';
import {
  hmacSha256Hex,
  timingSafeEqualStr,
  timingSafeEqualHex,
  verifyWebhookSignature,
} from '../shared/crypto.js';

describe('shared/crypto (Web Crypto)', () => {
  describe('hmacSha256Hex', () => {
    it('matches the known RFC fixture HMAC-SHA256("secret","payload")', async () => {
      // Standard public test vector (also used by the GitHub webhook docs).
      expect(await hmacSha256Hex('secret', 'payload')).toBe(
        'b82fcb791acec57859b989b430a826488ce2e479fdf92326bd0a2e8375a42ba4',
      );
    });

    it('produces a 64-char lowercase hex digest', async () => {
      const hex = await hmacSha256Hex('k', 'msg');
      expect(hex).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  describe('timingSafeEqualStr / timingSafeEqualHex', () => {
    it('returns true for equal strings', () => {
      const d = 'b82fcb791acec57859b989b430a826488ce2e479fdf92326bd0a2e8375a42ba4';
      expect(timingSafeEqualStr(d, d)).toBe(true);
      expect(timingSafeEqualHex(d, d)).toBe(true);
    });

    it('returns false for different strings of equal length', () => {
      expect(timingSafeEqualStr('abc', 'abd')).toBe(false);
    });

    it('returns false for different lengths', () => {
      expect(timingSafeEqualStr('abc', 'abcd')).toBe(false);
    });

    it('returns false for non-string inputs', () => {
      expect(timingSafeEqualStr(null, null)).toBe(false);
      expect(timingSafeEqualStr(123, 123)).toBe(false);
    });
  });

  describe('verifyWebhookSignature', () => {
    const body = '{"action":"opened"}';

    it('validates a correctly-signed request', async () => {
      const sig = `sha256=${await hmacSha256Hex('whsecret', body)}`;
      const req = new Request('https://example.com/hook', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-hub-signature-256': sig },
        body,
      });
      expect(await verifyWebhookSignature(req, 'whsecret')).toBe(true);
    });

    it('rejects a request whose body was tampered', async () => {
      const sig = `sha256=${await hmacSha256Hex('whsecret', body)}`;
      const req = new Request('https://example.com/hook', {
        method: 'POST',
        headers: { 'x-hub-signature-256': sig },
        body: '{"action":"synchronize"}',
      });
      expect(await verifyWebhookSignature(req, 'whsecret')).toBe(false);
    });

    it('rejects when the signature header is missing', async () => {
      const req = new Request('https://example.com/hook', { method: 'POST', body });
      expect(await verifyWebhookSignature(req, 'whsecret')).toBe(false);
    });

    it('rejects when the secret is empty', async () => {
      const req = new Request('https://example.com/hook', {
        method: 'POST',
        headers: { 'x-hub-signature-256': 'sha256=deadbeef' },
        body,
      });
      expect(await verifyWebhookSignature(req, '')).toBe(false);
    });
  });
});
