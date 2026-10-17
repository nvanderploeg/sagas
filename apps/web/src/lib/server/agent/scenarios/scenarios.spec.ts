import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '#lib/server/db/client.ts';
import { testDb } from '#lib/server/test/db.ts';
import { buildStormspire, type LabourName, type Stormspire } from '#lib/server/test/stormspire.ts';
import { DEFAULT_LOUDNESS } from '../attributes.ts';
import { reportOutcomes, type Verdict } from '../outcomes.ts';
import { readAffinity } from '../sentiment.ts';
import { survey, type SurveyInput, type SurveyResult } from '../survey/index.ts';
import { loadEmbedder, type Embedder } from '../vectors/embedder.ts';
import { createEmbeddingQueue } from '../vectors/index.ts';

// Scenario tests over the Stormspire fixture (test/stormspire.ts): a small game team with an
// artist (Ivy), a programmer (Rook) and a forum feeder agent. Each test pins a claim the agent
// layer makes about *why* a Labour surfaces, not only *that* it does. Where several features agree
// on a leader, a test isolates the one it is about with a single-weight Survey, so the claim
// cannot be carried by a neighbour.

let db: Db;
let spire: Stormspire;

beforeEach(() => {
	db = testDb();
	spire = buildStormspire(db);
});

afterEach(() => {
	db.$client.close();
});

const nameOf = (labourId: number) =>
	(Object.keys(spire.labours) as LabourName[]).find((name) => spire.labours[name].id === labourId)!;

const order = (result: SurveyResult) => result.results.map((item) => nameOf(item.labourId));

const itemOf = (result: SurveyResult, name: LabourName) =>
	result.results.find((item) => item.labourId === spire.labours[name].id)!;

const positionOf = (result: SurveyResult, name: LabourName) => order(result).indexOf(name);

const scoreOf = (result: SurveyResult, name: LabourName) => itemOf(result, name).score;

const strongest = (result: SurveyResult, name: LabourName, count: number) =>
	Object.entries(itemOf(result, name).contributions)
		.sort(([, a], [, b]) => Math.abs(b) - Math.abs(a))
		.slice(0, count)
		.map(([feature]) => feature);

function ask(
	who: 'ivy' | 'rook',
	input: Omit<SurveyInput, 'forUserId'>,
	queryVector?: Float32Array
) {
	return survey(
		db,
		{ id: spire.users[who] },
		{ forUserId: spire.users[who], temperature: 0, limit: 50, ...input },
		{ now: spire.now, queryVector }
	);
}

const sentimentOf = (result: SurveyResult, key: string) =>
	result.sentiment.find((entry) => entry.key === key)!;

// `pain` of a Labour holding one loud key with full reach: the key's strength v = volume /
// (volume + loudness), times how negative its mood is.
const painOf = (result: SurveyResult, key: string) => {
	const { volume, mood } = sentimentOf(result, key);
	return (volume / (volume + DEFAULT_LOUDNESS)) * Math.max(0, -mood);
};

function checkBossNotes(result: SurveyResult) {
	const boss = sentimentOf(result, 'area:boss');
	expect(boss.pulses.map((pulse) => pulse.note)).toEqual([
		'Bosses are bullet sponges, 40 upvotes',
		'Dragon fight drags'
	]);
	expect(boss.pulses[0].evidence).toContainEqual({ labour: spire.labours.sponge.id });
	expect(boss.pulses[1].evidence).toEqual([{ labour: spire.labours.dragon.id }]);
}

function report(surveyId: number, outcomes: [LabourName, Verdict][]) {
	reportOutcomes(
		db,
		{ id: spire.users.rook },
		surveyId,
		outcomes.map(([name, verdict]) => ({ labourId: spire.labours[name].id, verdict })),
		spire.now
	);
}

const affinityOf = (who: 'ivy' | 'rook') =>
	Object.fromEntries(
		readAffinity(db, spire.users[who], { now: spire.now }).keys.map((entry) => [
			entry.key,
			{ volume: entry.volume, mood: entry.mood }
		])
	);

