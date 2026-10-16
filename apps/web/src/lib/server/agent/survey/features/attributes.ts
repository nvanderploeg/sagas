import { sql } from 'drizzle-orm';
import { attributes } from '../../../db/schema.ts';
import type { Handle } from '../../../db/client.ts';
import type { ScaleSpec } from '../../attributes.ts';
import type { Candidate } from '../candidates.ts';

// A weight key that names an Attribute: `impact`, or `topic:boss-hp` for a tags member.
export type AttributeWeight = { key: string; attribute: string; member?: string };

export type AttributeFeature = {
	// A candidate lacking the data holds MISSING.
	values: Map<number, number>;
	missing: number;
};

export const MISSING = 0.5;

type Held = { kind: string; spec: unknown; held: Map<number, unknown> };

export function loadAttributeFeatures(
	db: Handle,
	candidates: Candidate[],
	candidateIds: string,
	weights: AttributeWeight[]
): Map<string, AttributeFeature> {
	const features = new Map<string, AttributeFeature>();
	if (weights.length === 0) return features;

	const keys = [...new Set(weights.map((weight) => weight.attribute))];
	const realmIds = [...new Set(candidates.map((candidate) => candidate.realmId))];

	const byRealm = new Map<number, Map<string, number>>();
	const byId = new Map<number, Held>();
	const rows = db
		.select({
			id: attributes.id,
			realmId: attributes.realmId,
			key: attributes.key,
			kind: attributes.kind,
			spec: attributes.spec
		})
		.from(attributes)
		.where(
			sql`${attributes.key} IN (SELECT value FROM json_each(${JSON.stringify(keys)})) AND ${attributes.realmId} IN (SELECT value FROM json_each(${JSON.stringify(realmIds)}))`
		)
		.all();
	for (const row of rows) {
		byId.set(row.id, { kind: row.kind, spec: row.spec, held: new Map() });
		const realm = byRealm.get(row.realmId) ?? new Map<string, number>();
		realm.set(row.key, row.id);
		byRealm.set(row.realmId, realm);
	}
	if (byId.size > 0) {
		const values = db.all<{ labourId: number; attributeId: number; value: string }>(sql`
			SELECT la.labour_id AS labourId, la.attribute_id AS attributeId, la.value AS value
			FROM json_each(${candidateIds}) c
			CROSS JOIN labour_attributes la ON la.labour_id = c.value
			WHERE la.attribute_id IN (SELECT value FROM json_each(${JSON.stringify([...byId.keys()])}))
		`);
		for (const { labourId, attributeId, value } of values) {
			byId.get(attributeId)!.held.set(labourId, JSON.parse(value));
		}
	}

	for (const weight of weights) {
		const feature: AttributeFeature = { values: new Map(), missing: 0 };
		for (const candidate of candidates) {
			const id = byRealm.get(candidate.realmId)?.get(weight.attribute);
			const attribute = id === undefined ? undefined : byId.get(id);
			const value = attribute?.held.get(candidate.id);
			const wanted = weight.member === undefined ? 'scale' : 'tags';
			if (attribute === undefined || attribute.kind !== wanted || value === undefined) {
				feature.values.set(candidate.id, MISSING);
				feature.missing += 1;
			} else if (weight.member === undefined) {
				const { min, max } = attribute.spec as ScaleSpec;
				feature.values.set(candidate.id, ((value as number) - min) / (max - min));
			} else {
				feature.values.set(candidate.id, (value as string[]).includes(weight.member) ? 1 : 0);
			}
		}
		features.set(weight.key, feature);
	}
	return features;
}
