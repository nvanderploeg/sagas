import { eq } from 'drizzle-orm';
import { Webhook } from 'standardwebhooks';
import pg from 'pg';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '#lib/server/db/client.ts';
import { webhookDeliveries, webhooks } from '#lib/server/db/schema.ts';
import { setAccessEnforced } from '#lib/server/domain/access.ts';
import { createRealm } from '#lib/server/domain/realms.ts';
import { write, type Actor } from '#lib/server/domain/write.ts';
import { eventsSince, eventWindow, pruneEvents } from '#lib/server/events/log.ts';
import type { EventSpec } from '#lib/server/events/types.ts';
import { testDb } from '#lib/server/test/db.ts';
import { seedActor, seedRealm, TODO } from '#lib/server/test/fixtures.ts';
import { seedHuman } from '#lib/server/auth/fixtures.ts';
import type { AuthUser } from '#lib/server/auth/users.ts';
import { listDeliveries } from './deliveries.ts';
import {
	assertDisableBeforeRetention,
	createDispatcher,
	type Dispatcher,
	type DispatcherDeps
} from './dispatcher.ts';
import { nudgeWebhook, setDispatcher } from './registry.ts';
import type { SafeFetchInput, SafeFetchResult } from './safe-fetch.ts';
import {
	createWebhook,
	updateWebhook,
	type WebhookEnv,
	type WebhookInput,
	type WebhookRow
} from './store.ts';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const KIB = 1024;
const NOW = Date.UTC(2026, 0, 10);
const KEY = Buffer.alloc(32, 1);

type Respond = (input: SafeFetchInput, n: number) => SafeFetchResult | Promise<SafeFetchResult>;
type Payload = {
	webhook: { id: number; name: string };
	events?: { seq: number; type: string; data: unknown }[];
	reset?: { seq: number };
};

let db: Db;
let ada: AuthUser;
let actor: Actor;
let clock: number;
let calls: SafeFetchInput[];
let respond: Respond;
let armed: { fn: () => void; ms: number } | null;
let reads: string[];
let onEventsRead: (() => void) | null;
let refuse: RegExp | null;

const ok = (): SafeFetchResult => ({ ok: true, status: 200, durationMs: 7, body: 'thanks' });
const fail = (): SafeFetchResult => ({
	ok: false,
	status: 500,
	durationMs: 9,
	body: 'nope',
	error: 'status 500'
});

beforeEach(async () => {
	db = await testDb();
	ada = await seedHuman(db, 'ada');
	actor = await seedActor(db);
	clock = NOW;
	calls = [];
	respond = ok;
	armed = null;
	reads = [];
	refuse = null;
	onEventsRead = null;
	const query = pg.Client.prototype.query as (...args: unknown[]) => unknown;
	vi.spyOn(pg.Client.prototype, 'query').mockImplementation(function (
		this: pg.Client,
		...args: unknown[]
	) {
		const first = args[0];
		const source = typeof first === 'string' ? first : ((first as { text?: string })?.text ?? '');
		if (source.includes('from "webhooks"')) reads.push(source);
		if (refuse?.test(source)) {
			refuse = null;
			const failure = new Error('database is locked');
			const done = args.at(-1);
			if (typeof done === 'function') {
				queueMicrotask(() => done(failure));
				return undefined as never;
			}
			return Promise.reject(failure) as never;
		}
		if (source.includes('from "events"') && onEventsRead !== null) {
			const run = onEventsRead;
			onEventsRead = null;
			run();
		}
		return query.apply(this, args) as never;
	} as never);
});

const made: Dispatcher[] = [];

afterEach(() => {
	for (const d of made.splice(0)) d.stop();
	setDispatcher(null);
	setAccessEnforced(false);
	vi.restoreAllMocks();
});

// The query a pass lists Webhooks with: every column it reads and no where clause.
const LIST = /^select "id", "status", "cursor", "next_attempt_at" from "webhooks"$/;

function storeEnv(): WebhookEnv {
	return { key: KEY, maxPerUser: 10, max: 50, allowPrivate: false, now: clock };
}

function hook(extra: Partial<WebhookInput> = {}) {
	return createWebhook(
		db,
		ada,
		{ name: 'hook', url: 'https://example.com/hook', ...extra },
		storeEnv()
	);
}

function spec(type: string, data: unknown, realms?: number[]): EventSpec {
	return { type, data, realms } as EventSpec;
}

const touch = (realmId = 1, extra = {}) =>
	spec('realm.updated', { realm: { id: realmId }, ...extra });

async function record(...specs: EventSpec[]): Promise<number> {
	await write(db, actor, () => ({ value: null, events: specs.length ? specs : [touch()] }));
	return (await eventWindow(db)).last;
}

async function recordMany(
	n: number,
	make: (i: number) => EventSpec = () => touch()
): Promise<number> {
	return record(...Array.from({ length: n }, (_, i) => make(i)));
}

async function row(id: number): Promise<WebhookRow> {
	return (await db.select().from(webhooks).where(eq(webhooks.id, id)).limit(1))[0]!;
}