describe("the artist's biggest win today", () => {
	// Ivy is the team's artist (vfx 4, animation 3, ui-art 2). She asks for the work she is best
	// placed to do, that matters, that people have already pulled her into, weighted by what players
	// feel, discounted by effort. The forum has been loud about bosses, and the telegraph design has
	// been breaking down into VFX and animation tasks that Rook has asked her about by name.
	const WEIGHTS = { skill_fit: 3, impact: 2, pulled_in: 1, mentions: 1, pain: 1, effort: -1 };

	it('puts her VFX and animation boss tasks on top, led by the glow she was asked about', () => {
		const result = ask('ivy', { weights: WEIGHTS });

		expect(order(result).slice(0, 3)).toEqual(['glow', 'anticipation', 'embers']);
		expect(result.ignored).toEqual([]);
	});

	it('ranks work only a programmer can do, and unrelated work, below her boss tasks', () => {
		const result = ask('ivy', { weights: WEIGHTS });

		for (const name of ['hitStop', 'hpRetune', 'saveMigration', 'oauth', 'typo', 'roar'] as const) {
			expect(positionOf(result, name), name).toBeGreaterThan(positionOf(result, 'embers'));
		}
		expect(order(result)).not.toContain('iFrames');
	});

	it('shows her Skills and the impact of the work driving the leaders', () => {
		const result = ask('ivy', { weights: WEIGHTS });

		for (const name of ['glow', 'anticipation', 'embers'] as const) {
			expect(strongest(result, name, 2), name).toEqual(['skill_fit', 'impact']);
			expect(itemOf(result, name).contributions.skill_fit, name).toBeCloseTo(3);
		}
		expect(itemOf(result, 'saveMigration').contributions.skill_fit ?? 0).toBeCloseTo(0);
	});

	it('lets player pain lift the boss VFX over a UI fix she is just as fit for', () => {
		// The ember burst and the sort-button fix both need only Skills Ivy holds in full (fit 1),
		// and impact minus effort comes out level: 1 - 1/2 for the embers, 1/2 - 0 for the button
		// on the 1-5 scales. What separates them is the forum: area:boss is loud and angry,
		// area:ui is quiet and mildly unhappy. `pain` is the whole margin, at the size the Realm's
		// Sentiment says it should be.
		const result = ask('ivy', { weights: WEIGHTS });
		const embers = itemOf(result, 'embers').contributions;
		const button = itemOf(result, 'sortButton').contributions;

		expect(embers.pain).toBeCloseTo(painOf(result, 'area:boss'), 6);
		expect(button.pain).toBeCloseTo(painOf(result, 'area:ui'), 6);
		expect(embers.pain).toBeGreaterThan(0.5);
		expect(button.pain).toBeLessThan(0.1);

		expect(scoreOf(result, 'embers') - embers.pain).toBeCloseTo(
			scoreOf(result, 'sortButton') - button.pain,
			6
		);
		expect(positionOf(result, 'embers')).toBeLessThan(positionOf(result, 'sortButton'));
	});

	it('shows being pulled in only where people asked her, and mentions where they pointed at the work', () => {
		const mentioned = ask('ivy', { weights: { mentions: 1 } });
		expect(scoreOf(mentioned, 'glow')).toBeGreaterThan(0);

		const pulled = ask('ivy', { weights: { pulled_in: 1 } });
		expect(order(pulled).slice(0, 3)).toEqual(['glow', 'anticipation', 'menuAnim']);
		for (const name of order(pulled).slice(3)) expect(scoreOf(pulled, name), name).toBe(0);
	});

	it("carries the forum's notes on the boss, behind what players feel", () => {
		const result = ask('ivy', { weights: WEIGHTS });

		const boss = sentimentOf(result, 'area:boss');
		expect(boss.mood).toBeLessThan(-0.7);
		expect(boss.volume).toBeGreaterThan(10);
		checkBossNotes(result);
	});

	it('is a different answer for the programmer with the same weights', () => {
		const result = ask('rook', { weights: WEIGHTS });

		expect(order(result)[0]).toBe('hpRetune');
		for (const name of ['glow', 'anticipation', 'embers'] as const) {
			expect(positionOf(result, name), name).toBeGreaterThan(2);
		}
	});
});

