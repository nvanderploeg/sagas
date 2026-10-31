import { and, count, eq, inArray, isNull, or } from 'drizzle-orm';
import type { Db, Handle } from '#lib/server/db/client.ts';
import { realms, users, webhooks } from '#lib/server/db/schema.ts';
import { visibleRealmIds } from '#lib/server/domain/access.ts';
import { DomainError } from '#lib/server/domain/errors.ts';
import { requireText } from '#lib/server/domain/validate.ts';
import { eventWindow } from '#lib/server/events/log.ts';
import { EVENT_TYPES } from '#lib/server/events/types.ts';
import {
	generateWebhookSecret,
	keyFingerprint,
	open,
	seal,
	sealedFingerprint,
	TamperedError,
	WrongKeyError
} from '#lib/server/auth/webhook-secrets.ts';
import type { AuthUser } from '#lib/server/auth/users.ts';
import { checkTargetUrl } from './safe-fetch.ts';

export type WebhookEnv = {
	key: Buffer | undefined;
	maxPerUser: number;
	max: number;
	allowPrivate: boolean;
	now: number;
};

export type WebhookRow = typeof webhooks.$inferSelect;

export type WebhookInfo = {
	id: number;
	ownerId: number;
	name: string;
	url: string;
	eventTypes: string[] | null;
	realmIds: number[] | null;
	status: WebhookRow['status'];
	statusReason: string | null;
	cursor: number;
	createdAt: Date;
	updatedAt: Date;
	failingSince: Date | null;
	nextAttemptAt: Date | null;
};

export type WebhookInput = {
	name: string;
	url: string;
	eventTypes?: string[] | null;
	realmIds?: number[] | null;
};

const ROTATION_OVERLAP_MS = 24 * 60 * 60 * 1000;

export function toInfo(row: WebhookRow): WebhookInfo {
	return {
		id: row.id,
		ownerId: row.ownerId,
		name: row.name,
		url: row.url,
		eventTypes: row.eventTypes === null ? null : (JSON.parse(row.eventTypes) as string[]),
		realmIds: row.realmIds === null ? null : (JSON.parse(row.realmIds) as number[]),
		status: row.status,
		statusReason: row.statusReason,
		cursor: row.cursor,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
		failingSince: row.failingSince,
		nextAttemptAt: row.nextAttemptAt
	};
}

function requireKey(env: WebhookEnv): Buffer {
	if (!env.key) throw new DomainError('invalid', 'webhooks need WEBHOOK_KEY');
	return env.key;
}

function sealedUnder(sealed: string, key: Buffer): boolean {
	try {
		return sealedFingerprint(sealed) === keyFingerprint(key);
	} catch (error) {
		if (error instanceof TamperedError) return false;
		throw error;
	}
}

function canSee(actor: AuthUser, ownerId: number): boolean {
	return actor.id === ownerId || actor.isAdmin;
}

function requireWebhook(db: Handle, actor: AuthUser, id: number): WebhookRow {
	const row = db.select().from(webhooks).where(eq(webhooks.id, id)).get();
	if (!row || !canSee(actor, row.ownerId)) throw new DomainError('not_found', 'Webhook not found');
	return row;
}

function checkUrl(url: string, env: WebhookEnv): string {
	const checked = checkTargetUrl(url, env.allowPrivate);
	if (!checked.ok) throw new DomainError('invalid', checked.error);
	return url;
}

function encodeEventTypes(types: string[] | null): string | null {
	if (types === null) return null;
	if (types.length === 0) throw new DomainError('invalid', 'eventTypes must not be empty');
	const known: readonly string[] = EVENT_TYPES;
	const unknown = types.filter((type) => !known.includes(type));
	if (unknown.length > 0) {
		throw new DomainError('invalid', `unknown event types: ${unknown.join(', ')}`);
	}
	return JSON.stringify([...new Set(types)]);
}

// A Realm the owner cannot see answers like one that does not exist. Ids already stored pass
// unchecked: a deleted Realm's id stays in the list.
function encodeRealmIds(
	db: Handle,
	ownerId: number,
	ids: number[] | null,
	stored: number[] = []
): string | null {
	if (ids === null) return null;
	if (ids.length === 0) throw new DomainError('invalid', 'realmIds must not be empty');
	const unique = [...new Set(ids)];
	if (!unique.every((id) => Number.isInteger(id))) {
		throw new DomainError('invalid', 'realmIds must be integers');
	}
	const added = unique.filter((id) => !stored.includes(id));
	const found = db.select({ id: realms.id }).from(realms).where(inArray(realms.id, added)).all();
	const visible = visibleRealmIds(db, { id: ownerId });
	const missing = added.filter(
		(id) => !found.some((row) => row.id === id) || (visible !== null && !visible.includes(id))
	);
	if (missing.length > 0) {
		throw new DomainError('invalid', `unknown realms: ${missing.join(', ')}`);
	}
	return JSON.stringify(unique);
}

function countWebhooks(db: Handle, ownerId?: number): number {
	return db
		.select({ n: count() })
		.from(webhooks)
		.where(ownerId === undefined ? undefined : eq(webhooks.ownerId, ownerId))
		.get()!.n;
}