function dispatcher(overrides: Partial<DispatcherDeps> = {}): Dispatcher {
	const d = createDispatcher(db, {
		env: { key: KEY, allowPrivate: false },
		concurrency: 4,
		disableAfterMs: 72 * HOUR,
		now: () => clock,
		random: () => 0.5,
		fetch: async (input) => {
			calls.push(input);
			return respond(input, calls.length);
		},
		setTimer: ((fn: () => void, ms: number) => {
			armed = { fn, ms };
			return { unref() {} };
		}) as unknown as typeof setTimeout,
		clearTimer: (() => {
			armed = null;
		}) as unknown as typeof clearTimeout,
		...overrides
	});
	made.push(d);
	setDispatcher(d);
	d.start();
	return d;
}

// Winds the id sequence back so the next Webhook reuses the last deleted id.
async function reuseLastId(): Promise<void> {
	await db.$client.query(
		`SELECT setval(pg_get_serial_sequence('webhooks', 'id'), last_value, false) FROM webhooks_id_seq`
	);
}

function payload(i: number): Payload {
	return JSON.parse(calls[i]!.body) as Payload;
}

const seqs = (i: number) => payload(i).events!.map((event) => event.seq);
const range = (from: number, to: number) =>
	Array.from({ length: to - from + 1 }, (_, i) => from + i);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(condition: () => boolean | Promise<boolean>): Promise<void> {
	for (let i = 0; i < 2000 && !(await condition()); i++) await sleep(5);
	expect(await condition()).toBe(true);
}

// A turn is a stretch of real time: the dispatcher works through the database.
async function turns(n = 20): Promise<void> {
	await sleep(n * 5);
}

// Each call waits for the spec to release its gate.
function hold(): ((result: SafeFetchResult) => void)[] {
	const gates: ((result: SafeFetchResult) => void)[] = [];
	respond = () => new Promise((resolve) => gates.push(resolve));
	return gates;
}

// Moves the clock to the Webhook's retry and fires the timer the dispatcher armed for it.
async function retry(d: Dispatcher, id: number): Promise<void> {
	const at = (await row(id)).nextAttemptAt;
	expect(at).not.toBeNull();
	expect(armed).not.toBeNull();
	clock = at!.getTime();
	const timer = armed!;
	armed = null;
	timer.fn();
	await d.drain();
}

describe('delivery', () => {
	it('POSTs the Events after the cursor, signed per Standard Webhooks', async () => {
		clock = Date.now();
		const { webhook, secret } = await hook({ name: 'mine' });
		const last = await recordMany(3);
		const d = dispatcher();
		await d.drain();

		expect(calls).toHaveLength(1);
		expect(calls[0]!.url).toBe('https://example.com/hook');
		expect(payload(0).webhook).toEqual({ id: webhook.id, name: 'mine' });
		expect(seqs(0)).toEqual(range(last - 2, last));
		expect(payload(0).events![0]).toEqual(
			JSON.parse(JSON.stringify((await eventsSince(db, last - 3))[0]))
		);
		expect(calls[0]!.headers['webhook-id']).toBe(`${webhook.id}:${last - 2}-${last}`);
		expect(() => new Webhook(secret).verify(calls[0]!.body, calls[0]!.headers)).not.toThrow();
		expect((await row(webhook.id)).cursor).toBe(last);
	});

	it('delivers Events recorded during a Delivery afterwards, in seq order, with no gaps', async () => {
		const { webhook } = await hook();
		const start = (await eventWindow(db)).last + 1;
		await recordMany(3);
		const gates = hold();
		const d = dispatcher();
		await until(() => calls.length === 1);

		await record();
		const last = await record(touch(), touch());
		await turns();
		expect(calls).toHaveLength(1);

		gates[0]!(ok());
		await until(() => calls.length === 2);
		gates[1]!(ok());
		await d.drain();

		expect(calls).toHaveLength(2);
		expect([...seqs(0), ...seqs(1)]).toEqual(range(start, last));
		expect((await row(webhook.id)).cursor).toBe(last);
	});

	it('sends nothing for a paused or disabled Webhook, and carries on once resumed', async () => {
		const paused = (await hook()).webhook;
		const disabled = (await hook()).webhook;
		await updateWebhook(db, ada, paused.id, { status: 'paused' }, storeEnv());
		await db
			.update(webhooks)
			.set({ status: 'disabled', statusReason: 'failing' })
			.where(eq(webhooks.id, disabled.id));
		const last = await recordMany(2);
		const d = dispatcher();
		await d.drain();
		await d.nudge(paused.id);
		await d.nudge(disabled.id);
		await d.drain();

		expect(calls).toHaveLength(0);
		expect((await row(paused.id)).cursor).toBe(paused.cursor);

		await updateWebhook(db, ada, paused.id, { status: 'active' }, storeEnv());
		d.wake();
		await d.drain();

		expect(calls).toHaveLength(1);
		expect(seqs(0)).toEqual(range(last - 1, last));
		expect((await row(disabled.id)).cursor).toBe(disabled.cursor);
	});
});