describe("the programmer's ask: improve combat feel for boss fights", () => {
	// Rook has been asked to improve combat feel for boss fights. He wants the reports that bosses
	// feel like bullet sponges, the design work on telegraph feedback, and the Sentiment notes behind
	// them, so an agent can say: "We've had recent reports that bosses feel like bullet sponges, and
	// several design items lay out how improving feedback on telegraphs gives players more
	// decision-making moments. Want to dig in?"
	const QUERY = 'improve combat feel for boss fights';
	const WEIGHTS = { keywords: 2, pain: 2, evidence: 1, skill_fit: 1 };
	const LEADERS: LabourName[] = [
		'damagePhases',
		'telegraph',
		'sponge',
		'hpRetune',
		'cantTell',
		'dragon'
	];
	const TRAILING: LabourName[] = [
		'sortButton',
		'stackCount',
		'menuAnim',
		'inventoryLayout',
		'oauth',
		'typo',
		'saveMigration'
	];

	it('leads with the bullet-sponge report and the telegraph and damage designs', () => {
		const result = ask('rook', { query: QUERY, weights: WEIGHTS });

		expect(new Set(order(result).slice(0, LEADERS.length))).toEqual(new Set(LEADERS));
		expect(new Set(order(result).slice(0, 3))).toEqual(
			new Set(['damagePhases', 'telegraph', 'sponge'])
		);
	});

	it('trails unrelated work, including UI and the positive dodge report', () => {
		const result = ask('rook', { query: QUERY, weights: WEIGHTS });

		const lastLeader = Math.max(...LEADERS.map((name) => positionOf(result, name)));
		for (const name of [...TRAILING, 'dodge'] as const) {
			expect(positionOf(result, name), name).toBeGreaterThan(lastLeader);
		}
		expect(order(result)).not.toContain('iFrames');
	});

	it('explains the leaders by keywords and pain, and lifts the designs by the reports behind them', () => {
		// Every leader shares words with the ask and every one is about bosses, so `keywords` and
		// `pain` are present on all six; `pain` is the same for each since area:boss is their only
		// angry key. `evidence` counts the reports linked as supporting a design: the sponge, dragon
		// and slam reports support the telegraph design (3 / (3 + 2)), the sponge and dragon
		// reports the damage design (2 / (2 + 2)). Without it the telegraph design would fall
		// behind the slam report it answers.
		const result = ask('rook', { query: QUERY, weights: WEIGHTS });
		const bossPain = 2 * painOf(result, 'area:boss');

		for (const name of LEADERS) {
			const contributions = itemOf(result, name).contributions;
			expect(contributions.keywords, name).toBeGreaterThan(0.2);
			expect(contributions.pain, name).toBeCloseTo(bossPain, 6);
		}
		expect(itemOf(result, 'sponge').contributions.keywords).toBeCloseTo(2);

		expect(itemOf(result, 'telegraph').contributions.evidence).toBeCloseTo(3 / 5);
		expect(itemOf(result, 'damagePhases').contributions.evidence).toBeCloseTo(2 / 4);
		expect(itemOf(result, 'sponge').contributions.evidence ?? 0).toBe(0);
		expect(itemOf(result, 'glow').contributions.evidence ?? 0).toBe(0);

		const telegraph = itemOf(result, 'telegraph');
		expect(positionOf(result, 'telegraph')).toBeLessThan(positionOf(result, 'cantTell'));
		expect(telegraph.score - telegraph.contributions.evidence).toBeLessThan(
			scoreOf(result, 'cantTell')
		);
		expect(positionOf(result, 'damagePhases')).toBeLessThan(positionOf(result, 'hpRetune'));
	});

	it('gives no pain to combat work players are happy with', () => {
		// area:combat is loud on the forum, but warm: the dodge roll feels great. Pain reads only
		// unhappy keys, so the dodge report and the hit-stop task (both area:combat, neither
		// area:boss) take none, while `delight` sees the same key.
		const pain = ask('rook', { weights: { pain: 1 } });
		const delight = ask('rook', { weights: { delight: 1 } });

		for (const name of ['dodge', 'hitStop'] as const) {
			expect(scoreOf(pain, name), name).toBe(0);
			expect(scoreOf(delight, name), name).toBeGreaterThan(0.2);
		}
		expect(scoreOf(pain, 'sponge')).toBeGreaterThan(0.5);
	});

	it('carries the area:boss notes behind the pain', () => {
		const result = ask('rook', { query: QUERY, weights: WEIGHTS });

		expect(sentimentOf(result, 'area:boss').mood).toBeLessThan(-0.7);
		checkBossNotes(result);
		expect(result.coverage).toMatchObject({ candidates: 19, unappraised: 0, stale: 0 });
	});

	it('moves his Affinity when he picks the telegraph design and skips a UI report', () => {
		const asked = ask('rook', { query: QUERY, weights: WEIGHTS });
		const before = ask('rook', { weights: { affinity: 1 } });
		expect(before.results.every((item) => item.score === 0)).toBe(true);

		report(asked.surveyId, [
			['telegraph', 'picked'],
			['stackCount', 'skipped']
		]);

		const affinity = affinityOf('rook');
		expect(affinity['area:boss'].mood).toBe(1);
		expect(affinity['area:vfx'].mood).toBe(1);
		expect(affinity['kind:design'].mood).toBe(1);
		expect(affinity['area:ui'].mood).toBe(-1);
		expect(affinity['kind:report'].mood).toBe(-1);

		const after = ask('rook', { query: QUERY, weights: { ...WEIGHTS, affinity: 2 } });
		expect(itemOf(after, 'damagePhases').contributions.affinity).toBeGreaterThan(0.5);
		expect(itemOf(after, 'sortButton').contributions.affinity).toBeLessThan(0);
		expect(itemOf(after, 'oauth').contributions.affinity ?? 0).toBeLessThan(
			itemOf(after, 'damagePhases').contributions.affinity
		);
		expect(itemOf(after, 'telegraph').contributions.affinity).toBeGreaterThan(
			itemOf(after, 'damagePhases').contributions.affinity
		);
		expect(positionOf(asked, 'telegraph')).toBeGreaterThan(0);
		expect(order(after)[0]).toBe('telegraph');
		expect(positionOf(after, 'stackCount')).toBeGreaterThan(positionOf(asked, 'stackCount'));
	});
});

