import { accessEnforced, requireRealmRole } from '../domain/access.ts';
import { currentVia } from '#lib/server/auth/via.ts';
import { and, eq, sql, type SQL } from 'drizzle-orm';
import type { Db, Handle } from '../db/client.ts';
import { attributes, pulses } from '../db/schema.ts';
import { DomainError } from '../domain/errors.ts';
import { getLabour, getRealm, getUser } from '../domain/lookup.ts';
import { STATE_KEY } from '../domain/validate.ts';
import type { Actor } from '../domain/write.ts';
import { readRealmAgent, type TagsSpec } from './attributes.ts';
import { DAY_MS } from './survey/candidates.ts';

export type EvidenceInput = { href: string; label?: string | null } | { labour: number };
export type Evidence = { href: string; label: string | null } | { labour: number };

export type PulseInput = {
	key: string;
	amount: number;
	mood: number;
	note?: string;
	evidence?: EvidenceInput[];
	halfLifeDays?: number | null;
	ref?: string;
};

export type PulseView = {
	id: number;
	note: string;
	evidence: Evidence[];
	authorId: number;
	createdAt: Date;
	weight: number;
};

export type SentimentKey = {
	realmId: number;
	key: string;
	volume: number;
	mood: number;
	v: number;
	pulses: PulseView[];
};

export type SentimentView = {
	asOf: Date;
	keys: SentimentKey[];
	unfiled: {
		rawKey: string;
		volume: number;
		count: number;
		newest: { id: number; note: string };
	}[];
};

export type PulseStatus = 'filed' | 'unfiled' | 'skipped';

export const PULSES_MAX = 50;
export const AMOUNT_MAX = 10;
export const NOTE_MAX = 1000;
export const EVIDENCE_MAX = 10;
export const HREF_MAX = 500;
export const EVIDENCE_LABEL_MAX = 120;
export const REF_MAX = 200;
export const HALF_LIFE_MAX = 365;
export const LIMIT_DEFAULT = 3;
export const LIMIT_MAX = 20;
export const AFFINITY_LOUDNESS = 5;

const FADED = Math.log2(100);
const DAY = sql.raw(`${DAY_MS}.0`);

function invalid(message: string): never {
	throw new DomainError('invalid', message);
}

const anyOf = (ids: readonly number[]) =>
	sql`(SELECT value FROM json_each(${JSON.stringify(ids)}))`;

// The weight of the Pulse aliased `p` at `now`.
const weightOf = (now: Date) =>
	sql`(CASE WHEN p.half_life_days IS NULL THEN p.amount ELSE p.amount * pow(2, -max(0, (${now.getTime()} - p.created_at) / (p.half_life_days * ${DAY}))) END)`;

// A null `member` is a scale Attribute.
export const keyOf = (attributeId: number, member: string | null) =>
	`${attributeId}:${member ?? ''}`;

export type KeyTotal = { volume: number; mood: number };

// Whose Pulses a read covers: a Realm's Sentiment or a User's Affinity.
export type Owner = 'realm' | 'user';

const filedFor = (owner: Owner) =>
	owner === 'realm'
		? sql`p.attribute_id IS NOT NULL AND p.realm_id IS NOT NULL`
		: sql`p.attribute_id IS NOT NULL AND p.user_id IS NOT NULL`;

// Totals of the filed Pulses of `owner` matching `where`, over the Pulse aliased `p`. An Affinity
// total has a null `realmId`.
export function totalsOf(db: Handle, where: SQL, now: Date, owner: Owner = 'realm') {
	const rows = db.all<{
		realmId: number | null;
		attributeId: number;
		member: string | null;
		volume: number;
		moody: number;
	}>(sql`
		SELECT p.realm_id AS realmId, p.attribute_id AS attributeId, p.member AS member,
			sum(w) AS volume, sum(w * p.mood) AS moody
		FROM (SELECT *, ${weightOf(now)} AS w FROM pulses p) p
		WHERE ${filedFor(owner)} AND ${where}
		GROUP BY p.realm_id, p.attribute_id, p.member
	`);
	return rows.map((row) => ({
		realmId: row.realmId,
		attributeId: row.attributeId,
		member: row.member,
		volume: row.volume,
		mood: row.volume > 0 ? row.moody / row.volume : 0
	}));
}