describe('off the request path', () => {
	it('never runs a Delivery inside a write, and a hung receiver blocks no other Webhook', async () => {
		await hook({ url: 'https://hang.example.com/hook' });
		const other = (await hook()).webhook;
		respond = (input) => (input.url.includes('hang') ? new Promise(() => {}) : ok());
		dispatcher();
		reads = [];

		const value = await write(db, actor, () => ({ value: 'written', events: [touch()] }));
		expect(value).toBe('written');
		expect(reads).toHaveLength(0);
		expect(calls).toHaveLength(0);

		const first = (await eventWindow(db)).last;
		await until(async () => (await row(other.id)).cursor === first);
		const second = await record();
		await until(async () => (await row(other.id)).cursor === second);

		expect(calls.filter((call) => call.url.includes('hang'))).toHaveLength(1);
		expect(calls.filter((call) => !call.url.includes('hang'))).toHaveLength(2);
	});

	it('reads Webhooks after a write returns, then sends', async () => {
		await hook();
		const d = dispatcher();
		await d.drain();
		reads = [];

		await record();
		expect(reads).toHaveLength(0);
		expect(calls).toHaveLength(0);

		await until(() => reads.some((sql) => LIST.test(sql)));
		await until(() => calls.length === 1);
		await d.drain();
		expect(calls).toHaveLength(1);
	});

	it('takes due Webhooks round-robin when concurrency is short', async () => {
		const a = (await hook()).webhook.id;
		const b = (await hook()).webhook.id;
		const c = (await hook()).webhook.id;
		const gates = hold();
		await record();
		const d = dispatcher({ concurrency: 1 });
		await until(() => calls.length === 1);
		await record();

		// a has had a turn, so b and c go before it even though a is due again first.
		for (let n = 1; n <= 4; n++) {
			gates[n - 1]!(ok());
			if (n < 4) await until(() => calls.length === n + 1);
		}
		await d.drain();

		expect(calls.map((_, i) => payload(i).webhook.id)).toEqual([a, b, c, a]);
	});

	it("forgets a deleted Webhook's turn, so a later one under its id goes first", async () => {
		const other = (await hook()).webhook.id;
		const gone = (await hook()).webhook.id;
		await record();
		const d = dispatcher({ concurrency: 1 });
		await d.drain();
		await record();
		await d.drain();
		await db.delete(webhooks).where(eq(webhooks.id, gone));
		d.wake();
		await d.drain();
		await reuseLastId();
		const reborn = (await hook()).webhook.id;
		expect(reborn).toBe(gone);

		calls = [];
		const gates = hold();
		await record();
		await until(() => calls.length === 1);
		gates[0]!(ok());
		await until(() => calls.length === 2);
		gates[1]!(ok());
		await d.drain();

		expect(calls.map((_, i) => payload(i).webhook.id)).toEqual([reborn, other]);
	});

	it('keeps at most `concurrency` Webhooks delivering at once', async () => {
		const ids = [(await hook()).webhook.id, (await hook()).webhook.id, (await hook()).webhook.id];
		let open = 0;
		let peak = 0;
		const gates: (() => void)[] = [];
		respond = () => {
			open += 1;
			peak = Math.max(peak, open);
			return new Promise((resolve) =>
				gates.push(() => {
					open -= 1;
					resolve(ok());
				})
			);
		};
		const last = await record();
		const d = dispatcher({ concurrency: 2 });
		await until(() => calls.length === 2);
		await turns();
		expect(calls).toHaveLength(2);

		gates[0]!();
		await until(() => calls.length === 3);
		gates[1]!();
		gates[2]!();
		await d.drain();

		expect(peak).toBe(2);
		expect(await Promise.all(ids.map(async (id) => (await row(id)).cursor))).toEqual([
			last,
			last,
			last
		]);
	});
});

