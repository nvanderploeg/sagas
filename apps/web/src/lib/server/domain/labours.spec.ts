import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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

beforeEach(() => {
	db = testDb();
	actor = seedActor(db);
});

afterEach(() => {
	db.$client.close();
});

const style = (key: string) => ({ key, label: key, color: '#000000', icon: 'dot' });

const closedOf = (realmId: number) => listStates(db, realmId).find((s) => s.isClosed)!;

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

describe('numbering', () => {
	it('numbers Labours from the Realm counter, separately per Realm', () => {
		const am = seedRealm(db, 'AM');
		const bl = seedRealm(db, 'BL');

		expect(seedLabour(db, { realmId: am.id }).number).toBe(1);
		expect(seedLabour(db, { realmId: am.id }).number).toBe(2);
		expect(seedLabour(db, { realmId: bl.id }).number).toBe(1);
	});

	it('never reuses a number after its Labour is deleted', () => {
		const realm = seedRealm(db, 'AM');
		const last = seedLabour(db, { realmId: realm.id });

		deleteLabour(db, actor, last.id);

		expect(seedLabour(db, { realmId: realm.id }).number).toBe(2);
	});

	it('does not consume a number when creation fails', () => {
		const realm = seedRealm(db, 'AM');
		const ownerId = seedUser(db, 'ada');
		seedLabour(db, { realmId: realm.id, ownerId });

		expectDomainError(
			() => createLabour(db, actor, { realmId: realm.id, title: 'x', ownerId, parentId: 999 }),
			'not_found'
		);

		expect(seedLabour(db, { realmId: realm.id, ownerId }).number).toBe(2);
	});

	it('gives a Labour the key of its Realm and number', () => {
		const realm = seedRealm(db, 'AM');
		const labour = seedLabour(db, { realmId: realm.id });

		expect(labourKeyOf(db, labour)).toBe('AM-1');
	});
});

describe('resolveLabourKey', () => {
	it('resolves a key in any case', () => {
		const realm = seedRealm(db, 'AM');
		const labour = seedLabour(db, { realmId: realm.id });

		expect(resolveLabourKey(db, 'am-1')?.id).toBe(labour.id);
		expect(resolveLabourKey(db, 'Am-1')?.id).toBe(labour.id);
	});

	it('returns null for an unknown, malformed or zero-numbered key', () => {
		const realm = seedRealm(db, 'AM');
		seedLabour(db, { realmId: realm.id });

		expect(resolveLabourKey(db, 'AM-2')).toBeNull();
		expect(resolveLabourKey(db, 'AM-0')).toBeNull();
		expect(resolveLabourKey(db, 'nope')).toBeNull();
	});
});

