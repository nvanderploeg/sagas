import { createHmac } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '#lib/server/db/client.ts';
import { webhookDeliveries, webhooks } from '#lib/server/db/schema.ts';
import { DomainError } from '#lib/server/domain/errors.ts';
import { testDb } from '#lib/server/test/db.ts';
import { seedHuman } from '#lib/server/auth/fixtures.ts';
import type { AuthUser } from '#lib/server/auth/users.ts';
import { listDeliveries } from './deliveries.ts';
import { testWebhook } from './ping.ts';
import type { WebhookRuntime } from './runtime.ts';
import type { SafeFetchInput, SafeFetchResult } from './safe-fetch.ts';
import { createWebhook, rotateWebhookSecret, type WebhookEnv } from './store.ts';

const HOUR = 60 * 60 * 1000;
const KEY = Buffer.alloc(32, 1);
const OTHER_KEY = Buffer.alloc(32, 2);
const URL = 'https://example.com/hook';
const NOW = Date.UTC(2026, 0, 1);
const PING_AT = NOW + HOUR;

let db: Db;
let env: WebhookEnv;
let ada: AuthUser;
let bob: AuthUser;
let admin: AuthUser;
let calls: { input: SafeFetchInput; allowPrivate: boolean }[];
let respond: () => Promise<SafeFetchResult>;

const fetchFake: WebhookRuntime['fetch'] = (input, allowPrivate) => {
	calls.push({ input, allowPrivate });
	return respond();
};

beforeEach(async () => {
	db = await testDb();
	env = { key: KEY, maxPerUser: 10, max: 50, allowPrivate: false, now: NOW };
	ada = await seedHuman(db, 'ada');
	bob = await seedHuman(db, 'bob');
	admin = { ...(await seedHuman(db, 'root')), isAdmin: true };
	calls = [];
	respond = async () => ({ ok: true, status: 200, durationMs: 7, body: '' });
});

afterEach(() => {
	vi.useRealTimers();
});

function make(extra = {}) {
	return createWebhook(db, ada, { name: 'hook', url: URL, ...extra }, env);
}

const pingEnv = (extra: Partial<WebhookEnv> = {}): WebhookEnv => ({
	...env,
	now: PING_AT,
	...extra
});

const row = async (id: number) =>
	(await db.select().from(webhooks).where(eq(webhooks.id, id)).limit(1))[0]!;

const deliveries = async (id: number) => (await listDeliveries(db, id)).deliveries;

function sign(secret: string, content: string): string {
	const key = Buffer.from(secret.slice('whsec_'.length), 'base64');
	return `v1,${createHmac('sha256', key).update(content).digest('base64')}`;
}

function expectSignedBy(headers: Record<string, string>, body: string, secrets: string[]) {
	const content = `${headers['webhook-id']}.${headers['webhook-timestamp']}.${body}`;
	const sent = headers['webhook-signature']!.split(' ');
	expect(sent).toHaveLength(secrets.length);
	for (const secret of secrets) expect(sent).toContain(sign(secret, content));
}

async function expectCode(action: () => Promise<unknown>, code: string, message?: string) {
	let thrown: unknown;
	try {
		await action();
	} catch (error) {
		thrown = error;
	}
	expect(thrown).toBeInstanceOf(DomainError);
	expect((thrown as DomainError).code).toBe(code);
	if (message) expect((thrown as DomainError).message).toBe(message);
}