describe('what each signal means on its own', () => {
	// Single-weight Surveys: the score is the feature's value, with nothing else to carry it.

	it('scores Skill fit by how much of each need is held, not by holding any of it', () => {
		// Ivy holds ui-art 2; the inventory layout needs ui-art 3, so she covers 2/3 of it. Rook
		// holds audio 1; the roar cue needs audio 3, so he covers 1/3. A level above the need counts
		// as the need (Ivy's vfx 4 against the glow's 3), and a Labour that needs nothing she holds
		// fits not at all.
		const ivy = ask('ivy', { weights: { skill_fit: 1 } });
		const rook = ask('rook', { weights: { skill_fit: 1 } });

		expect(scoreOf(ivy, 'inventoryLayout')).toBeCloseTo(2 / 3);
		expect(scoreOf(ivy, 'glow')).toBeCloseTo(1);
		expect(scoreOf(ivy, 'menuAnim')).toBeCloseTo(1);
		expect(scoreOf(ivy, 'telegraph')).toBe(0);
		expect(scoreOf(rook, 'roar')).toBeCloseTo(1 / 3);
		expect(scoreOf(rook, 'hitStop')).toBeCloseTo(1);
		expect(scoreOf(rook, 'glow')).toBe(0);
	});

	it('records each verdict at its own weight, scale keys included, and leaves other Users untouched', () => {
		// A verdict posts one Affinity Pulse per key the Labour holds, of amount base × reach:
		// picked 1, done 2, skipped 0.5 (mood -1). The telegraph design (picked) alone is
		// kind:design, the stack-count report (skipped) alone kind:report, the HP retune (done)
		// alone kind:task. Scale keys post at their place on the scale: impact 4, 3 and 5 reach
		// 3/4, 1/2 and 1; effort 4 and 2 reach 3/4 and 1/4, and the retune's effort 1 reaches
		// nothing and posts nothing.
		const asked = ask('rook', { weights: { impact: 1 } });
		report(asked.surveyId, [
			['telegraph', 'picked'],
			['stackCount', 'skipped'],
			['hpRetune', 'done']
		]);

		const rook = affinityOf('rook');
		expect(rook['kind:design'].volume).toBeCloseTo(1);
		expect(rook['kind:report'].volume).toBeCloseTo(0.5);
		expect(rook['kind:task'].volume).toBeCloseTo(2);
		expect(rook['kind:report'].mood).toBe(-1);

		expect(Object.keys(rook)).toEqual(expect.arrayContaining(['impact', 'effort']));
		expect(rook.impact.volume).toBeCloseTo(3 / 4 + 1 / 4 + 2);
		expect(rook.impact.mood).toBeCloseTo((3 / 4 - 1 / 4 + 2) / 3);
		expect(rook.effort.volume).toBeCloseTo(3 / 4 + 1 / 8);
		expect(rook.effort.mood).toBeCloseTo((3 / 4 - 1 / 8) / (3 / 4 + 1 / 8));

		const forRook = ask('rook', { weights: { affinity: 1 } });
		expect(scoreOf(forRook, 'damagePhases')).toBeGreaterThan(0);

		// The Outcomes were Rook's; Ivy's Affinity, and every Survey made for her, are untouched.
		expect(affinityOf('ivy')).toEqual({});
		const forIvy = ask('ivy', { weights: { affinity: 1 } });
		expect(forIvy.results.every((item) => item.score === 0)).toBe(true);
	});
});

const MODEL_FILES = [
	'config.json',
	'tokenizer.json',
	'tokenizer_config.json',
	'onnx/model_quantized.onnx'
].map((file) => join('Xenova/bge-small-en-v1.5', file));
const modelDir = resolve(process.cwd(), process.env.EMBEDDING_MODEL_DIR ?? 'models');
const modelPresent = MODEL_FILES.every((file) => existsSync(join(modelDir, file)));