describe('retries', () => {
	it('keeps the cursor and resends the same Events under the same webhook-id', async () => {
		const { webhook } = await hook();
		const last = await recordMany(3);
		respond = (_, n) => (n === 1 ? fail() : ok());
		const d = dispatcher();
		await d.drain();

		expect((await row(webhook.id)).cursor).toBe(webhook.cursor);
		expect((await row(webhook.id)).nextAttemptAt!.getTime()).toBe(NOW + 15_000);
		expect(armed!.ms).toBe(15_000);

		const later = await recordMany(2);
		await d.drain();
		expect(calls).toHaveLength(1);

		await retry(d, webhook.id);

		expect(calls).toHaveLength(3);
		expect(calls[1]!.body).toBe(calls[0]!.body);
		expect(calls[1]!.headers['webhook-id']).toBe(calls[0]!.headers['webhook-id']);
		expect(seqs(1)).toEqual(range(last - 2, last));
		expect(seqs(2)).toEqual(range(later - 1, later));
		expect(await row(webhook.id)).toMatchObject({
			cursor: later,
			attempts: 0,
			failingSince: null,
			nextAttemptAt: null
		});
	});

	it('retries at once when random() is 0', async () => {
		const { webhook } = await hook();
		await record();
		const gates: ((result: SafeFetchResult) => void)[] = [];
		respond = (_, n) => (n === 1 ? fail() : new Promise((resolve) => gates.push(resolve)));
		const d = dispatcher({ random: () => 0 });
		await until(() => calls.length === 2);

		expect((await row(webhook.id)).attempts).toBe(1);
		expect((await row(webhook.id)).nextAttemptAt!.getTime()).toBe(NOW);
		gates[0]!(ok());
		await d.drain();
	});

	it('waits min(1 h, 30 s × 2ⁿ) before retry n when random() is 1', async () => {
		const { webhook } = await hook();
		await record();
		respond = fail;
		const d = dispatcher({ random: () => 1 });
		await d.drain();
		const waits: number[] = [];
		for (let n = 0; n < 9; n++) {
			if (n > 0) await retry(d, webhook.id);
			waits.push((await row(webhook.id)).nextAttemptAt!.getTime() - clock);
		}

		expect(waits).toEqual([
			30_000,
			60_000,
			120_000,
			240_000,
			480_000,
			960_000,
			1_920_000,
			HOUR,
			HOUR
		]);
		expect((await row(webhook.id)).attempts).toBe(9);
	});

	it('makes a waiting retry due at once on nudge', async () => {
		const { webhook } = await hook();
		const last = await record();
		respond = (_, n) => (n === 1 ? fail() : ok());
		const d = dispatcher({ random: () => 1 });
		await d.drain();
		expect((await row(webhook.id)).nextAttemptAt!.getTime()).toBe(NOW + 30_000);

		await d.nudge(webhook.id);
		await d.drain();

		expect(calls).toHaveLength(2);
		expect((await row(webhook.id)).cursor).toBe(last);
	});

	it('disables a Webhook failing for disableAfterMs, keeping its cursor', async () => {
		const { webhook } = await hook();
		await record();
		respond = fail;
		const d = dispatcher({ random: () => 1, disableAfterMs: 2 * HOUR });
		await d.drain();
		for (let i = 0; i < 20 && (await row(webhook.id)).status === 'active'; i++) {
			await retry(d, webhook.id);
		}
		const sent = calls.length;

		expect(await row(webhook.id)).toMatchObject({
			status: 'disabled',
			statusReason: 'failing',
			nextAttemptAt: null,
			cursor: webhook.cursor,
			failingSince: new Date(NOW)
		});
		expect(clock - NOW).toBeGreaterThanOrEqual(2 * HOUR);
		expect(clock - NOW).toBeLessThan(2 * HOUR + HOUR);

		await record();
		await d.nudge(webhook.id);
		await d.drain();
		expect(calls).toHaveLength(sent);
	});

	it('disables a Webhook whose failing reaches exactly disableAfterMs', async () => {
		for (const disableAfterMs of [30_000, 30_001]) {
			calls = [];
			clock = NOW;
			await db.delete(webhooks);
			const { webhook } = await hook();
			await record();
			respond = fail;
			const d = dispatcher({ random: () => 1, disableAfterMs });
			await d.drain();
			await retry(d, webhook.id);

			expect(clock - NOW).toBe(30_000);
			expect(calls).toHaveLength(2);
			expect((await row(webhook.id)).status).toBe(
				disableAfterMs === 30_000 ? 'disabled' : 'active'
			);
			d.stop();
		}
	});

	it('arms its timer for the earliest retry', async () => {
		await hook();
		await hook();
		await record();
		respond = fail;
		const draws = [0.2, 0.8];
		const d = dispatcher({ random: () => draws.shift()! });
		await d.drain();

		expect(calls).toHaveLength(2);
		expect(armed!.ms).toBe(6_000);
	});

	it('clears its timer on stop', async () => {
		await hook();
		await record();
		respond = fail;
		const d = dispatcher();
		await d.drain();
		expect(armed).not.toBeNull();

		d.stop();
		expect(armed).toBeNull();
	});

	it('retries at once when resumed during a failing attempt', async () => {
		const { webhook } = await hook();
		await record();
		const gates: ((result: SafeFetchResult) => void)[] = [];
		respond = (_, n) => (n === 1 ? new Promise((resolve) => gates.push(resolve)) : fail());
		const d = dispatcher({ random: () => 1 });
		await until(() => calls.length === 1);

		await updateWebhook(db, ada, webhook.id, { status: 'paused' }, storeEnv());
		await updateWebhook(db, ada, webhook.id, { status: 'active' }, storeEnv());
		gates[0]!(fail());
		await d.drain();

		expect(calls).toHaveLength(2);
		expect(calls[1]!.headers['webhook-id']).toBe(calls[0]!.headers['webhook-id']);
		// The nudge is spent: the next failure backs off as usual.
		expect(await row(webhook.id)).toMatchObject({
			attempts: 2,
			nextAttemptAt: new Date(clock + 60_000)
		});
	});

	it('neither backs off nor disables a Webhook paused during its attempt', async () => {
		const { webhook } = await hook();
		await record();
		const gates: ((result: SafeFetchResult) => void)[] = [];
		respond = (_, n) => (n === 1 ? new Promise((resolve) => gates.push(resolve)) : ok());
		const d = dispatcher({ random: () => 1, disableAfterMs: 1 });
		await until(() => calls.length === 1);

		await updateWebhook(db, ada, webhook.id, { status: 'paused' }, storeEnv());
		clock += 1;
		gates[0]!(fail());
		await d.drain();

		expect(await row(webhook.id)).toMatchObject({
			status: 'paused',
			attempts: 0,
			failingSince: null,
			nextAttemptAt: null
		});
		expect((await listDeliveries(db, webhook.id)).deliveries.map((r) => r.status)).toEqual([500]);
	});

	it('holds a Webhook back 30 s after its Delivery throws, until nudged', async () => {
		const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
		const { webhook } = await hook();
		const breakRow = async () =>
			await db.update(webhooks).set({ eventTypes: '[' }).where(eq(webhooks.id, webhook.id));
		const mend = async () =>
			await db.update(webhooks).set({ eventTypes: null }).where(eq(webhooks.id, webhook.id));
		await breakRow();
		const first = await record();
		const d = dispatcher();
		await turns(50);

		expect(errors).toHaveBeenCalledTimes(1);
		expect(armed!.ms).toBe(30_000);

		await mend();
		clock += 30_000;
		armed!.fn();
		await d.drain();
		expect((await row(webhook.id)).cursor).toBe(first);

		await breakRow();
		const second = await record();
		await turns(50);
		expect(errors).toHaveBeenCalledTimes(2);

		await mend();
		await d.nudge(webhook.id);
		await d.drain();
		expect((await row(webhook.id)).cursor).toBe(second);
		expect(calls).toHaveLength(2);
	});

	it('keeps its retry timer when a pass fails', async () => {
		const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
		const { webhook } = await hook();
		const last = await record();
		respond = (_, n) => (n === 1 ? fail() : ok());
		const d = dispatcher();
		await d.drain();
		expect(armed!.ms).toBe(15_000);

		clock = (await row(webhook.id)).nextAttemptAt!.getTime();
		refuse = LIST;
		const timer = armed!;
		armed = null;
		timer.fn();
		await d.drain();
		expect(errors).toHaveBeenCalledTimes(1);
		expect(calls).toHaveLength(1);
		expect(armed!.ms).toBe(30_000);

		clock += 30_000;
		armed!.fn();
		await d.drain();
		expect(calls).toHaveLength(2);
		expect((await row(webhook.id)).cursor).toBe(last);
	});

	it('moves on from a retry whose Events no longer match, without spinning', async () => {
		const { webhook } = await hook();
		await recordMany(3);
		respond = (_, n) => (n === 1 ? fail() : ok());
		const d = dispatcher({ random: () => 1 });
		await d.drain();
		await updateWebhook(db, ada, webhook.id, { eventTypes: ['labour.created'] }, storeEnv());
		const created = () => spec('labour.created', { labour: { id: 1, realmId: 1 } });
		const later = await record(created(), created());

		clock = (await row(webhook.id)).nextAttemptAt!.getTime();
		reads = [];
		armed!.fn();
		await turns(60);

		expect(calls).toHaveLength(2);
		expect(seqs(1)).toEqual(range(later - 1, later));
		expect((await row(webhook.id)).cursor).toBe(later);
		expect(reads.filter((sql) => LIST.test(sql)).length).toBeLessThan(6);
	});

	it('forgets a deleted Webhook, so a later one under its id is not held back', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const gone = (await hook()).webhook;
		await db.update(webhooks).set({ eventTypes: '[' }).where(eq(webhooks.id, gone.id));
		await record();
		const d = dispatcher();
		await turns(50);
		expect(armed!.ms).toBe(30_000);

		await db.delete(webhooks).where(eq(webhooks.id, gone.id));
		await record();
		await d.drain();
		await reuseLastId();
		const reborn = (await hook()).webhook;
		expect(reborn.id).toBe(gone.id);
		const last = await record();
		await d.drain();

		expect(calls).toHaveLength(1);
		expect((await row(reborn.id)).cursor).toBe(last);
	});

	it('keeps one delivery log row per attempt', async () => {
		const { webhook } = await hook();
		const last = await recordMany(2);
		respond = (_, n) => (n < 3 ? fail() : ok());
		const d = dispatcher({ random: () => 1 });
		await d.drain();
		const times = [clock];
		await retry(d, webhook.id);
		times.push(clock);
		await retry(d, webhook.id);
		times.push(clock);

		const rows = (await listDeliveries(db, webhook.id)).deliveries.reverse();
		expect(rows.map((r) => r.status)).toEqual([500, 500, 200]);
		expect(rows.map((r) => r.error)).toEqual(['status 500', 'status 500', null]);
		expect(rows.map((r) => r.responseBody)).toEqual(['nope', 'nope', 'thanks']);
		expect(rows.map((r) => r.durationMs)).toEqual([9, 9, 7]);
		expect(rows.map((r) => r.attemptedAt.getTime())).toEqual(times);
		for (const r of rows) {
			expect(r).toMatchObject({
				kind: 'events',
				messageId: `${webhook.id}:${last - 1}-${last}`,
				firstSeq: last - 1,
				lastSeq: last
			});
		}
	});
});

