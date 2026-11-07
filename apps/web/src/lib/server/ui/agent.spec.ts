import { beforeEach, describe, expect, it } from 'vitest';
import { appraise, type LinkInput } from '../agent/appraisals.ts';
import { defineAttribute, setValues, tuneRealm } from '../agent/attributes.ts';
import { contentHash } from '../agent/content.ts';
import { postPulses } from '../agent/sentiment.ts';
import { defineSkill, setSkills } from '../agent/skills.ts';
import type { Db } from '../db/client.ts';
import { pulses } from '../db/schema.ts';
import { DomainError } from '../domain/errors.ts';
import { addComment } from '../domain/comments.ts';
import type { Actor } from '../domain/write.ts';
import { testDb } from '../test/db.ts';
import { seedActor, seedLabour, seedRealm, seedUser } from '../test/fixtures.ts';
import {
	KEYS_SHOWN,
	LINKS_SHOWN,
	readLabourLayer,
	readRealmLayer,
	readUserLayer
} from './agent.ts';
import { countStatements } from '#lib/server/test/db.ts';

const DAY = 86_400_000;
const NOW = new Date('2026-06-15T12:00:00.000Z');
const ago = (days: number) => new Date(NOW.getTime() - days * DAY);

let db: Db;
let actor: Actor;
let realm: { id: number };

beforeEach(async () => {
	db = await testDb();
	actor = await seedActor(db);
	realm = await seedRealm(db, 'AM');
});

function statements(run: () => unknown): Promise<number> {
	return countStatements(run);
}

function labour(title = 'Labour') {
	return seedLabour(db, { realmId: realm.id, ownerId: actor.id, title });
}

async function attribute(
	key: string,
	kind: 'scale' | 'tags' | 'text',
	spec?: object,
	label?: string
) {
	return (
		await defineAttribute(
			db,
			actor,
			realm.id,
			{ key, kind, label: label ?? key, rubric: `About ${key}`, spec },
			ago(10)
		)
	).attribute;
}