describe('the ping request', () => {
	it('POSTs the ping body to the Webhook url', async () => {
		const { webhook } = await make({ name: 'my hook' });

		await testWebhook(db, ada, webhook.id, pingEnv(), fetchFake);

		expect(calls).toHaveLength(1);
		expect(calls[0]!.input.url).toBe(URL);
		expect(calls[0]!.input.body).toBe(
			`{"webhook":{"id":${webhook.id},"name":"my hook"},"ping":true}`
		);
	});

	it('passes env.allowPrivate to fetch', async () => {
		const { webhook } = await make();

		await testWebhook(db, ada, webhook.id, pingEnv({ allowPrivate: true }), fetchFake);
		await testWebhook(db, ada, webhook.id, pingEnv({ allowPrivate: false }), fetchFake);

		expect(calls.map((c) => c.allowPrivate)).toEqual([true, false]);
	});

	it('carries the Standard Webhooks headers with a ping id and the env time', async () => {
		const { webhook } = await make();
		const timestamp = String(Math.floor(PING_AT / 1000));

		await testWebhook(db, ada, webhook.id, pingEnv(), fetchFake);

		const headers = calls[0]!.input.headers;
		expect(headers['webhook-id']).toBe(`${webhook.id}:ping-${timestamp}`);
		expect(headers['webhook-timestamp']).toBe(timestamp);
		expect(headers['content-type']).toBe('application/json');
	});

	it('signs the id, timestamp and body with the secret', async () => {
		const { webhook, secret } = await make();

		await testWebhook(db, ada, webhook.id, pingEnv(), fetchFake);

		expectSignedBy(calls[0]!.input.headers, calls[0]!.input.body, [secret]);
	});

	it('signs with a secret that does not verify under another one', async () => {
		const { webhook } = await make();
		const other = (await make()).secret;

		await testWebhook(db, ada, webhook.id, pingEnv(), fetchFake);

		const headers = calls[0]!.input.headers;
		const content = `${headers['webhook-id']}.${headers['webhook-timestamp']}.${calls[0]!.input.body}`;
		expect(headers['webhook-signature']).not.toContain(sign(other, content));
	});

	it('signs with both secrets during a rotation overlap', async () => {
		const { webhook, secret: first } = await make();
		const { secret: second } = await rotateWebhookSecret(db, ada, webhook.id, env);

		await testWebhook(db, ada, webhook.id, pingEnv(), fetchFake);

		expectSignedBy(calls[0]!.input.headers, calls[0]!.input.body, [first, second]);
	});

	it('signs with the new secret alone once the overlap has passed', async () => {
		const { webhook, secret: first } = await make();
		const { secret: second } = await rotateWebhookSecret(db, ada, webhook.id, env);

		await testWebhook(db, ada, webhook.id, pingEnv({ now: NOW + 25 * HOUR }), fetchFake);

		expectSignedBy(calls[0]!.input.headers, calls[0]!.input.body, [second]);
		expect(calls[0]!.input.headers['webhook-signature']).not.toContain(
			sign(
				first,
				`${calls[0]!.input.headers['webhook-id']}.${calls[0]!.input.headers['webhook-timestamp']}.${calls[0]!.input.body}`
			)
		);
	});
});

describe('the attempt', () => {
	it('reports a 2xx answer as ok', async () => {
		const { webhook } = await make();
		respond = async () => ({ ok: true, status: 204, durationMs: 31, body: '' });

		expect(await testWebhook(db, ada, webhook.id, pingEnv(), fetchFake)).toEqual({
			ok: true,
			status: 204,
			error: null,
			durationMs: 31
		});
	});

	it('reports ok:false from fetch as an attempt with its error', async () => {
		const { webhook } = await make();
		respond = async () => ({
			ok: false,
			status: 500,
			durationMs: 12,
			body: 'boom',
			error: 'HTTP 500'
		});

		expect(await testWebhook(db, ada, webhook.id, pingEnv(), fetchFake)).toEqual({
			ok: false,
			status: 500,
			error: 'HTTP 500',
			durationMs: 12
		});
	});

	it('reports a status-less failure as an attempt', async () => {
		const { webhook } = await make();
		respond = async () => ({ ok: false, status: null, durationMs: 3, body: '', error: 'timeout' });

		expect(await testWebhook(db, ada, webhook.id, pingEnv(), fetchFake)).toMatchObject({
			ok: false,
			status: null,
			error: 'timeout'
		});
	});

	it('turns a throwing fetch into an attempt, never a thrown error', async () => {
		const { webhook } = await make();
		respond = async () => {
			throw new Error('socket exploded');
		};

		const attempt = await testWebhook(db, ada, webhook.id, pingEnv(), fetchFake);

		expect(attempt.ok).toBe(false);
		expect(attempt.status).toBeNull();
		expect(attempt.error).toEqual(expect.any(String));
		expect(attempt.error).not.toBe('');
		expect(await deliveries(webhook.id)).toHaveLength(1);
	});

	it('turns secrets sealed under another key into a failed attempt, still recorded', async () => {
		const { webhook } = await make();

		const attempt = await testWebhook(db, ada, webhook.id, pingEnv({ key: OTHER_KEY }), fetchFake);

		expect(attempt.ok).toBe(false);
		expect(attempt.error).toEqual(expect.any(String));
		expect(attempt.error).not.toBe('');
		const [delivery] = await deliveries(webhook.id);
		expect(delivery).toMatchObject({ kind: 'ping', error: attempt.error });
		expect(await deliveries(webhook.id)).toHaveLength(1);
	});
});