describe('restarts', () => {
	it('retries the same Events under the same webhook-id after a restart', async () => {
		const { webhook } = await hook();
		const last = await recordMany(3);
		respond = (_, n) => (n === 1 ? fail() : ok());
		await dispatcher({ random: () => 1 }).drain();
		const later = await recordMany(2);

		const d = dispatcher({ random: () => 1 });
		await d.drain();
		expect(calls).toHaveLength(1);
		await retry(d, webhook.id);

		expect(calls).toHaveLength(3);
		expect(calls[1]!.body).toBe(calls[0]!.body);
		expect(calls[1]!.headers['webhook-id']).toBe(`${webhook.id}:${last - 2}-${last}`);
		expect(seqs(2)).toEqual(range(later - 1, later));
		expect((await row(webhook.id)).cursor).toBe(later);
	});

	it('retries the same reset after a restart', async () => {
		const { webhook } = await hook();
		await recordMany(3);
		await pruneEvents(db, 0, Date.now() + 60_000);
		const pruned = (await eventWindow(db)).last;
		respond = (_, n) => (n === 1 ? fail() : ok());
		await dispatcher({ random: () => 1 }).drain();
		const after = await record();

		const d = dispatcher({ random: () => 1 });
		await d.drain();
		await retry(d, webhook.id);

		expect(calls).toHaveLength(3);
		expect(calls[1]!.body).toBe(calls[0]!.body);
		expect(calls[1]!.headers['webhook-id']).toBe(`${webhook.id}:reset-${pruned}`);
		expect(seqs(2)).toEqual([after]);
	});

	it('sends the Events after a success under a new webhook-id after a restart', async () => {
		const { webhook } = await hook();
		const first = await record();
		await dispatcher().drain();
		const later = await recordMany(2);

		const d = dispatcher();
		await d.drain();

		expect(calls.map((call) => call.headers['webhook-id'])).toEqual([
			`${webhook.id}:${first}-${first}`,
			`${webhook.id}:${later - 1}-${later}`
		]);
	});
});