describe.skipIf(!modelPresent)("the programmer's ask against the shipped model", () => {
	// The same ask, with every Labour embedded by the real model and the query's vector added to the
	// Survey as `similarity`. The lexical features already pick the leaders, so the claims about
	// `similarity` are made where it acts alone, as margins between groups rather than exact scores,
	// so they survive small numeric drift in the model.
	const QUERY = 'improve combat feel for boss fights';
	const LEXICAL = { keywords: 2, pain: 2, evidence: 1, skill_fit: 1 };
	const WEIGHTS = { similarity: 3, ...LEXICAL };
	const BOSS_FIGHT: LabourName[] = ['sponge', 'telegraph', 'damagePhases', 'cantTell', 'dragon'];
	const UNRELATED: LabourName[] = [
		'oauth',
		'typo',
		'saveMigration',
		'sortButton',
		'stackCount',
		'inventoryLayout',
		'menuAnim'
	];
	let embedder: Embedder;
	let queryVector: Float32Array;

	beforeAll(async () => {
		const loaded = await loadEmbedder(modelDir);
		if (loaded === null) throw new Error(`loadEmbedder returned null for ${modelDir}`);
		embedder = loaded;
		queryVector = await embedder.embedQuery(QUERY);
	}, 120_000);

	beforeEach(async () => {
		const queue = createEmbeddingQueue(db, embedder);
		for (const { id } of Object.values(spire.labours)) queue.enqueue(id);
		await queue.drain();
	}, 120_000);

	const similar = () => ask('rook', { query: QUERY, weights: { similarity: 1 } }, queryVector);

	it('embeds every Labour and leads with the boss-fight reports and designs', () => {
		const result = ask('rook', { query: QUERY, weights: WEIGHTS }, queryVector);

		expect(result.coverage.unembedded).toBe(0);
		expect(result.coverage.missing.similarity).toBeUndefined();
		expect(new Set(order(result).slice(0, 3))).toEqual(
			new Set(['damagePhases', 'telegraph', 'sponge'])
		);
	});

	it('separates the boss-fight work from the unrelated by meaning alone', () => {
		// Measured with the pinned model: the boss-fight five score about 0.36 to 0.61 and the
		// unrelated seven at most about 0.13. The ratio of 2 and the bounds leave room for int8
		// kernels that differ between CPUs, while still failing if every embedded Labour scored
		// alike or the floor stopped holding the unrelated near 0.
		const result = similar();
		const lowestBossFight = Math.min(...BOSS_FIGHT.map((name) => scoreOf(result, name)));
		const highestUnrelated = Math.max(...UNRELATED.map((name) => scoreOf(result, name)));

		expect(lowestBossFight).toBeGreaterThan(2 * highestUnrelated);
		expect(highestUnrelated).toBeLessThan(0.2);
		for (const name of [...BOSS_FIGHT, ...UNRELATED]) {
			expect(scoreOf(result, name), name).toBeGreaterThanOrEqual(0);
			expect(scoreOf(result, name), name).toBeLessThanOrEqual(1);
		}
		expect(scoreOf(result, 'oauth')).toBeLessThan(0.02);
		expect(scoreOf(result, 'sortButton')).toBeLessThan(0.05);
	});

	it('finds combat-feel work the words of the query miss', () => {
		// The hit-stop task shares no word with the ask, so the lexical run gives it no `keywords`
		// and it ties the save-migration crash on Skill fit alone. The model knows hit-stop is
		// combat feel: alone it scores well clear of every unrelated Labour, and with the model in
		// the ask it pulls ahead of the crash.
		const lexical = ask('rook', { query: QUERY, weights: LEXICAL });
		expect(itemOf(lexical, 'hitStop').contributions.keywords).toBeUndefined();
		expect(scoreOf(lexical, 'hitStop')).toBeCloseTo(scoreOf(lexical, 'saveMigration'));

		const alone = similar();
		const highestUnrelated = Math.max(...UNRELATED.map((name) => scoreOf(alone, name)));
		expect(scoreOf(alone, 'hitStop')).toBeGreaterThan(2 * highestUnrelated);

		const result = ask('rook', { query: QUERY, weights: WEIGHTS }, queryVector);
		expect(scoreOf(result, 'hitStop') - scoreOf(result, 'saveMigration')).toBeGreaterThan(0.5);
		for (const name of UNRELATED) {
			expect(positionOf(result, name), name).toBeGreaterThan(positionOf(result, 'dragon'));
			expect(positionOf(result, name), name).toBeGreaterThan(positionOf(result, 'hitStop'));
		}
	}, 120_000);
});
