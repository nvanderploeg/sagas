import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '#lib/server/db/client.ts';
import { events, labourKeys, labours } from '#lib/server/db/schema.ts';
import type { Actor } from './write.ts';
import { testDb } from '#lib/server/test/db.ts';
import { seedActor, seedRealm, seedLabour, seedUser } from '#lib/server/test/fixtures.ts';
import { DomainError } from './errors.ts';
import { getRealm, getLabour } from './lookup.ts';
import { deleteRealm, renameRealmKey } from './realms.ts';
import { createState, createSubstate, listStates } from './states.ts';
import {
	createLabour,
	deleteLabour,
	listLabours,
	moveLabour,
	readLabour,
	resolveLabourKey,
	setParent,
	labourKeyOf,
	updateLabour
} from './labours.ts';

let db: Db;
let actor: Actor;

beforeEach(async () => {
	db = await testDb();
	actor = await seedActor(db);
});

const style = (key: string) => ({ key, label: key, color: '#000000', icon: 'dot' });

const closedOf = async (realmId: number) =>
	(await listStates(db, realmId)).find((s) => s.isClosed)!;

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

describe('numbering', () => {
	it('numbers Labours from the Realm counter, separately per Realm', async () => {
		const am = await seedRealm(db, 'AM');
		const bl = await seedRealm(db, 'BL');

		expect((await seedLabour(db, { realmId: am.id })).number).toBe(1);
		expect((await seedLabour(db, { realmId: am.id })).number).toBe(2);
		expect((await seedLabour(db, { realmId: bl.id })).number).toBe(1);
	});

	it('never reuses a number after its Labour is deleted', async () => {
		const realm = await seedRealm(db, 'AM');
		const last = await seedLabour(db, { realmId: realm.id });

		await deleteLabour(db, actor, last.id);

		expect((await seedLabour(db, { realmId: realm.id })).number).toBe(2);
	});

	it('does not consume a number when creation fails', async () => {
		const realm = await seedRealm(db, 'AM');
		const ownerId = await seedUser(db, 'ada');
		await seedLabour(db, { realmId: realm.id, ownerId });

		await expectDomainError(
			() => createLabour(db, actor, { realmId: realm.id, title: 'x', ownerId, parentId: 999 }),
			'not_found'
		);

		expect((await seedLabour(db, { realmId: realm.id, ownerId })).number).toBe(2);
	});

	it('gives a Labour the key of its Realm and number', async () => {
		const realm = await seedRealm(db, 'AM');
		const labour = await seedLabour(db, { realmId: realm.id });

		expect(await labourKeyOf(db, labour)).toBe('AM-1');
	});
});

describe('resolveLabourKey', () => {
	it('resolves a key in any case', async () => {
		const realm = await seedRealm(db, 'AM');
		const labour = await seedLabour(db, { realmId: realm.id });

		expect((await resolveLabourKey(db, 'am-1'))?.id).toBe(labour.id);
		expect((await resolveLabourKey(db, 'Am-1'))?.id).toBe(labour.id);
	});

	it('returns null for an unknown, malformed or zero-numbered key', async () => {
		const realm = await seedRealm(db, 'AM');
		await seedLabour(db, { realmId: realm.id });

		expect(await resolveLabourKey(db, 'AM-2')).toBeNull();
		expect(await resolveLabourKey(db, 'AM-0')).toBeNull();
		expect(await resolveLabourKey(db, 'nope')).toBeNull();
	});
});