type PulseRow = {
	id: number;
	attributeId: number;
	member: string | null;
	note: string;
	evidence: string;
	authorId: number;
	createdAt: number;
	weight: number;
};

// Ties go newest first.
function heaviestOf(db: Handle, where: SQL, limit: number, now: Date, owner: Owner) {
	const rows = db.all<PulseRow>(sql`
		SELECT id, attribute_id AS attributeId, member, note, evidence, author_id AS authorId,
			created_at AS createdAt, w AS weight
		FROM (
			SELECT p.*, ${weightOf(now)} AS w,
				row_number() OVER (
					PARTITION BY p.attribute_id, p.member
					ORDER BY ${weightOf(now)} DESC, p.created_at DESC, p.id DESC
				) AS rn
			FROM pulses p
			WHERE ${filedFor(owner)} AND ${where}
		)
		WHERE rn <= ${limit}
		ORDER BY attribute_id, member, rn
	`);
	const byKey = new Map<string, PulseRow[]>();
	for (const row of rows) {
		const key = keyOf(row.attributeId, row.member);
		const list = byKey.get(key);
		if (list === undefined) byKey.set(key, [row]);
		else list.push(row);
	}
	return byKey;
}

function liveLabours(db: Handle, ids: number[]): Set<number> {
	if (ids.length === 0) return new Set();
	const rows = db.all<{ id: number }>(
		sql`SELECT id FROM labours WHERE id IN (SELECT value FROM json_each(${JSON.stringify(ids)}))`
	);
	return new Set(rows.map((row) => row.id));
}

// Evidence naming a deleted Labour is left out.
function viewPulses(db: Handle, rows: PulseRow[]): Map<number, PulseView> {
	const parsed = rows.map((row) => ({ row, evidence: JSON.parse(row.evidence) as Evidence[] }));
	const named = new Set<number>();
	for (const { evidence } of parsed) {
		for (const item of evidence) if ('labour' in item) named.add(item.labour);
	}
	const live = liveLabours(db, [...named]);
	return new Map(
		parsed.map(({ row, evidence }) => [
			row.id,
			{
				id: row.id,
				note: row.note,
				evidence: evidence.filter((item) => !('labour' in item) || live.has(item.labour)),
				authorId: row.authorId,
				createdAt: new Date(row.createdAt),
				weight: row.weight
			}
		])
	);
}

export function heaviestPulses(
	db: Handle,
	where: SQL,
	limit: number,
	now: Date,
	owner: Owner = 'realm'
): Map<string, PulseView[]> {
	const byKey = heaviestOf(db, where, limit, now, owner);
	const views = viewPulses(db, [...byKey.values()].flat());
	return new Map([...byKey].map(([key, list]) => [key, list.map((row) => views.get(row.id)!)]));
}

export const inRealms = (realmIds: number[]) => sql`p.realm_id IN ${anyOf(realmIds)}`;
export const inAttributes = (attributeIds: number[]) =>
	sql`p.attribute_id IN ${anyOf(attributeIds)}`;
export const inKeys = (keys: { attributeId: number; member: string | null }[]) =>
	sql`EXISTS (
		SELECT 1 FROM json_each(${JSON.stringify(keys.map((k) => ({ a: k.attributeId, m: k.member })))}) k
		WHERE json_extract(k.value, '$.a') = p.attribute_id AND json_extract(k.value, '$.m') IS p.member
	)`;

function parseKey(
	raw: unknown,
	what = 'A Pulse key'
): { rawKey: string; attr: string; member?: string } {
	if (typeof raw !== 'string') invalid(`${what} must be text`);
	const rawKey = raw.trim().toLowerCase();
	const parts = rawKey.split(':');
	if (parts.length > 2 || parts.some((part) => !STATE_KEY.test(part))) {
		invalid(`${what} must be an Attribute key, or an Attribute key and a member as attr:member`);
	}
	return { rawKey, attr: parts[0], member: parts[1] };
}

type Filing = { attributeId: number; member: string | null };