describe('a Webhook deleted while its ping is in flight', () => {
	it('answers with the attempt and records no row', async () => {
		const { webhook } = await make();
		respond = async () => {
			await db.delete(webhooks).where(eq(webhooks.id, webhook.id));
			return { ok: true, status: 200, durationMs: 7, body: '' };
		};

		const attempt = await testWebhook(db, ada, webhook.id, pingEnv(), fetchFake);

		expect(attempt.ok).toBe(true);
		expect(await deliveries(webhook.id)).toHaveLength(0);
	});
});

describe('the delivery record', () => {
	it('records exactly one ping row with the attempt', async () => {
		const { webhook } = await make();
		respond = async () => ({ ok: true, status: 200, durationMs: 18, body: 'pong' });

		await testWebhook(db, ada, webhook.id, pingEnv(), fetchFake);

		const all = await deliveries(webhook.id);
		expect(all).toHaveLength(1);
		expect(all[0]).toMatchObject({
			webhookId: webhook.id,
			kind: 'ping',
			messageId: `${webhook.id}:ping-${Math.floor(PING_AT / 1000)}`,
			firstSeq: null,
			lastSeq: null,
			status: 200,
			error: null,
			durationMs: 18,
			responseBody: 'pong'
		});
	});

	it('uses the sent webhook-id as the message id', async () => {
		const { webhook } = await make();

		await testWebhook(db, ada, webhook.id, pingEnv(), fetchFake);

		expect((await deliveries(webhook.id))[0]!.messageId).toBe(
			calls[0]!.input.headers['webhook-id']
		);
	});

	it('stores an empty response body as null', async () => {
		const { webhook } = await make();
		respond = async () => ({ ok: true, status: 200, durationMs: 1, body: '' });

		await testWebhook(db, ada, webhook.id, pingEnv(), fetchFake);

		expect((await deliveries(webhook.id))[0]!.responseBody).toBeNull();
	});

	it('records the status and error of a failed attempt', async () => {
		const { webhook } = await make();
		respond = async () => ({
			ok: false,
			status: 502,
			durationMs: 9,
			body: 'bad gateway',
			error: 'HTTP 502'
		});

		await testWebhook(db, ada, webhook.id, pingEnv(), fetchFake);

		expect((await deliveries(webhook.id))[0]).toMatchObject({
			status: 502,
			error: 'HTTP 502',
			responseBody: 'bad gateway'
		});
	});

	it('adds one row per ping', async () => {
		const { webhook } = await make();

		await testWebhook(db, ada, webhook.id, pingEnv(), fetchFake);
		await testWebhook(db, ada, webhook.id, pingEnv({ now: PING_AT + 5000 }), fetchFake);

		expect(await deliveries(webhook.id)).toHaveLength(2);
	});
});

