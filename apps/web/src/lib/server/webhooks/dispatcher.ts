import { and, desc, eq, inArray } from 'drizzle-orm';
import type { Db, Handle } from '#lib/server/db/client.ts';
import { webhookDeliveries, webhooks } from '#lib/server/db/schema.ts';
import { subscribe } from '#lib/server/events/bus.ts';
import { canReplayFrom, eventRealmIds, eventsSince, eventWindow } from '#lib/server/events/log.ts';
import type { SagasEvent } from '#lib/server/events/types.ts';
import { eventForViewer } from '#lib/server/events/visibility.ts';
import { recordDelivery } from './deliveries.ts';
import type { SafeFetchInput, SafeFetchResult } from './safe-fetch.ts';
import { signedHeaders, webhookMessageId, type DeliveryKind } from './sign.ts';
import { signingSecrets, toInfo, type WebhookEnv, type WebhookRow } from './store.ts';
import { transact } from '#lib/server/db/tx.ts';

export type Dispatcher = {
	start(): void;
	stop(): void;
	// Does nothing while stopped.
	wake(): void;
	nudge(webhookId: number): Promise<void>;
	// Resolves when no pass or Delivery is running; a retry waiting on the timer does not count.
	drain(): Promise<void>;
};

export type DispatcherDeps = {
	env: Pick<WebhookEnv, 'key' | 'allowPrivate'>;
	concurrency: number;
	disableAfterMs: number;
	now: () => number;
	random: () => number;
	fetch: (input: SafeFetchInput, allowPrivate: boolean) => Promise<SafeFetchResult>;
	setTimer?: typeof setTimeout;
	clearTimer?: typeof clearTimeout;
};

const PAGE = 500;
const SCAN_PAGES = 20;
const MAX_EVENTS = 100;
const MAX_BODY_BYTES = 256 * 1024;
const BACKOFF_BASE_MS = 30_000;
const BACKOFF_CAP_MS = 60 * 60 * 1000;
const BROKEN_COOLDOWN_MS = 30_000;
const MAX_TIMER_MS = 2 ** 31 - 1;

type Held = { kind: 'events'; firstSeq: number; lastSeq: number } | { kind: 'reset'; seq: number };

type Prepared =
	| { kind: 'skip'; cursor: number }
	| { kind: 'send'; delivery: DeliveryKind; body: string; cursor: number };

const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

export function assertDisableBeforeRetention(disableAfterMs: number, retentionMs: number): void {
	if (disableAfterMs >= retentionMs) {
		throw new Error('WEBHOOK_DISABLE_AFTER_HOURS must be shorter than EVENT_RETENTION_DAYS');
	}
}

// What a failed attempt past the cursor sent, read from the log so a restart retries it
// unchanged: same Events, same webhook-id (docs/webhooks.md, "Retries and disabling").
async function held(db: Handle, row: WebhookRow): Promise<Held | undefined> {
	const last = (
		await db
			.select()
			.from(webhookDeliveries)
			.where(
				and(
					eq(webhookDeliveries.webhookId, row.id),
					inArray(webhookDeliveries.kind, ['events', 'reset'])
				)
			)
			.orderBy(desc(webhookDeliveries.id))
			.limit(1)
	)[0];
	if (!last || last.error === null || last.lastSeq === null || last.lastSeq <= row.cursor) {
		return undefined;
	}
	return last.kind === 'reset'
		? { kind: 'reset', seq: last.lastSeq }
		: { kind: 'events', firstSeq: last.firstSeq ?? last.lastSeq, lastSeq: last.lastSeq };
}

// Test eventTypes against the Event as the Owner is shown it, and realmIds against the
// Realms the logged Event touches (docs/webhooks.md, "Subscribing").
async function shownTo(
	db: Handle,
	hook: ReturnType<typeof toInfo>,
	event: SagasEvent
): Promise<SagasEvent | null> {
	const wanted = hook.realmIds;
	if (wanted !== null && !(await eventRealmIds(db, event.seq)).some((id) => wanted.includes(id))) {
		return null;
	}
	const shown = await eventForViewer(db, event, { id: hook.ownerId });
	if (shown === null) return null;
	return hook.eventTypes === null || hook.eventTypes.includes(shown.type) ? shown : null;
}