describe('Labour keys', () => {
	it('resolves every key a Labour has held, across renames, moves and renames after moves', async () => {
		const am = await seedRealm(db, 'AM');
		const xy = await seedRealm(db, 'XY');
		const labour = await seedLabour(db, { realmId: am.id });

		await renameRealmKey(db, actor, am.id, 'BM');
		await moveLabour(db, actor, labour.id, { realmId: xy.id });
		await renameRealmKey(db, actor, xy.id, 'ZZ');
		await moveLabour(db, actor, labour.id, { realmId: am.id });
		await renameRealmKey(db, actor, am.id, 'AM');

		for (const key of ['AM-1', 'BM-1', 'XY-1', 'ZZ-1', 'BM-2', 'AM-2']) {
			expect((await resolveLabourKey(db, key))?.id, key).toBe(labour.id);
		}
		expect(await labourKeyOf(db, await getLabour(db, labour.id))).toBe('AM-2');
	});

	it('never points one key at two Labours', async () => {
		const old = await seedRealm(db, 'AM');
		const other = await seedRealm(db, 'XY');
		const moved = await seedLabour(db, { realmId: old.id });
		await moveLabour(db, actor, moved.id, { realmId: other.id });
		await deleteRealm(db, actor, old.id);
		const fresh = await seedRealm(db, 'NU');
		const local = await seedLabour(db, { realmId: fresh.id });

		await expectDomainError(() => renameRealmKey(db, actor, fresh.id, 'AM'), 'conflict');

		expect((await getRealm(db, fresh.id)).key).toBe('NU');
		expect((await resolveLabourKey(db, 'AM-1'))?.id).toBe(moved.id);
		expect((await resolveLabourKey(db, 'NU-1'))?.id).toBe(local.id);
	});

	it('never wedges creation after a rename onto a key its own Labours held', async () => {
		const am = await seedRealm(db, 'AM');
		const xy = await seedRealm(db, 'XY');
		await seedLabour(db, { realmId: xy.id });
		const moved = await seedLabour(db, { realmId: xy.id });
		await moveLabour(db, actor, moved.id, { realmId: am.id });
		await deleteRealm(db, actor, xy.id);
		await renameRealmKey(db, actor, am.id, 'XY');

		const next = await seedLabour(db, { realmId: am.id });
		const after = await seedLabour(db, { realmId: am.id });

		expect(await labourKeyOf(db, next)).toBe('XY-3');
		expect(await labourKeyOf(db, after)).toBe('XY-4');
		expect((await resolveLabourKey(db, 'XY-2'))?.id).toBe(moved.id);
		expect((await resolveLabourKey(db, 'XY-1'))?.id).toBe(moved.id);
	});

	it('never wedges moving in, skipping a number whose key another Labour holds', async () => {
		const am = await seedRealm(db, 'AM');
		const bl = await seedRealm(db, 'BL');
		const away = await seedLabour(db, { realmId: am.id });
		await moveLabour(db, actor, away.id, { realmId: bl.id });
		await deleteRealm(db, actor, am.id);
		const reborn = await seedRealm(db, 'AM');
		const incoming = await seedLabour(db, { realmId: bl.id });

		const moved = await moveLabour(db, actor, incoming.id, { realmId: reborn.id });
		const created = await seedLabour(db, { realmId: reborn.id });

		expect(await labourKeyOf(db, moved)).toBe('AM-2');
		expect(await labourKeyOf(db, created)).toBe('AM-3');
		expect((await resolveLabourKey(db, 'AM-1'))?.id).toBe(away.id);
	});
});

