import { requireRealmRole } from '../domain/access.ts';
import { currentVia } from '#lib/server/auth/via.ts';
import { and, asc, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import type { Db, Handle } from '../db/client.ts';
import { attributes, labourAttributes, pulses, realmAgent } from '../db/schema.ts';
import { DomainError } from '../domain/errors.ts';
import { getLabour, getRealm } from '../domain/lookup.ts';
import { placeAt, writePositions } from '../domain/positions.ts';
import { requireMatch, requireText, STATE_KEY } from '../domain/validate.ts';
import type { Actor } from '../domain/write.ts';
import { refreshLabourText } from './search.ts';

export type AttributeKind = 'scale' | 'tags' | 'text';
export type Member = { key: string; label: string; rubric: string };
export type ScaleSpec = { min: number; max: number };
export type TagsSpec = { members: Member[]; max: number | null };
export type TextSpec = { max: number };
export type Spec = ScaleSpec | TagsSpec | TextSpec;
export type SpecInput = {
	min?: number;
	max?: number | null;
	members?: { key: string; label: string; rubric?: string }[];
};

export type AttributeInput = {
	key: string;
	kind: AttributeKind;
	label?: string;
	rubric?: string;
	spec?: SpecInput;
	index?: number;
};

export type AttributeView = {
	id: number;
	key: string;
	kind: AttributeKind;
	label: string;
	rubric: string;
	spec: Spec;
	position: number;
	createdAt: Date;
	revisedAt: Date;
	updatedAt: Date;
	held: number;
	stale: number;
	counts: Record<string, number>;
};

export type RealmAgentView = {
	version: number;
	notes: string;
	halfLifeDays: number;
	loudness: number;
};

export type ValueView = {
	key: string;
	kind: AttributeKind;
	value: number | string[] | string;
	setBy: number;
	via: string | null;
	setAt: Date;
	stale: boolean;
};

type Value = number | string[] | string;
type AttributeRow = typeof attributes.$inferSelect;

export const ATTRIBUTES_MAX = 32;
export const NOTES_MAX = 4000;
export const LOUDNESS_MAX = 1000;
export const DEFAULT_HALF_LIFE_DAYS = 14;
export const DEFAULT_LOUDNESS = 5;

const KINDS: readonly AttributeKind[] = ['scale', 'tags', 'text'];
export const RESERVED = new Set([
	'rank',
	'priority',
	'similarity',
	'keywords',
	'sentiment',
	'pain',
	'delight',
	'affinity',
	'skill_fit',
	'mentions',
	'pulled_in',
	'evidence',
	'unblocks',
	'quest_finish',
	'column',
	'age',
	'activity'
]);

const specOf = (row: AttributeRow) => row.spec as Spec;

export function readRealmAgent(db: Handle, realmId: number): RealmAgentView {
	getRealm(db, realmId);
	const row = db.select().from(realmAgent).where(eq(realmAgent.realmId, realmId)).get();
	if (row === undefined) {
		return {
			version: 0,
			notes: '',
			halfLifeDays: DEFAULT_HALF_LIFE_DAYS,
			loudness: DEFAULT_LOUDNESS
		};
	}
	return {
		version: row.version,
		notes: row.notes,
		halfLifeDays: row.halfLifeDays,
		loudness: row.loudness
	};
}

function attributeRows(db: Handle, realmId: number): AttributeRow[] {
	return db
		.select()
		.from(attributes)
		.where(eq(attributes.realmId, realmId))
		.orderBy(asc(attributes.position))
		.all();
}

export function readAttributes(db: Handle, realmId: number): AttributeView[] {
	const rows = attributeRows(db, realmId);
	const held = db
		.select({
			attributeId: labourAttributes.attributeId,
			value: labourAttributes.value,
			setAt: labourAttributes.setAt
		})
		.from(labourAttributes)
		.where(eq(labourAttributes.realmId, realmId))
		.all();

	return rows.map((row) => {
		const spec = specOf(row);
		const counts: Record<string, number> = {};
		if (row.kind === 'tags') {
			for (const member of (spec as TagsSpec).members) counts[member.key] = 0;
		}
		let total = 0;
		let stale = 0;
		for (const entry of held) {
			if (entry.attributeId !== row.id) continue;
			total += 1;
			if (entry.setAt < row.revisedAt) stale += 1;
			if (row.kind === 'scale') {
				const bucket = String(entry.value);
				counts[bucket] = (counts[bucket] ?? 0) + 1;
			} else if (row.kind === 'tags') {
				for (const key of entry.value as string[]) counts[key] = (counts[key] ?? 0) + 1;
			}
		}
		return {
			id: row.id,
			key: row.key,
			kind: row.kind,
			label: row.label,
			rubric: row.rubric,
			spec,
			position: row.position,
			createdAt: row.createdAt,
			revisedAt: row.revisedAt,
			updatedAt: row.updatedAt,
			held: total,
			stale,
			counts
		};
	});
}

export function readValues(db: Handle, labourId: number): ValueView[] {
	return db
		.select({
			key: attributes.key,
			kind: attributes.kind,
			value: labourAttributes.value,
			setBy: labourAttributes.setBy,
			via: labourAttributes.via,
			setAt: labourAttributes.setAt,
			revisedAt: attributes.revisedAt
		})
		.from(labourAttributes)
		.innerJoin(attributes, eq(attributes.id, labourAttributes.attributeId))
		.where(eq(labourAttributes.labourId, labourId))
		.orderBy(asc(attributes.position))
		.all()
		.map((row) => ({
			key: row.key,
			kind: row.kind,
			value: row.value as Value,
			setBy: row.setBy,
			via: row.via,
			setAt: row.setAt,
			stale: row.setAt < row.revisedAt
		}));
}

// Each Realm rises by one, however many times it is listed.
export function bumpRealms(tx: Handle, realmIds: Iterable<number>, now: Date): void {
	for (const realmId of new Set(realmIds)) {
		tx.insert(realmAgent)
			.values({ realmId, version: 1, updatedAt: now })
			.onConflictDoUpdate({
				target: realmAgent.realmId,
				set: { version: sql`${realmAgent.version} + 1`, updatedAt: now }
			})
			.run();
	}
}

function intIn(value: unknown, min: number, max: number): value is number {
	return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}

function invalid(message: string): never {
	throw new DomainError('invalid', message);
}

function normalizeSpec(kind: AttributeKind, input: SpecInput | undefined, base: Spec | undefined) {
	const given = Object.fromEntries(
		Object.entries(input ?? {}).filter(([, value]) => value !== undefined)
	);
	const allowed = { scale: ['min', 'max'], tags: ['members', 'max'], text: ['max'] }[kind];
	for (const field of Object.keys(given)) {
		if (!allowed.includes(field)) invalid(`A ${kind} Attribute's spec has no "${field}"`);
	}
	const merged: Record<string, unknown> = { ...base, ...given };

	if (kind === 'scale') {
		const { min, max } = merged;
		if (!Number.isInteger(min) || !Number.isInteger(max)) {
			invalid('A scale spec needs integer min and max');
		}
		if ((min as number) >= (max as number) || (max as number) - (min as number) > 100) {
			invalid('A scale spec needs min below max, at most 100 apart');
		}
		return { min, max } as ScaleSpec;
	}
	if (kind === 'text') {
		const max = merged.max === undefined ? 2000 : merged.max;
		if (!intIn(max, 1, 20_000)) invalid('A text spec max must be an integer from 1 to 20,000');
		return { max } as TextSpec;
	}

	const raw = merged.members;
	if (!Array.isArray(raw) || raw.length < 1 || raw.length > 64) {
		invalid('A tags spec needs 1 to 64 members');
	}
	const seen = new Set<string>();
	const members = (raw as NonNullable<SpecInput['members']>).map((member) => {
		if (typeof member?.key !== 'string' || typeof member.label !== 'string') {
			invalid('Each member needs a key and a label');
		}
		if (member.rubric != null && typeof member.rubric !== 'string') {
			invalid('A member rubric must be text');
		}
		const key = requireMatch(
			member.key,
			STATE_KEY,
			'Member key must be lowercase letters, digits and hyphens, starting with a letter'
		);
		if (seen.has(key)) invalid(`Member key "${key}" is used twice`);
		seen.add(key);
		const rubric = (member.rubric ?? '').trim();
		if (rubric.length > 1000) invalid('Member rubric must be at most 1,000 characters');
		return { key, label: requireText(member.label, 'Member label', 64), rubric };
	});
	const max = merged.max ?? null;
	if (max !== null && !intIn(max, 1, 64)) {
		invalid('A tags spec max must be null or an integer from 1 to 64');
	}
	return { members, max } as TagsSpec;
}

function normalizeKey(key: string): string {
	requireMatch(
		key,
		STATE_KEY,
		'Attribute key must be lowercase letters, digits and hyphens, starting with a letter'
	);
	if (RESERVED.has(key)) invalid(`"${key}" is reserved and cannot be an Attribute key`);
	return key;
}

function findAttribute(db: Handle, realmId: number, key: string): AttributeRow | undefined {
	return db
		.select()
		.from(attributes)
		.where(and(eq(attributes.realmId, realmId), eq(attributes.key, key)))
		.get();
}

// Keep setBy and setAt: fitting a value to a revised spec is not a new judgement of it.
function reshapeValues(tx: Handle, row: AttributeRow, next: Spec): boolean {
	const held = tx
		.select()
		.from(labourAttributes)
		.where(eq(labourAttributes.attributeId, row.id))
		.all();
	let changed = false;
	const rewrite = (labourId: number, value: Value) => {
		changed = true;
		tx.update(labourAttributes)
			.set({ value })
			.where(and(eq(labourAttributes.labourId, labourId), eq(labourAttributes.attributeId, row.id)))
			.run();
	};

	for (const entry of held) {
		if (row.kind === 'scale') {
			const { min, max } = next as ScaleSpec;
			const value = entry.value as number;
			const clamped = Math.min(Math.max(value, min), max);
			if (clamped !== value) rewrite(entry.labourId, clamped);
		} else if (row.kind === 'tags') {
			const { members, max } = next as TagsSpec;
			const keys = new Set(members.map((member) => member.key));
			const value = entry.value as string[];
			const kept = value.filter((key) => keys.has(key));
			if (kept.length === 0) {
				changed = true;
				tx.delete(labourAttributes)
					.where(
						and(
							eq(labourAttributes.labourId, entry.labourId),
							eq(labourAttributes.attributeId, row.id)
						)
					)
					.run();
				continue;
			}
			if (max !== null && kept.length > max) {
				throw new DomainError(
					'conflict',
					`A Labour holds ${kept.length} members of Attribute "${row.key}"; max cannot go below that`
				);
			}
			if (kept.length !== value.length) rewrite(entry.labourId, kept);
		} else if ((entry.value as string).length > (next as TextSpec).max) {
			throw new DomainError(
				'conflict',
				`A Labour holds a value of Attribute "${row.key}" longer than ${(next as TextSpec).max} characters`
			);
		}
	}
	return changed;
}

export function defineAttribute(
	db: Db,
	actor: Actor,
	realmId: number,
	input: AttributeInput,
	now: Date = new Date()
): { version: number; attribute: AttributeView } {
	return db.transaction((tx) => {
		getRealm(tx, realmId);
		requireRealmRole(tx, actor, realmId, 'owner');
		const key = normalizeKey(input.key);
		if (!KINDS.includes(input.kind)) invalid('Attribute kind must be scale, tags or text');
		const existing = findAttribute(tx, realmId, key);

		const changed =
			existing === undefined
				? createAttribute(tx, realmId, key, input, now)
				: reviseAttribute(tx, existing, input, now);
		if (changed) bumpRealms(tx, [realmId], now);

		const attribute = readAttributes(tx, realmId).find((a) => a.key === key)!;
		return { version: readRealmAgent(tx, realmId).version, attribute };
	});
}

function createAttribute(
	tx: Handle,
	realmId: number,
	key: string,
	input: AttributeInput,
	now: Date
): boolean {
	if (input.label === undefined || input.rubric === undefined) {
		invalid('Creating an Attribute needs a label and a rubric');
	}
	const label = requireText(input.label, 'Attribute label', 64);
	const rubric = requireText(input.rubric, 'Attribute rubric', 4000);
	const spec = normalizeSpec(input.kind, input.spec, undefined);

	const order = attributeRows(tx, realmId).map((row) => row.id);
	if (order.length >= ATTRIBUTES_MAX) {
		throw new DomainError('conflict', `A Realm holds at most ${ATTRIBUTES_MAX} Attributes`);
	}
	placeAt(order, 0, input.index);

	const row = tx
		.insert(attributes)
		.values({
			realmId,
			key,
			kind: input.kind,
			label,
			rubric,
			spec,
			position: order.length,
			createdAt: now,
			revisedAt: now,
			updatedAt: now
		})
		.returning()
		.get();
	writePositions(placeAt(order, row.id, input.index), (id, position) =>
		tx.update(attributes).set({ position }).where(eq(attributes.id, id)).run()
	);
	return true;
}

function reviseAttribute(tx: Handle, row: AttributeRow, input: AttributeInput, now: Date): boolean {
	if (input.kind !== row.kind) {
		invalid(`Attribute "${row.key}" is ${row.kind}; its kind cannot change`);
	}
	const label =
		input.label === undefined ? row.label : requireText(input.label, 'Attribute label', 64);
	const rubric =
		input.rubric === undefined ? row.rubric : requireText(input.rubric, 'Attribute rubric', 4000);
	const spec = normalizeSpec(row.kind, input.spec, specOf(row));

	const rows = attributeRows(tx, row.realmId);
	const rest = rows.filter((other) => other.id !== row.id).map((other) => other.id);
	const order = placeAt(rest, row.id, input.index ?? row.position);
	const moved = order.indexOf(row.id) !== row.position;

	const specChanged = JSON.stringify(spec) !== JSON.stringify(row.spec);
	const revised = specChanged || rubric !== row.rubric;
	const valuesChanged = specChanged && reshapeValues(tx, row, spec);
	if (row.kind === 'tags' && specChanged) {
		const kept = new Set((spec as TagsSpec).members.map((member) => member.key));
		const removed = (specOf(row) as TagsSpec).members
			.map((member) => member.key)
			.filter((key) => !kept.has(key));
		unfilePulses(tx, row.id, removed);
		deleteAffinityPulses(tx, row.id, removed);
	}
	if (!revised && label === row.label && !moved) return false;

	tx.update(attributes)
		.set({ label, rubric, spec, updatedAt: now, ...(revised ? { revisedAt: now } : {}) })
		.where(eq(attributes.id, row.id))
		.run();
	if (moved) {
		writePositions(order, (id, position) =>
			tx.update(attributes).set({ position }).where(eq(attributes.id, id)).run()
		);
		if (rows.filter((other) => other.kind === 'text').length > 1) {
			refreshTextHolders(tx, row.realmId);
		}
	}
	return revised || valuesChanged || label !== row.label || moved;
}

// notes follow Attribute position: refresh them whenever text Attributes reorder.
function refreshTextHolders(tx: Handle, realmId: number): void {
	const holders = tx
		.selectDistinct({ labourId: labourAttributes.labourId })
		.from(labourAttributes)
		.innerJoin(attributes, eq(attributes.id, labourAttributes.attributeId))
		.where(and(eq(attributes.realmId, realmId), eq(attributes.kind, 'text')))
		.all();
	for (const { labourId } of holders) refreshLabourText(tx, labourId);
}

// Only Sentiment Pulses unfile: CHECK `pulses_unfiled_is_sentiment`.
function unfilePulses(tx: Handle, attributeId: number, members?: string[]): void {
	if (members?.length === 0) return;
	const owned = and(eq(pulses.attributeId, attributeId), isNotNull(pulses.realmId));
	const scope =
		members === undefined
			? owned
			: and(
					owned,
					sql`${pulses.member} IN (SELECT value FROM json_each(${JSON.stringify(members)}))`
				);
	tx.update(pulses).set({ attributeId: null, member: null }).where(scope).run();
}

function deleteAffinityPulses(tx: Handle, attributeId: number, members: string[]): void {
	if (members.length === 0) return;
	tx.delete(pulses)
		.where(
			and(
				isNull(pulses.realmId),
				eq(pulses.attributeId, attributeId),
				sql`${pulses.member} IN (SELECT value FROM json_each(${JSON.stringify(members)}))`
			)
		)
		.run();
}

// Every Attribute deletion goes through here; release what an Attribute owns here too.
export function removeAttribute(tx: Handle, row: AttributeRow): void {
	unfilePulses(tx, row.id);
	const holders =
		row.kind === 'text'
			? tx
					.select({ labourId: labourAttributes.labourId })
					.from(labourAttributes)
					.where(eq(labourAttributes.attributeId, row.id))
					.all()
			: [];
	tx.delete(attributes).where(eq(attributes.id, row.id)).run();
	for (const { labourId } of holders) refreshLabourText(tx, labourId);
	writePositions(
		attributeRows(tx, row.realmId).map((other) => other.id),
		(id, position) => tx.update(attributes).set({ position }).where(eq(attributes.id, id)).run()
	);
}

export function deleteAttribute(
	db: Db,
	actor: Actor,
	realmId: number,
	key: string,
	now: Date = new Date()
): { version: number } {
	return db.transaction((tx) => {
		getRealm(tx, realmId);
		requireRealmRole(tx, actor, realmId, 'owner');
		const row = findAttribute(tx, realmId, key);
		if (row === undefined) throw new DomainError('not_found', 'Attribute not found');
		removeAttribute(tx, row);
		bumpRealms(tx, [realmId], now);
		return { version: readRealmAgent(tx, realmId).version };
	});
}

export function tuneRealm(
	db: Db,
	actor: Actor,
	realmId: number,
	input: { notes?: string; halfLifeDays?: number; loudness?: number },
	now: Date = new Date()
): RealmAgentView {
	return db.transaction((tx) => {
		requireRealmRole(tx, actor, realmId, 'owner');
		const current = readRealmAgent(tx, realmId);
		const next = { ...current };
		if (input.notes !== undefined) {
			if (typeof input.notes !== 'string' || input.notes.length > NOTES_MAX) {
				invalid(`Realm notes must be at most ${NOTES_MAX} characters`);
			}
			next.notes = input.notes;
		}
		if (input.halfLifeDays !== undefined) {
			const days = input.halfLifeDays;
			if (typeof days !== 'number' || !(days > 0 && days <= 365)) {
				invalid('Half-life must be more than 0 and at most 365 days');
			}
			next.halfLifeDays = days;
		}
		if (input.loudness !== undefined) {
			const loudness = input.loudness;
			if (typeof loudness !== 'number' || !(loudness > 0 && loudness <= LOUDNESS_MAX)) {
				invalid(`Loudness must be more than 0 and at most ${LOUDNESS_MAX}`);
			}
			next.loudness = loudness;
		}
		if (
			next.notes === current.notes &&
			next.halfLifeDays === current.halfLifeDays &&
			next.loudness === current.loudness
		) {
			return current;
		}
		bumpRealms(tx, [realmId], now);
		tx.update(realmAgent)
			.set({ notes: next.notes, halfLifeDays: next.halfLifeDays, loudness: next.loudness })
			.where(eq(realmAgent.realmId, realmId))
			.run();
		return readRealmAgent(tx, realmId);
	});
}

// null means clear.
function normalizeValue(row: AttributeRow, raw: unknown): Value | null {
	const spec = specOf(row);
	if (raw === null) return null;
	if (row.kind === 'scale') {
		const { min, max } = spec as ScaleSpec;
		if (!intIn(raw, min, max))
			invalid(`Attribute "${row.key}" takes an integer from ${min} to ${max}`);
		return raw;
	}
	if (row.kind === 'text') {
		const { max } = spec as TextSpec;
		if (typeof raw !== 'string') invalid(`Attribute "${row.key}" takes text`);
		const text = raw.trim();
		if (text.length > max) invalid(`Attribute "${row.key}" takes at most ${max} characters`);
		return text === '' ? null : text;
	}
	const { members, max } = spec as TagsSpec;
	if (!Array.isArray(raw) || raw.some((key) => typeof key !== 'string')) {
		invalid(`Attribute "${row.key}" takes an array of member keys`);
	}
	const known = new Set(members.map((member) => member.key));
	const unknown = (raw as string[]).filter((key) => !known.has(key));
	if (unknown.length > 0) {
		invalid(`Attribute "${row.key}" has no member ${unknown.map((k) => `"${k}"`).join(', ')}`);
	}
	const keys = [...new Set(raw as string[])].sort();
	if (keys.length === 0) return null;
	if (max !== null && keys.length > max) {
		invalid(`Attribute "${row.key}" takes at most ${max} members`);
	}
	return keys;
}

// Never bumps a version; `touched` gains the Labour's Realm when a row changed.
export function writeValues(
	tx: Handle,
	userId: number,
	labour: { id: number; realmId: number },
	values: Record<string, unknown>,
	now: Date,
	touched: Set<number>
): void {
	if (values === null || typeof values !== 'object' || Array.isArray(values)) {
		invalid('Values must be an object of Attribute keys to values');
	}
	const rows = new Map(attributeRows(tx, labour.realmId).map((row) => [row.key, row]));
	const planned = Object.entries(values).map(([key, raw]) => {
		const row = rows.get(key);
		if (row === undefined) invalid(`Attribute "${key}" does not exist in this Realm`);
		return { row, value: normalizeValue(row, raw) };
	});

	let notesChanged = false;
	for (const { row, value } of planned) {
		if (row.kind === 'text') notesChanged = true;
		const match = and(
			eq(labourAttributes.labourId, labour.id),
			eq(labourAttributes.attributeId, row.id)
		);
		if (value === null) {
			const removed = tx.delete(labourAttributes).where(match).run().changes;
			if (removed > 0) touched.add(labour.realmId);
			continue;
		}
		tx.insert(labourAttributes)
			.values({
				realmId: labour.realmId,
				labourId: labour.id,
				attributeId: row.id,
				value,
				setBy: userId,
				via: currentVia(),
				setAt: now
			})
			.onConflictDoUpdate({
				target: [labourAttributes.labourId, labourAttributes.attributeId],
				set: { value, setBy: userId, via: currentVia(), setAt: now }
			})
			.run();
		touched.add(labour.realmId);
	}
	if (notesChanged) refreshLabourText(tx, labour.id);
}

export function setValues(
	db: Db,
	actor: Actor,
	labourId: number,
	values: Record<string, unknown>,
	now: Date = new Date()
): ValueView[] {
	return db.transaction((tx) => {
		const labour = getLabour(tx, labourId);
		requireRealmRole(tx, actor, labour.realmId, 'editor');
		const touched = new Set<number>();
		writeValues(tx, actor.id, labour, values, now, touched);
		bumpRealms(tx, touched, now);
		return readValues(tx, labourId);
	});
}

export type DetachedValue = {
	key: string;
	kind: AttributeKind;
	value: Value;
	setBy: number;
	setAt: Date;
};

// Must run before the Labour's realm_id changes: the composite foreign key blocks the update.
export function detachValues(tx: Handle, labourId: number): DetachedValue[] {
	const detached = readValues(tx, labourId).map(
		({ key, kind, value, setBy, setAt }): DetachedValue => ({ key, kind, value, setBy, setAt })
	);
	tx.delete(labourAttributes).where(eq(labourAttributes.labourId, labourId)).run();
	return detached;
}

// Keeps each value the new Realm's same-key, same-kind Attribute accepts as it stands, with its
// original setBy and setAt.
export function attachValues(
	tx: Handle,
	labourId: number,
	fromRealmId: number,
	toRealmId: number,
	detached: DetachedValue[],
	now: Date
): void {
	if (detached.length === 0) return;
	const rows = new Map(attributeRows(tx, toRealmId).map((row) => [row.key, row]));
	for (const entry of detached) {
		const row = rows.get(entry.key);
		if (row === undefined || row.kind !== entry.kind) continue;
		const value = carriedValue(row, entry.value);
		if (value === null) continue;
		tx.insert(labourAttributes)
			.values({
				realmId: toRealmId,
				labourId,
				attributeId: row.id,
				value,
				setBy: entry.setBy,
				setAt: entry.setAt
			})
			.run();
	}
	bumpRealms(tx, [fromRealmId, toRealmId], now);
}

function carriedValue(row: AttributeRow, value: Value): Value | null {
	const spec = specOf(row);
	if (row.kind === 'scale') {
		const { min, max } = spec as ScaleSpec;
		return intIn(value, min, max) ? value : null;
	}
	if (row.kind === 'text') {
		return (value as string).length <= (spec as TextSpec).max ? value : null;
	}
	const { members, max } = spec as TagsSpec;
	const known = new Set(members.map((member) => member.key));
	const kept = (value as string[]).filter((key) => known.has(key));
	if (kept.length === 0 || (max !== null && kept.length > max)) return null;
	return kept;
}