export function createWebhook(
	db: Db,
	actor: AuthUser,
	input: WebhookInput,
	env: WebhookEnv
): { webhook: WebhookInfo; secret: string } {
	const key = requireKey(env);
	return db.transaction((tx) => {
		const name = requireText(input.name, 'Webhook name', 100);
		const url = checkUrl(input.url, env);
		const eventTypes = encodeEventTypes(input.eventTypes ?? null);
		const realmIds = encodeRealmIds(tx, actor.id, input.realmIds ?? null);
		const total = countWebhooks(tx);
		if (total >= env.max) {
			throw new DomainError('conflict', `the instance allows ${env.max} Webhooks`);
		}
		if (countWebhooks(tx, actor.id) >= env.maxPerUser) {
			throw new DomainError('conflict', `a User may own ${env.maxPerUser} Webhooks`);
		}
		const secret = generateWebhookSecret();
		const at = new Date(env.now);
		const row = tx
			.insert(webhooks)
			.values({
				ownerId: actor.id,
				name,
				url,
				eventTypes,
				realmIds,
				cursor: eventWindow(tx).last,
				secret: seal(secret, key),
				createdAt: at,
				updatedAt: at
			})
			.returning()
			.get();
		return { webhook: toInfo(row), secret };
	});
}

export function listWebhooks(
	db: Handle,
	actor: AuthUser,
	userId: number,
	env: WebhookEnv
): WebhookInfo[] {
	requireKey(env);
	if (!canSee(actor, userId) || !db.select().from(users).where(eq(users.id, userId)).get()) {
		throw new DomainError('not_found', 'User not found');
	}
	return db
		.select()
		.from(webhooks)
		.where(eq(webhooks.ownerId, userId))
		.orderBy(webhooks.id)
		.all()
		.map(toInfo);
}

export function getWebhook(db: Handle, actor: AuthUser, id: number, env: WebhookEnv): WebhookInfo {
	requireKey(env);
	return toInfo(requireWebhook(db, actor, id));
}

export function updateWebhook(
	db: Db,
	actor: AuthUser,
	id: number,
	patch: {
		name?: string;
		url?: string;
		eventTypes?: string[] | null;
		realmIds?: number[] | null;
		status?: 'active' | 'paused';
	},
	env: WebhookEnv
): WebhookInfo {
	const key = requireKey(env);
	return db.transaction((tx) => {
		const row = requireWebhook(tx, actor, id);
		const set: Partial<typeof webhooks.$inferInsert> = { updatedAt: new Date(env.now) };
		if (patch.name !== undefined) set.name = requireText(patch.name, 'Webhook name', 100);
		if (patch.url !== undefined) set.url = checkUrl(patch.url, env);
		if (patch.eventTypes !== undefined) set.eventTypes = encodeEventTypes(patch.eventTypes);
		if (patch.realmIds !== undefined) set.realmIds = encodeRealmIds(
				tx,
				row.ownerId,
				patch.realmIds,
				row.realmIds === null ? [] : (JSON.parse(row.realmIds) as number[])
			);
		if (patch.status !== undefined && patch.status !== 'active' && patch.status !== 'paused') {
			throw new DomainError('invalid', 'status must be active or paused');
		}
		if (patch.status === 'paused' && row.status === 'active') {
			set.status = 'paused';
			set.statusReason = null;
		} else if (patch.status === 'active' && row.status !== 'active') {
			if (!sealedUnder(row.secret, key)) {
				throw new DomainError('conflict', 'rotate the secret first');
			}
			set.status = 'active';
			set.statusReason = null;
			set.failingSince = null;
			set.attempts = 0;
			set.nextAttemptAt = new Date(env.now);
		}
		return toInfo(tx.update(webhooks).set(set).where(eq(webhooks.id, id)).returning().get());
	});
}

export function rotateWebhookSecret(
	db: Db,
	actor: AuthUser,
	id: number,
	env: WebhookEnv
): { secret: string } {
	const key = requireKey(env);
	return db.transaction((tx) => {
		const row = requireWebhook(tx, actor, id);
		const secret = generateWebhookSecret();
		const keep = sealedUnder(row.secret, key);
		tx.update(webhooks)
			.set({
				secret: seal(secret, key),
				previousSecret: keep ? row.secret : null,
				previousSecretExpiresAt: keep ? new Date(env.now + ROTATION_OVERLAP_MS) : null,
				updatedAt: new Date(env.now)
			})
			.where(eq(webhooks.id, id))
			.run();
		return { secret };
	});
}

export function deleteWebhook(db: Db, actor: AuthUser, id: number, env: WebhookEnv): void {
	requireKey(env);
	db.transaction((tx) => {
		requireWebhook(tx, actor, id);
		tx.delete(webhooks).where(eq(webhooks.id, id)).run();
	});
}

export function pauseKeyChanged(db: Db, env: WebhookEnv): number {
	const key = env.key;
	if (!key) return 0;
	return db.transaction((tx) => {
		const candidates = tx
			.select()
			.from(webhooks)
			.where(
				or(
					eq(webhooks.status, 'active'),
					and(eq(webhooks.status, 'paused'), isNull(webhooks.statusReason))
				)
			)
			.all()
			.filter((row) => !sealedUnder(row.secret, key));
		if (candidates.length === 0) return 0;
		tx.update(webhooks)
			.set({ status: 'paused', statusReason: 'key_changed', updatedAt: new Date(env.now) })
			.where(
				inArray(
					webhooks.id,
					candidates.map((row) => row.id)
				)
			)
			.run();
		return candidates.length;
	});
}

export function signingSecrets(row: WebhookRow, env: WebhookEnv): string[] {
	const key = requireKey(env);
	const secrets = [open(row.secret, key)];
	if (
		row.previousSecret !== null &&
		row.previousSecretExpiresAt !== null &&
		row.previousSecretExpiresAt.getTime() > env.now
	) {
		try {
			secrets.push(open(row.previousSecret, key));
		} catch (error) {
			if (!(error instanceof WrongKeyError || error instanceof TamperedError)) throw error;
		}
	}
	return secrets;
}
