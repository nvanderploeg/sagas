import { sql } from 'drizzle-orm';
import type { Handle } from '../../../db/client.ts';
import { DEFAULT_LOUDNESS, type ScaleSpec } from '../../attributes.ts';
import { inAttributes, inRealms, keyOf, totalsOf } from '../../sentiment.ts';
import type { Feature, FeatureContext } from './types.ts';
import { intList, intRows } from '#lib/server/db/lists.ts';

export type HeldKey = {
	realmId: number;
	attributeId: number;
	attribute: string;
	member: string | null;
	x: number;
};

export async function loadHeldKeys(
	db: Handle,
	labourIds: number[]
): Promise<Map<number, HeldKey[]>> {
	const rows = (
		await db.execute<{
			labourId: number;
			realmId: number;
			attributeId: number;
			attribute: string;
			kind: string;
			spec: ScaleSpec | null;
			value: unknown;
		}>(sql`
		SELECT la.labour_id AS "labourId", la.realm_id AS "realmId", la.attribute_id AS "attributeId",
			a.key AS attribute, a.kind AS kind,
			CASE WHEN a.kind = 'scale' THEN a.spec END AS spec, la.value AS value
		FROM ${intRows(labourIds)} AS c(value)
		JOIN labour_attributes la ON la.labour_id = c.value
		JOIN attributes a ON a.id = la.attribute_id
		WHERE a.kind IN ('scale', 'tags')
	`)
	).rows;
	const scales = new Map<number, ScaleSpec>();
	const held = new Map<number, HeldKey[]>();
	const add = (labourId: number, entry: HeldKey) => {
		const list = held.get(labourId);
		if (list === undefined) held.set(labourId, [entry]);
		else list.push(entry);
	};
	for (const row of rows) {
		const value = row.value;
		if (row.kind === 'tags') {
			for (const member of value as string[]) {
				add(row.labourId, {
					realmId: row.realmId,
					attributeId: row.attributeId,
					attribute: row.attribute,
					member,
					x: 1
				});
			}
			continue;
		}
		let spec = scales.get(row.attributeId);
		if (spec === undefined) {
			spec = row.spec!;
			scales.set(row.attributeId, spec);
		}
		add(row.labourId, {
			realmId: row.realmId,
			attributeId: row.attributeId,
			attribute: row.attribute,
			member: null,
			x: ((value as number) - spec.min) / (spec.max - spec.min)
		});
	}
	return held;
}

export type KeyStrength = { volume: number; mood: number; v: number };

export async function loadStrengths(
	db: Handle,
	held: Map<number, HeldKey[]>,
	now: Date
): Promise<Map<string, KeyStrength>> {
	const strengths = new Map<string, KeyStrength>();
	const realmIds = new Set<number>();
	const attributeIds = new Set<number>();
	for (const entries of held.values()) {
		for (const entry of entries) {
			realmIds.add(entry.realmId);
			attributeIds.add(entry.attributeId);
		}
	}
	if (attributeIds.size === 0) return strengths;

	const loudness = new Map(
		(
			await db.execute<{
				realmId: number;
				loudness: number;
			}>(sql`SELECT realm_id AS "realmId", loudness FROM realm_agent
					WHERE realm_id IN ${intList([...realmIds])}`)
		).rows.map((row) => [row.realmId, row.loudness])
	);
	const totals = await totalsOf(
		db,
		sql`${inRealms([...realmIds])} AND ${inAttributes([...attributeIds])}`,
		now
	);
	for (const total of totals) {
		const loud = loudness.get(total.realmId!) ?? DEFAULT_LOUDNESS;
		strengths.set(keyOf(total.attributeId, total.member), {
			volume: total.volume,
			mood: total.mood,
			v: total.volume / (total.volume + loud)
		});
	}
	return strengths;
}

type Scores = {
	sentiment: Map<number, number>;
	pain: Map<number, number>;
	delight: Map<number, number>;
};

type Loaded = {
	held: Map<number, HeldKey[]>;
	strengths: Map<string, KeyStrength>;
	scores: Scores;
};

const loaded = new WeakMap<FeatureContext, Loaded>();
const heldCache = new WeakMap<FeatureContext, Map<number, HeldKey[]>>();

export async function heldOf(ctx: FeatureContext): Promise<Map<number, HeldKey[]>> {
	let held = heldCache.get(ctx);
	if (held === undefined) {
		held = await loadHeldKeys(ctx.db, ctx.candidateIds);
		heldCache.set(ctx, held);
	}
	return held;
}

// Load the three Sentiment features once per Survey.
export async function loadOf(ctx: FeatureContext): Promise<Loaded> {
	const cached = loaded.get(ctx);
	if (cached !== undefined) return cached;
	const held = await heldOf(ctx);
	const strengths = await loadStrengths(ctx.db, held, ctx.now);

	const scores: Scores = { sentiment: new Map(), pain: new Map(), delight: new Map() };
	for (const { id } of ctx.candidates) {
		let quiet = 1;
		let calm = 1;
		let glad = 1;
		for (const entry of held.get(id) ?? []) {
			const strength = strengths.get(keyOf(entry.attributeId, entry.member));
			if (strength === undefined) continue;
			const reach = strength.v * entry.x;
			quiet *= 1 - reach;
			calm *= 1 - reach * Math.max(0, -strength.mood);
			glad *= 1 - reach * Math.max(0, strength.mood);
		}
		scores.sentiment.set(id, 1 - quiet);
		scores.pain.set(id, 1 - calm);
		scores.delight.set(id, 1 - glad);
	}
	const result = { held, strengths, scores };
	loaded.set(ctx, result);
	return result;
}

export const sentiment: Feature = {
	name: 'sentiment',
	load: async (ctx) => (await loadOf(ctx)).scores.sentiment
};

export const pain: Feature = {
	name: 'pain',
	load: async (ctx) => (await loadOf(ctx)).scores.pain
};

export const delight: Feature = {
	name: 'delight',
	load: async (ctx) => (await loadOf(ctx)).scores.delight
};