describe('readLabourLayer', () => {
	it('answers a Labour with nothing kept as an empty layer', async () => {
		const target = await labour();
		expect(await readLabourLayer(db, actor, target.id)).toEqual({
			brief: '',
			refs: [],
			setBy: null,
			via: null,
			setAt: null,
			stamp: null,
			unappraised: true,
			stale: false,
			values: [],
			needs: [],
			links: [],
			moreLinks: 0,
			mentions: []
		});
	});

	it('shows values in Attribute order with labels and how people read them', async () => {
		const target = await labour();
		await attribute('effort', 'scale', { min: 1, max: 5 }, 'Effort');
		await attribute('area', 'tags', {
			members: [
				{ key: 'ui', label: 'Interface' },
				{ key: 'db', label: 'Database' }
			]
		});
		await attribute('why', 'text', undefined, 'Why');
		await setValues(
			db,
			actor,
			target.id,
			{ why: 'Players asked', area: ['db', 'ui'], effort: 3 },
			ago(5)
		);

		const { values } = await readLabourLayer(db, actor, target.id);
		expect(values.map(({ key, label, kind, display }) => ({ key, label, kind, display }))).toEqual([
			{ key: 'effort', label: 'Effort', kind: 'scale', display: '3 / 5' },
			{ key: 'area', label: 'area', kind: 'tags', display: 'Database, Interface' },
			{ key: 'why', label: 'Why', kind: 'text', display: 'Players asked' }
		]);
		expect(values[0]).toMatchObject({
			value: 3,
			setBy: actor.id,
			via: null,
			setAt: ago(5),
			stale: false
		});
	});

	it('marks a value stale once its Attribute is revised', async () => {
		const target = await labour();
		await attribute('effort', 'scale', { min: 1, max: 5 });
		await setValues(db, actor, target.id, { effort: 2 }, ago(5));
		await defineAttribute(
			db,
			actor,
			realm.id,
			{ key: 'effort', kind: 'scale', rubric: 'New' },
			ago(1)
		);
		expect((await readLabourLayer(db, actor, target.id)).values[0].stale).toBe(true);
	});

	it('carries the Brief, References, needs and the stamp', async () => {
		const target = await labour();
		await defineSkill(db, actor, { key: 'netcode', label: 'Netcode' });
		const [{ labourId }] = await appraise(
			db,
			actor,
			[
				{
					labourId: target.id,
					brief: 'Rubber-banding on join',
					refs: [{ href: 'https://example.com/a', label: 'Report' }, { href: 'src/net.ts' }],
					needs: { netcode: 4 }
				}
			],
			ago(3)
		);
		expect(labourId).toBe(target.id);

		const layer = await readLabourLayer(db, actor, target.id);
		expect(layer.brief).toBe('Rubber-banding on join');
		expect(layer.refs).toEqual([
			{ href: 'https://example.com/a', label: 'Report' },
			{ href: 'src/net.ts', label: null }
		]);
		expect(layer.needs).toEqual([
			{ key: 'netcode', label: 'Netcode', level: 4, setBy: actor.id, via: null, setAt: ago(3) }
		]);
		expect(layer).toMatchObject({ stamp: null, unappraised: true, setBy: actor.id });
	});

	it('shows the stamp, and stale once the content changes', async () => {
		const target = await labour();
		const hash = await contentHash(db, target.id);
		await appraise(db, actor, [{ labourId: target.id, stamp: hash }], ago(2));
		expect(await readLabourLayer(db, actor, target.id)).toMatchObject({
			stamp: { appraisedBy: actor.id, appraisedVia: null, appraisedAt: ago(2) },
			unappraised: false,
			stale: false
		});

		await addComment(db, actor, target.id, 'Something new');
		expect(await readLabourLayer(db, actor, target.id)).toMatchObject({
			unappraised: false,
			stale: true
		});
	});

	it('gives Links a direction from this Labour and names the other end', async () => {
		const target = await labour('Target');
		const blocked = await labour('Blocked');
		const blocker = await labour('Blocker');
		const sibling = await labour('Sibling');
		await appraise(db, actor, [
			{
				labourId: target.id,
				links: [
					{ type: 'blocks', to: blocked.id, note: 'first' },
					{ type: 'blocks', from: blocker.id },
					{ type: 'relates', to: sibling.id }
				]
			}
		]);

		const { links, moreLinks } = await readLabourLayer(db, actor, target.id);
		expect(moreLinks).toBe(0);
		expect(
			links.map((link) => [link.type, link.direction, link.other.key, link.other.title, link.note])
		).toEqual([
			['blocks', 'out', 'AM-2', 'Blocked', 'first'],
			['blocks', 'in', 'AM-3', 'Blocker', ''],
			['relates', 'both', 'AM-4', 'Sibling', '']
		]);
	});

	it('caps Links and counts the rest', async () => {
		const target = await labour();
		const links: LinkInput[] = await Promise.all(
			Array.from({ length: LINKS_SHOWN + 3 }, async () => ({
				type: 'relates',
				to: (await labour()).id
			}))
		);
		for (let at = 0; at < links.length; at += 25) {
			await appraise(db, actor, [{ labourId: target.id, links: links.slice(at, at + 25) }]);
		}
		const layer = await readLabourLayer(db, actor, target.id);
		expect(layer.links).toHaveLength(LINKS_SHOWN);
		expect(layer.moreLinks).toBe(3);
	});

	it('lists Mentions with their source Labour', async () => {
		const target = await labour('Target');
		const source = await labour('Source');
		await addComment(db, actor, source.id, `See ${'AM-1'}`);
		const { mentions } = await readLabourLayer(db, actor, target.id);
		expect(mentions).toHaveLength(1);
		expect(mentions[0]).toMatchObject({
			source: { id: source.id, key: 'AM-2', title: 'Source' },
			authorId: actor.id
		});
		expect(mentions[0].commentId).toBeTypeOf('number');
	});

	it('is not found for a missing Labour', async () => {
		await expect(readLabourLayer(db, actor, 999)).rejects.toThrow(DomainError);
	});

	it('reads in as many statements however much the Labour holds', async () => {
		const target = await labour();
		await attribute('effort', 'scale', { min: 1, max: 5 });
		await defineSkill(db, actor, { key: 'art', label: 'Art' });
		await defineSkill(db, actor, { key: 'sound', label: 'Sound' });
		const first = await labour();
		const kept = async (others: { id: number }[]) => {
			await setValues(db, actor, target.id, { effort: 2 });
			await appraise(db, actor, [
				{
					labourId: target.id,
					brief: 'b',
					refs: [{ href: 'https://example.com' }],
					needs: { art: 2, sound: 3 },
					links: others.map((other, at) => ({
						type: 'relates' as const,
						to: other.id,
						note: `${at}`
					}))
				}
			]);
			for (const other of others) await addComment(db, actor, other.id, 'AM-1 again');
		};
		await kept([first]);
		const few = await statements(() => readLabourLayer(db, actor, target.id));

		await kept([first, ...(await Promise.all(Array.from({ length: 6 }, () => labour())))]);
		expect((await readLabourLayer(db, actor, target.id)).links).toHaveLength(7);
		expect(await statements(() => readLabourLayer(db, actor, target.id))).toBe(few);
	});
});

