import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { parseWebhookKey } from '../config.ts';
import {
	TamperedError,
	WrongKeyError,
	generateWebhookSecret,
	keyFingerprint,
	open,
	seal,
	sealedFingerprint
} from './webhook-secrets.ts';

const key = randomBytes(32);

describe('seal and open', () => {
	it('round-trips a secret', () => {
		const secret = generateWebhookSecret();
		expect(open(seal(secret, key), key)).toBe(secret);
	});

	it('seals the same plaintext differently each time', () => {
		expect(seal('x', key)).not.toBe(seal('x', key));
	});

	it('reads the fingerprint without a key', () => {
		expect(sealedFingerprint(seal('x', key))).toBe(keyFingerprint(key));
		expect(keyFingerprint(key)).toMatch(/^[0-9a-f]{16}$/);
	});

	it('throws WrongKeyError for another key', () => {
		expect(() => open(seal('x', key), randomBytes(32))).toThrow(WrongKeyError);
	});

	it('throws TamperedError when the ciphertext changes', () => {
		const [fp, nonce, body] = seal('hello', key).split('.');
		const bytes = Buffer.from(body, 'base64url');
		bytes[0] ^= 1;
		expect(() => open(`${fp}.${nonce}.${bytes.toString('base64url')}`, key)).toThrow(TamperedError);
	});

	it('throws TamperedError when the tag or nonce is altered or the body truncated', () => {
		const [fp, nonce, body] = seal(generateWebhookSecret(), key).split('.');
		const flip = (part: string, at: number) => {
			const bytes = Buffer.from(part, 'base64url');
			bytes[at] ^= 1;
			return bytes.toString('base64url');
		};
		const last = Buffer.from(body, 'base64url').length - 1;
		expect(() => open(`${fp}.${nonce}.${flip(body, last)}`, key)).toThrow(TamperedError);
		expect(() => open(`${fp}.${flip(nonce, 0)}.${body}`, key)).toThrow(TamperedError);
		const short = Buffer.from(body, 'base64url').subarray(0, 8).toString('base64url');
		expect(() => open(`${fp}.${nonce}.${short}`, key)).toThrow(TamperedError);
	});

	it('round-trips an empty plaintext', () => {
		expect(open(seal('', key), key)).toBe('');
	});

	it('throws TamperedError for malformed input', () => {
		expect(() => open('nonsense', key)).toThrow(TamperedError);
		expect(() => open(`${keyFingerprint(key)}.AAAA.AAAA`, key)).toThrow(TamperedError);
	});
});

describe('generateWebhookSecret', () => {
	it('prefixes 32 random bytes in base64', () => {
		const secret = generateWebhookSecret();
		expect(secret.startsWith('whsec_')).toBe(true);
		expect(Buffer.from(secret.slice(6), 'base64')).toHaveLength(32);
	});
});

describe('parseWebhookKey', () => {
	it('treats unset and blank as undefined', () => {
		expect(parseWebhookKey(undefined)).toBeUndefined();
		expect(parseWebhookKey('  ')).toBeUndefined();
	});

	it('decodes 32 bytes', () => {
		expect(parseWebhookKey(key.toString('base64'))).toEqual(key);
	});

	it('throws for a malformed key', () => {
		const message = 'WEBHOOK_KEY must be 32 bytes in base64';
		expect(() => parseWebhookKey('short')).toThrow(message);
		expect(() => parseWebhookKey(randomBytes(16).toString('base64'))).toThrow(message);
		expect(() => parseWebhookKey('!'.repeat(44))).toThrow(message);
	});
});
