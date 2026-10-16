import { createHash } from 'node:crypto';
import { generateNKeysBetween } from 'fractional-indexing';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '#lib/server/db/client.ts';
import { labourKeys, labours } from '#lib/server/db/schema.ts';
import { survey, type SurveyInput } from '#lib/server/agent/survey/index.ts';
import { updateLabour } from '#lib/server/domain/labours.ts';
import type { Actor } from '#lib/server/domain/write.ts';
import { testDb } from '#lib/server/test/db.ts';
import { seedActor, seedLabour, seedRealm, seedUser } from '#lib/server/test/fixtures.ts';
import { refreshEmbeddingInput, writeVector } from './index.ts';

const MODEL_ID = 'Xenova/bge-small-en-v1.5@ea104dacec62c0de699686887e3f920caeb4f3e3';
const DIMENSIONS = 384;
const QUERY = 'improve combat feel for boss fights';

let db: Db;
let actor: Actor;
let realmId: number;
let stateId: number;

beforeEach(() => {
	db = testDb();
	actor = seedActor(db);
	const realm = seedRealm(db, 'AM');
	realmId = realm.id;
	stateId = realm.initialStateId!;
});

afterEach(() => {
	db.$client.close();
});

const sha = (text: string) => createHash('sha256').update(text).digest('hex');

function normalize(values: Float32Array): Float32Array {
	let norm = 0;
	for (const x of values) norm += x * x;
	norm = Math.sqrt(norm);
	return values.map((x) => x / norm);
}

function hashedVector(text: string): Float32Array {
	let state = createHash('sha256').update(text).digest().readUInt32LE(0) || 1;
	const out = new Float32Array(DIMENSIONS);
	for (let i = 0; i < DIMENSIONS; i++) {
		state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
		out[i] = state / 2 ** 32 - 0.5;
	}
	return normalize(out);
}

// The query vector for the cosine fixtures: the first axis.
const AXIS = Float32Array.from({ length: DIMENSIONS }, (_, i) => (i === 0 ? 1 : 0));

// A unit vector whose cosine with AXIS is `cosine`.
function withCosine(cosine: number): Float32Array {
	const out = new Float32Array(DIMENSIONS);
	out[0] = cosine;
	out[1] = Math.sqrt(1 - cosine * cosine);
	return out;
}

const dot = (a: Float32Array, b: Float32Array) => a.reduce((sum, x, i) => sum + x * b[i], 0);
const floor = (cosine: number) => Math.max(0, (cosine - 0.45) / 0.55);

function labour(title: string, realm = realmId) {
	return seedLabour(db, { realmId: realm, title });
}

function embed(labourId: number, vector: Float32Array, model = MODEL_ID) {
	const row = db.select().from(labours).where(eq(labours.id, labourId)).get()!;
	const input = [row.title, row.description]
		.map((part) => part.trim())
		.filter((part) => part !== '')
		.join('\n\n');
	writeVector(db, labourId, model, sha(input), vector);
}

function run(input: Partial<SurveyInput>, opts: { queryVector?: Float32Array } = {}) {
	return survey(
		db,
		actor,
		{ weights: { similarity: 1 }, query: QUERY, temperature: 0, limit: 50, ...input },
		opts
	);
}

const scoreOf = (result: ReturnType<typeof run>, labourId: number) =>
	result.results.find((item) => item.labourId === labourId)?.score;