describe('readRealmLayer', () => {
	it('answers a Realm with nothing kept as defaults', async () => {
		expect(await readRealmLayer(db, actor, realm.id, NOW)).toEqual({
			notes: '',
			halfLifeDays: 14,
			loudness: 5,
			version: 0,
			attributes: [],
			sentiment: [],
			moreSentiment: 0,
			unfiled: [],
			moreUnfiled: 0
		});
	});

	it('shows notes, Attributes with counts, Sentiment with labels and unfiled keys', async () => {
		const target = await labour();
		await tuneRealm(
			db,
			actor,
			realm.id,
			{ notes: '**Play** first', halfLifeDays: 7, loudness: 3 },
			ago(9)
		);
		await attribute('perf', 'scale', { min: 0, max: 4 }, 'Performance');
		await attribute('bugs', 'tags', { members: [{ key: 'crash', label: 'Crash' }] }, 'Bugs');
		await setValues(db, actor, target.id, { perf: 2, bugs: ['crash'] }, ago(5));
		await postPulses(
			db,
			actor,
			realm.id,
			[
				{ key: 'perf', amount: 4, mood: -1 },
				{ key: 'bugs:crash', amount: 2, mood: 0.5 },
				{ key: 'wishlist', amount: 1, mood: 1 }
			],
			NOW
		);

		const layer = await readRealmLayer(db, actor, realm.id, NOW);
		expect(layer).toMatchObject({ notes: '**Play** first', halfLifeDays: 7, loudness: 3 });
		expect(layer.attributes.map((a) => [a.key, a.label, a.held, a.stale])).toEqual([
			['perf', 'Performance', 1, 0],
			['bugs', 'Bugs', 1, 0]
		]);
		expect(layer.attributes[0]).toMatchObject({ rubric: 'About perf', counts: { '2': 1 } });
		expect(layer.sentiment.map((s) => [s.key, s.label, s.volume, s.mood])).toEqual([
			['perf', 'Performance', 4, -1],
			['bugs:crash', 'Bugs: Crash', 2, 0.5]
		]);
		expect(layer.unfiled).toEqual([{ rawKey: 'wishlist', volume: 1, count: 1 }]);
	});

	it('caps Sentiment and unfiled keys and counts the rest', async () => {
		const total = KEYS_SHOWN + 4;
		for (let at = 0; at < total; at++) await attribute(`k${at}`, 'scale', { min: 0, max: 4 });
		const keyed = Array.from({ length: total }, (_, at) => ({ key: `k${at}`, amount: 1, mood: 1 }));
		const loose = Array.from({ length: total }, (_, at) => ({
			key: `loose${at}`,
			amount: 1,
			mood: 1
		}));
		await postPulses(db, actor, realm.id, keyed.slice(0, 24), NOW);
		await postPulses(db, actor, realm.id, loose.slice(0, 24), NOW);

		const layer = await readRealmLayer(db, actor, realm.id, NOW);
		expect(layer.sentiment).toHaveLength(KEYS_SHOWN);
		expect(layer.moreSentiment).toBe(4);
		expect(layer.unfiled).toHaveLength(KEYS_SHOWN);
		expect(layer.moreUnfiled).toBe(4);
	});

	it('is not found for a missing Realm', async () => {
		await expect(readRealmLayer(db, actor, 999)).rejects.toThrow(DomainError);
	});

	it('reads in as many statements however much the Realm holds', async () => {
		await attribute('perf', 'scale', { min: 0, max: 4 });
		await postPulses(db, actor, realm.id, [{ key: 'perf', amount: 1, mood: 1 }], NOW);
		const few = await statements(() => readRealmLayer(db, actor, realm.id, NOW));

		for (let at = 0; at < 8; at++) await attribute(`more${at}`, 'scale', { min: 0, max: 4 });
		await postPulses(
			db,
			actor,
			realm.id,
			[
				...Array.from({ length: 8 }, (_, at) => ({ key: `more${at}`, amount: 1, mood: 1 })),
				{ key: 'loose-a', amount: 1, mood: 1 },
				{ key: 'loose-b', amount: 1, mood: 1 }
			],
			NOW
		);
		expect(await statements(() => readRealmLayer(db, actor, realm.id, NOW))).toBe(few);
	});
});

