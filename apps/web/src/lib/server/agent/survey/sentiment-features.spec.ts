import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '#lib/server/db/client.ts';
import type { Actor } from '#lib/server/domain/write.ts';
import { testDb } from '#lib/server/test/db.ts';
import { seedActor, seedLabour, seedRealm } from '#lib/server/test/fixtures.ts';
import { defineAttribute, setValues, tuneRealm } from '../attributes.ts';
import { postPulses, type PulseInput } from '../sentiment.ts';
import { survey } from './index.ts';

const DAY = 86_400_000;
const NOW = new Date('2026-06-15T12:00:00.000Z');
const LATER = new Date(NOW.getTime() + 14 * DAY);

let db: Db;
let actor: Actor;
let realm: { id: number };
let pulseIds: Record<string, number>;

beforeEach(() => {
	db = testDb();
	actor = seedActor(db);
	realm = seedRealm(db, 'AM');
	tuneRealm(db, actor, realm.id, { loudness: 1 }, NOW);
	define(realm.id, 'perf', 'scale', { min: 0, max: 4 });
	define(realm.id, 'fun', 'scale', { min: 1, max: 5 });
	define(realm.id, 'ux', 'scale', { min: 0, max: 10 });
	define(realm.id, 'speed', 'scale', { min: 0, max: 4 });
	define(realm.id, 'bugs', 'tags', {
		members: [
			{ key: 'crash', label: 'Crash' },
			{ key: 'lag', label: 'Lag' }
		]
	});
	define(realm.id, 'notes', 'text');

	// Expected scores derive from these: loudness 1 gives perf v 0.75 mood -1, fun v 0.5 mood 1,
	// bugs:crash v 2/3 mood -0.25, bugs:lag v 0.5 mood 0.5, ux v 0.5 mood 0.
	pulseIds = {
		perf: onePulse(realm.id, { key: 'perf', amount: 3, mood: -1, note: 'slow' }),
		fun: onePulse(realm.id, { key: 'fun', amount: 1, mood: 1, note: 'fun' }),
		crashA: onePulse(realm.id, { key: 'bugs:crash', amount: 1, mood: -1, note: 'crashed' }),
		crashB: onePulse(realm.id, { key: 'bugs:crash', amount: 1, mood: 0.5, note: 'fine' }),
		lag: onePulse(realm.id, { key: 'bugs:lag', amount: 1, mood: 0.5, note: 'laggy' }),
		ux: onePulse(realm.id, { key: 'ux', amount: 1, mood: 0, note: 'meh' })
	};

	labour(realm.id, { perf: 3, fun: 3, ux: 5, bugs: ['crash', 'lag'] });
	labour(realm.id, { perf: 1, speed: 4 }, ['pick']);
	labour(realm.id, { notes: 'hello' });
	labour(realm.id, { bugs: ['lag'] }, ['pick']);
	labour(realm.id, { perf: 0 });
});

afterEach(() => {
	db.$client.close();
});

function define(
	realmId: number,
	key: string,
	kind: 'scale' | 'tags' | 'text',
	spec?: Parameters<typeof defineAttribute>[3]['spec']
) {
	defineAttribute(db, actor, realmId, { key, kind, label: key, rubric: `About ${key}`, spec }, NOW);
}

function onePulse(realmId: number, item: Partial<PulseInput> & { key: string }, at = NOW): number {
	const full: PulseInput = { amount: 1, mood: 0, ...item };
	return postPulses(db, actor, realmId, [full], at)[0].id;
}

function labour(realmId: number, values: Record<string, unknown>, labels: string[] = []): number {
	const made = seedLabour(db, { realmId, labels });
	setValues(db, actor, made.id, values, NOW);
	return made.id;
}

function run(
	weights: Record<string, number>,
	extra: Partial<Parameters<typeof survey>[2]> = {},
	now = NOW
) {
	return survey(
		db,
		actor,
		{ realmIds: [realm.id], weights, limit: 50, temperature: 0, ...extra },
		{ now }
	);
}

function scoresOf(result: ReturnType<typeof survey>): Record<string, number> {
	return Object.fromEntries(result.results.map((item) => [item.key, item.score]));
}

function expectScores(actual: Record<string, number>, expected: Record<string, number>) {
	expect(Object.keys(actual).sort()).toEqual(Object.keys(expected).sort());
	for (const [key, value] of Object.entries(expected)) {
		expect(actual[key], key).toBeCloseTo(value, 10);
	}
}

