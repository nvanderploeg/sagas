import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

const DAY = 86_400_000;
const NOW = new Date('2026-06-15T12:00:00.000Z');
const ago = (days: number) => new Date(NOW.getTime() - days * DAY);

let db: Db;
let actor: Actor;
let realm: { id: number };

beforeEach(() => {
	db = testDb();
	actor = seedActor(db);
	realm = seedRealm(db, 'AM');
});

afterEach(() => {
	db.$client.close();
});

function statements(read: () => unknown): number {
	const prepare = vi.spyOn(db.$client, 'prepare');
	read();
	const count = prepare.mock.calls.length;
	prepare.mockRestore();
	return count;
}

function labour(title = 'Labour') {
	return seedLabour(db, { realmId: realm.id, ownerId: actor.id, title });
}

function attribute(key: string, kind: 'scale' | 'tags' | 'text', spec?: object, label?: string) {
	return defineAttribute(
		db,
		actor,
		realm.id,
		{ key, kind, label: label ?? key, rubric: `About ${key}`, spec },
		ago(10)
	).attribute;
}

describe('readLabourLayer', () => {
	it('answers a Labour with nothing kept as an empty layer', () => {
		const target = labour();
		expect(readLabourLayer(db, target.id)).toEqual({
			brief: '',
			refs: [],
			setBy: null,
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

	it('shows values in Attribute order with labels and how people read them', () => {
		const target = labour();
		attribute('effort', 'scale', { min: 1, max: 5 }, 'Effort');
		attribute('area', 'tags', {
			members: [
				{ key: 'ui', label: 'Interface' },
				{ key: 'db', label: 'Database' }
			]
		});
		attribute('why', 'text', undefined, 'Why');
		setValues(
			db,
			actor,
			target.id,
			{ why: 'Players asked', area: ['db', 'ui'], effort: 3 },
			ago(5)
		);

		const { values } = readLabourLayer(db, target.id);
		expect(values.map(({ key, label, kind, display }) => ({ key, label, kind, display }))).toEqual([
			{ key: 'effort', label: 'Effort', kind: 'scale', display: '3 / 5' },
			{ key: 'area', label: 'area', kind: 'tags', display: 'Database, Interface' },
			{ key: 'why', label: 'Why', kind: 'text', display: 'Players asked' }
		]);
		expect(values[0]).toMatchObject({ value: 3, setBy: actor.id, setAt: ago(5), stale: false });
	});

	it('marks a value stale once its Attribute is revised', () => {
		const target = labour();
		attribute('effort', 'scale', { min: 1, max: 5 });
		setValues(db, actor, target.id, { effort: 2 }, ago(5));
		defineAttribute(db, actor, realm.id, { key: 'effort', kind: 'scale', rubric: 'New' }, ago(1));
		expect(readLabourLayer(db, target.id).values[0].stale).toBe(true);
	});

	it('carries the Brief, References, needs and the stamp', () => {
		const target = labour();
		defineSkill(db, actor, { key: 'netcode', label: 'Netcode' });
		const [{ labourId }] = appraise(
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

		const layer = readLabourLayer(db, target.id);
		expect(layer.brief).toBe('Rubber-banding on join');
		expect(layer.refs).toEqual([
			{ href: 'https://example.com/a', label: 'Report' },
			{ href: 'src/net.ts', label: null }
		]);
		expect(layer.needs).toEqual([
			{ key: 'netcode', label: 'Netcode', level: 4, setBy: actor.id, setAt: ago(3) }
		]);
		expect(layer).toMatchObject({ stamp: null, unappraised: true, setBy: actor.id });
	});

	it('shows the stamp, and stale once the content changes', () => {
		const target = labour();
		const hash = contentHash(db, target.id);
		appraise(db, actor, [{ labourId: target.id, stamp: hash }], ago(2));
		expect(readLabourLayer(db, target.id)).toMatchObject({
			stamp: { appraisedBy: actor.id, appraisedAt: ago(2) },
			unappraised: false,
			stale: false
		});

		addComment(db, actor, target.id, 'Something new');
		expect(readLabourLayer(db, target.id)).toMatchObject({ unappraised: false, stale: true });
	});

	it('gives Links a direction from this Labour and names the other end', () => {
		const target = labour('Target');
		const blocked = labour('Blocked');
		const blocker = labour('Blocker');
		const sibling = labour('Sibling');
		appraise(db, actor, [
			{
				labourId: target.id,
				links: [
					{ type: 'blocks', to: blocked.id, note: 'first' },
					{ type: 'blocks', from: blocker.id },
					{ type: 'relates', to: sibling.id }
				]
			}
		]);

		const { links, moreLinks } = readLabourLayer(db, target.id);
		expect(moreLinks).toBe(0);
		expect(
			links.map((link) => [link.type, link.direction, link.other.key, link.other.title, link.note])
		).toEqual([
			['blocks', 'out', 'AM-2', 'Blocked', 'first'],
			['blocks', 'in', 'AM-3', 'Blocker', ''],
			['relates', 'both', 'AM-4', 'Sibling', '']
		]);
	});

	it('caps Links and counts the rest', () => {
		const target = labour();
		const links: LinkInput[] = Array.from({ length: LINKS_SHOWN + 3 }, () => ({
			type: 'relates',
			to: labour().id
		}));
		for (let at = 0; at < links.length; at += 25) {
			appraise(db, actor, [{ labourId: target.id, links: links.slice(at, at + 25) }]);
		}
		const layer = readLabourLayer(db, target.id);
		expect(layer.links).toHaveLength(LINKS_SHOWN);
		expect(layer.moreLinks).toBe(3);
	});

	it('lists Mentions with their source Labour', () => {
		const target = labour('Target');
		const source = labour('Source');
		addComment(db, actor, source.id, `See ${'AM-1'}`);
		const { mentions } = readLabourLayer(db, target.id);
		expect(mentions).toHaveLength(1);
		expect(mentions[0]).toMatchObject({
			source: { id: source.id, key: 'AM-2', title: 'Source' },
			authorId: actor.id
		});
		expect(mentions[0].commentId).toBeTypeOf('number');
	});

	it('is not found for a missing Labour', () => {
		expect(() => readLabourLayer(db, 999)).toThrow(DomainError);
	});

	it('reads in as many statements however much the Labour holds', () => {
		const target = labour();
		attribute('effort', 'scale', { min: 1, max: 5 });
		defineSkill(db, actor, { key: 'art', label: 'Art' });
		defineSkill(db, actor, { key: 'sound', label: 'Sound' });
		const first = labour();
		const kept = (others: { id: number }[]) => {
			setValues(db, actor, target.id, { effort: 2 });
			appraise(db, actor, [
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
			for (const other of others) addComment(db, actor, other.id, 'AM-1 again');
		};
		kept([first]);
		const few = statements(() => readLabourLayer(db, target.id));

		kept([first, ...Array.from({ length: 6 }, () => labour())]);
		expect(readLabourLayer(db, target.id).links).toHaveLength(7);
		expect(statements(() => readLabourLayer(db, target.id))).toBe(few);
	});
});

describe('readRealmLayer', () => {
	it('answers a Realm with nothing kept as defaults', () => {
		expect(readRealmLayer(db, realm.id, NOW)).toEqual({
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

	it('shows notes, Attributes with counts, Sentiment with labels and unfiled keys', () => {
		const target = labour();
		tuneRealm(
			db,
			actor,
			realm.id,
			{ notes: '**Play** first', halfLifeDays: 7, loudness: 3 },
			ago(9)
		);
		attribute('perf', 'scale', { min: 0, max: 4 }, 'Performance');
		attribute('bugs', 'tags', { members: [{ key: 'crash', label: 'Crash' }] }, 'Bugs');
		setValues(db, actor, target.id, { perf: 2, bugs: ['crash'] }, ago(5));
		postPulses(
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

		const layer = readRealmLayer(db, realm.id, NOW);
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

	it('caps Sentiment and unfiled keys and counts the rest', () => {
		const total = KEYS_SHOWN + 4;
		for (let at = 0; at < total; at++) attribute(`k${at}`, 'scale', { min: 0, max: 4 });
		const keyed = Array.from({ length: total }, (_, at) => ({ key: `k${at}`, amount: 1, mood: 1 }));
		const loose = Array.from({ length: total }, (_, at) => ({
			key: `loose${at}`,
			amount: 1,
			mood: 1
		}));
		postPulses(db, actor, realm.id, keyed.slice(0, 24), NOW);
		postPulses(db, actor, realm.id, loose.slice(0, 24), NOW);

		const layer = readRealmLayer(db, realm.id, NOW);
		expect(layer.sentiment).toHaveLength(KEYS_SHOWN);
		expect(layer.moreSentiment).toBe(4);
		expect(layer.unfiled).toHaveLength(KEYS_SHOWN);
		expect(layer.moreUnfiled).toBe(4);
	});

	it('is not found for a missing Realm', () => {
		expect(() => readRealmLayer(db, 999)).toThrow(DomainError);
	});

	it('reads in as many statements however much the Realm holds', () => {
		attribute('perf', 'scale', { min: 0, max: 4 });
		postPulses(db, actor, realm.id, [{ key: 'perf', amount: 1, mood: 1 }], NOW);
		const few = statements(() => readRealmLayer(db, realm.id, NOW));

		for (let at = 0; at < 8; at++) attribute(`more${at}`, 'scale', { min: 0, max: 4 });
		postPulses(
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
		expect(statements(() => readRealmLayer(db, realm.id, NOW))).toBe(few);
	});
});

describe('readUserLayer', () => {
	function affinity(userId: number, attributeId: number, member: string | null, rawKey: string) {
		db.insert(pulses)
			.values({
				userId,
				attributeId,
				member,
				rawKey,
				amount: 2,
				mood: 1,
				halfLifeDays: null,
				authorId: actor.id,
				createdAt: NOW
			})
			.run();
	}

	it('answers a User with nothing kept as empty', () => {
		expect(readUserLayer(db, actor.id, NOW)).toEqual({
			skills: [],
			affinity: [],
			moreAffinity: 0
		});
	});

	it('shows Skills with labels and Affinity with its Realm and label', () => {
		const user = seedUser(db, 'dev');
		defineSkill(db, actor, { key: 'art', label: 'Art' });
		defineSkill(db, actor, { key: 'netcode', label: 'Netcode' });
		setSkills(db, actor, user, { netcode: 3, art: 5 });
		const bugs = attribute('bugs', 'tags', { members: [{ key: 'crash', label: 'Crash' }] }, 'Bugs');
		affinity(user, bugs.id, 'crash', 'bugs:crash');

		expect(readUserLayer(db, user, NOW)).toEqual({
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

	it('keeps Users apart and caps Affinity', () => {
		const user = seedUser(db, 'dev');
		const other = seedUser(db, 'other');
		for (let at = 0; at < KEYS_SHOWN + 2; at++) {
			affinity(user, attribute(`k${at}`, 'text').id, null, `k${at}`);
		}
		affinity(other, attribute('mine', 'text').id, null, 'mine');

		const layer = readUserLayer(db, user, NOW);
		expect(layer.affinity).toHaveLength(KEYS_SHOWN);
		expect(layer.moreAffinity).toBe(2);
		expect(layer.affinity.map((entry) => entry.key)).not.toContain('mine');
		expect(readUserLayer(db, other, NOW).affinity.map((entry) => entry.key)).toEqual(['mine']);
	});

	it('reads in as many statements however much the User holds', () => {
		const user = seedUser(db, 'dev');
		defineSkill(db, actor, { key: 'art', label: 'Art' });
		setSkills(db, actor, user, { art: 2 });
		affinity(user, attribute('a0', 'text').id, null, 'a0');
		const few = statements(() => readUserLayer(db, user, NOW));

		defineSkill(db, actor, { key: 'sound', label: 'Sound' });
		setSkills(db, actor, user, { sound: 4 });
		for (let at = 1; at < 6; at++) affinity(user, attribute(`a${at}`, 'text').id, null, `a${at}`);
		expect(statements(() => readUserLayer(db, user, NOW))).toBe(few);
	});

	it('is not found for a missing User', () => {
		expect(() => readUserLayer(db, 999, NOW)).toThrow(DomainError);
	});
});