describe('Labour keys', () => {
	it('resolves every key a Labour has held, across renames, moves and renames after moves', () => {
		const am = seedRealm(db, 'AM');
		const xy = seedRealm(db, 'XY');
		const labour = seedLabour(db, { realmId: am.id });

		renameRealmKey(db, actor, am.id, 'BM');
		moveLabour(db, actor, labour.id, { realmId: xy.id });
		renameRealmKey(db, actor, xy.id, 'ZZ');
		moveLabour(db, actor, labour.id, { realmId: am.id });
		renameRealmKey(db, actor, am.id, 'AM');

		for (const key of ['AM-1', 'BM-1', 'XY-1', 'ZZ-1', 'BM-2', 'AM-2']) {
			expect(resolveLabourKey(db, key)?.id, key).toBe(labour.id);
		}
		expect(labourKeyOf(db, getLabour(db, labour.id))).toBe('AM-2');
	});

	it('never points one key at two Labours', () => {
		const old = seedRealm(db, 'AM');
		const other = seedRealm(db, 'XY');
		const moved = seedLabour(db, { realmId: old.id });
		moveLabour(db, actor, moved.id, { realmId: other.id });
		deleteRealm(db, actor, old.id);
		const fresh = seedRealm(db, 'NU');
		const local = seedLabour(db, { realmId: fresh.id });

		expectDomainError(() => renameRealmKey(db, actor, fresh.id, 'AM'), 'conflict');

		expect(getRealm(db, fresh.id).key).toBe('NU');
		expect(resolveLabourKey(db, 'AM-1')?.id).toBe(moved.id);
		expect(resolveLabourKey(db, 'NU-1')?.id).toBe(local.id);
	});

	it('never wedges creation after a rename onto a key its own Labours held', () => {
		const am = seedRealm(db, 'AM');
		const xy = seedRealm(db, 'XY');
		seedLabour(db, { realmId: xy.id });
		const moved = seedLabour(db, { realmId: xy.id });
		moveLabour(db, actor, moved.id, { realmId: am.id });
		deleteRealm(db, actor, xy.id);
		renameRealmKey(db, actor, am.id, 'XY');

		const next = seedLabour(db, { realmId: am.id });
		const after = seedLabour(db, { realmId: am.id });

		expect(labourKeyOf(db, next)).toBe('XY-3');
		expect(labourKeyOf(db, after)).toBe('XY-4');
		expect(resolveLabourKey(db, 'XY-2')?.id).toBe(moved.id);
		expect(resolveLabourKey(db, 'XY-1')?.id).toBe(moved.id);
	});

	it('never wedges moving in, skipping a number whose key another Labour holds', () => {
		const am = seedRealm(db, 'AM');
		const bl = seedRealm(db, 'BL');
		const away = seedLabour(db, { realmId: am.id });
		moveLabour(db, actor, away.id, { realmId: bl.id });
		deleteRealm(db, actor, am.id);
		const reborn = seedRealm(db, 'AM');
		const incoming = seedLabour(db, { realmId: bl.id });

		const moved = moveLabour(db, actor, incoming.id, { realmId: reborn.id });
		const created = seedLabour(db, { realmId: reborn.id });

		expect(labourKeyOf(db, moved)).toBe('AM-2');
		expect(labourKeyOf(db, created)).toBe('AM-3');
		expect(resolveLabourKey(db, 'AM-1')?.id).toBe(away.id);
	});
});