describe('similarity', () => {
	describe('the cosine floor', () => {
		it.each([
			[1, 1],
			[0.9, 0.8181818],
			[0.725, 0.5],
			[0.45, 0],
			[0.449, 0],
			[0.2, 0],
			[0, 0],
			[-0.6, 0],
			[-1, 0]
		])('scores a cosine of %f as %f', (cosine, expected) => {
			const l = labour('Candidate');
			embed(l.id, withCosine(cosine));

			const result = run({}, { queryVector: AXIS });

			expect(floor(cosine)).toBeCloseTo(expected, 6);
			expect(scoreOf(result, l.id)).toBeCloseTo(expected, 5);
			expect(result.coverage.missing).toEqual({});
		});

		it('scores every candidate on its own cosine, not relative to the best', () => {
			const strong = labour('Strong');
			const middling = labour('Middling');
			const weak = labour('Weak');
			const below = labour('Below the floor');
			embed(strong.id, withCosine(0.95));
			embed(middling.id, withCosine(0.6));
			embed(weak.id, withCosine(0.5));
			embed(below.id, withCosine(0.1));

			const result = run({}, { queryVector: AXIS });

			expect(scoreOf(result, strong.id)).toBeCloseTo(floor(0.95), 5);
			expect(scoreOf(result, middling.id)).toBeCloseTo(floor(0.6), 5);
			expect(scoreOf(result, weak.id)).toBeCloseTo(floor(0.5), 5);
			expect(scoreOf(result, below.id)).toBe(0);
			expect(result.results.map((item) => item.labourId)).toEqual([
				strong.id,
				middling.id,
				weak.id,
				below.id
			]);
		});

		it('takes the cosine as the dot product of the stored and the query vectors', () => {
			const query = hashedVector('query');
			const noise = hashedVector('noise');
			const vector = normalize(query.map((x, i) => x + 0.5 * noise[i]));
			const cosine = dot(query, vector);
			expect(floor(cosine)).toBeGreaterThan(0.5);
			const l = labour('Dense');
			embed(l.id, vector);

			const result = run({}, { queryVector: query });

			expect(scoreOf(result, l.id)).toBeCloseTo(floor(cosine), 5);
		});

		it('multiplies the feature by its weight in the contribution', () => {
			const l = labour('Weighted');
			embed(l.id, withCosine(0.725));

			const result = run({ weights: { similarity: 3 } }, { queryVector: AXIS });

			expect(scoreOf(result, l.id)).toBeCloseTo(1.5, 5);
			expect(result.results[0].contributions.similarity).toBeCloseTo(1.5, 5);
		});

		it('is not an ignored weight key', () => {
			const l = labour('Candidate');
			embed(l.id, withCosine(0.8));

			expect(run({}, { queryVector: AXIS }).ignored).toEqual([]);
		});
	});

	describe('a candidate without a current vector', () => {
		it('takes 0.5 and counts as missing when it has no vector', () => {
			const l = labour('Never embedded');

			const result = run({}, { queryVector: AXIS });

			expect(scoreOf(result, l.id)).toBe(0.5);
			expect(result.coverage.missing).toEqual({ similarity: 1 });
		});

		it('takes 0.5 and counts as missing when the text changed after embedding', () => {
			const l = labour('Before');
			embed(l.id, withCosine(1));
			updateLabour(db, actor, l.id, { title: 'After' });

			const result = run({}, { queryVector: AXIS });

			expect(scoreOf(result, l.id)).toBe(0.5);
			expect(result.coverage.missing).toEqual({ similarity: 1 });
		});

		it('takes 0.5 and counts as missing when the vector is from another model', () => {
			const l = labour('Old model');
			embed(l.id, withCosine(1), 'Xenova/bge-small-en-v1.5@0000000');

			const result = run({}, { queryVector: AXIS });

			expect(scoreOf(result, l.id)).toBe(0.5);
			expect(result.coverage.missing).toEqual({ similarity: 1 });
		});

		it('counts only the candidates that lack a current vector', () => {
			const current = labour('Current');
			const absent = labour('Absent');
			const stale = labour('Stale');
			embed(current.id, withCosine(0.45));
			embed(stale.id, withCosine(1));
			updateLabour(db, actor, stale.id, { description: 'edited' });

			const result = run({}, { queryVector: AXIS });

			expect(scoreOf(result, current.id)).toBe(0);
			expect(scoreOf(result, absent.id)).toBe(0.5);
			expect(scoreOf(result, stale.id)).toBe(0.5);
			expect(result.coverage.missing).toEqual({ similarity: 2 });
		});

		it('ranks between a strong match and a candidate below the floor', () => {
			const strong = labour('Strong');
			const missing = labour('Missing');
			const weak = labour('Weak');
			embed(strong.id, withCosine(0.9));
			embed(weak.id, withCosine(0.3));

			const result = run({}, { queryVector: AXIS });

			expect(result.results.map((item) => item.labourId)).toEqual([strong.id, missing.id, weak.id]);
		});

		it('reports a missing 0.5 as a contribution of weight times 0.5', () => {
			const l = labour('Never embedded');

			const result = run({ weights: { similarity: 4 } }, { queryVector: AXIS });

			expect(result.results.find((item) => item.labourId === l.id)!.contributions).toEqual({
				similarity: 2
			});
		});
	});

	describe('without a query vector', () => {
		it('makes every candidate missing, even those with a current vector', () => {
			const embedded = labour('Embedded');
			const bare = labour('Bare');
			embed(embedded.id, withCosine(1));

			const result = run({});

			expect(scoreOf(result, embedded.id)).toBe(0.5);
			expect(scoreOf(result, bare.id)).toBe(0.5);
			expect(result.coverage.missing).toEqual({ similarity: 2 });
			expect(result.ignored).toEqual([]);
		});

		it('does the same when the survey is given no options at all', () => {
			const embedded = labour('Embedded');
			embed(embedded.id, withCosine(1));

			const result = survey(db, actor, {
				weights: { similarity: 1 },
				query: QUERY,
				temperature: 0
			});

			expect(scoreOf(result, embedded.id)).toBe(0.5);
			expect(result.coverage.missing).toEqual({ similarity: 1 });
		});
	});

	describe('without a query', () => {
		it('ignores the weight, though a query vector is present', () => {
			const l = labour('Candidate');
			embed(l.id, withCosine(1));

			const result = run({ query: undefined }, { queryVector: AXIS });

			expect(result.ignored).toEqual(['similarity']);
			expect(scoreOf(result, l.id)).toBe(0);
			expect(result.results[0].contributions).toEqual({});
			expect(result.coverage.missing).toEqual({});
		});

		it('ignores the weight for an empty or blank query', () => {
			const l = labour('Candidate');
			embed(l.id, withCosine(1));

			expect(run({ query: '' }, { queryVector: AXIS }).ignored).toEqual(['similarity']);
			expect(run({ query: '   ' }, { queryVector: AXIS }).ignored).toEqual(['similarity']);
		});

		it('keeps scoring the other weights', () => {
			const l = labour('Candidate');
			embed(l.id, withCosine(1));

			const result = run({ query: undefined, weights: { similarity: 1, age: 1 } });

			expect(result.ignored).toEqual(['similarity']);
			expect(Object.keys(result.results[0].contributions)).toEqual(['age']);
		});
	});

	describe('coverage.unembedded', () => {
		it('counts the candidates without a current vector', () => {
			const current = labour('Current');
			const absent = labour('Absent');
			const staleText = labour('Stale text');
			const staleModel = labour('Stale model');
			embed(current.id, withCosine(0.7));
			embed(staleText.id, withCosine(0.7));
			updateLabour(db, actor, staleText.id, { title: 'Edited title' });
			embed(staleModel.id, withCosine(0.7), 'Xenova/bge-small-en-v1.5@0000000');
			expect(absent.id).toBeGreaterThan(0);

			const result = run({}, { queryVector: AXIS });

			expect(result.coverage.candidates).toBe(4);
			expect(result.coverage.unembedded).toBe(3);
		});

		it('is 0 when every candidate is current', () => {
			for (const title of ['A', 'B', 'C']) embed(labour(title).id, withCosine(0.7));

			expect(run({}, { queryVector: AXIS }).coverage.unembedded).toBe(0);
		});

		it('counts without a similarity weight, a query, or a query vector', () => {
			embed(labour('Current').id, withCosine(0.7));
			labour('Absent');

			const result = survey(db, actor, { weights: { age: 1 }, temperature: 0 });

			expect(result.coverage.unembedded).toBe(1);
		});

		it('counts only the surveyed candidates', () => {
			const other = seedRealm(db, 'BL');
			embed(labour('Surveyed').id, withCosine(0.7));
			labour('Elsewhere', other.id);

			const result = run({ realmIds: [realmId] }, { queryVector: AXIS });

			expect(result.coverage.candidates).toBe(1);
			expect(result.coverage.unembedded).toBe(0);
		});
	});

	describe('over 5,000 Labours', () => {
		it('surveys in under 200 ms, median of three warm runs', { timeout: 60_000 }, () => {
			const total = 5_000;
			const chunk = 500;
			const ownerId = seedUser(db, 'bulk-owner');
			const ranks = generateNKeysBetween(null, null, total);
			const vectors = Array.from({ length: 20 }, (_, i) => hashedVector(`bulk ${i}`));
			const query = hashedVector('bulk query');

			const ids: number[] = [];
			for (let start = 0; start < total; start += chunk) {
				const rows = Array.from({ length: chunk }, (_, offset) => {
					const n = start + offset;
					return {
						realmId,
						number: n + 1,
						title: `Bulk labour ${n}`,
						description: `Description of bulk labour ${n}`,
						ownerId,
						stateId,
						rank: ranks[n]
					};
				});
				const inserted = db.insert(labours).values(rows).returning({ id: labours.id }).all();
				db.insert(labourKeys)
					.values(
						inserted.map(({ id }, offset) => ({ key: `AM-${start + offset + 1}`, labourId: id }))
					)
					.run();
				ids.push(...inserted.map(({ id }) => id));
			}
			for (const id of ids) refreshEmbeddingInput(db, id);
			ids.forEach((id, n) => {
				writeVector(
					db,
					id,
					MODEL_ID,
					sha(`Bulk labour ${n}\n\nDescription of bulk labour ${n}`),
					vectors[n % vectors.length]
				);
			});

			const once = () => {
				const started = performance.now();
				const result = survey(
					db,
					actor,
					{ weights: { similarity: 1 }, query: QUERY, limit: 15 },
					{ queryVector: query }
				);
				return { elapsed: performance.now() - started, result };
			};
			once();
			const runs = [once(), once(), once()];
			const median = runs.map((run) => run.elapsed).sort((a, b) => a - b)[1];

			const { result } = runs[0];
			expect(result.coverage.candidates).toBe(total);
			expect(result.coverage.unembedded).toBe(0);
			expect(result.coverage.missing).toEqual({});
			expect(result.results).toHaveLength(15);
			expect(median).toBeLessThan(200);
		});
	});
});