describe('moveLabour', () => {
	it('gives the Labour a key from the target Realm and keeps the old one as an alias', async () => {
		const from = await seedRealm(db, 'AM');
		const to = await seedRealm(db, 'BL');
		const labour = await seedLabour(db, { realmId: from.id });
		await seedLabour(db, { realmId: to.id });

		const moved = await moveLabour(db, actor, labour.id, { realmId: to.id });

		expect(moved.realmId).toBe(to.id);
		expect(moved.number).toBe(2);
		expect(await labourKeyOf(db, moved)).toBe('BL-2');
		expect((await resolveLabourKey(db, 'AM-1'))?.id).toBe(labour.id);
		expect((await resolveLabourKey(db, 'bl-2'))?.id).toBe(labour.id);
	});

	it('moves the Labour into the target Initial State, with its default Substate', async () => {
		const from = await seedRealm(db, 'AM');
		const to = await seedRealm(db, 'BL');
		const labour = await seedLabour(db, { realmId: from.id });
		const target = (await listStates(db, to.id))[0];
		const review = await createSubstate(db, actor, target.id, style('review'));

		const moved = await moveLabour(db, actor, labour.id, { realmId: to.id });

		expect(moved.stateId).toBe(target.id);
		expect(moved.substateId).toBe(review.id);
	});

	it('moves the Labour into the State and Substate the caller picks', async () => {
		const from = await seedRealm(db, 'AM');
		const to = await seedRealm(db, 'BL');
		const labour = await seedLabour(db, { realmId: from.id });
		const doing = await createState(db, actor, to.id, style('doing'));
		await createSubstate(db, actor, doing.id, style('build'));
		const qa = await createSubstate(db, actor, doing.id, style('qa'));

		const moved = await moveLabour(db, actor, labour.id, {
			realmId: to.id,
			stateId: doing.id,
			substateId: qa.id
		});

		expect(moved).toMatchObject({ realmId: to.id, stateId: doing.id, substateId: qa.id });
	});

	it('lands the Labour in the picked State default Substate when only the State is picked', async () => {
		const from = await seedRealm(db, 'AM');
		const to = await seedRealm(db, 'BL');
		const labour = await seedLabour(db, { realmId: from.id });
		const doing = await createState(db, actor, to.id, style('doing'));
		const build = await createSubstate(db, actor, doing.id, style('build'));

		const moved = await moveLabour(db, actor, labour.id, { realmId: to.id, stateId: doing.id });

		expect(moved).toMatchObject({ stateId: doing.id, substateId: build.id });
	});

	it('lands a Closed Labour in the target Closed', async () => {
		const from = await seedRealm(db, 'AM');
		const to = await seedRealm(db, 'BL');
		const labour = await seedLabour(db, { realmId: from.id });
		await updateLabour(db, actor, labour.id, { stateId: (await closedOf(from.id)).id });
		const shipped = await createSubstate(db, actor, (await closedOf(to.id)).id, style('shipped'));

		const moved = await moveLabour(db, actor, labour.id, { realmId: to.id });

		expect(moved).toMatchObject({ stateId: (await closedOf(to.id)).id, substateId: shipped.id });
	});

	it('refuses to move a Closed Labour into an open State', async () => {
		const from = await seedRealm(db, 'AM');
		const to = await seedRealm(db, 'BL');
		const labour = await seedLabour(db, { realmId: from.id });
		await updateLabour(db, actor, labour.id, { stateId: (await closedOf(from.id)).id });

		await expectDomainError(
			() => moveLabour(db, actor, labour.id, { realmId: to.id, stateId: to.initialStateId! }),
			'invalid'
		);
		expect((await getLabour(db, labour.id)).realmId).toBe(from.id);
	});

	it('refuses a State of another Realm, or a Substate of another State', async () => {
		const from = await seedRealm(db, 'AM');
		const to = await seedRealm(db, 'BL');
		const labour = await seedLabour(db, { realmId: from.id });
		const foreign = await createSubstate(db, actor, from.initialStateId!, style('review'));

		await expectDomainError(
			() => moveLabour(db, actor, labour.id, { realmId: to.id, stateId: from.initialStateId! }),
			'invalid'
		);
		await expectDomainError(
			() => moveLabour(db, actor, labour.id, { realmId: to.id, substateId: foreign.id }),
			'invalid'
		);
		expect((await getLabour(db, labour.id)).realmId).toBe(from.id);
	});

	it('keeps a Labour resolvable under every key it has held', async () => {
		const first = await seedRealm(db, 'AM');
		const second = await seedRealm(db, 'BL');
		const labour = await seedLabour(db, { realmId: first.id });

		await moveLabour(db, actor, labour.id, { realmId: second.id });
		await moveLabour(db, actor, labour.id, { realmId: first.id });

		expect((await resolveLabourKey(db, 'AM-1'))?.id).toBe(labour.id);
		expect((await resolveLabourKey(db, 'BL-1'))?.id).toBe(labour.id);
		expect(await labourKeyOf(db, await getLabour(db, labour.id))).toBe('AM-2');
	});

	it('refuses to move into the Realm the Labour is already in', async () => {
		const realm = await seedRealm(db, 'AM');
		const labour = await seedLabour(db, { realmId: realm.id });

		await expectDomainError(
			() => moveLabour(db, actor, labour.id, { realmId: realm.id }),
			'invalid'
		);
	});

	it('keeps the Parent and the Children when moving', async () => {
		const from = await seedRealm(db, 'AM');
		const to = await seedRealm(db, 'BL');
		const parent = await seedLabour(db, { realmId: to.id });
		const labour = await seedLabour(db, { realmId: from.id, parentId: parent.id });
		const child = await seedLabour(db, { realmId: from.id, parentId: labour.id });

		await moveLabour(db, actor, labour.id, { realmId: to.id });

		expect((await getLabour(db, labour.id)).parentId).toBe(parent.id);
		expect(await getLabour(db, child.id)).toMatchObject({ parentId: labour.id, realmId: from.id });
	});
});