describe('the sentiment feature', () => {
	it('is 1 − Π(1 − v · x) over every scale and tags value the Labour holds', () => {
		const scores = scoresOf(run({ sentiment: 1 }));

		expectScores(scores, {
			// perf 3/4, fun (3−1)/4, ux 5/10, crash and lag held outright.
			'AM-1':
				1 -
				(1 - 0.75 * 0.75) * (1 - 0.5 * 0.5) * (1 - 0.5 * 0.5) * (1 - (2 / 3) * 1) * (1 - 0.5 * 1),
			'AM-2': 0.75 * 0.25,
			'AM-3': 0,
			'AM-4': 0.5,
			'AM-5': 0
		});
	});

	it('counts a held tags member as x = 1 and ignores members it does not hold', () => {
		const scores = scoresOf(run({ sentiment: 1 }));

		expect(scores['AM-4']).toBeCloseTo(0.5 * 1, 10);
	});

	it('is 0 for a scale value at the bottom of its range', () => {
		expect(scoresOf(run({ sentiment: 1 }))['AM-5']).toBe(0);
	});

	it('ignores a key without Pulses, a text value and unset Attributes', () => {
		const scores = scoresOf(run({ sentiment: 1 }));

		expect(scores['AM-2']).toBeCloseTo(0.75 * 0.25, 10);
		expect(scores['AM-3']).toBe(0);
	});

	it('decays with the Survey time', () => {
		const later = scoresOf(run({ sentiment: 1 }, {}, LATER));

		// perf volume 3 → 1.5 after one half-life: v = 1.5 / 2.5.
		expect(later['AM-2']).toBeCloseTo(0.6 * 0.25, 10);
	});

	it('counts no unfiled Pulse', () => {
		onePulse(realm.id, { key: 'perf:high', amount: 10 });
		onePulse(realm.id, { key: 'bugs', amount: 10 });
		onePulse(realm.id, { key: 'notes', amount: 10 });

		expect(scoresOf(run({ sentiment: 1 }))['AM-2']).toBeCloseTo(0.75 * 0.25, 10);
	});
});

describe('the pain feature', () => {
	it('is 1 − Π(1 − v · max(0, −mood) · x), so only keys with a negative mood count', () => {
		const scores = scoresOf(run({ pain: 1 }));

		expectScores(scores, {
			// perf mood -1 (v 0.75, x 0.75) and crash mood -0.25 (v 2/3, x 1).
			'AM-1': 1 - (1 - 0.75 * 1 * 0.75) * (1 - (2 / 3) * 0.25 * 1),
			'AM-2': 0.75 * 1 * 0.25,
			'AM-3': 0,
			'AM-4': 0,
			'AM-5': 0
		});
	});
});

describe('the delight feature', () => {
	it('is 1 − Π(1 − v · max(0, mood) · x), so only keys with a positive mood count', () => {
		const scores = scoresOf(run({ delight: 1 }));

		expectScores(scores, {
			// fun mood 1 (v 0.5, x 0.5) and lag mood 0.5 (v 0.5, x 1).
			'AM-1': 1 - (1 - 0.5 * 1 * 0.5) * (1 - 0.5 * 0.5 * 1),
			'AM-2': 0,
			'AM-3': 0,
			'AM-4': 0.5 * 0.5 * 1,
			'AM-5': 0
		});
	});
});

describe('weighing the three features', () => {
	it('applies all three as built-in features, scaled by their weights', () => {
		const result = run({ sentiment: 1, pain: -2, delight: 3 });
		const first = result.results.find((item) => item.key === 'AM-1')!;

		const sentiment =
			1 - (1 - 0.75 * 0.75) * (1 - 0.5 * 0.5) * (1 - 0.5 * 0.5) * (1 - (2 / 3) * 1) * (1 - 0.5 * 1);
		const pain = 1 - (1 - 0.75 * 1 * 0.75) * (1 - (2 / 3) * 0.25 * 1);
		const delight = 1 - (1 - 0.5 * 1 * 0.5) * (1 - 0.5 * 0.5 * 1);
		expect(result.ignored).toEqual([]);
		expect(first.contributions.sentiment).toBeCloseTo(sentiment, 10);
		expect(first.contributions.pain).toBeCloseTo(-2 * pain, 10);
		expect(first.contributions.delight).toBeCloseTo(3 * delight, 10);
		expect(first.score).toBeCloseTo(sentiment - 2 * pain + 3 * delight, 10);
	});

	it('scores a Labour that holds nothing as 0 and never reports it missing', () => {
		const result = run({ sentiment: 1, pain: 1, delight: 1, perf: 1 });
		const empty = result.results.find((item) => item.key === 'AM-3')!;

		// Only the missing perf takes 0.5; the three sentiment features add nothing.
		expect(empty.score).toBeCloseTo(0.5, 10);
		expect(Object.keys(empty.contributions)).toEqual(['perf']);
		expect(result.coverage.missing).toEqual({ perf: 2 });
	});

	it('reports no missing key for the three features alone', () => {
		expect(run({ sentiment: 1, pain: 1, delight: 1 }).coverage.missing).toEqual({});
	});
});