describe('moveLabour', () => {
	it('gives the Labour a key from the target Realm and keeps the old one as an alias', () => {
		const from = seedRealm(db, 'AM');
		const to = seedRealm(db, 'BL');
		const labour = seedLabour(db, { realmId: from.id });
		seedLabour(db, { realmId: to.id });

		const moved = moveLabour(db, actor, labour.id, { realmId: to.id });

		expect(moved.realmId).toBe(to.id);
		expect(moved.number).toBe(2);
		expect(labourKeyOf(db, moved)).toBe('BL-2');
		expect(resolveLabourKey(db, 'AM-1')?.id).toBe(labour.id);
		expect(resolveLabourKey(db, 'bl-2')?.id).toBe(labour.id);
	});

	it('moves the Labour into the target Initial State, with its default Substate', () => {
		const from = seedRealm(db, 'AM');
		const to = seedRealm(db, 'BL');
		const labour = seedLabour(db, { realmId: from.id });
		const target = listStates(db, to.id)[0];
		const review = createSubstate(db, actor, target.id, style('review'));

		const moved = moveLabour(db, actor, labour.id, { realmId: to.id });

		expect(moved.stateId).toBe(target.id);
		expect(moved.substateId).toBe(review.id);
	});

	it('moves the Labour into the State and Substate the caller picks', () => {
		const from = seedRealm(db, 'AM');
		const to = seedRealm(db, 'BL');
		const labour = seedLabour(db, { realmId: from.id });
		const doing = createState(db, actor, to.id, style('doing'));
		createSubstate(db, actor, doing.id, style('build'));
		const qa = createSubstate(db, actor, doing.id, style('qa'));

		const moved = moveLabour(db, actor, labour.id, {
			realmId: to.id,
			stateId: doing.id,
			substateId: qa.id
		});

		expect(moved).toMatchObject({ realmId: to.id, stateId: doing.id, substateId: qa.id });
	});

	it('lands the Labour in the picked State default Substate when only the State is picked', () => {
		const from = seedRealm(db, 'AM');
		const to = seedRealm(db, 'BL');
		const labour = seedLabour(db, { realmId: from.id });
		const doing = createState(db, actor, to.id, style('doing'));
		const build = createSubstate(db, actor, doing.id, style('build'));

		const moved = moveLabour(db, actor, labour.id, { realmId: to.id, stateId: doing.id });

		expect(moved).toMatchObject({ stateId: doing.id, substateId: build.id });
	});

	it('lands a Closed Labour in the target Closed', () => {
		const from = seedRealm(db, 'AM');
		const to = seedRealm(db, 'BL');
		const labour = seedLabour(db, { realmId: from.id });
		updateLabour(db, actor, labour.id, { stateId: closedOf(from.id).id });
		const shipped = createSubstate(db, actor, closedOf(to.id).id, style('shipped'));

		const moved = moveLabour(db, actor, labour.id, { realmId: to.id });

		expect(moved).toMatchObject({ stateId: closedOf(to.id).id, substateId: shipped.id });
	});

	it('refuses to move a Closed Labour into an open State', () => {
		const from = seedRealm(db, 'AM');
		const to = seedRealm(db, 'BL');
		const labour = seedLabour(db, { realmId: from.id });
		updateLabour(db, actor, labour.id, { stateId: closedOf(from.id).id });

		expectDomainError(
			() => moveLabour(db, actor, labour.id, { realmId: to.id, stateId: to.initialStateId! }),
			'invalid'
		);
		expect(getLabour(db, labour.id).realmId).toBe(from.id);
	});

	it('refuses a State of another Realm, or a Substate of another State', () => {
		const from = seedRealm(db, 'AM');
		const to = seedRealm(db, 'BL');
		const labour = seedLabour(db, { realmId: from.id });
		const foreign = createSubstate(db, actor, from.initialStateId!, style('review'));

		expectDomainError(
			() => moveLabour(db, actor, labour.id, { realmId: to.id, stateId: from.initialStateId! }),
			'invalid'
		);
		expectDomainError(
			() => moveLabour(db, actor, labour.id, { realmId: to.id, substateId: foreign.id }),
			'invalid'
		);
		expect(getLabour(db, labour.id).realmId).toBe(from.id);
	});

	it('keeps a Labour resolvable under every key it has held', () => {
		const first = seedRealm(db, 'AM');
		const second = seedRealm(db, 'BL');
		const labour = seedLabour(db, { realmId: first.id });

		moveLabour(db, actor, labour.id, { realmId: second.id });
		moveLabour(db, actor, labour.id, { realmId: first.id });

		expect(resolveLabourKey(db, 'AM-1')?.id).toBe(labour.id);
		expect(resolveLabourKey(db, 'BL-1')?.id).toBe(labour.id);
		expect(labourKeyOf(db, getLabour(db, labour.id))).toBe('AM-2');
	});

	it('refuses to move into the Realm the Labour is already in', () => {
		const realm = seedRealm(db, 'AM');
		const labour = seedLabour(db, { realmId: realm.id });

		expectDomainError(() => moveLabour(db, actor, labour.id, { realmId: realm.id }), 'invalid');
	});

	it('keeps the Parent and the Children when moving', () => {
		const from = seedRealm(db, 'AM');
		const to = seedRealm(db, 'BL');
		const parent = seedLabour(db, { realmId: to.id });
		const labour = seedLabour(db, { realmId: from.id, parentId: parent.id });
		const child = seedLabour(db, { realmId: from.id, parentId: labour.id });

		moveLabour(db, actor, labour.id, { realmId: to.id });

		expect(getLabour(db, labour.id).parentId).toBe(parent.id);
		expect(getLabour(db, child.id)).toMatchObject({ parentId: labour.id, realmId: from.id });
	});
});