describe('registry', () => {
	it('delivers at once when a Webhook is resumed, with no later Event', async () => {
		const { webhook } = await hook();
		await db
			.update(webhooks)
			.set({ status: 'disabled', statusReason: 'failing' })
			.where(eq(webhooks.id, webhook.id));
		const last = await record();
		const d = dispatcher();
		await d.drain();
		expect(calls).toHaveLength(0);

		await updateWebhook(db, ada, webhook.id, { status: 'active' }, storeEnv());
		await d.drain();

		expect(calls).toHaveLength(1);
		expect((await row(webhook.id)).cursor).toBe(last);
	});

	it('stops the previous dispatcher when another is set', async () => {
		const { webhook } = await hook();
		const gates = hold();
		const first = dispatcher();
		const second = dispatcher();
		const last = await record();
		await until(() => calls.length === 1);
		await turns();

		expect(calls).toHaveLength(1);
		gates[0]!(ok());
		await Promise.all([first.drain(), second.drain()]);
		expect((await row(webhook.id)).cursor).toBe(last);
	});

	it('nudges the current dispatcher, and nothing once none is set', async () => {
		const { webhook } = await hook();
		await record();
		respond = (_, n) => (n === 1 ? fail() : ok());
		const d = dispatcher({ random: () => 1 });
		await d.drain();

		await nudgeWebhook(webhook.id);
		await d.drain();
		expect(calls).toHaveLength(2);

		setDispatcher(null);
		await nudgeWebhook(webhook.id);
	});
});

