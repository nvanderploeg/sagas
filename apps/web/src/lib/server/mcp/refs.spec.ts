import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '#lib/server/db/client.ts';
import { DomainError } from '#lib/server/domain/errors.ts';
import { renameRealmKey } from '#lib/server/domain/realms.ts';
import { createQuest } from '#lib/server/domain/quests.ts';
import { createSubstate, listStates } from '#lib/server/domain/states.ts';
import { moveLabour } from '#lib/server/domain/labours.ts';
import { testDb } from '#lib/server/test/db.ts';
import { seedActor, seedRealm, seedLabour, seedUser } from '#lib/server/test/fixtures.ts';
import * as refs from './refs.ts';

let db: Db;
const viewer = { id: 1 };

beforeEach(() => {
	db = testDb();
});

afterEach(() => {
	db.$client.close();
});

function failure(action: () => unknown): DomainError {
	try {
		action();
	} catch (error) {
		if (error instanceof DomainError) return error;
		throw error;
	}
	throw new Error('expected a DomainError');
}

const style = (key: string) => ({ key, label: key, color: '#000000', icon: 'dot' });

describe('labourId', () => {
	it('resolves a key in any case, and an id given as a number', () => {
		const realm = seedRealm(db, 'AM');
		const labour = seedLabour(db, { realmId: realm.id });

		expect(refs.labourId(db, 'AM-1', viewer)).toBe(labour.id);
		expect(refs.labourId(db, ' am-1 ', viewer)).toBe(labour.id);
		expect(refs.labourId(db, labour.id, viewer)).toBe(labour.id);
	});

	it('never reads a string as an id', () => {
		const realm = seedRealm(db, 'AM');
		const labour = seedLabour(db, { realmId: realm.id });

		for (const action of [
			() => refs.labourId(db, String(labour.id), viewer),
			() => refs.realmId(db, String(realm.id), viewer),
			() => refs.userId(db, String(seedUser(db)), { id: 0 }),
			() => refs.stateId(db, realm.id, String(realm.initialStateId))
		]) {
			expect(failure(action)).toMatchObject({
				code: 'invalid',
				message: expect.stringContaining('give an id as a JSON number')
			});
		}
	});

	it('resolves a former key after a move and after a Realm key rename', () => {
		const am = seedRealm(db, 'AM');
		const ops = seedRealm(db, 'OPS');
		const labour = seedLabour(db, { realmId: am.id });
		moveLabour(db, seedActor(db), labour.id, { realmId: ops.id });
		renameRealmKey(db, seedActor(db), ops.id, 'OP');

		for (const key of ['am-1', 'OPS-1', 'op-1'])
			expect(refs.labourId(db, key, viewer)).toBe(labour.id);
	});

	it('tells a malformed reference from a missing Labour', () => {
		seedRealm(db, 'AM');

		expect(failure(() => refs.labourId(db, 'not a key', viewer))).toMatchObject({
			code: 'invalid',
			message: '"not a key" is not a Labour key, e.g. "AM-12"'
		});
		expect(failure(() => refs.labourId(db, 'am-9', viewer))).toMatchObject({
			code: 'not_found',
			message: 'No Labour has the key AM-9'
		});
		expect(failure(() => refs.labourId(db, 999, viewer))).toMatchObject({
			code: 'not_found',
			message: 'No Labour has the id 999'
		});
	});
});

describe('realmId and userId', () => {
	it('resolves a Realm by current key, former key or id', () => {
		const realm = seedRealm(db, 'AM');
		renameRealmKey(db, seedActor(db), realm.id, 'AX');

		expect(refs.realmId(db, 'ax', viewer)).toBe(realm.id);
		expect(refs.realmId(db, 'am', viewer)).toBe(realm.id);
		expect(refs.realmId(db, realm.id, viewer)).toBe(realm.id);
		expect(failure(() => refs.realmId(db, 'ZZ', viewer))).toMatchObject({ code: 'not_found' });
	});

	it('resolves a User by username in any case, by id, or as "me"', () => {
		const id = seedUser(db, 'ada');
		const me = { id: seedUser(db, 'grace') };

		expect(refs.userId(db, 'Ada', me)).toBe(id);
		expect(refs.userId(db, id, me)).toBe(id);
		expect(refs.userId(db, 'me', me)).toBe(me.id);
		expect(refs.userId(db, ' ME ', me)).toBe(me.id);
		expect(failure(() => refs.userId(db, 'nobody', me))).toMatchObject({ code: 'not_found' });
	});

	it('finds a Quest by id', () => {
		const quest = createQuest(db, seedActor(db), { name: 'Q', ownerId: seedUser(db) });

		expect(refs.questId(db, quest.id)).toBe(quest.id);
		expect(failure(() => refs.questId(db, 999))).toMatchObject({ code: 'not_found' });
	});
});

describe('stateId and substateId', () => {
	it('resolves a State key within its Realm, and lists the keys when it is missing', () => {
		const realm = seedRealm(db, 'AM');
		const todo = listStates(db, realm.id).find((s) => s.key === 'todo')!;

		expect(refs.stateId(db, realm.id, 'TODO')).toBe(todo.id);
		expect(refs.stateId(db, undefined, todo.id)).toBe(todo.id);
		expect(failure(() => refs.stateId(db, realm.id, 'doing'))).toMatchObject({
			code: 'not_found',
			message: 'No State "doing" in AM; its States are todo, closed'
		});
	});

	it('needs the Realm for a key, and rejects an id from another Realm', () => {
		const am = seedRealm(db, 'AM');
		const ops = seedRealm(db, 'OPS');
		const opsTodo = listStates(db, ops.id)[0];

		expect(failure(() => refs.stateId(db, undefined, 'todo'))).toMatchObject({
			code: 'invalid'
		});
		expect(failure(() => refs.stateId(db, am.id, opsTodo.id))).toMatchObject({
			code: 'invalid',
			message: 'The State belongs to another Realm'
		});
	});

	it('resolves a Substate key within its State', () => {
		const realm = seedRealm(db, 'AM');
		const todo = listStates(db, realm.id)[0];
		const ready = createSubstate(db, seedActor(db), todo.id, style('ready'));

		expect(refs.substateId(db, todo.id, 'ready')).toBe(ready.id);
		expect(refs.substateId(db, undefined, ready.id)).toBe(ready.id);
		expect(failure(() => refs.substateId(db, todo.id, 'done'))).toMatchObject({
			code: 'not_found',
			message: 'No Substate "done" in State "todo"; its Substates are ready'
		});
		expect(failure(() => refs.substateId(db, undefined, 'ready'))).toMatchObject({
			code: 'invalid'
		});
	});
});

describe('placement', () => {
	it('takes at most one of position, before and after, resolving Labour references', () => {
		const realm = seedRealm(db, 'AM');
		const labour = seedLabour(db, { realmId: realm.id });

		expect(refs.placement(db, {}, viewer)).toBeUndefined();
		expect(refs.placement(db, { position: 'top' }, viewer)).toBe('top');
		expect(refs.placement(db, { before: 'am-1' }, viewer)).toEqual({ before: labour.id });
		expect(refs.placement(db, { after: labour.id }, viewer)).toEqual({ after: labour.id });
		expect(
			failure(() => refs.placement(db, { position: 'top', after: 'AM-1' }, viewer))
		).toMatchObject({
			code: 'invalid'
		});
	});
});