describe('Parent', () => {
	it('lets a Labour sit under a Labour in any Realm', () => {
		const am = seedRealm(db, 'AM');
		const bl = seedRealm(db, 'BL');
		const parent = seedLabour(db, { realmId: bl.id });

		const child = seedLabour(db, { realmId: am.id, parentId: parent.id });

		expect(child.parentId).toBe(parent.id);
	});

	it('rejects a Labour as its own Parent', () => {
		const realm = seedRealm(db, 'AM');
		const labour = seedLabour(db, { realmId: realm.id });

		expectDomainError(() => setParent(db, actor, labour.id, labour.id), 'invalid');
	});

	it('rejects a Parent that would close a loop of any length', () => {
		const realm = seedRealm(db, 'AM');
		const a = seedLabour(db, { realmId: realm.id });
		const b = seedLabour(db, { realmId: realm.id, parentId: a.id });
		const c = seedLabour(db, { realmId: realm.id, parentId: b.id });

		expectDomainError(() => setParent(db, actor, a.id, c.id), 'conflict');
		expect(getLabour(db, a.id).parentId).toBeNull();
	});

	it('clears the link when the Parent is removed, and clears with null', () => {
		const realm = seedRealm(db, 'AM');
		const parent = seedLabour(db, { realmId: realm.id });
		const child = seedLabour(db, { realmId: realm.id, parentId: parent.id });

		deleteLabour(db, actor, parent.id);
		expect(getLabour(db, child.id).parentId).toBeNull();

		const next = seedLabour(db, { realmId: realm.id });
		setParent(db, actor, child.id, next.id);
		expect(setParent(db, actor, child.id, null).parentId).toBeNull();
	});
});

describe('updateLabour', () => {
	it('moves to a new State and lands in its default Substate', () => {
		const realm = seedRealm(db, 'AM');
		const labour = seedLabour(db, { realmId: realm.id });
		const doing = createState(db, actor, realm.id, {
			key: 'doing',
			label: 'Doing',
			color: '#000000',
			icon: 'dot'
		});
		const qa = createSubstate(db, actor, doing.id, {
			key: 'qa',
			label: 'QA',
			color: '#000000',
			icon: 'dot'
		});

		const updated = updateLabour(db, actor, labour.id, { stateId: doing.id });

		expect(updated.stateId).toBe(doing.id);
		expect(updated.substateId).toBe(qa.id);
	});

	it('moves a Labour to Closed without a Substate when Closed has none', () => {
		const realm = seedRealm(db, 'AM');
		const labour = seedLabour(db, { realmId: realm.id });
		const closed = listStates(db, realm.id).find((s) => s.isClosed)!;

		const updated = updateLabour(db, actor, labour.id, { stateId: closed.id });

		expect(updated).toMatchObject({ stateId: closed.id, substateId: null });
	});

	it('validates the owner and assignee, and allows an empty assignee', () => {
		const realm = seedRealm(db, 'AM');
		const labour = seedLabour(db, { realmId: realm.id });
		const other = seedUser(db, 'grace');

		expectDomainError(() => updateLabour(db, actor, labour.id, { ownerId: 999 }), 'invalid');
		expect(updateLabour(db, actor, labour.id, { assigneeId: other }).assigneeId).toBe(other);
		expect(updateLabour(db, actor, labour.id, { assigneeId: null }).assigneeId).toBeNull();
	});

	it('edits the title and description and rejects a blank title', () => {
		const realm = seedRealm(db, 'AM');
		const labour = seedLabour(db, { realmId: realm.id });

		const updated = updateLabour(db, actor, labour.id, {
			title: ' Fix login ',
			description: 'Steps...'
		});

		expect(updated).toMatchObject({ title: 'Fix login', description: 'Steps...' });
		expectDomainError(() => updateLabour(db, actor, labour.id, { title: '   ' }), 'invalid');
	});

	it('refuses a State of another Realm', () => {
		const realm = seedRealm(db, 'AM');
		const other = seedRealm(db, 'BL');
		const labour = seedLabour(db, { realmId: realm.id });
		const foreign = listStates(db, other.id)[0];

		expectDomainError(() => updateLabour(db, actor, labour.id, { stateId: foreign.id }), 'invalid');
	});
});