// The cursor moves to `examined` on success, past trailing Events that did not match.
async function collect(
	db: Handle,
	row: WebhookRow,
	bound: number | undefined
): Promise<{ events: SagasEvent[]; examined: number; body: string }> {
	const hook = toInfo(row);
	const webhook = { id: row.id, name: row.name };
	const batch: SagasEvent[] = [];
	let bytes = Buffer.byteLength(JSON.stringify({ webhook, events: [] }));
	let examined = row.cursor;
	const finish = () => ({
		events: batch,
		examined,
		body: JSON.stringify({ webhook, events: batch })
	});
	for (let page = 0; page < SCAN_PAGES; page++) {
		const events = await eventsSince(db, examined, PAGE);
		for (const event of events) {
			if (bound !== undefined && event.seq > bound) return finish();
			const shown = await shownTo(db, hook, event);
			if (shown !== null) {
				const size = Buffer.byteLength(JSON.stringify(shown)) + (batch.length > 0 ? 1 : 0);
				if (batch.length >= MAX_EVENTS || (batch.length > 0 && bytes + size > MAX_BODY_BYTES)) {
					return finish();
				}
				batch.push(shown);
				bytes += size;
			}
			examined = event.seq;
		}
		if (events.length < PAGE) break;
	}
	return finish();
}