describe('guards', () => {
	it('ends the failing episode when a retry turns into a skip', async () => {
		const { webhook } = await hook();
		await recordMany(3);
		respond = (_, n) => (n === 1 ? fail() : ok());
		const d = dispatcher({ random: () => 1 });
		await d.drain();
		expect(await row(webhook.id)).toMatchObject({ attempts: 1 });
		expect((await row(webhook.id)).failingSince).not.toBeNull();

		await updateWebhook(db, ada, webhook.id, { eventTypes: ['labour.created'] }, storeEnv());
		const skipped = (await eventWindow(db)).last;
		await retry(d, webhook.id);

		expect(calls).toHaveLength(1);
		expect(await row(webhook.id)).toMatchObject({
			cursor: skipped,
			failingSince: null,
			attempts: 0,
			nextAttemptAt: null
		});

		clock += 80 * HOUR;
		respond = fail;
		await record(spec('labour.created', { labour: { id: 1, realmId: 1 } }));
		await d.drain();

		expect(calls).toHaveLength(2);
		expect(await row(webhook.id)).toMatchObject({ status: 'active', attempts: 1 });
	});

	it('makes no request when stopped before a launched Delivery fetches', async () => {
		await hook();
		await record();
		onEventsRead = () => d.stop();
		const d: Dispatcher = dispatcher();
		await d.drain();
		await turns();

		expect(calls).toHaveLength(0);
	});

	it('never moves the cursor backwards when two dispatchers race on it', async () => {
		const { webhook } = await hook();
		const first = await record();
		const gates = hold();
		const a = dispatcher();
		await until(() => calls.length === 1);

		const second = await record();
		const b = dispatcher();
		await until(() => calls.length === 2);
		expect(second).toBeGreaterThan(first);

		gates[1]!(ok());
		await b.drain();
		expect((await row(webhook.id)).cursor).toBe(second);

		gates[0]!(ok());
		await a.drain();
		expect((await row(webhook.id)).cursor).toBe(second);
	});

	it('retries at once when the url of a failing Webhook changes', async () => {
		const { webhook } = await hook();
		await record();
		respond = (_, n) => (n === 1 ? fail() : ok());
		const d = dispatcher({ random: () => 1 });
		await d.drain();
		await db
			.update(webhooks)
			.set({ nextAttemptAt: new Date(clock + HOUR) })
			.where(eq(webhooks.id, webhook.id));

		await updateWebhook(db, ada, webhook.id, { url: 'https://example.com/other' }, storeEnv());
		await d.drain();

		expect(calls).toHaveLength(2);
		expect(calls[1]!.url).toBe('https://example.com/other');
	});

	it('does not retry a failing Webhook when only its name changes', async () => {
		const { webhook } = await hook();
		await record();
		respond = fail;
		const d = dispatcher({ random: () => 1 });
		await d.drain();
		await db
			.update(webhooks)
			.set({ nextAttemptAt: new Date(clock + HOUR) })
			.where(eq(webhooks.id, webhook.id));

		await updateWebhook(db, ada, webhook.id, { name: 'renamed' }, storeEnv());
		await d.drain();
		await turns();

		expect(calls).toHaveLength(1);
	});
});

describe('batches', () => {
	it('carries at most 100 Events', async () => {
		const { webhook } = await hook();
		const start = (await eventWindow(db)).last + 1;
		const last = await recordMany(150);
		const d = dispatcher();
		await d.drain();

		expect(calls.map((_, i) => seqs(i).length)).toEqual([100, 50]);
		expect([...seqs(0), ...seqs(1)]).toEqual(range(start, last));
		expect((await row(webhook.id)).cursor).toBe(last);
	});

	it('fills a body up to exactly 256 KiB and no further', async () => {
		for (const over of [0, 1]) {
			calls = [];
			await db.delete(webhooks);
			const { webhook } = await hook({ name: `h${over}` });
			const first = await record(touch(1, { pad: 'x' }));
			const firstBytes = Buffer.byteLength(JSON.stringify((await eventsSince(db, first - 1))[0]));
			const envelope = Buffer.byteLength(
				JSON.stringify({ webhook: { id: webhook.id, name: `h${over}` }, events: [] })
			);
			const secondBytes = 256 * KIB - envelope - firstBytes - 1 + over;
			await record(touch(1, { pad: 'x'.repeat(1 + secondBytes - firstBytes) }));
			await record();
			const d = dispatcher();
			await d.drain();
			d.stop();

			expect(calls.map((_, i) => seqs(i).length)).toEqual(over ? [1, 2] : [2, 1]);
			if (!over) expect(Buffer.byteLength(calls[0]!.body)).toBe(256 * KIB);
			for (const call of calls) expect(Buffer.byteLength(call.body)).toBeLessThanOrEqual(256 * KIB);
		}
	});

	it('sends an Event larger than the cap alone', async () => {
		await hook();
		const small = await record();
		const big = await record(touch(1, { pad: 'x'.repeat(300 * KIB) }));
		const after = await record();
		const d = dispatcher();
		await d.drain();

		expect(calls.map((_, i) => seqs(i))).toEqual([[small], [big], [after]]);
		expect(Buffer.byteLength(calls[1]!.body)).toBeGreaterThan(256 * KIB);
	});
});