// The Attribute and member a key names in the Realm, when it files.
function filingOf(db: Handle, realmId: number, key: { attr: string; member?: string }) {
	const row = db
		.select({ id: attributes.id, kind: attributes.kind, spec: attributes.spec })
		.from(attributes)
		.where(and(eq(attributes.realmId, realmId), eq(attributes.key, key.attr)))
		.get();
	if (row === undefined) return null;
	if (key.member === undefined) {
		return row.kind === 'scale' ? { attributeId: row.id, member: null } : null;
	}
	if (row.kind !== 'tags') return null;
	const known = (row.spec as TagsSpec).members.some((member) => member.key === key.member);
	return known ? { attributeId: row.id, member: key.member } : null;
}

function checkNumber(value: unknown, what: string): number {
	if (typeof value !== 'number' || !Number.isFinite(value)) invalid(`${what} must be a number`);
	return value;
}

type Checked = {
	rawKey: string;
	attr: string;
	member?: string;
	amount: number;
	mood: number;
	note: string;
	evidence: Evidence[];
	halfLifeDays: number | null | undefined;
	ref: string | null;
};

function checkItem(item: PulseInput, at: number): Checked {
	const where = `Pulse ${at + 1}`;
	if (item === null || typeof item !== 'object') invalid(`${where} must be an object`);
	const key = parseKey(item.key, `${where} key`);

	const amount = checkNumber(item.amount, `${where} amount`);
	if (!(amount > 0 && amount <= AMOUNT_MAX)) {
		invalid(`${where} amount must be more than 0 and at most ${AMOUNT_MAX}`);
	}
	const mood = checkNumber(item.mood, `${where} mood`);
	if (!(mood >= -1 && mood <= 1)) invalid(`${where} mood must be from -1 to 1`);

	if (item.note !== undefined && typeof item.note !== 'string')
		invalid(`${where} note must be text`);
	const note = (item.note ?? '').trim();
	if (note.length > NOTE_MAX) invalid(`${where} note must be at most ${NOTE_MAX} characters`);

	let halfLifeDays: number | null | undefined = item.halfLifeDays;
	if (halfLifeDays !== undefined && halfLifeDays !== null) {
		const days = checkNumber(halfLifeDays, `${where} half-life`);
		if (!(days > 0 && days <= HALF_LIFE_MAX)) {
			invalid(`${where} half-life must be more than 0 and at most ${HALF_LIFE_MAX} days`);
		}
		halfLifeDays = days;
	}

	let ref: string | null = null;
	if (item.ref !== undefined) {
		if (typeof item.ref !== 'string') invalid(`${where} ref must be text`);
		ref = item.ref.trim();
		if (ref.length < 1 || ref.length > REF_MAX) {
			invalid(`${where} ref must be 1 to ${REF_MAX} characters`);
		}
	}

	return {
		...key,
		amount,
		mood,
		note,
		evidence: checkEvidence(item.evidence, where),
		halfLifeDays,
		ref
	};
}

function checkEvidence(raw: EvidenceInput[] | undefined, where: string): Evidence[] {
	if (raw === undefined) return [];
	if (!Array.isArray(raw)) invalid(`${where} evidence must be an array`);
	if (raw.length > EVIDENCE_MAX) invalid(`${where} carries at most ${EVIDENCE_MAX} evidence items`);
	return raw.map((entry): Evidence => {
		if (entry === null || typeof entry !== 'object') invalid(`${where} evidence must be objects`);
		const hasLabour = 'labour' in entry && entry.labour !== undefined;
		const hasHref = 'href' in entry && entry.href !== undefined;
		if (hasLabour === hasHref) invalid(`${where} evidence needs exactly one of href and labour`);
		if (hasLabour) {
			const { labour } = entry as { labour: unknown };
			if (typeof labour !== 'number' || !Number.isInteger(labour) || labour < 1) {
				invalid(`${where} evidence labour must be a Labour id`);
			}
			return { labour };
		}
		const { href, label } = entry as { href: unknown; label?: unknown };
		if (typeof href !== 'string') invalid(`${where} evidence href must be text`);
		const trimmed = href.trim();
		if (trimmed.length < 1 || trimmed.length > HREF_MAX) {
			invalid(`${where} evidence href must be 1 to ${HREF_MAX} characters`);
		}
		if (label != null && typeof label !== 'string') invalid(`${where} evidence label must be text`);
		const text = (label ?? '').trim();
		if (text.length > EVIDENCE_LABEL_MAX) {
			invalid(`${where} evidence label must be at most ${EVIDENCE_LABEL_MAX} characters`);
		}
		return { href: trimmed, label: text === '' ? null : text };
	});
}