describe('each Realm has its own Sentiment', () => {
	it('uses the loudness and Pulses of the Labour’s own Realm', () => {
		const quiet = seedRealm(db, 'LA');
		const loud = seedRealm(db, 'LB');
		const bare = seedRealm(db, 'LC');
		tuneRealm(db, actor, quiet.id, { loudness: 1 }, NOW);
		tuneRealm(db, actor, loud.id, { loudness: 9 }, NOW);
		for (const other of [quiet, loud, bare]) define(other.id, 'perf', 'scale', { min: 0, max: 4 });
		onePulse(quiet.id, { key: 'perf' });
		onePulse(loud.id, { key: 'perf' });
		labour(quiet.id, { perf: 4 });
		labour(loud.id, { perf: 4 });
		labour(bare.id, { perf: 4 });

		const result = survey(
			db,
			actor,
			{
				realmIds: [quiet.id, loud.id, bare.id],
				weights: { sentiment: 1 },
				temperature: 0
			},
			{ now: NOW }
		);

		// v = volume / (volume + loudness): 1/2, 1/10, and 0 for a key without Pulses.
		expectScores(scoresOf(result), { 'LA-1': 0.5, 'LB-1': 0.1, 'LC-1': 0 });
	});
});

describe('the batched loads', () => {
	function statementsFor(labourCount: number, key: string): number {
		const big = seedRealm(db, key);
		define(big.id, 'perf', 'scale', { min: 0, max: 4 });
		define(big.id, 'bugs', 'tags', { members: [{ key: 'lag', label: 'Lag' }] });
		onePulse(big.id, { key: 'perf' });
		onePulse(big.id, { key: 'bugs:lag' });
		for (let i = 0; i < labourCount; i++) labour(big.id, { perf: i % 5, bugs: ['lag'] });

		const spy = vi.spyOn(db.$client, 'prepare');
		try {
			survey(
				db,
				actor,
				{
					realmIds: [big.id],
					weights: { sentiment: 1, pain: 1, delight: 1 },
					limit: 50
				},
				{ now: NOW, random: () => 0.5 }
			);
			return spy.mock.calls.length;
		} finally {
			spy.mockRestore();
		}
	}

	it('loads Sentiment without a query per candidate', () => {
		const few = statementsFor(3, 'FEW');
		const many = statementsFor(40, 'MANY');

		expect(many).toBe(few);
	});
});