export function createDispatcher(db: Db, deps: DispatcherDeps): Dispatcher {
	const setTimer = deps.setTimer ?? setTimeout;
	const clearTimer = deps.clearTimer ?? clearTimeout;
	const running = new Map<number, Promise<void>>();
	const lastTurn = new Map<number, number>();
	const brokenUntil = new Map<number, number>();
	const nudged = new Set<number>();
	let turn = 0;
	let started = false;
	let scheduled: Promise<void> | null = null;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let armedAt = Infinity;
	let unsubscribe: (() => void) | null = null;

	function signEnv(): WebhookEnv {
		return { ...deps.env, maxPerUser: 0, max: 0, now: deps.now() };
	}

	async function prepare(row: WebhookRow): Promise<Prepared | null> {
		const window = await eventWindow(db);
		if (row.cursor >= window.last) return null;
		const last = await held(db, row);
		const webhook = { id: row.id, name: row.name };
		if (!canReplayFrom(window, row.cursor)) {
			const seq = last?.kind === 'reset' ? last.seq : window.last;
			return {
				kind: 'send',
				delivery: { kind: 'reset', webhookId: row.id, seq },
				body: JSON.stringify({ webhook, reset: { seq } }),
				cursor: seq
			};
		}
		const bound = last?.kind === 'events' ? last.lastSeq : undefined;
		const batch = await collect(db, row, bound);
		if (batch.events.length === 0) {
			return batch.examined > row.cursor ? { kind: 'skip', cursor: batch.examined } : null;
		}
		const firstSeq = batch.events[0]!.seq;
		const lastSeq = batch.events[batch.events.length - 1]!.seq;
		return {
			kind: 'send',
			delivery: { kind: 'events', webhookId: row.id, firstSeq, lastSeq },
			body: batch.body,
			cursor: batch.examined
		};
	}

	async function settle(
		row: WebhookRow,
		prepared: Extract<Prepared, { kind: 'send' }>,
		attemptedAt: number,
		result: SafeFetchResult
	): Promise<void> {
		const { delivery } = prepared;
		await transact(db, async (tx) => {
			const current = (await tx.select().from(webhooks).where(eq(webhooks.id, row.id)).limit(1))[0];
			if (!current) return;
			await recordDelivery(tx, {
				webhookId: row.id,
				attemptedAt,
				messageId: webhookMessageId(delivery),
				kind: delivery.kind === 'reset' ? 'reset' : 'events',
				firstSeq: delivery.kind === 'events' ? delivery.firstSeq : prepared.cursor,
				lastSeq: delivery.kind === 'events' ? delivery.lastSeq : prepared.cursor,
				status: result.status,
				error: result.ok ? null : result.error,
				durationMs: Math.round(result.durationMs),
				responseBody: result.body === '' ? null : result.body
			});
			if (result.ok) {
				if (current.cursor !== row.cursor) return;
				await tx
					.update(webhooks)
					.set({ cursor: prepared.cursor, failingSince: null, attempts: 0, nextAttemptAt: null })
					.where(eq(webhooks.id, row.id));
				return;
			}
			if (current.status !== 'active') return;
			const now = deps.now();
			const failingSince = current.failingSince?.getTime() ?? now;
			const attempts = current.attempts + 1;
			if (now - failingSince >= deps.disableAfterMs) {
				await tx
					.update(webhooks)
					.set({
						status: 'disabled',
						statusReason: 'failing',
						failingSince: new Date(failingSince),
						attempts,
						nextAttemptAt: null
					})
					.where(eq(webhooks.id, row.id));
				return;
			}
			const wait =
				deps.random() * Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** current.attempts);
			await tx
				.update(webhooks)
				.set({
					failingSince: new Date(failingSince),
					attempts,
					nextAttemptAt: new Date(nudged.has(row.id) ? now : now + wait)
				})
				.where(eq(webhooks.id, row.id));
		});
	}

	async function deliver(id: number): Promise<void> {
		// Prepare on a turn of its own: one pass must not run every launched Webhook's scan back
		// to back.
		await nextTurn();
		if (!started) return;
		const row = (await db.select().from(webhooks).where(eq(webhooks.id, id)).limit(1))[0];
		if (!row || row.status !== 'active') return;
		const prepared = await prepare(row);
		if (prepared === null) return;
		if (prepared.kind === 'skip') {
			await db
				.update(webhooks)
				.set({ cursor: prepared.cursor, failingSince: null, attempts: 0, nextAttemptAt: null })
				.where(eq(webhooks.id, id));
			return;
		}
		const attemptedAt = deps.now();
		let result: SafeFetchResult;
		try {
			const secrets = signingSecrets(row, signEnv());
			const headers = signedHeaders(prepared.delivery, prepared.body, secrets, attemptedAt);
			result = await deps.fetch(
				{ url: row.url, headers, body: prepared.body },
				deps.env.allowPrivate
			);
		} catch (error) {
			result = {
				ok: false,
				status: null,
				durationMs: deps.now() - attemptedAt,
				body: '',
				error: error instanceof Error ? error.message : String(error)
			};
		}
		await settle(row, prepared, attemptedAt, result);
	}

	function launch(id: number): void {
		lastTurn.set(id, ++turn);
		const task = deliver(id)
			.catch((error: unknown) => {
				console.error(`sagas Webhook ${id} delivery failed`, error);
				brokenUntil.set(id, deps.now() + BROKEN_COOLDOWN_MS);
			})
			.finally(() => {
				running.delete(id);
				nudged.delete(id);
				wake();
			});
		running.set(id, task);
	}

	function disarm(): void {
		if (timer !== undefined) clearTimer(timer);
		timer = undefined;
		armedAt = Infinity;
	}

	function arm(at: number, now: number): void {
		disarm();
		if (at === Infinity) return;
		armedAt = at;
		timer = setTimer(
			() => {
				timer = undefined;
				armedAt = Infinity;
				wake();
			},
			Math.min(MAX_TIMER_MS, Math.max(0, at - now))
		);
		(timer as { unref?: () => void }).unref?.();
	}

	async function pass(): Promise<void> {
		const now = deps.now();
		const last = (await eventWindow(db)).last;
		const rows = await db
			.select({
				id: webhooks.id,
				status: webhooks.status,
				cursor: webhooks.cursor,
				nextAttemptAt: webhooks.nextAttemptAt
			})
			.from(webhooks);
		const present = new Set(rows.map((row) => row.id));
		for (const id of lastTurn.keys()) if (!present.has(id)) lastTurn.delete(id);
		for (const id of brokenUntil.keys()) if (!present.has(id)) brokenUntil.delete(id);
		let earliest = Infinity;
		const due: number[] = [];
		for (const row of rows) {
			if (row.status !== 'active' || running.has(row.id) || row.cursor >= last) continue;
			const at = Math.max(row.nextAttemptAt?.getTime() ?? 0, brokenUntil.get(row.id) ?? 0);
			if (at > now) earliest = Math.min(earliest, at);
			else due.push(row.id);
		}
		due.sort((a, b) => (lastTurn.get(a) ?? 0) - (lastTurn.get(b) ?? 0));
		for (const id of due) {
			if (running.size >= deps.concurrency) break;
			launch(id);
		}
		arm(earliest, now);
	}

	// A wake during a pass asks for another once it ends; drain() waits through both.
	let again = false;

	function wake(): void {
		if (!started) return;
		if (scheduled !== null) {
			again = true;
			return;
		}
		scheduled = new Promise((resolve) => {
			setImmediate(async () => {
				try {
					do {
						again = false;
						if (started) await pass();
					} while (again && started);
				} catch (error) {
					console.error('sagas Webhook dispatch failed', error);
					const now = deps.now();
					arm(Math.min(armedAt, now + BROKEN_COOLDOWN_MS), now);
				} finally {
					scheduled = null;
					resolve();
				}
			});
		});
	}

	return {
		start() {
			if (started) return;
			started = true;
			unsubscribe = subscribe(() => wake());
			wake();
		},
		stop() {
			started = false;
			unsubscribe?.();
			unsubscribe = null;
			disarm();
		},
		wake,
		async nudge(webhookId) {
			brokenUntil.delete(webhookId);
			if (running.has(webhookId)) nudged.add(webhookId);
			await db
				.update(webhooks)
				.set({ nextAttemptAt: new Date(deps.now()) })
				.where(and(eq(webhooks.id, webhookId), eq(webhooks.status, 'active')));
			wake();
		},
		async drain() {
			while (scheduled !== null || running.size > 0) {
				await Promise.all([scheduled, ...running.values()]);
			}
		}
	};
}