describe('Parent', () => {
	it('lets a Labour sit under a Labour in any Realm', async () => {
		const am = await seedRealm(db, 'AM');
		const bl = await seedRealm(db, 'BL');
		const parent = await seedLabour(db, { realmId: bl.id });

		const child = await seedLabour(db, { realmId: am.id, parentId: parent.id });

		expect(child.parentId).toBe(parent.id);
	});

	it('rejects a Labour as its own Parent', async () => {
		const realm = await seedRealm(db, 'AM');
		const labour = await seedLabour(db, { realmId: realm.id });

		await expectDomainError(() => setParent(db, actor, labour.id, labour.id), 'invalid');
	});

	it('rejects a Parent that would close a loop of any length', async () => {
		const realm = await seedRealm(db, 'AM');
		const a = await seedLabour(db, { realmId: realm.id });
		const b = await seedLabour(db, { realmId: realm.id, parentId: a.id });
		const c = await seedLabour(db, { realmId: realm.id, parentId: b.id });

		await expectDomainError(() => setParent(db, actor, a.id, c.id), 'conflict');
		expect((await getLabour(db, a.id)).parentId).toBeNull();
	});

	it('clears the link when the Parent is removed, and clears with null', async () => {
		const realm = await seedRealm(db, 'AM');
		const parent = await seedLabour(db, { realmId: realm.id });
		const child = await seedLabour(db, { realmId: realm.id, parentId: parent.id });

		await deleteLabour(db, actor, parent.id);
		expect((await getLabour(db, child.id)).parentId).toBeNull();

		const next = await seedLabour(db, { realmId: realm.id });
		await setParent(db, actor, child.id, next.id);
		expect((await setParent(db, actor, child.id, null)).parentId).toBeNull();
	});
});

describe('updateLabour', () => {
	it('moves to a new State and lands in its default Substate', async () => {
		const realm = await seedRealm(db, 'AM');
		const labour = await seedLabour(db, { realmId: realm.id });
		const doing = await createState(db, actor, realm.id, {
			key: 'doing',
			label: 'Doing',
			color: '#000000',
			icon: 'dot'
		});
		const qa = await createSubstate(db, actor, doing.id, {
			key: 'qa',
			label: 'QA',
			color: '#000000',
			icon: 'dot'
		});

		const updated = await updateLabour(db, actor, labour.id, { stateId: doing.id });

		expect(updated.stateId).toBe(doing.id);
		expect(updated.substateId).toBe(qa.id);
	});

	it('moves a Labour to Closed without a Substate when Closed has none', async () => {
		const realm = await seedRealm(db, 'AM');
		const labour = await seedLabour(db, { realmId: realm.id });
		const closed = (await listStates(db, realm.id)).find((s) => s.isClosed)!;

		const updated = await updateLabour(db, actor, labour.id, { stateId: closed.id });

		expect(updated).toMatchObject({ stateId: closed.id, substateId: null });
	});

	it('validates the owner and assignee, and allows an empty assignee', async () => {
		const realm = await seedRealm(db, 'AM');
		const labour = await seedLabour(db, { realmId: realm.id });
		const other = await seedUser(db, 'grace');

		await expectDomainError(() => updateLabour(db, actor, labour.id, { ownerId: 999 }), 'invalid');
		expect((await updateLabour(db, actor, labour.id, { assigneeId: other })).assigneeId).toBe(
			other
		);
		expect((await updateLabour(db, actor, labour.id, { assigneeId: null })).assigneeId).toBeNull();
	});

	it('edits the title and description and rejects a blank title', async () => {
		const realm = await seedRealm(db, 'AM');
		const labour = await seedLabour(db, { realmId: realm.id });

		const updated = await updateLabour(db, actor, labour.id, {
			title: ' Fix login ',
			description: 'Steps...'
		});

		expect(updated).toMatchObject({ title: 'Fix login', description: 'Steps...' });
		await expectDomainError(() => updateLabour(db, actor, labour.id, { title: '   ' }), 'invalid');
	});

	it('refuses a State of another Realm', async () => {
		const realm = await seedRealm(db, 'AM');
		const other = await seedRealm(db, 'BL');
		const labour = await seedLabour(db, { realmId: realm.id });
		const foreign = (await listStates(db, other.id))[0];

		await expectDomainError(
			() => updateLabour(db, actor, labour.id, { stateId: foreign.id }),
			'invalid'
		);
	});
});

