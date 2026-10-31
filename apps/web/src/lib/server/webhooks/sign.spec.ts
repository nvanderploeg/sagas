import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Webhook } from 'standardwebhooks';
import { signedHeaders, webhookMessageId, type DeliveryKind } from './sign.ts';

const secret = () => `whsec_${randomBytes(32).toString('base64')}`;
const body = JSON.stringify({ webhook: { id: 7, name: 'x' }, ping: true });
const kind: DeliveryKind = { kind: 'events', webhookId: 7, firstSeq: 3, lastSeq: 9 };
const now = 1700000000999;

beforeAll(() => {
	vi.useFakeTimers();
	vi.setSystemTime(now);
});
afterAll(() => vi.useRealTimers());

describe('webhookMessageId', () => {
	it('derives the id from each kind', () => {
		expect(webhookMessageId(kind)).toBe('7:3-9');
		expect(webhookMessageId({ kind: 'reset', webhookId: 7, seq: 12 })).toBe('7:reset-12');
		expect(webhookMessageId({ kind: 'ping', webhookId: 7, timestamp: 1700000000 })).toBe(
			'7:ping-1700000000'
		);
	});
});

describe('signedHeaders', () => {
	it('sets the fixed headers and a seconds timestamp', () => {
		const h = signedHeaders(kind, body, [secret()], now);
		expect(h['content-type']).toBe('application/json');
		expect(h['user-agent']).toBe('sagas-webhooks');
		expect(h['webhook-id']).toBe('7:3-9');
		expect(h['webhook-timestamp']).toBe('1700000000');
	});

	it('verifies reset and ping Deliveries', () => {
		const s = secret();
		const kinds: DeliveryKind[] = [
			{ kind: 'reset', webhookId: 7, seq: 12 },
			{ kind: 'ping', webhookId: 7, timestamp: 1700000000 }
		];
		for (const k of kinds) {
			const h = signedHeaders(k, body, [s], now);
			expect(h['webhook-id']).toBe(webhookMessageId(k));
			expect(new Webhook(s).verify(body, h)).toBeTruthy();
		}
	});

	it('refuses a secret without the whsec_ prefix or 32 bytes', () => {
		expect(() => signedHeaders(kind, body, ['abc'], now)).toThrow();
		expect(() => signedHeaders(kind, body, ['whsec_'], now)).toThrow();
	});

	it('verifies with the official library', () => {
		const s = secret();
		const h = signedHeaders(kind, body, [s], now);
		expect(new Webhook(s).verify(body, h)).toEqual(JSON.parse(body));
	});

	it('verifies with either secret during rotation', () => {
		const next = secret();
		const prev = secret();
		const h = signedHeaders(kind, body, [next, prev], now);
		const [first, second] = h['webhook-signature'].split(' ');
		expect(new Webhook(next).verify(body, { ...h, 'webhook-signature': first })).toBeTruthy();
		expect(() => new Webhook(prev).verify(body, { ...h, 'webhook-signature': first })).toThrow();
		expect(new Webhook(prev).verify(body, { ...h, 'webhook-signature': second })).toBeTruthy();
		expect(new Webhook(next).verify(body, h)).toBeTruthy();
		expect(new Webhook(prev).verify(body, h)).toBeTruthy();
	});

	it('rejects a tampered body', () => {
		const s = secret();
		const h = signedHeaders(kind, body, [s], now);
		expect(() => new Webhook(s).verify(body + ' ', h)).toThrow();
	});

	it('rejects an unrelated secret', () => {
		const h = signedHeaders(kind, body, [secret()], now);
		expect(() => new Webhook(secret()).verify(body, h)).toThrow();
	});
});
