import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '#lib/server/db/client.ts';
import { events, users, webhookDeliveries } from '#lib/server/db/schema.ts';
import { schedulePruning } from '#lib/server/events/log.ts';
import { testDb } from '#lib/server/test/db.ts';
import { seedHuman } from '#lib/server/auth/fixtures.ts';
import type { AuthUser } from '#lib/server/auth/users.ts';
import {
	listDeliveries,
	pruneDeliveries,
	recordDelivery,
	type DeliveryInput
} from './deliveries.ts';
import { createWebhook, deleteWebhook, type WebhookEnv } from './store.ts';

const HOUR = 60 * 60 * 1000;
const NOW = Date.UTC(2026, 0, 10);

let db: Db;
let ada: AuthUser;
let env: WebhookEnv;
let hookId: number;

function hook(): number {
	return createWebhook(db, ada, { name: 'hook', url: 'https://example.com/hook' }, env).webhook.id;
}

function attempt(extra: Partial<DeliveryInput> = {}): DeliveryInput {
	return {
		webhookId: hookId,
		attemptedAt: NOW,
		messageId: 'msg_1',
		kind: 'events',
		firstSeq: 1,
		lastSeq: 3,
		status: 200,
		error: null,
		durationMs: 12,
		responseBody: 'ok',
		...extra
	};
}

beforeEach(() => {
	db = testDb();
	ada = seedHuman(db, 'ada');
	env = { key: Buffer.alloc(32, 1), maxPerUser: 10, max: 50, allowPrivate: false, now: NOW };
	hookId = hook();
});

afterEach(() => {
	vi.useRealTimers();
	db.$client.close();
});

describe('recordDelivery', () => {
	it('writes one row per attempt', () => {
		recordDelivery(db, attempt());
		recordDelivery(
			db,
			attempt({ kind: 'ping', firstSeq: null, lastSeq: null, status: null, error: 'timeout' })
		);

		const { deliveries } = listDeliveries(db, hookId);
		expect(deliveries).toHaveLength(2);
		expect(deliveries[1]).toMatchObject({
			webhookId: hookId,
			attemptedAt: new Date(NOW),
			messageId: 'msg_1',
			kind: 'events',
			firstSeq: 1,
			lastSeq: 3,
			status: 200,
			error: null,
			durationMs: 12,
			responseBody: 'ok'
		});
		expect(deliveries[0]).toMatchObject({
			kind: 'ping',
			firstSeq: null,
			status: null,
			error: 'timeout'
		});
	});

	it('cuts the response body to 512 bytes without splitting a character', () => {
		recordDelivery(db, attempt({ responseBody: 'a'.repeat(600) }));
		recordDelivery(db, attempt({ responseBody: 'a' + 'é'.repeat(300) }));
		recordDelivery(db, attempt({ responseBody: null }));

		const [nul, multi, plain] = listDeliveries(db, hookId).deliveries;
		expect(plain!.responseBody).toBe('a'.repeat(512));
		// 1 + 255 two-byte characters = 511 bytes; a 256th would pass 512.
		expect(multi!.responseBody).toBe('a' + 'é'.repeat(255));
		expect(Buffer.byteLength(multi!.responseBody!)).toBe(511);
		expect(nul!.responseBody).toBeNull();
	});
});

describe('listDeliveries', () => {
	it('pages newest first and reports nextBefore only while more remain', () => {
		for (let i = 1; i <= 5; i++) recordDelivery(db, attempt({ messageId: `m${i}` }));
		const other = createWebhook(db, ada, { name: 'other', url: 'https://example.com/o' }, env);
		recordDelivery(db, attempt({ webhookId: other.webhook.id, messageId: 'x' }));

		const first = listDeliveries(db, hookId, { limit: 2 });
		expect(first.deliveries.map((d) => d.messageId)).toEqual(['m5', 'm4']);
		expect(first.nextBefore).toBe(first.deliveries[1]!.id);

		const second = listDeliveries(db, hookId, { limit: 2, before: first.nextBefore! });
		expect(second.deliveries.map((d) => d.messageId)).toEqual(['m3', 'm2']);

		const third = listDeliveries(db, hookId, { limit: 2, before: second.nextBefore! });
		expect(third.deliveries.map((d) => d.messageId)).toEqual(['m1']);
		expect(third.nextBefore).toBeNull();

		expect(listDeliveries(db, hookId, { limit: 5 }).nextBefore).toBeNull();
	});

	it('defaults to 50 and caps at 200', () => {
		for (let i = 0; i < 210; i++) recordDelivery(db, attempt());
		expect(listDeliveries(db, hookId).deliveries).toHaveLength(50);
		expect(listDeliveries(db, hookId, { limit: 1000 }).deliveries).toHaveLength(200);
	});
});

describe('pruning', () => {
	it('pruneDeliveries deletes rows older than retention and counts them', () => {
		recordDelivery(db, attempt({ attemptedAt: NOW - 3 * HOUR, messageId: 'old' }));
		recordDelivery(db, attempt({ attemptedAt: NOW - HOUR / 2, messageId: 'new' }));

		expect(pruneDeliveries(db, HOUR, NOW)).toBe(1);
		expect(listDeliveries(db, hookId).deliveries.map((d) => d.messageId)).toEqual(['new']);
	});

	it('schedulePruning prunes Events and deliveries in the same run', () => {
		vi.useFakeTimers({ now: NOW });
		db.insert(events)
			.values({
				type: 'labour.created',
				actorId: ada.id,
				createdAt: new Date(NOW - 3 * HOUR),
				data: {}
			} as never)
			.run();
		recordDelivery(db, attempt({ attemptedAt: NOW - 3 * HOUR }));
		recordDelivery(db, attempt({ attemptedAt: NOW }));

		const stop = schedulePruning(db, HOUR);
		stop();

		expect(db.select().from(events).all()).toHaveLength(0);
		expect(db.select().from(webhookDeliveries).all()).toHaveLength(1);
	});
});

describe('cascade', () => {
	it('deleting a Webhook removes its rows', () => {
		const other = hook();
		recordDelivery(db, attempt());
		recordDelivery(db, attempt({ webhookId: other }));

		deleteWebhook(db, ada, hookId, env);

		expect(
			db
				.select()
				.from(webhookDeliveries)
				.all()
				.map((r) => r.webhookId)
		).toEqual([other]);
	});

	it('deleting the Owner removes its Webhooks rows', () => {
		recordDelivery(db, attempt());
		db.delete(users).where(eq(users.id, ada.id)).run();
		expect(db.select().from(webhookDeliveries).all()).toHaveLength(0);
	});
});
