import { asc, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '#lib/server/db/client.ts';
import { events, labours, outcomes, pulses, surveys } from '#lib/server/db/schema.ts';
import { DomainError } from '#lib/server/domain/errors.ts';
import type { Actor } from '#lib/server/domain/write.ts';
import { testDb } from '#lib/server/test/db.ts';
import { seedActor, seedLabour, seedRealm, seedUser } from '#lib/server/test/fixtures.ts';
import {
	defineAttribute,
	deleteAttribute,
	readAttributes,
	readRealmAgent,
	setValues,
	tuneRealm
} from './attributes.ts';
import { reportOutcomes, type Verdict } from './outcomes.ts';
import { postPulses, prunePulses, readAffinity, readSentiment } from './sentiment.ts';
import { pruneSurveys, survey } from './survey/index.ts';

let db: Db;
let actor: Actor;

beforeEach(() => {
	db = testDb();
	actor = seedActor(db);
});

afterEach(() => {
	db.$client.close();
});

const DAY = 86_400_000;
const NOW = new Date('2026-03-01T12:00:00.000Z');
const daysAgo = (days: number) => new Date(NOW.getTime() - days * DAY);

// Every Labour scores 0 on it while no Links exist, so the order is the board order.
const NEUTRAL = { evidence: 1 };

function expectDomainError(action: () => unknown, code: DomainError['code']) {
	let thrown: unknown;
	try {
		action();
	} catch (error) {
		thrown = error;
	}
	expect(thrown).toBeInstanceOf(DomainError);
	expect((thrown as DomainError).code).toBe(code);
}

const json = (value: unknown) => (typeof value === 'string' ? JSON.parse(value) : value) as any;

function scale(realmId: number, key: string, min: number, max: number) {
	defineAttribute(db, actor, realmId, {
		key,
		kind: 'scale',
		label: key,
		rubric: 'rubric',
		spec: { min, max }
	});
}

function tags(realmId: number, key: string, members: string[]) {
	defineAttribute(db, actor, realmId, {
		key,
		kind: 'tags',
		label: key,
		rubric: 'rubric',
		spec: { members: members.map((member) => ({ key: member, label: member })) }
	});
}

const set = (labourId: number, values: Record<string, unknown>) =>
	setValues(db, actor, labourId, values);

const attributeId = (realmId: number, key: string) =>
	readAttributes(db, realmId).find((a) => a.key === key)!.id;

function ask(forUserId: number, input: { limit?: number; realmIds?: number[] } = {}, at = NOW) {
	return survey(db, actor, { weights: NEUTRAL, temperature: 0, forUserId, ...input }, { now: at })
		.surveyId;
}

type Item = { labourId: number; verdict: Verdict };

const report = (surveyId: number, items: Item[], by: number, at = NOW) =>
	reportOutcomes(db, { id: by }, surveyId, items, at);

const affinityRows = (userId: number) =>
	db.select().from(pulses).where(eq(pulses.userId, userId)).orderBy(asc(pulses.id)).all();

const byRawKey = <T extends { rawKey: string }>(rows: T[]) =>
	[...rows].sort((a, b) => (a.rawKey < b.rawKey ? -1 : 1));

const storedOutcomes = () =>
	db
		.select()
		.from(outcomes)
		.all()
		.sort((a, b) => a.labourId - b.labourId || (a.verdict < b.verdict ? -1 : 1));

// `rich` holds impact 3 of 0-4 (x 0.75), effort 2 of 1-5 (x 0.25), area audio and ui (x 1 each).
function world() {
	const am = seedRealm(db, 'AM');
	scale(am.id, 'impact', 0, 4);
	scale(am.id, 'effort', 1, 5);
	tags(am.id, 'area', ['ui', 'audio', 'net']);
	const bob = seedUser(db, 'bob');
	const carol = seedUser(db, 'carol');
	const rich = seedLabour(db, { realmId: am.id, title: 'Rich' });
	const plain = seedLabour(db, { realmId: am.id, title: 'Plain' });
	set(rich.id, { impact: 3, effort: 2, area: ['audio', 'ui'] });
	return { am, bob, carol, rich, plain };
}

describe('reportOutcomes validation', () => {
	it('refuses an unknown Survey as not_found and stores nothing', () => {
		const { rich, bob, carol } = world();

		expectDomainError(
			() => report(9999, [{ labourId: rich.id, verdict: 'picked' }], carol),
			'not_found'
		);

		expect(storedOutcomes()).toEqual([]);
		expect(affinityRows(bob)).toEqual([]);
	});

	it('refuses an empty list as invalid', () => {
		const { bob, carol } = world();

		expectDomainError(() => report(ask(bob), [], carol), 'invalid');
	});

	it('takes 50 items and refuses 51 as invalid, recording nothing for the refused call', () => {
		const am = seedRealm(db, 'AM');
		const bob = seedUser(db, 'bob');
		const carol = seedUser(db, 'carol');
		const all = Array.from({ length: 50 }, () => seedLabour(db, { realmId: am.id }));
		const id = ask(bob, { limit: 50 });
		const items = all.map((l): Item => ({ labourId: l.id, verdict: 'picked' }));

		expectDomainError(() => report(id, [...items, items[0]], carol), 'invalid');
		expect(storedOutcomes()).toEqual([]);
		const reported = report(id, items, carol);

		expect(reported).toHaveLength(50);
		expect(reported.every((r) => r.recorded)).toBe(true);
		expect(storedOutcomes()).toHaveLength(50);
	});

	it('refuses a verdict that is not picked, skipped or done as invalid', () => {
		const { rich, bob, carol } = world();
		const id = ask(bob);

		for (const verdict of ['liked', '']) {
			expectDomainError(
				() => report(id, [{ labourId: rich.id, verdict: verdict as Verdict }], carol),
				'invalid'
			);
		}

		expect(storedOutcomes()).toEqual([]);
		expect(affinityRows(bob)).toEqual([]);
	});

	it('refuses a Labour id that is not in the Survey results as invalid', () => {
		const { bob, carol } = world();

		expectDomainError(
			() => report(ask(bob), [{ labourId: 9999, verdict: 'picked' }], carol),
			'invalid'
		);
		expect(storedOutcomes()).toEqual([]);
	});

	it('refuses a Labour that matched the Survey but was cut by its limit', () => {
		const { am, rich, bob, carol } = world();
		const cut = seedLabour(db, { realmId: am.id, title: 'Cut' });
		set(cut.id, { impact: 4 });
		const id = ask(bob, { limit: 1 });
		const stored = json(db.select().from(surveys).where(eq(surveys.id, id)).get()!.results);
		expect(stored.map((r: { labour: number }) => r.labour)).toEqual([rich.id]);

		expectDomainError(
			() => report(id, [{ labourId: cut.id, verdict: 'picked' }], carol),
			'invalid'
		);

		expect(storedOutcomes()).toEqual([]);
		expect(affinityRows(bob)).toEqual([]);
	});

	it('refuses a Labour from a Realm the Survey did not cover', () => {
		const { am, bob, carol } = world();
		const bl = seedRealm(db, 'BL');
		const elsewhere = seedLabour(db, { realmId: bl.id });
		const id = ask(bob, { realmIds: [am.id] });

		expectDomainError(
			() => report(id, [{ labourId: elsewhere.id, verdict: 'picked' }], carol),
			'invalid'
		);
		expect(storedOutcomes()).toEqual([]);
	});

	it('records nothing when any item of the batch is refused, whichever comes first', () => {
		const { rich, bob, carol } = world();
		const id = ask(bob);
		const good: Item = { labourId: rich.id, verdict: 'picked' };
		const unknown: Item = { labourId: 9999, verdict: 'picked' };
		const badVerdict = { labourId: rich.id, verdict: 'nope' } as unknown as Item;

		expectDomainError(() => report(id, [good, unknown], carol), 'invalid');
		expectDomainError(() => report(id, [unknown, good], carol), 'invalid');
		expectDomainError(() => report(id, [good, badVerdict], carol), 'invalid');
		expectDomainError(() => report(id, [badVerdict, good], carol), 'invalid');

		expect(storedOutcomes()).toEqual([]);
		expect(db.select().from(pulses).all()).toEqual([]);
	});
});

describe('reportOutcomes recording', () => {
	it('answers each item in the order given, recorded true', () => {
		const { rich, plain, bob, carol } = world();
		const id = ask(bob);

		const answered = report(
			id,
			[
				{ labourId: plain.id, verdict: 'skipped' },
				{ labourId: rich.id, verdict: 'picked' }
			],
			carol
		);

		expect(answered).toEqual([
			{ labourId: plain.id, verdict: 'skipped', recorded: true },
			{ labourId: rich.id, verdict: 'picked', recorded: true }
		]);
	});

	it('stores the Survey, Labour, verdict, the reporter and the time', () => {
		const { rich, bob, carol } = world();
		const id = ask(bob);

		report(id, [{ labourId: rich.id, verdict: 'picked' }], carol, daysAgo(2));

		expect(db.select().from(outcomes).all()).toEqual([
			{
				surveyId: id,
				labourId: rich.id,
				verdict: 'picked',
				authorId: carol,
				via: null,
				createdAt: daysAgo(2)
			}
		]);
	});

	it('lets a User who is neither the Survey actor nor the Survey User report', () => {
		const { rich, bob, carol } = world();
		const id = ask(bob);
		expect(new Set([actor.id, bob, carol]).size).toBe(3);

		const answered = report(id, [{ labourId: rich.id, verdict: 'done' }], carol);

		expect(answered[0].recorded).toBe(true);
	});

	it('changes nothing when a Labour already has that verdict for the Survey', () => {
		const { rich, bob, carol } = world();
		const dave = seedUser(db, 'dave');
		const id = ask(bob);
		report(id, [{ labourId: rich.id, verdict: 'picked' }], carol);
		const outcomesBefore = storedOutcomes();
		const pulsesBefore = db.select().from(pulses).orderBy(asc(pulses.id)).all();

		const again = report(
			id,
			[{ labourId: rich.id, verdict: 'picked' }],
			dave,
			new Date(NOW.getTime() + DAY)
		);

		expect(again).toEqual([{ labourId: rich.id, verdict: 'picked', recorded: false }]);
		expect(storedOutcomes()).toEqual(outcomesBefore);
		expect(db.select().from(pulses).orderBy(asc(pulses.id)).all()).toEqual(pulsesBefore);
	});

	it('records the new item of a batch beside a repeat, posting Pulses for the new one only', () => {
		const { rich, plain, bob, carol } = world();
		set(plain.id, { impact: 4 });
		const id = ask(bob);
		report(id, [{ labourId: rich.id, verdict: 'picked' }], carol);
		const before = affinityRows(bob).length;

		const answered = report(
			id,
			[
				{ labourId: rich.id, verdict: 'picked' },
				{ labourId: plain.id, verdict: 'picked' }
			],
			carol
		);

		expect(answered.map((r) => r.recorded)).toEqual([false, true]);
		expect(storedOutcomes()).toHaveLength(2);
		expect(affinityRows(bob)).toHaveLength(before + 1);
	});

	it('keeps picked then done as two Outcomes, each posting its own Pulses', () => {
		const { rich, bob, carol } = world();
		const id = ask(bob);

		const first = report(id, [{ labourId: rich.id, verdict: 'picked' }], carol);
		const second = report(id, [{ labourId: rich.id, verdict: 'done' }], carol);

		expect(first[0].recorded).toBe(true);
		expect(second[0].recorded).toBe(true);
		expect(storedOutcomes().map((o) => o.verdict)).toEqual(['done', 'picked']);
		const rows = affinityRows(bob);
		expect(rows).toHaveLength(8);
		expect(rows.filter((r) => r.note.startsWith('picked'))).toHaveLength(4);
		expect(rows.filter((r) => r.note.startsWith('done'))).toHaveLength(4);
	});

	it('treats picked then skipped as two Outcomes too', () => {
		const { rich, bob, carol } = world();
		const id = ask(bob);

		report(id, [{ labourId: rich.id, verdict: 'picked' }], carol);
		const second = report(id, [{ labourId: rich.id, verdict: 'skipped' }], carol);

		expect(second[0].recorded).toBe(true);
		expect(storedOutcomes()).toHaveLength(2);
	});

	it('records the same verdict for the same Labour in another Survey', () => {
		const { rich, bob, carol } = world();
		const first = ask(bob);
		const second = ask(bob);
		report(first, [{ labourId: rich.id, verdict: 'picked' }], carol);

		const answered = report(second, [{ labourId: rich.id, verdict: 'picked' }], carol);

		expect(answered[0].recorded).toBe(true);
		expect(affinityRows(bob)).toHaveLength(8);
	});

	it('records an Outcome for a Labour that holds no values and posts no Pulse', () => {
		const { plain, bob, carol } = world();
		const id = ask(bob);

		const answered = report(id, [{ labourId: plain.id, verdict: 'picked' }], carol);

		expect(answered[0].recorded).toBe(true);
		expect(storedOutcomes()).toHaveLength(1);
		expect(affinityRows(bob)).toEqual([]);
	});

	it('records no Event, leaves labours.updatedAt alone and does not bump the Realm version', () => {
		const { am, rich, bob, carol } = world();
		const id = ask(bob);
		const eventsBefore = db.select().from(events).all();
		const laboursBefore = db.select().from(labours).all();
		const versionBefore = readRealmAgent(db, am.id).version;
		expect(versionBefore).toBeGreaterThan(0);

		report(id, [{ labourId: rich.id, verdict: 'done' }], carol, new Date(NOW.getTime() + 5 * DAY));

		expect(db.select().from(events).all()).toEqual(eventsBefore);
		expect(db.select().from(labours).all()).toEqual(laboursBefore);
		expect(readRealmAgent(db, am.id).version).toBe(versionBefore);
	});
});

describe('Affinity Pulses', () => {
	it('posts one per held key, filed under the Attribute and member, to the Survey User', () => {
		const { am, rich, bob, carol } = world();
		const id = ask(bob);

		report(id, [{ labourId: rich.id, verdict: 'picked' }], carol);

		const rows = byRawKey(affinityRows(bob));
		expect(
			rows.map((r) => ({
				userId: r.userId,
				realmId: r.realmId,
				attributeId: r.attributeId,
				member: r.member,
				rawKey: r.rawKey,
				amount: r.amount,
				mood: r.mood,
				halfLifeDays: r.halfLifeDays,
				note: r.note,
				evidence: json(r.evidence),
				authorId: r.authorId,
				createdAt: r.createdAt
			}))
		).toEqual(
			[
				['area:audio', 'area', 'audio', 1],
				['area:ui', 'area', 'ui', 1],
				['effort', 'effort', null, 0.25],
				['impact', 'impact', null, 0.75]
			].map(([rawKey, attribute, member, amount]) => ({
				userId: bob,
				realmId: null,
				attributeId: attributeId(am.id, attribute as string),
				member,
				rawKey,
				amount,
				mood: 1,
				halfLifeDays: 30,
				note: `picked AM-1 in Survey ${id}`,
				evidence: [{ labour: rich.id }],
				authorId: carol,
				createdAt: NOW
			}))
		);
	});

	it.each([
		['picked', 1, 1],
		['done', 2, 1],
		['skipped', 0.5, -1]
	] as const)('weights a %s Outcome by base %s with mood %s', (verdict, base, mood) => {
		const { rich, bob, carol } = world();
		const id = ask(bob);

		report(id, [{ labourId: rich.id, verdict }], carol);

		const rows = byRawKey(affinityRows(bob));
		expect(rows.map((r) => [r.rawKey, r.amount, r.mood])).toEqual([
			['area:audio', base * 1, mood],
			['area:ui', base * 1, mood],
			['effort', base * 0.25, mood],
			['impact', base * 0.75, mood]
		]);
		expect(rows.every((r) => r.note === `${verdict} AM-1 in Survey ${id}`)).toBe(true);
	});

	it('skips a scale key at its minimum, whatever the minimum is', () => {
		const { am, bob, carol } = world();
		const floor = seedLabour(db, { realmId: am.id });
		set(floor.id, { impact: 0, effort: 1, area: ['ui'] });
		const id = ask(bob);

		report(id, [{ labourId: floor.id, verdict: 'picked' }], carol);

		expect(affinityRows(bob).map((r) => r.rawKey)).toEqual(['area:ui']);
	});

	it('posts base x 1 for a scale value at its maximum', () => {
		const { am, bob, carol } = world();
		const top = seedLabour(db, { realmId: am.id });
		set(top.id, { impact: 4, effort: 5 });
		const id = ask(bob);

		report(id, [{ labourId: top.id, verdict: 'done' }], carol);

		expect(byRawKey(affinityRows(bob)).map((r) => [r.rawKey, r.amount])).toEqual([
			['effort', 2],
			['impact', 2]
		]);
	});

	it('posts nothing for a key the Labour holds no value for, or for a text Attribute', () => {
		const { am, bob, carol } = world();
		defineAttribute(db, actor, am.id, {
			key: 'notes',
			kind: 'text',
			label: 'Notes',
			rubric: 'rubric'
		});
		const sparse = seedLabour(db, { realmId: am.id });
		set(sparse.id, { notes: 'words', impact: 2 });
		const id = ask(bob);

		report(id, [{ labourId: sparse.id, verdict: 'picked' }], carol);

		expect(affinityRows(bob).map((r) => r.rawKey)).toEqual(['impact']);
	});

	it('files under the Labour own Realm Attribute, not another Realm with the same key', () => {
		const { am, bob, carol } = world();
		const bl = seedRealm(db, 'BL');
		scale(bl.id, 'impact', 0, 10);
		const there = seedLabour(db, { realmId: bl.id });
		set(there.id, { impact: 5 });
		const id = ask(bob);

		report(id, [{ labourId: there.id, verdict: 'picked' }], carol);

		const [row] = affinityRows(bob);
		expect(row.attributeId).toBe(attributeId(bl.id, 'impact'));
		expect(row.attributeId).not.toBe(attributeId(am.id, 'impact'));
		expect(row.amount).toBe(0.5);
		expect(row.note).toBe(`picked BL-1 in Survey ${id}`);
	});

	it('posts to the Survey User, never to the actor or the reporter', () => {
		const { rich, bob, carol } = world();
		const id = ask(bob);

		report(id, [{ labourId: rich.id, verdict: 'picked' }], carol);

		expect(affinityRows(bob)).toHaveLength(4);
		expect(affinityRows(carol)).toEqual([]);
		expect(affinityRows(actor.id)).toEqual([]);
		const all = db.select().from(pulses).all();
		expect(all.every((r) => r.userId === bob && r.realmId === null)).toBe(true);
	});

	it('posts to the Survey actor when the Survey was not run for anyone else', () => {
		const { rich, carol } = world();
		const id = survey(db, actor, { weights: NEUTRAL, temperature: 0 }, { now: NOW }).surveyId;

		report(id, [{ labourId: rich.id, verdict: 'picked' }], carol);

		expect(affinityRows(actor.id)).toHaveLength(4);
	});

	it('keeps Sentiment and Affinity apart: neither reads the other Pulses', () => {
		const { am, rich, bob, carol } = world();
		report(ask(bob), [{ labourId: rich.id, verdict: 'picked' }], carol);
		postPulses(db, actor, am.id, [{ key: 'impact', amount: 3, mood: 1 }], NOW);

		const sentiment = readSentiment(db, am.id, { now: NOW });
		const affinity = readAffinity(db, bob, { now: NOW });

		expect(sentiment.keys.map((k) => k.key)).toEqual(['impact']);
		expect(sentiment.keys[0].volume).toBeCloseTo(3, 10);
		expect(sentiment.unfiled).toEqual([]);
		expect(affinity.keys.find((k) => k.key === 'impact')!.volume).toBeCloseTo(0.75, 10);
	});
});

describe('retention and cleanup', () => {
	it('deletes Outcomes with their Survey in pruneSurveys, keeping the Pulses', () => {
		const { rich, bob, carol } = world();
		const old = ask(bob, {}, daysAgo(40));
		const recent = ask(bob, {}, NOW);
		report(old, [{ labourId: rich.id, verdict: 'picked' }], carol, daysAgo(40));
		report(recent, [{ labourId: rich.id, verdict: 'picked' }], carol, NOW);

		const removed = pruneSurveys(db, 30 * DAY, NOW.getTime());

		expect(removed).toBe(1);
		expect(storedOutcomes().map((o) => o.surveyId)).toEqual([recent]);
		expect(affinityRows(bob)).toHaveLength(8);
	});

	it('deletes an Attribute Affinity Pulses with it and no other Realm', () => {
		const { am, rich, bob, carol } = world();
		const bl = seedRealm(db, 'BL');
		scale(bl.id, 'impact', 0, 10);
		const there = seedLabour(db, { realmId: bl.id });
		set(there.id, { impact: 5 });
		const id = ask(bob);
		report(
			id,
			[
				{ labourId: rich.id, verdict: 'picked' },
				{ labourId: there.id, verdict: 'picked' }
			],
			carol
		);
		const kept = [
			['area:audio', attributeId(am.id, 'area')],
			['area:ui', attributeId(am.id, 'area')],
			['effort', attributeId(am.id, 'effort')],
			['impact', attributeId(bl.id, 'impact')]
		];

		deleteAttribute(db, actor, am.id, 'impact');

		expect(byRawKey(affinityRows(bob)).map((r) => [r.rawKey, r.attributeId])).toEqual(kept);
	});

	it('leaves no Affinity Pulse unfiled when an Attribute is deleted', () => {
		const { am, rich, bob, carol } = world();
		report(ask(bob), [{ labourId: rich.id, verdict: 'done' }], carol);

		deleteAttribute(db, actor, am.id, 'area');

		expect(byRawKey(affinityRows(bob)).map((r) => r.rawKey)).toEqual(['effort', 'impact']);
		expect(readAffinity(db, bob, { now: NOW }).unfiled).toEqual([]);
	});

	it('deletes the Affinity Pulses of a removed tags member and keeps its siblings', () => {
		const { am, rich, bob, carol } = world();
		report(ask(bob), [{ labourId: rich.id, verdict: 'picked' }], carol);

		defineAttribute(db, actor, am.id, {
			key: 'area',
			kind: 'tags',
			spec: {
				members: [
					{ key: 'ui', label: 'ui' },
					{ key: 'net', label: 'net' }
				]
			}
		});

		expect(byRawKey(affinityRows(bob)).map((r) => r.rawKey)).toEqual([
			'area:ui',
			'effort',
			'impact'
		]);
	});

	it('prunes Affinity Pulses past 30 x log2(100) days and keeps younger ones', () => {
		const { rich, bob, carol } = world();
		const id = ask(bob);
		report(id, [{ labourId: rich.id, verdict: 'picked' }], carol, daysAgo(200));
		report(id, [{ labourId: rich.id, verdict: 'done' }], carol, daysAgo(199));

		const removed = prunePulses(db, NOW.getTime());

		expect(removed).toBe(4);
		const left = affinityRows(bob);
		expect(left).toHaveLength(4);
		expect(left.every((r) => r.note.startsWith('done'))).toBe(true);
	});
});

describe('readAffinity', () => {
	// impact: picked L1 (x 1) 60 days ago, skipped L1 now, done L2 (x 0.5) now.
	function learned() {
		const { am, bob, carol } = world();
		const l1 = seedLabour(db, { realmId: am.id, title: 'L1' });
		const l2 = seedLabour(db, { realmId: am.id, title: 'L2' });
		set(l1.id, { impact: 4, area: ['ui'] });
		set(l2.id, { impact: 2, area: ['audio'] });
		const id = ask(bob);
		report(id, [{ labourId: l1.id, verdict: 'picked' }], carol, daysAgo(60));
		report(id, [{ labourId: l1.id, verdict: 'skipped' }], carol, NOW);
		report(id, [{ labourId: l2.id, verdict: 'done' }], carol, NOW);
		return { am, bob, carol };
	}

	it('sums weights per key into volume, signed mood and v, ordered by volume', () => {
		const { am, bob } = learned();

		const view = readAffinity(db, bob, { now: NOW });

		expect(view.asOf).toEqual(NOW);
		expect(view.unfiled).toEqual([]);
		expect(view.keys.map((k) => k.key)).toEqual(['area:audio', 'impact', 'area:ui']);
		const [audio, impact, ui] = view.keys;
		expect(audio.realmId).toBe(am.id);
		expect(audio.volume).toBeCloseTo(2, 10);
		expect(audio.mood).toBeCloseTo(1, 10);
		expect(audio.v).toBeCloseTo(2 / 7, 10);
		expect(impact.realmId).toBe(am.id);
		expect(impact.volume).toBeCloseTo(1.75, 10);
		expect(impact.mood).toBeCloseTo(0.75 / 1.75, 10);
		expect(impact.v).toBeCloseTo(1.75 / 6.75, 10);
		expect(ui.realmId).toBe(am.id);
		expect(ui.volume).toBeCloseTo(0.75, 10);
		expect(ui.mood).toBeCloseTo(-0.25 / 0.75, 10);
		expect(ui.v).toBeCloseTo(0.75 / 5.75, 10);
	});

	it('lists each key heaviest Pulses first, three by default', () => {
		const { rich, bob, carol } = world();
		const first = ask(bob);
		const second = ask(bob);
		report(first, [{ labourId: rich.id, verdict: 'picked' }], carol, daysAgo(60));
		report(first, [{ labourId: rich.id, verdict: 'done' }], carol, daysAgo(60));
		report(second, [{ labourId: rich.id, verdict: 'picked' }], carol, NOW);
		report(second, [{ labourId: rich.id, verdict: 'done' }], carol, NOW);

		const ui = (limit?: number) =>
			readAffinity(db, bob, { now: NOW, limit }).keys.find((k) => k.key === 'area:ui')!;

		expect(ui().pulses.map((p) => [p.note, p.weight])).toEqual([
			[`done AM-1 in Survey ${second}`, 2],
			[`picked AM-1 in Survey ${second}`, 1],
			[`done AM-1 in Survey ${first}`, 0.5]
		]);
		expect(ui(1).pulses.map((p) => p.note)).toEqual([`done AM-1 in Survey ${second}`]);
		expect(ui(4).pulses).toHaveLength(4);
		expect(ui().pulses[0]).toMatchObject({ authorId: carol, evidence: [{ labour: rich.id }] });
	});

	it('keeps the same key of two Realms apart, each with its realmId', () => {
		const { am, rich, bob, carol } = world();
		const bl = seedRealm(db, 'BL');
		scale(bl.id, 'impact', 0, 10);
		const there = seedLabour(db, { realmId: bl.id });
		set(there.id, { impact: 10 });
		report(
			ask(bob),
			[
				{ labourId: rich.id, verdict: 'picked' },
				{ labourId: there.id, verdict: 'picked' }
			],
			carol
		);

		const view = readAffinity(db, bob, { now: NOW });

		const impacts = view.keys
			.filter((k) => k.key === 'impact')
			.map((k) => [k.realmId, k.volume])
			.sort((a, b) => a[0] - b[0]);
		expect(impacts).toEqual([
			[am.id, 0.75],
			[bl.id, 1]
		]);
	});

	it('counts only that User Pulses', () => {
		const { rich, bob, carol } = world();
		const alice = seedUser(db, 'alice');
		report(ask(bob), [{ labourId: rich.id, verdict: 'picked' }], carol);
		report(ask(alice), [{ labourId: rich.id, verdict: 'skipped' }], carol);

		const mine = readAffinity(db, bob, { now: NOW }).keys.find((k) => k.key === 'impact')!;
		const hers = readAffinity(db, alice, { now: NOW }).keys.find((k) => k.key === 'impact')!;

		expect(mine.mood).toBeCloseTo(1, 10);
		expect(hers.mood).toBeCloseTo(-1, 10);
		expect(readAffinity(db, carol, { now: NOW }).keys).toEqual([]);
	});

	it('uses loudness 5 and half-life 30 whatever the Realm settings', () => {
		const { am, rich, bob, carol } = world();
		tuneRealm(db, actor, am.id, { loudness: 500, halfLifeDays: 3 });
		report(ask(bob), [{ labourId: rich.id, verdict: 'picked' }], carol, daysAgo(30));

		const impact = readAffinity(db, bob, { now: NOW }).keys.find((k) => k.key === 'impact')!;

		expect(affinityRows(bob).every((r) => r.halfLifeDays === 30)).toBe(true);
		expect(impact.volume).toBeCloseTo(0.375, 10);
		expect(impact.v).toBeCloseTo(0.375 / 5.375, 10);
	});

	it('never ages a Pulse below 0 days', () => {
		const { rich, bob, carol } = world();
		report(ask(bob), [{ labourId: rich.id, verdict: 'picked' }], carol, NOW);

		const early = readAffinity(db, bob, { now: daysAgo(10) });

		expect(early.keys.find((k) => k.key === 'impact')!.volume).toBeCloseTo(0.75, 10);
	});

	it('reads empty for a User with no Pulses', () => {
		const { bob } = world();

		expect(readAffinity(db, bob, { now: NOW })).toEqual({ asOf: NOW, keys: [], unfiled: [] });
	});

	it('refuses an unknown User as not_found', () => {
		world();

		expectDomainError(() => readAffinity(db, 9999, { now: NOW }), 'not_found');
	});
});