describe('createLabour', () => {
	it('lands in the Initial State with its default Substate', async () => {
		const realm = await seedRealm(db, 'AM');
		const labour = await seedLabour(db, { realmId: realm.id });

		expect(labour.stateId).toBe(realm.initialStateId);
		expect(labour.substateId).toBeNull();
		expect(labour.description).toBe('');
	});

	it('rejects an owner that does not exist and a parent that does not exist', async () => {
		const realm = await seedRealm(db, 'AM');

		await expectDomainError(
			() => createLabour(db, actor, { realmId: realm.id, title: 'x', ownerId: 999 }),
			'invalid'
		);
		await expectDomainError(
			() => seedLabour(db, { realmId: realm.id, parentId: 999 }),
			'not_found'
		);
	});

	it('lists the Labours of a Realm by number', async () => {
		const realm = await seedRealm(db, 'AM');
		await seedLabour(db, { realmId: realm.id, title: 'first' });
		await seedLabour(db, { realmId: realm.id, title: 'second' });

		expect((await listLabours(db, realm.id)).map((t) => t.title)).toEqual(['first', 'second']);
	});
});

describe('deleteLabour', () => {
	it('removes the Labour and every key it held', async () => {
		const from = await seedRealm(db, 'AM');
		const to = await seedRealm(db, 'BL');
		const labour = await seedLabour(db, { realmId: from.id });
		await moveLabour(db, actor, labour.id, { realmId: to.id });

		await deleteLabour(db, actor, labour.id);

		expect(await db.select().from(labours).where(eq(labours.id, labour.id))).toEqual([]);
		expect(await resolveLabourKey(db, 'AM-1')).toBeNull();
		expect(await db.select().from(labourKeys)).toEqual([]);
	});
});

describe('Labels', () => {
	it('are normalized, deduplicated and sorted on create', async () => {
		const realm = await seedRealm(db, 'AM');
		const labour = await seedLabour(db, {
			realmId: realm.id,
			labels: [' Wayfinder:Map ', 'bug', 'wayfinder:map']
		});
		expect(labour.labels).toEqual(['bug', 'wayfinder:map']);
		expect((await readLabour(db, labour.id)).labels).toEqual(['bug', 'wayfinder:map']);
	});

	it('are replaced, added to and removed from by an update', async () => {
		const realm = await seedRealm(db, 'AM');
		const labour = await seedLabour(db, { realmId: realm.id, labels: ['a', 'b'] });
		expect((await updateLabour(db, actor, labour.id, { addLabels: ['c'] })).labels).toEqual([
			'a',
			'b',
			'c'
		]);
		expect(
			(await updateLabour(db, actor, labour.id, { removeLabels: ['a', 'nope'] })).labels
		).toEqual(['b', 'c']);
		expect(
			(await updateLabour(db, actor, labour.id, { labels: ['z'], addLabels: ['y'] })).labels
		).toEqual(['y', 'z']);
		expect((await updateLabour(db, actor, labour.id, { labels: [] })).labels).toEqual([]);
	});

	it('record no Event when the set does not change', async () => {
		const realm = await seedRealm(db, 'AM');
		const labour = await seedLabour(db, { realmId: realm.id, labels: ['a'] });
		const before = (await db.select().from(events)).length;
		await updateLabour(db, actor, labour.id, { labels: ['A'], addLabels: ['a'] });
		expect(await db.select().from(events)).toHaveLength(before);
	});

	it('are refused when malformed or too many', async () => {
		const realm = await seedRealm(db, 'AM');
		const labour = await seedLabour(db, { realmId: realm.id });
		for (const bad of ['', 'has space', '-lead', 'x'.repeat(41), 'UPPER!']) {
			await expectDomainError(
				() => updateLabour(db, actor, labour.id, { labels: [bad] }),
				'invalid'
			);
		}
		const many = Array.from({ length: 21 }, (_, i) => `l${i}`);
		await expectDomainError(() => updateLabour(db, actor, labour.id, { labels: many }), 'invalid');
		expect((await readLabour(db, labour.id)).labels).toEqual([]);
	});
});