describe('what a ping leaves alone', () => {
	it('moves nothing on an active Webhook after success', async () => {
		const { webhook } = await make();
		const before = await row(webhook.id);

		await testWebhook(db, ada, webhook.id, pingEnv(), fetchFake);

		expect(await row(webhook.id)).toEqual(before);
	});

	it('moves nothing after a failed ping', async () => {
		const { webhook } = await make();
		const before = await row(webhook.id);
		respond = async () => ({ ok: false, status: 500, durationMs: 1, body: '', error: 'HTTP 500' });

		await testWebhook(db, ada, webhook.id, pingEnv(), fetchFake);

		expect(await row(webhook.id)).toEqual(before);
	});

	it('moves nothing when fetch throws', async () => {
		const { webhook } = await make();
		const before = await row(webhook.id);
		respond = async () => {
			throw new Error('nope');
		};

		await testWebhook(db, ada, webhook.id, pingEnv(), fetchFake);

		expect(await row(webhook.id)).toEqual(before);
	});

	it('moves nothing on a failing Webhook with a cursor, attempts and a retry time', async () => {
		const { webhook } = await make();
		await db
			.update(webhooks)
			.set({
				cursor: 42,
				attempts: 4,
				failingSince: new Date(NOW + 1000),
				nextAttemptAt: new Date(NOW + 2000)
			})
			.where(eq(webhooks.id, webhook.id));
		const before = await row(webhook.id);

		await testWebhook(db, ada, webhook.id, pingEnv(), fetchFake);

		const after = await row(webhook.id);
		expect(after).toEqual(before);
		expect(after.cursor).toBe(42);
		expect(after.attempts).toBe(4);
	});

	it('moves nothing when the secrets cannot be opened', async () => {
		const { webhook } = await make();
		const before = await row(webhook.id);

		await testWebhook(db, ada, webhook.id, pingEnv({ key: OTHER_KEY }), fetchFake);

		expect(await row(webhook.id)).toEqual(before);
	});
});

describe('Webhook status', () => {
	it.each([
		['paused', null],
		['paused', 'key_changed'],
		['disabled', 'failing']
	] as const)('pings a %s Webhook (reason %s) without changing it', async (status, reason) => {
		const { webhook } = await make();
		await db
			.update(webhooks)
			.set({ status, statusReason: reason })
			.where(eq(webhooks.id, webhook.id));
		const before = await row(webhook.id);

		const attempt = await testWebhook(db, ada, webhook.id, pingEnv(), fetchFake);

		expect(attempt.ok).toBe(true);
		expect(calls).toHaveLength(1);
		expect(await deliveries(webhook.id)).toHaveLength(1);
		expect(await row(webhook.id)).toEqual(before);
	});
});

describe('permissions and the key', () => {
	it('lets the owner and an Admin ping', async () => {
		const { webhook } = await make();

		await testWebhook(db, ada, webhook.id, pingEnv(), fetchFake);
		await testWebhook(db, admin, webhook.id, pingEnv(), fetchFake);

		expect(calls).toHaveLength(2);
		expect(await deliveries(webhook.id)).toHaveLength(2);
	});

	it('answers not_found to another User, sending and recording nothing', async () => {
		const { webhook } = await make();

		await expectCode(
			() => testWebhook(db, bob, webhook.id, pingEnv(), fetchFake),
			'not_found',
			'Webhook not found'
		);

		expect(calls).toHaveLength(0);
		expect(await deliveries(webhook.id)).toHaveLength(0);
	});

	it('answers not_found for a Webhook that does not exist', async () => {
		await expectCode(
			() => testWebhook(db, ada, 999, pingEnv(), fetchFake),
			'not_found',
			'Webhook not found'
		);
		expect(calls).toHaveLength(0);
	});

	it('refuses without a key, sending and recording nothing', async () => {
		const { webhook } = await make();

		await expectCode(
			() => testWebhook(db, ada, webhook.id, pingEnv({ key: undefined }), fetchFake),
			'invalid',
			'webhooks need WEBHOOK_KEY'
		);

		expect(calls).toHaveLength(0);
		expect(await db.select().from(webhookDeliveries)).toHaveLength(0);
	});
});