describe('createLabour', () => {
	it('lands in the Initial State with its default Substate', () => {
		const realm = seedRealm(db, 'AM');
		const labour = seedLabour(db, { realmId: realm.id });

		expect(labour.stateId).toBe(realm.initialStateId);
		expect(labour.substateId).toBeNull();
		expect(labour.description).toBe('');
	});

	it('rejects an owner that does not exist and a parent that does not exist', () => {
		const realm = seedRealm(db, 'AM');

		expectDomainError(
			() => createLabour(db, actor, { realmId: realm.id, title: 'x', ownerId: 999 }),
			'invalid'
		);
		expectDomainError(() => seedLabour(db, { realmId: realm.id, parentId: 999 }), 'not_found');
	});

	it('lists the Labours of a Realm by number', () => {
		const realm = seedRealm(db, 'AM');
		seedLabour(db, { realmId: realm.id, title: 'first' });
		seedLabour(db, { realmId: realm.id, title: 'second' });

		expect(listLabours(db, realm.id).map((t) => t.title)).toEqual(['first', 'second']);
	});
});

describe('deleteLabour', () => {
	it('removes the Labour and every key it held', () => {
		const from = seedRealm(db, 'AM');
		const to = seedRealm(db, 'BL');
		const labour = seedLabour(db, { realmId: from.id });
		moveLabour(db, actor, labour.id, { realmId: to.id });

		deleteLabour(db, actor, labour.id);

		expect(db.select().from(labours).where(eq(labours.id, labour.id)).all()).toEqual([]);
		expect(resolveLabourKey(db, 'AM-1')).toBeNull();
		expect(db.select().from(labourKeys).all()).toEqual([]);
	});
});

describe('Labels', () => {
	it('are normalized, deduplicated and sorted on create', () => {
		const realm = seedRealm(db, 'AM');
		const labour = seedLabour(db, {
			realmId: realm.id,
			labels: [' Wayfinder:Map ', 'bug', 'wayfinder:map']
		});
		expect(labour.labels).toEqual(['bug', 'wayfinder:map']);
		expect(readLabour(db, labour.id).labels).toEqual(['bug', 'wayfinder:map']);
	});

	it('are replaced, added to and removed from by an update', () => {
		const realm = seedRealm(db, 'AM');
		const labour = seedLabour(db, { realmId: realm.id, labels: ['a', 'b'] });
		expect(updateLabour(db, actor, labour.id, { addLabels: ['c'] }).labels).toEqual([
			'a',
			'b',
			'c'
		]);
		expect(updateLabour(db, actor, labour.id, { removeLabels: ['a', 'nope'] }).labels).toEqual([
			'b',
			'c'
		]);
		expect(updateLabour(db, actor, labour.id, { labels: ['z'], addLabels: ['y'] }).labels).toEqual([
			'y',
			'z'
		]);
		expect(updateLabour(db, actor, labour.id, { labels: [] }).labels).toEqual([]);
	});

	it('record no Event when the set does not change', () => {
		const realm = seedRealm(db, 'AM');
		const labour = seedLabour(db, { realmId: realm.id, labels: ['a'] });
		const before = db.select().from(events).all().length;
		updateLabour(db, actor, labour.id, { labels: ['A'], addLabels: ['a'] });
		expect(db.select().from(events).all()).toHaveLength(before);
	});

	it('are refused when malformed or too many', () => {
		const realm = seedRealm(db, 'AM');
		const labour = seedLabour(db, { realmId: realm.id });
		for (const bad of ['', 'has space', '-lead', 'x'.repeat(41), 'UPPER!']) {
			expectDomainError(() => updateLabour(db, actor, labour.id, { labels: [bad] }), 'invalid');
		}
		const many = Array.from({ length: 21 }, (_, i) => `l${i}`);
		expectDomainError(() => updateLabour(db, actor, labour.id, { labels: many }), 'invalid');
		expect(readLabour(db, labour.id).labels).toEqual([]);
	});
});