describe('the sentiment block of the result', () => {
	const block = (weights: Record<string, number>, extra = {}, now = NOW) =>
		run(weights, extra, now).sentiment as unknown as {
			realmId: number;
			key: string;
			volume: number;
			mood: number;
			pulses: {
				id: number;
				note: string;
				evidence: unknown[];
				authorId: number;
				createdAt: Date;
				weight: number;
			}[];
		}[];

	it.each(['sentiment', 'pain', 'delight'])('is filled when %s is weighted', (name) => {
		expect(block({ [name]: 1 }).length).toBeGreaterThan(0);
	});

	it.each([
		['an Attribute', { perf: 1 }],
		['built-in features that are not sentiment', { age: 1, activity: 1 }],
		['a weight of an ignored key', { similarity: 1 }]
	])('is empty when only %s is weighted', (_name, weights) => {
		expect(block(weights)).toEqual([]);
	});

	it('lists only keys that a returned Labour holds and that have Pulses', () => {
		const keys = block({ sentiment: 1 }, { filter: { labels: ['pick'] } });

		// AM-2 holds perf and speed (no Pulses); AM-4 holds bugs:lag. fun, ux and bugs:crash
		// have volume but only the unreturned AM-1 holds them.
		expect(keys.map((k) => k.key)).toEqual(['perf', 'bugs:lag']);
	});

	it('shows the key with its volume, mood and heaviest Pulses', () => {
		const keys = block({ sentiment: 1 }, { filter: { labels: ['pick'] } });

		expect(keys).toEqual([
			{
				realmId: realm.id,
				key: 'perf',
				volume: 3,
				mood: -1,
				pulses: [
					{
						id: pulseIds.perf,
						note: 'slow',
						evidence: [],
						authorId: actor.id,
						createdAt: NOW,
						weight: 3
					}
				]
			},
			{
				realmId: realm.id,
				key: 'bugs:lag',
				volume: 1,
				mood: 0.5,
				pulses: [
					{
						id: pulseIds.lag,
						note: 'laggy',
						evidence: [],
						authorId: actor.id,
						createdAt: NOW,
						weight: 1
					}
				]
			}
		]);
	});

	it('is empty when the returned Labours hold no key with Pulses', () => {
		labour(realm.id, { speed: 2 }, ['solo']);

		expect(block({ sentiment: 1 }, { filter: { labels: ['solo'] } })).toEqual([]);
	});

	it('orders by volume, then Realm key, then key', () => {
		const keys = block({ sentiment: 1 });

		expect(keys.map((k) => [k.key, k.volume])).toEqual([
			['perf', 3],
			['bugs:crash', 2],
			['bugs:lag', 1],
			['fun', 1],
			['ux', 1]
		]);
	});

	it('breaks a tie of volume by Realm key, not by Realm id', () => {
		const zz = seedRealm(db, 'ZZ');
		const aa = seedRealm(db, 'AA');
		for (const other of [zz, aa]) {
			define(other.id, 'perf', 'scale', { min: 0, max: 4 });
			onePulse(other.id, { key: 'perf', amount: 2 });
		}
		define(zz.id, 'tone', 'scale', { min: 0, max: 4 });
		onePulse(zz.id, { key: 'tone', amount: 5 });
		labour(zz.id, { perf: 2, tone: 2 });
		labour(aa.id, { perf: 2 });

		const result = survey(
			db,
			actor,
			{ realmIds: [zz.id, aa.id], weights: { sentiment: 1 }, temperature: 0 },
			{ now: NOW }
		);

		expect(result.sentiment.map((k) => [k.realmId, k.key])).toEqual([
			[zz.id, 'tone'],
			[aa.id, 'perf'],
			[zz.id, 'perf']
		]);
	});

	it('lists at most 10 keys, the heaviest', () => {
		const big = seedRealm(db, 'BIG');
		const members = Array.from({ length: 12 }, (_, i) => `m${String(i + 1).padStart(2, '0')}`);
		define(big.id, 'many', 'tags', { members: members.map((key) => ({ key, label: key })) });
		members.forEach((member, i) => {
			onePulse(big.id, { key: `many:${member}`, amount: (i + 1) * 0.5, halfLifeDays: null });
		});
		labour(big.id, { many: members });

		const result = survey(
			db,
			actor,
			{ realmIds: [big.id], weights: { sentiment: 1 }, temperature: 0 },
			{ now: NOW }
		);

		expect(result.sentiment.map((k) => k.key)).toEqual(
			members
				.slice(2)
				.reverse()
				.map((member) => `many:${member}`)
		);
	});

	it('shows the two heaviest Pulses of a key, with volume and mood over all of them', () => {
		const five = onePulse(realm.id, { key: 'perf', amount: 5, mood: 1, note: 'five' });
		onePulse(realm.id, { key: 'perf', amount: 0.5, mood: 0, note: 'half' });
		onePulse(realm.id, { key: 'perf', amount: 2, mood: 1, note: 'two' });

		const perf = block({ sentiment: 1 }).find((k) => k.key === 'perf')!;

		expect(perf.pulses.map((p) => p.id)).toEqual([five, pulseIds.perf]);
		expect(perf.pulses.map((p) => p.weight)).toEqual([5, 3]);
		expect(perf.volume).toBeCloseTo(10.5, 10);
		expect(perf.mood).toBeCloseTo((-3 + 5 + 0 + 2) / 10.5, 10);
	});

	it('weighs the Pulses at the Survey time', () => {
		const perf = block({ sentiment: 1 }, {}, LATER).find((k) => k.key === 'perf')!;

		expect(perf.volume).toBeCloseTo(1.5, 10);
		expect(perf.pulses[0].weight).toBeCloseTo(1.5, 10);
	});
});