describe('readUserLayer', () => {
	async function affinity(
		userId: number,
		attributeId: number,
		member: string | null,
		rawKey: string
	) {
		await db.insert(pulses).values({
			userId,
			attributeId,
			member,
			rawKey,
			amount: 2,
			mood: 1,
			halfLifeDays: null,
			authorId: actor.id,
			createdAt: NOW
		});
	}

	it('answers a User with nothing kept as empty', async () => {
		expect(await readUserLayer(db, actor.id, NOW)).toEqual({
			skills: [],
			affinity: [],
			moreAffinity: 0
		});
	});

	it('shows Skills with labels and Affinity with its Realm and label', async () => {
		const user = await seedUser(db, 'dev');
		await defineSkill(db, actor, { key: 'art', label: 'Art' });
		await defineSkill(db, actor, { key: 'netcode', label: 'Netcode' });
		await setSkills(db, actor, user, { netcode: 3, art: 5 });
		const bugs = await attribute(
			'bugs',
			'tags',
			{ members: [{ key: 'crash', label: 'Crash' }] },
			'Bugs'
		);
		await affinity(user, bugs.id, 'crash', 'bugs:crash');

		expect(await readUserLayer(db, user, NOW)).toEqual({
			skills: [
				{ key: 'art', label: 'Art', level: 5 },
				{ key: 'netcode', label: 'Netcode', level: 3 }
			],
			affinity: [
				{ realm: 'AM', key: 'bugs:crash', label: 'Bugs: Crash', volume: 2, mood: 1, v: 2 / 7 }
			],
			moreAffinity: 0
		});
	});

	it('keeps Users apart and caps Affinity', async () => {
		const user = await seedUser(db, 'dev');
		const other = await seedUser(db, 'other');
		for (let at = 0; at < KEYS_SHOWN + 2; at++) {
			await affinity(user, (await attribute(`k${at}`, 'text')).id, null, `k${at}`);
		}
		await affinity(other, (await attribute('mine', 'text')).id, null, 'mine');

		const layer = await readUserLayer(db, user, NOW);
		expect(layer.affinity).toHaveLength(KEYS_SHOWN);
		expect(layer.moreAffinity).toBe(2);
		expect(layer.affinity.map((entry) => entry.key)).not.toContain('mine');
		expect((await readUserLayer(db, other, NOW)).affinity.map((entry) => entry.key)).toEqual([
			'mine'
		]);
	});

	it('reads in as many statements however much the User holds', async () => {
		const user = await seedUser(db, 'dev');
		await defineSkill(db, actor, { key: 'art', label: 'Art' });
		await setSkills(db, actor, user, { art: 2 });
		await affinity(user, (await attribute('a0', 'text')).id, null, 'a0');
		const few = await statements(() => readUserLayer(db, user, NOW));

		await defineSkill(db, actor, { key: 'sound', label: 'Sound' });
		await setSkills(db, actor, user, { sound: 4 });
		for (let at = 1; at < 6; at++)
			await affinity(user, (await attribute(`a${at}`, 'text')).id, null, `a${at}`);
		expect(await statements(() => readUserLayer(db, user, NOW))).toBe(few);
	});

	it('is not found for a missing User', async () => {
		await expect(readUserLayer(db, 999, NOW)).rejects.toThrow(DomainError);
	});
});