export function postPulses(
	db: Db,
	actor: Actor,
	realmId: number,
	items: PulseInput[],
	now: Date = new Date()
): { index: number; status: PulseStatus; id: number }[] {
	if (!Array.isArray(items) || items.length < 1 || items.length > PULSES_MAX) {
		invalid(`Post 1 to ${PULSES_MAX} Pulses at a time`);
	}
	return db.transaction((tx) => {
		getRealm(tx, realmId);
		requireRealmRole(tx, actor, realmId, 'editor');
		const checked = items.map(checkItem);
		const named = new Set(
			checked.flatMap((item) => item.evidence.flatMap((e) => ('labour' in e ? [e.labour] : [])))
		);
		for (const id of named) getLabour(tx, id);
		const defaultHalfLife = readRealmAgent(tx, realmId).halfLifeDays;

		return checked.map((item, index) => {
			if (item.ref !== null) {
				const earlier = tx
					.select({ id: pulses.id })
					.from(pulses)
					.where(
						and(
							eq(pulses.authorId, actor.id),
							eq(pulses.ref, item.ref),
							eq(pulses.rawKey, item.rawKey)
						)
					)
					.get();
				if (earlier !== undefined) return { index, status: 'skipped' as const, id: earlier.id };
			}
			const filing: Filing | null = filingOf(tx, realmId, item);
			const { id } = tx
				.insert(pulses)
				.values({
					realmId,
					attributeId: filing?.attributeId ?? null,
					member: filing?.member ?? null,
					rawKey: item.rawKey,
					amount: item.amount,
					mood: item.mood,
					halfLifeDays: item.halfLifeDays === undefined ? defaultHalfLife : item.halfLifeDays,
					note: item.note,
					evidence: item.evidence,
					ref: item.ref,
					authorId: actor.id,
					via: currentVia(),
					createdAt: now
				})
				.returning({ id: pulses.id })
				.get();
			return { index, status: filing === null ? ('unfiled' as const) : ('filed' as const), id };
		});
	});
}

function limitOf(given: number | undefined): number {
	const limit = given ?? LIMIT_DEFAULT;
	if (!Number.isInteger(limit) || limit < 1 || limit > LIMIT_MAX) {
		invalid(`limit must be an integer from 1 to ${LIMIT_MAX}`);
	}
	return limit;
}

const byVolume = (a: SentimentKey, b: SentimentKey) =>
	b.volume - a.volume || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0) || a.realmId - b.realmId;

export function readSentiment(
	db: Handle,
	realmId: number,
	opts: { limit?: number; now?: Date } = {}
): SentimentView {
	const now = opts.now ?? new Date();
	const limit = limitOf(opts.limit);
	getRealm(db, realmId);
	const { loudness } = readRealmAgent(db, realmId);

	const names = new Map(
		db
			.select({ id: attributes.id, key: attributes.key })
			.from(attributes)
			.where(eq(attributes.realmId, realmId))
			.all()
			.map((row) => [row.id, row.key])
	);
	const where = sql`p.realm_id = ${realmId}`;
	const listed = heaviestPulses(db, where, limit, now);
	const keys = totalsOf(db, where, now)
		.filter((total) => names.has(total.attributeId))
		.map((total): SentimentKey => {
			const attr = names.get(total.attributeId)!;
			return {
				realmId,
				key: total.member === null ? attr : `${attr}:${total.member}`,
				volume: total.volume,
				mood: total.mood,
				v: total.volume / (total.volume + loudness),
				pulses: listed.get(keyOf(total.attributeId, total.member)) ?? []
			};
		})
		.sort(byVolume);

	return { asOf: now, keys, unfiled: readUnfiled(db, realmId, now) };
}

