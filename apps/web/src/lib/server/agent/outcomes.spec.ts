import { asc, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
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

beforeEach(async () => {
	db = await testDb();
	actor = await seedActor(db);
});

const DAY = 86_400_000;
const NOW = new Date('2026-03-01T12:00:00.000Z');
const daysAgo = (days: number) => new Date(NOW.getTime() - days * DAY);

// Every Labour scores 0 on it while no Links exist, so the order is the board order.
const NEUTRAL = { evidence: 1 };

async function expectDomainError(action: () => unknown, code: DomainError['code']) {
	let thrown: unknown;
	try {
		await action();
	} catch (error) {
		thrown = error;
	}
	expect(thrown).toBeInstanceOf(DomainError);
	expect((thrown as DomainError).code).toBe(code);
}

const json = (value: unknown) => (typeof value === 'string' ? JSON.parse(value) : value) as any;

async function scale(realmId: number, key: string, min: number, max: number) {
	await defineAttribute(db, actor, realmId, {
		key,
		kind: 'scale',
		label: key,
		rubric: 'rubric',
		spec: { min, max }
	});
}

async function tags(realmId: number, key: string, members: string[]) {
	await defineAttribute(db, actor, realmId, {
		key,
		kind: 'tags',
		label: key,
		rubric: 'rubric',
		spec: { members: members.map((member) => ({ key: member, label: member })) }
	});
}

const set = (labourId: number, values: Record<string, unknown>) =>
	setValues(db, actor, labourId, values);

const attributeId = async (realmId: number, key: string) =>
	(await readAttributes(db, realmId)).find((a) => a.key === key)!.id;

async function ask(
	forUserId: number,
	input: { limit?: number; realmIds?: number[] } = {},
	at = NOW
) {
	return (
		await survey(db, actor, { weights: NEUTRAL, temperature: 0, forUserId, ...input }, { now: at })
	).surveyId;
}

type Item = { labourId: number; verdict: Verdict };

const report = (surveyId: number, items: Item[], by: number, at = NOW) =>
	reportOutcomes(db, { id: by }, surveyId, items, at);

const affinityRows = async (userId: number) =>
	await db.select().from(pulses).where(eq(pulses.userId, userId)).orderBy(asc(pulses.id));

const byRawKey = <T extends { rawKey: string }>(rows: T[]) =>
	[...rows].sort((a, b) => (a.rawKey < b.rawKey ? -1 : 1));

const storedOutcomes = async () =>
	(await db.select().from(outcomes)).sort(
		(a, b) => a.labourId - b.labourId || (a.verdict < b.verdict ? -1 : 1)
	);

// `rich` holds impact 3 of 0-4 (x 0.75), effort 2 of 1-5 (x 0.25), area audio and ui (x 1 each).
async function world() {
	const am = await seedRealm(db, 'AM');
	await scale(am.id, 'impact', 0, 4);
	await scale(am.id, 'effort', 1, 5);
	await tags(am.id, 'area', ['ui', 'audio', 'net']);
	const bob = await seedUser(db, 'bob');
	const carol = await seedUser(db, 'carol');
	const rich = await seedLabour(db, { realmId: am.id, title: 'Rich' });
	const plain = await seedLabour(db, { realmId: am.id, title: 'Plain' });
	await set(rich.id, { impact: 3, effort: 2, area: ['audio', 'ui'] });
	return { am, bob, carol, rich, plain };
}

describe('reportOutcomes validation', () => {
	it('refuses an unknown Survey as not_found and stores nothing', async () => {
		const { rich, bob, carol } = await world();

		await expectDomainError(
			() => report(9999, [{ labourId: rich.id, verdict: 'picked' }], carol),
			'not_found'
		);

		expect(await storedOutcomes()).toEqual([]);
		expect(await affinityRows(bob)).toEqual([]);
	});

	it('refuses an empty list as invalid', async () => {
		const { bob, carol } = await world();

		await expectDomainError(async () => report(await ask(bob), [], carol), 'invalid');
	});

	it('takes 50 items and refuses 51 as invalid, recording nothing for the refused call', async () => {
		const am = await seedRealm(db, 'AM');
		const bob = await seedUser(db, 'bob');
		const carol = await seedUser(db, 'carol');
		const all = await Promise.all(
			Array.from({ length: 50 }, () => seedLabour(db, { realmId: am.id }))
		);
		const id = await ask(bob, { limit: 50 });
		const items = all.map((l): Item => ({ labourId: l.id, verdict: 'picked' }));

		await expectDomainError(() => report(id, [...items, items[0]], carol), 'invalid');
		expect(await storedOutcomes()).toEqual([]);
		const reported = await report(id, items, carol);

		expect(reported).toHaveLength(50);
		expect(reported.every((r) => r.recorded)).toBe(true);
		expect(await storedOutcomes()).toHaveLength(50);
	});

	it('refuses a verdict that is not picked, skipped or done as invalid', async () => {
		const { rich, bob, carol } = await world();
		const id = await ask(bob);

		for (const verdict of ['liked', '']) {
			await expectDomainError(
				() => report(id, [{ labourId: rich.id, verdict: verdict as Verdict }], carol),
				'invalid'
			);
		}

		expect(await storedOutcomes()).toEqual([]);
		expect(await affinityRows(bob)).toEqual([]);
	});

	it('refuses a Labour id that is not in the Survey results as invalid', async () => {
		const { bob, carol } = await world();

		await expectDomainError(
			async () => report(await ask(bob), [{ labourId: 9999, verdict: 'picked' }], carol),
			'invalid'
		);
		expect(await storedOutcomes()).toEqual([]);
	});

	it('refuses a Labour that matched the Survey but was cut by its limit', async () => {
		const { am, rich, bob, carol } = await world();
		const cut = await seedLabour(db, { realmId: am.id, title: 'Cut' });
		await set(cut.id, { impact: 4 });
		const id = await ask(bob, { limit: 1 });
		const stored = json(
			(await db.select().from(surveys).where(eq(surveys.id, id)).limit(1))[0]!.results
		);
		expect(stored.map((r: { labour: number }) => r.labour)).toEqual([rich.id]);

		await expectDomainError(
			() => report(id, [{ labourId: cut.id, verdict: 'picked' }], carol),
			'invalid'
		);

		expect(await storedOutcomes()).toEqual([]);
		expect(await affinityRows(bob)).toEqual([]);
	});

	it('refuses a Labour from a Realm the Survey did not cover', async () => {
		const { am, bob, carol } = await world();
		const bl = await seedRealm(db, 'BL');
		const elsewhere = await seedLabour(db, { realmId: bl.id });
		const id = await ask(bob, { realmIds: [am.id] });

		await expectDomainError(
			() => report(id, [{ labourId: elsewhere.id, verdict: 'picked' }], carol),
			'invalid'
		);
		expect(await storedOutcomes()).toEqual([]);
	});

	it('records nothing when any item of the batch is refused, whichever comes first', async () => {
		const { rich, bob, carol } = await world();
		const id = await ask(bob);
		const good: Item = { labourId: rich.id, verdict: 'picked' };
		const unknown: Item = { labourId: 9999, verdict: 'picked' };
		const badVerdict = { labourId: rich.id, verdict: 'nope' } as unknown as Item;

		await expectDomainError(() => report(id, [good, unknown], carol), 'invalid');
		await expectDomainError(() => report(id, [unknown, good], carol), 'invalid');
		await expectDomainError(() => report(id, [good, badVerdict], carol), 'invalid');
		await expectDomainError(() => report(id, [badVerdict, good], carol), 'invalid');

		expect(await storedOutcomes()).toEqual([]);
		expect(await db.select().from(pulses)).toEqual([]);
	});
});

describe('reportOutcomes recording', () => {
	it('answers each item in the order given, recorded true', async () => {
		const { rich, plain, bob, carol } = await world();
		const id = await ask(bob);

		const answered = await report(
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

	it('stores the Survey, Labour, verdict, the reporter and the time', async () => {
		const { rich, bob, carol } = await world();
		const id = await ask(bob);

		await report(id, [{ labourId: rich.id, verdict: 'picked' }], carol, daysAgo(2));

		expect(await db.select().from(outcomes)).toEqual([
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

	it('lets a User who is neither the Survey actor nor the Survey User report', async () => {
		const { rich, bob, carol } = await world();
		const id = await ask(bob);
		expect(new Set([actor.id, bob, carol]).size).toBe(3);

		const answered = await report(id, [{ labourId: rich.id, verdict: 'done' }], carol);

		expect(answered[0].recorded).toBe(true);
	});

	it('changes nothing when a Labour already has that verdict for the Survey', async () => {
		const { rich, bob, carol } = await world();
		const dave = await seedUser(db, 'dave');
		const id = await ask(bob);
		await report(id, [{ labourId: rich.id, verdict: 'picked' }], carol);
		const outcomesBefore = await storedOutcomes();
		const pulsesBefore = await db.select().from(pulses).orderBy(asc(pulses.id));

		const again = await report(
			id,
			[{ labourId: rich.id, verdict: 'picked' }],
			dave,
			new Date(NOW.getTime() + DAY)
		);

		expect(again).toEqual([{ labourId: rich.id, verdict: 'picked', recorded: false }]);
		expect(await storedOutcomes()).toEqual(outcomesBefore);
		expect(await db.select().from(pulses).orderBy(asc(pulses.id))).toEqual(pulsesBefore);
	});

	it('records the new item of a batch beside a repeat, posting Pulses for the new one only', async () => {
		const { rich, plain, bob, carol } = await world();
		await set(plain.id, { impact: 4 });
		const id = await ask(bob);
		await report(id, [{ labourId: rich.id, verdict: 'picked' }], carol);
		const before = (await affinityRows(bob)).length;

		const answered = await report(
			id,
			[
				{ labourId: rich.id, verdict: 'picked' },
				{ labourId: plain.id, verdict: 'picked' }
			],
			carol
		);

		expect(answered.map((r) => r.recorded)).toEqual([false, true]);
		expect(await storedOutcomes()).toHaveLength(2);
		expect(await affinityRows(bob)).toHaveLength(before + 1);
	});

	it('keeps picked then done as two Outcomes, each posting its own Pulses', async () => {
		const { rich, bob, carol } = await world();
		const id = await ask(bob);

		const first = await report(id, [{ labourId: rich.id, verdict: 'picked' }], carol);
		const second = await report(id, [{ labourId: rich.id, verdict: 'done' }], carol);

		expect(first[0].recorded).toBe(true);
		expect(second[0].recorded).toBe(true);
		expect((await storedOutcomes()).map((o) => o.verdict)).toEqual(['done', 'picked']);
		const rows = await affinityRows(bob);
		expect(rows).toHaveLength(8);
		expect(rows.filter((r) => r.note.startsWith('picked'))).toHaveLength(4);
		expect(rows.filter((r) => r.note.startsWith('done'))).toHaveLength(4);
	});

	it('treats picked then skipped as two Outcomes too', async () => {
		const { rich, bob, carol } = await world();
		const id = await ask(bob);

		await report(id, [{ labourId: rich.id, verdict: 'picked' }], carol);
		const second = await report(id, [{ labourId: rich.id, verdict: 'skipped' }], carol);

		expect(second[0].recorded).toBe(true);
		expect(await storedOutcomes()).toHaveLength(2);
	});

	it('records the same verdict for the same Labour in another Survey', async () => {
		const { rich, bob, carol } = await world();
		const first = await ask(bob);
		const second = await ask(bob);
		await report(first, [{ labourId: rich.id, verdict: 'picked' }], carol);

		const answered = await report(second, [{ labourId: rich.id, verdict: 'picked' }], carol);

		expect(answered[0].recorded).toBe(true);
		expect(await affinityRows(bob)).toHaveLength(8);
	});

	it('records an Outcome for a Labour that holds no values and posts no Pulse', async () => {
		const { plain, bob, carol } = await world();
		const id = await ask(bob);

		const answered = await report(id, [{ labourId: plain.id, verdict: 'picked' }], carol);

		expect(answered[0].recorded).toBe(true);
		expect(await storedOutcomes()).toHaveLength(1);
		expect(await affinityRows(bob)).toEqual([]);
	});

	it('records no Event, leaves labours.updatedAt alone and does not bump the Realm version', async () => {
		const { am, rich, bob, carol } = await world();
		const id = await ask(bob);
		const eventsBefore = await db.select().from(events);
		const laboursBefore = await db.select().from(labours);
		const versionBefore = (await readRealmAgent(db, am.id)).version;
		expect(versionBefore).toBeGreaterThan(0);

		await report(
			id,
			[{ labourId: rich.id, verdict: 'done' }],
			carol,
			new Date(NOW.getTime() + 5 * DAY)
		);

		expect(await db.select().from(events)).toEqual(eventsBefore);
		expect(await db.select().from(labours)).toEqual(laboursBefore);
		expect((await readRealmAgent(db, am.id)).version).toBe(versionBefore);
	});
});

describe('Affinity Pulses', () => {
	it('posts one per held key, filed under the Attribute and member, to the Survey User', async () => {
		const { am, rich, bob, carol } = await world();
		const id = await ask(bob);

		await report(id, [{ labourId: rich.id, verdict: 'picked' }], carol);

		const rows = byRawKey(await affinityRows(bob));
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
			await Promise.all(
				[
					['area:audio', 'area', 'audio', 1],
					['area:ui', 'area', 'ui', 1],
					['effort', 'effort', null, 0.25],
					['impact', 'impact', null, 0.75]
				].map(async ([rawKey, attribute, member, amount]) => ({
					userId: bob,
					realmId: null,
					attributeId: await attributeId(am.id, attribute as string),
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
			)
		);
	});

	it.each([
		['picked', 1, 1],
		['done', 2, 1],
		['skipped', 0.5, -1]
	] as const)('weights a %s Outcome by base %s with mood %s', async (verdict, base, mood) => {
		const { rich, bob, carol } = await world();
		const id = await ask(bob);

		await report(id, [{ labourId: rich.id, verdict }], carol);

		const rows = byRawKey(await affinityRows(bob));
		expect(rows.map((r) => [r.rawKey, r.amount, r.mood])).toEqual([
			['area:audio', base * 1, mood],
			['area:ui', base * 1, mood],
			['effort', base * 0.25, mood],
			['impact', base * 0.75, mood]
		]);
		expect(rows.every((r) => r.note === `${verdict} AM-1 in Survey ${id}`)).toBe(true);
	});

	it('skips a scale key at its minimum, whatever the minimum is', async () => {
		const { am, bob, carol } = await world();
		const floor = await seedLabour(db, { realmId: am.id });
		await set(floor.id, { impact: 0, effort: 1, area: ['ui'] });
		const id = await ask(bob);

		await report(id, [{ labourId: floor.id, verdict: 'picked' }], carol);

		expect((await affinityRows(bob)).map((r) => r.rawKey)).toEqual(['area:ui']);
	});

	it('posts base x 1 for a scale value at its maximum', async () => {
		const { am, bob, carol } = await world();
		const top = await seedLabour(db, { realmId: am.id });
		await set(top.id, { impact: 4, effort: 5 });
		const id = await ask(bob);

		await report(id, [{ labourId: top.id, verdict: 'done' }], carol);

		expect(byRawKey(await affinityRows(bob)).map((r) => [r.rawKey, r.amount])).toEqual([
			['effort', 2],
			['impact', 2]
		]);
	});

	it('posts nothing for a key the Labour holds no value for, or for a text Attribute', async () => {
		const { am, bob, carol } = await world();
		await defineAttribute(db, actor, am.id, {
			key: 'notes',
			kind: 'text',
			label: 'Notes',
			rubric: 'rubric'
		});
		const sparse = await seedLabour(db, { realmId: am.id });
		await set(sparse.id, { notes: 'words', impact: 2 });
		const id = await ask(bob);

		await report(id, [{ labourId: sparse.id, verdict: 'picked' }], carol);

		expect((await affinityRows(bob)).map((r) => r.rawKey)).toEqual(['impact']);
	});

	it('files under the Labour own Realm Attribute, not another Realm with the same key', async () => {
		const { am, bob, carol } = await world();
		const bl = await seedRealm(db, 'BL');
		await scale(bl.id, 'impact', 0, 10);
		const there = await seedLabour(db, { realmId: bl.id });
		await set(there.id, { impact: 5 });
		const id = await ask(bob);

		await report(id, [{ labourId: there.id, verdict: 'picked' }], carol);

		const [row] = await affinityRows(bob);
		expect(row.attributeId).toBe(await attributeId(bl.id, 'impact'));
		expect(row.attributeId).not.toBe(await attributeId(am.id, 'impact'));
		expect(row.amount).toBe(0.5);
		expect(row.note).toBe(`picked BL-1 in Survey ${id}`);
	});

	it('posts to the Survey User, never to the actor or the reporter', async () => {
		const { rich, bob, carol } = await world();
		const id = await ask(bob);

		await report(id, [{ labourId: rich.id, verdict: 'picked' }], carol);

		expect(await affinityRows(bob)).toHaveLength(4);
		expect(await affinityRows(carol)).toEqual([]);
		expect(await affinityRows(actor.id)).toEqual([]);
		const all = await db.select().from(pulses);
		expect(all.every((r) => r.userId === bob && r.realmId === null)).toBe(true);
	});

	it('posts to the Survey actor when the Survey was not run for anyone else', async () => {
		const { rich, carol } = await world();
		const id = (await survey(db, actor, { weights: NEUTRAL, temperature: 0 }, { now: NOW }))
			.surveyId;

		await report(id, [{ labourId: rich.id, verdict: 'picked' }], carol);

		expect(await affinityRows(actor.id)).toHaveLength(4);
	});

	it('keeps Sentiment and Affinity apart: neither reads the other Pulses', async () => {
		const { am, rich, bob, carol } = await world();
		await report(await ask(bob), [{ labourId: rich.id, verdict: 'picked' }], carol);
		await postPulses(db, actor, am.id, [{ key: 'impact', amount: 3, mood: 1 }], NOW);

		const sentiment = await readSentiment(db, am.id, { now: NOW });
		const affinity = await readAffinity(db, bob, { now: NOW });

		expect(sentiment.keys.map((k) => k.key)).toEqual(['impact']);
		expect(sentiment.keys[0].volume).toBeCloseTo(3, 10);
		expect(sentiment.unfiled).toEqual([]);
		expect(affinity.keys.find((k) => k.key === 'impact')!.volume).toBeCloseTo(0.75, 10);
	});
});

describe('retention and cleanup', () => {
	it('deletes Outcomes with their Survey in pruneSurveys, keeping the Pulses', async () => {
		const { rich, bob, carol } = await world();
		const old = await ask(bob, {}, daysAgo(40));
		const recent = await ask(bob, {}, NOW);
		await report(old, [{ labourId: rich.id, verdict: 'picked' }], carol, daysAgo(40));
		await report(recent, [{ labourId: rich.id, verdict: 'picked' }], carol, NOW);

		const removed = await pruneSurveys(db, 30 * DAY, NOW.getTime());

		expect(removed).toBe(1);
		expect((await storedOutcomes()).map((o) => o.surveyId)).toEqual([recent]);
		expect(await affinityRows(bob)).toHaveLength(8);
	});

	it('deletes an Attribute Affinity Pulses with it and no other Realm', async () => {
		const { am, rich, bob, carol } = await world();
		const bl = await seedRealm(db, 'BL');
		await scale(bl.id, 'impact', 0, 10);
		const there = await seedLabour(db, { realmId: bl.id });
		await set(there.id, { impact: 5 });
		const id = await ask(bob);
		await report(
			id,
			[
				{ labourId: rich.id, verdict: 'picked' },
				{ labourId: there.id, verdict: 'picked' }
			],
			carol
		);
		const kept = [
			['area:audio', await attributeId(am.id, 'area')],
			['area:ui', await attributeId(am.id, 'area')],
			['effort', await attributeId(am.id, 'effort')],
			['impact', await attributeId(bl.id, 'impact')]
		];

		await deleteAttribute(db, actor, am.id, 'impact');

		expect(byRawKey(await affinityRows(bob)).map((r) => [r.rawKey, r.attributeId])).toEqual(kept);
	});

	it('leaves no Affinity Pulse unfiled when an Attribute is deleted', async () => {
		const { am, rich, bob, carol } = await world();
		await report(await ask(bob), [{ labourId: rich.id, verdict: 'done' }], carol);

		await deleteAttribute(db, actor, am.id, 'area');

		expect(byRawKey(await affinityRows(bob)).map((r) => r.rawKey)).toEqual(['effort', 'impact']);
		expect((await readAffinity(db, bob, { now: NOW })).unfiled).toEqual([]);
	});

	it('deletes the Affinity Pulses of a removed tags member and keeps its siblings', async () => {
		const { am, rich, bob, carol } = await world();
		await report(await ask(bob), [{ labourId: rich.id, verdict: 'picked' }], carol);

		await defineAttribute(db, actor, am.id, {
			key: 'area',
			kind: 'tags',
			spec: {
				members: [
					{ key: 'ui', label: 'ui' },
					{ key: 'net', label: 'net' }
				]
			}
		});

		expect(byRawKey(await affinityRows(bob)).map((r) => r.rawKey)).toEqual([
			'area:ui',
			'effort',
			'impact'
		]);
	});

	it('prunes Affinity Pulses past 30 x log2(100) days and keeps younger ones', async () => {
		const { rich, bob, carol } = await world();
		const id = await ask(bob);
		await report(id, [{ labourId: rich.id, verdict: 'picked' }], carol, daysAgo(200));
		await report(id, [{ labourId: rich.id, verdict: 'done' }], carol, daysAgo(199));

		const removed = await prunePulses(db, NOW.getTime());

		expect(removed).toBe(4);
		const left = await affinityRows(bob);
		expect(left).toHaveLength(4);
		expect(left.every((r) => r.note.startsWith('done'))).toBe(true);
	});
});

describe('readAffinity', () => {
	// impact: picked L1 (x 1) 60 days ago, skipped L1 now, done L2 (x 0.5) now.
	async function learned() {
		const { am, bob, carol } = await world();
		const l1 = await seedLabour(db, { realmId: am.id, title: 'L1' });
		const l2 = await seedLabour(db, { realmId: am.id, title: 'L2' });
		await set(l1.id, { impact: 4, area: ['ui'] });
		await set(l2.id, { impact: 2, area: ['audio'] });
		const id = await ask(bob);
		await report(id, [{ labourId: l1.id, verdict: 'picked' }], carol, daysAgo(60));
		await report(id, [{ labourId: l1.id, verdict: 'skipped' }], carol, NOW);
		await report(id, [{ labourId: l2.id, verdict: 'done' }], carol, NOW);
		return { am, bob, carol };
	}

	it('sums weights per key into volume, signed mood and v, ordered by volume', async () => {
		const { am, bob } = await learned();

		const view = await readAffinity(db, bob, { now: NOW });

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

	it('lists each key heaviest Pulses first, three by default', async () => {
		const { rich, bob, carol } = await world();
		const first = await ask(bob);
		const second = await ask(bob);
		await report(first, [{ labourId: rich.id, verdict: 'picked' }], carol, daysAgo(60));
		await report(first, [{ labourId: rich.id, verdict: 'done' }], carol, daysAgo(60));
		await report(second, [{ labourId: rich.id, verdict: 'picked' }], carol, NOW);
		await report(second, [{ labourId: rich.id, verdict: 'done' }], carol, NOW);

		const ui = async (limit?: number) =>
			(await readAffinity(db, bob, { now: NOW, limit })).keys.find((k) => k.key === 'area:ui')!;

		expect((await ui()).pulses.map((p) => [p.note, p.weight])).toEqual([
			[`done AM-1 in Survey ${second}`, 2],
			[`picked AM-1 in Survey ${second}`, 1],
			[`done AM-1 in Survey ${first}`, 0.5]
		]);
		expect((await ui(1)).pulses.map((p) => p.note)).toEqual([`done AM-1 in Survey ${second}`]);
		expect((await ui(4)).pulses).toHaveLength(4);
		expect((await ui()).pulses[0]).toMatchObject({
			authorId: carol,
			evidence: [{ labour: rich.id }]
		});
	});

	it('keeps the same key of two Realms apart, each with its realmId', async () => {
		const { am, rich, bob, carol } = await world();
		const bl = await seedRealm(db, 'BL');
		await scale(bl.id, 'impact', 0, 10);
		const there = await seedLabour(db, { realmId: bl.id });
		await set(there.id, { impact: 10 });
		await report(
			await ask(bob),
			[
				{ labourId: rich.id, verdict: 'picked' },
				{ labourId: there.id, verdict: 'picked' }
			],
			carol
		);

		const view = await readAffinity(db, bob, { now: NOW });

		const impacts = view.keys
			.filter((k) => k.key === 'impact')
			.map((k) => [k.realmId, k.volume])
			.sort((a, b) => a[0] - b[0]);
		expect(impacts).toEqual([
			[am.id, 0.75],
			[bl.id, 1]
		]);
	});

	it('counts only that User Pulses', async () => {
		const { rich, bob, carol } = await world();
		const alice = await seedUser(db, 'alice');
		await report(await ask(bob), [{ labourId: rich.id, verdict: 'picked' }], carol);
		await report(await ask(alice), [{ labourId: rich.id, verdict: 'skipped' }], carol);

		const mine = (await readAffinity(db, bob, { now: NOW })).keys.find((k) => k.key === 'impact')!;
		const hers = (await readAffinity(db, alice, { now: NOW })).keys.find(
			(k) => k.key === 'impact'
		)!;

		expect(mine.mood).toBeCloseTo(1, 10);
		expect(hers.mood).toBeCloseTo(-1, 10);
		expect((await readAffinity(db, carol, { now: NOW })).keys).toEqual([]);
	});

	it('uses loudness 5 and half-life 30 whatever the Realm settings', async () => {
		const { am, rich, bob, carol } = await world();
		await tuneRealm(db, actor, am.id, { loudness: 500, halfLifeDays: 3 });
		await report(await ask(bob), [{ labourId: rich.id, verdict: 'picked' }], carol, daysAgo(30));

		const impact = (await readAffinity(db, bob, { now: NOW })).keys.find(
			(k) => k.key === 'impact'
		)!;

		expect((await affinityRows(bob)).every((r) => r.halfLifeDays === 30)).toBe(true);
		expect(impact.volume).toBeCloseTo(0.375, 10);
		expect(impact.v).toBeCloseTo(0.375 / 5.375, 10);
	});

	it('never ages a Pulse below 0 days', async () => {
		const { rich, bob, carol } = await world();
		await report(await ask(bob), [{ labourId: rich.id, verdict: 'picked' }], carol, NOW);

		const early = await readAffinity(db, bob, { now: daysAgo(10) });

		expect(early.keys.find((k) => k.key === 'impact')!.volume).toBeCloseTo(0.75, 10);
	});

	it('reads empty for a User with no Pulses', async () => {
		const { bob } = await world();

		expect(await readAffinity(db, bob, { now: NOW })).toEqual({ asOf: NOW, keys: [], unfiled: [] });
	});

	it('refuses an unknown User as not_found', async () => {
		await world();

		await expectDomainError(() => readAffinity(db, 9999, { now: NOW }), 'not_found');
	});
});