describe('matching', () => {
	it('moves the cursor past Events that do not match, with no Delivery', async () => {
		const { webhook } = await hook({ eventTypes: ['labour.created'] });
		const last = await recordMany(3);
		const d = dispatcher();
		await d.drain();

		expect(calls).toHaveLength(0);
		expect((await row(webhook.id)).cursor).toBe(last);
		expect(await db.select().from(webhookDeliveries)).toHaveLength(0);
	});

	it('matches realmIds against the Realms an Event touches', async () => {
		const a = (await seedRealm(db, 'AA')).id;
		const b = (await seedRealm(db, 'BB')).id;
		const inA = (await hook({ realmIds: [a] })).webhook;
		const all = (await hook()).webhook;
		const quests = (await hook({ eventTypes: ['quest.created'] })).webhook;
		const start = (await eventWindow(db)).last;
		const last = await record(
			spec('realm.updated', { realm: { id: b } }, [b]),
			spec('realm.updated', { realm: { id: a } }, [a]),
			spec('quest.created', { quest: { realmId: a } }, []),
			spec('realm.updated', { realm: { id: b } }, [a, b]),
			spec('realm.updated', { realm: { id: b } }, [b])
		);
		const d = dispatcher();
		await d.drain();

		const sent = (id: number) =>
			calls.flatMap((_, i) => (payload(i).webhook.id === id ? seqs(i) : []));
		expect(sent(inA.id)).toEqual([start + 2, start + 4]);
		expect(sent(all.id)).toEqual(range(start + 1, last));
		expect(sent(quests.id)).toEqual([start + 3]);
		expect(
			await Promise.all([inA, all, quests].map(async (w) => (await row(w.id)).cursor))
		).toEqual([last, last, last]);
	});

	it("sends only what the Owner's Stream would carry, as the Owner may see it", async () => {
		setAccessEnforced(true);
		const mine = (
			await createRealm(db, { id: ada.id }, { name: 'Mine', key: 'MI', initialState: TODO })
		).id;
		const theirs = (await seedRealm(db, 'TH')).id;
		const { webhook } = await hook();
		const start = (await eventWindow(db)).last;
		const last = await record(
			spec('realm.updated', { realm: { id: mine } }),
			spec('realm.updated', { realm: { id: theirs } }),
			spec('labour.moved', { labour: { id: 77, realmId: theirs }, fromRealmId: mine }),
			spec('realm.updated', { realm: { id: theirs } })
		);
		const d = dispatcher();
		await d.drain();

		expect(calls).toHaveLength(1);
		expect(payload(0).events!.map(({ seq, type }) => ({ seq, type }))).toEqual([
			{ seq: start + 1, type: 'realm.updated' },
			{ seq: start + 3, type: 'labour.deleted' }
		]);
		expect(payload(0).events![1]!.data).toEqual({ id: 77, realmId: mine });
		expect((await row(webhook.id)).cursor).toBe(last);

		const hidden = await record(spec('realm.updated', { realm: { id: theirs } }));
		await d.drain();
		expect(calls).toHaveLength(1);
		expect((await row(webhook.id)).cursor).toBe(hidden);
	});
});

describe('matching as shown', () => {
	it('tests eventTypes against the type the Owner is shown', async () => {
		setAccessEnforced(true);
		const mine = (
			await createRealm(db, { id: ada.id }, { name: 'Mine', key: 'MI', initialState: TODO })
		).id;
		const theirs = (await seedRealm(db, 'TH')).id;
		const deleted = (await hook({ eventTypes: ['labour.deleted'] })).webhook;
		const moved = (await hook({ eventTypes: ['labour.moved'] })).webhook;
		const last = await record(
			spec('labour.moved', { labour: { id: 77, realmId: theirs }, fromRealmId: mine })
		);
		const d = dispatcher();
		await d.drain();

		expect(calls).toHaveLength(1);
		expect(payload(0).webhook.id).toBe(deleted.id);
		expect(payload(0).events!.map(({ seq, type }) => ({ seq, type }))).toEqual([
			{ seq: last, type: 'labour.deleted' }
		]);
		expect(await Promise.all([deleted, moved].map(async (w) => (await row(w.id)).cursor))).toEqual([
			last,
			last
		]);
	});
});

describe('falling past retention', () => {
	it('sends reset, retries it unchanged, then jumps the cursor', async () => {
		const { webhook } = await hook();
		await recordMany(3);
		await pruneEvents(db, 0, Date.now() + 60_000);
		const pruned = (await eventWindow(db)).last;
		respond = (_, n) => (n === 1 ? fail() : ok());
		const d = dispatcher({ random: () => 1 });
		await d.drain();

		expect(payload(0)).toEqual({
			webhook: { id: webhook.id, name: 'hook' },
			reset: { seq: pruned }
		});
		expect(calls[0]!.headers['webhook-id']).toBe(`${webhook.id}:reset-${pruned}`);
		expect((await row(webhook.id)).cursor).toBe(webhook.cursor);

		const after = await record();
		await retry(d, webhook.id);

		expect(calls).toHaveLength(3);
		expect(calls[1]!.body).toBe(calls[0]!.body);
		expect(calls[1]!.headers['webhook-id']).toBe(`${webhook.id}:reset-${pruned}`);
		expect(seqs(2)).toEqual([after]);
		expect((await row(webhook.id)).cursor).toBe(after);
		const log = (await listDeliveries(db, webhook.id)).deliveries.reverse();
		expect(log.map((r) => [r.kind, r.firstSeq, r.lastSeq])).toEqual([
			['reset', pruned, pruned],
			['reset', pruned, pruned],
			['events', after, after]
		]);
	});
});

describe('assertDisableBeforeRetention', () => {
	it('accepts a disable window shorter than retention', () => {
		expect(() => assertDisableBeforeRetention(72 * HOUR, 7 * DAY)).not.toThrow();
	});

	it('refuses one as long as retention or longer', () => {
		for (const ms of [7 * DAY, 8 * DAY]) {
			expect(() => assertDisableBeforeRetention(ms, 7 * DAY)).toThrow(
				'WEBHOOK_DISABLE_AFTER_HOURS must be shorter than EVENT_RETENTION_DAYS'
			);
		}
	});
});