export function readAffinity(
	db: Handle,
	userId: number,
	opts: { limit?: number; now?: Date } = {}
): SentimentView {
	const now = opts.now ?? new Date();
	const limit = limitOf(opts.limit);
	getUser(db, userId);

	const where = sql`p.user_id = ${userId}`;
	const names = new Map(
		db
			.select({ id: attributes.id, key: attributes.key, realmId: attributes.realmId })
			.from(attributes)
			.where(
				sql`${attributes.id} IN (SELECT DISTINCT attribute_id FROM pulses WHERE user_id = ${userId})`
			)
			.all()
			.map((row) => [row.id, row])
	);
	const listed = heaviestPulses(db, where, limit, now, 'user');
	const keys = totalsOf(db, where, now, 'user')
		.filter((total) => names.has(total.attributeId))
		.map((total): SentimentKey => {
			const attribute = names.get(total.attributeId)!;
			return {
				realmId: attribute.realmId,
				key: total.member === null ? attribute.key : `${attribute.key}:${total.member}`,
				volume: total.volume,
				mood: total.mood,
				v: total.volume / (total.volume + AFFINITY_LOUDNESS),
				pulses: listed.get(keyOf(total.attributeId, total.member)) ?? []
			};
		})
		.sort(byVolume);

	return { asOf: now, keys, unfiled: [] };
}

function readUnfiled(db: Handle, realmId: number, now: Date): SentimentView['unfiled'] {
	const rows = db.all<{
		rawKey: string;
		volume: number;
		count: number;
		id: number;
		note: string;
	}>(sql`
		SELECT t.raw_key AS rawKey, t.volume AS volume, t.cnt AS count, n.id AS id, n.note AS note
		FROM (
			SELECT p.raw_key, sum(${weightOf(now)}) AS volume, count(*) AS cnt
			FROM pulses p
			WHERE p.realm_id = ${realmId} AND p.attribute_id IS NULL
			GROUP BY p.raw_key
		) t
		JOIN pulses n ON n.id = (
			SELECT id FROM pulses
			WHERE realm_id = ${realmId} AND attribute_id IS NULL AND raw_key = t.raw_key
			ORDER BY created_at DESC, id DESC LIMIT 1
		)
	`);
	return rows
		.map((row) => ({
			rawKey: row.rawKey,
			volume: row.volume,
			count: row.count,
			newest: { id: row.id, note: row.note }
		}))
		.sort(
			(a, b) => b.volume - a.volume || (a.rawKey < b.rawKey ? -1 : a.rawKey > b.rawKey ? 1 : 0)
		);
}

export function filePulses(
	db: Db,
	actor: Actor,
	realmId: number,
	rawKey: string,
	key: string
): number {
	return db.transaction((tx) => {
		getRealm(tx, realmId);
		requireRealmRole(tx, actor, realmId, 'editor');
		const from = parseKey(rawKey, 'raw_key');
		const to = parseKey(key);
		const target = filingOf(tx, realmId, to);
		if (target === null) invalid(`"${to.rawKey}" is not a key of this Realm`);
		const source = filingOf(tx, realmId, from);

		const filedUnderSource =
			source === null
				? sql`0`
				: sql`(attribute_id = ${source.attributeId} AND member IS ${source.member})`;
		return tx.run(sql`
			UPDATE pulses SET attribute_id = ${target.attributeId}, member = ${target.member}
			WHERE realm_id = ${realmId}
				AND ((attribute_id IS NULL AND raw_key = ${from.rawKey}) OR ${filedUnderSource})
				AND NOT (attribute_id IS ${target.attributeId} AND member IS ${target.member})
		`).changes;
	});
}

export function deletePulse(db: Db, actor: Actor, pulseId: number): void {
	const pulse = db
		.select({ realmId: pulses.realmId, userId: pulses.userId })
		.from(pulses)
		.where(eq(pulses.id, pulseId))
		.get();
	if (pulse === undefined) throw new DomainError('not_found', 'Pulse not found');
	// A Realm's Pulses take an editor; an Affinity Pulse belongs to its User alone.
	if (pulse.realmId !== null) requireRealmRole(db, actor, pulse.realmId, 'editor');
	else if (accessEnforced() && pulse.userId !== actor.id) {
		throw new DomainError('not_found', 'Pulse not found');
	}
	db.delete(pulses).where(eq(pulses.id, pulseId)).run();
}

export function prunePulses(db: Handle, now = Date.now()): number {
	return db.run(sql`
		DELETE FROM pulses
		WHERE half_life_days IS NOT NULL
			AND created_at < ${now} - half_life_days * ${DAY} * ${FADED}
	`).changes;
}
