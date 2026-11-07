import { beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '#lib/server/db/client.ts';
import { DomainError } from '#lib/server/domain/errors.ts';
import { renameRealmKey } from '#lib/server/domain/realms.ts';
import { createQuest } from '#lib/server/domain/quests.ts';
import { createSubstate, listStates } from '#lib/server/domain/states.ts';
import { moveLabour } from '#lib/server/domain/labours.ts';
import { testDb } from '#lib/server/test/db.ts';
import {
	seedActor,
	seedRealm,
	seedLabour,
	seedUser,
	anyRealmId
} from '#lib/server/test/fixtures.ts';
import * as refs from './refs.ts';

let db: Db;
const viewer = { id: 1 };

beforeEach(async () => {
	db = await testDb();
});

async function failure(action: () => unknown): Promise<DomainError> {
	try {
		await action();
	} catch (error) {
		if (error instanceof DomainError) return error;
		throw error;
	}
	throw new Error('expected a DomainError');
}

const style = (key: string) => ({ key, label: key, color: '#000000', icon: 'dot' });

describe('labourId', () => {
	it('resolves a key in any case, and an id given as a number', async () => {
		const realm = await seedRealm(db, 'AM');
		const labour = await seedLabour(db, { realmId: realm.id });

		expect(await refs.labourId(db, 'AM-1', viewer)).toBe(labour.id);
		expect(await refs.labourId(db, ' am-1 ', viewer)).toBe(labour.id);
		expect(await refs.labourId(db, labour.id, viewer)).toBe(labour.id);
	});

	it('never reads a string as an id', async () => {
		const realm = await seedRealm(db, 'AM');
		const labour = await seedLabour(db, { realmId: realm.id });

		for (const action of [
			() => refs.labourId(db, String(labour.id), viewer),
			() => refs.realmId(db, String(realm.id), viewer),
			async () => refs.userId(db, String(await seedUser(db)), { id: 0 }),
			() => refs.stateId(db, realm.id, String(realm.initialStateId))
		]) {
			expect(await failure(action)).toMatchObject({
				code: 'invalid',
				message: expect.stringContaining('give an id as a JSON number')
			});
		}
	});

	it('resolves a former key after a move and after a Realm key rename', async () => {
		const am = await seedRealm(db, 'AM');
		const ops = await seedRealm(db, 'OPS');
		const labour = await seedLabour(db, { realmId: am.id });
		await moveLabour(db, await seedActor(db), labour.id, { realmId: ops.id });
		await renameRealmKey(db, await seedActor(db), ops.id, 'OP');

		for (const key of ['am-1', 'OPS-1', 'op-1'])
			expect(await refs.labourId(db, key, viewer)).toBe(labour.id);
	});

	it('tells a malformed reference from a missing Labour', async () => {
		await seedRealm(db, 'AM');

		expect(await failure(() => refs.labourId(db, 'not a key', viewer))).toMatchObject({
			code: 'invalid',
			message: '"not a key" is not a Labour key, e.g. "AM-12"'
		});
		expect(await failure(() => refs.labourId(db, 'am-9', viewer))).toMatchObject({
			code: 'not_found',
			message: 'No Labour has the key AM-9'
		});
		expect(await failure(() => refs.labourId(db, 999, viewer))).toMatchObject({
			code: 'not_found',
			message: 'No Labour has the id 999'
		});
	});
});

describe('realmId and userId', () => {
	it('resolves a Realm by current key, former key or id', async () => {
		const realm = await seedRealm(db, 'AM');
		await renameRealmKey(db, await seedActor(db), realm.id, 'AX');

		expect(await refs.realmId(db, 'ax', viewer)).toBe(realm.id);
		expect(await refs.realmId(db, 'am', viewer)).toBe(realm.id);
		expect(await refs.realmId(db, realm.id, viewer)).toBe(realm.id);
		expect(await failure(() => refs.realmId(db, 'ZZ', viewer))).toMatchObject({
			code: 'not_found'
		});
	});

	it('resolves a User by username in any case, by id, or as "me"', async () => {
		const id = await seedUser(db, 'ada');
		const me = { id: await seedUser(db, 'grace') };

		expect(await refs.userId(db, 'Ada', me)).toBe(id);
		expect(await refs.userId(db, id, me)).toBe(id);
		expect(await refs.userId(db, 'me', me)).toBe(me.id);
		expect(await refs.userId(db, ' ME ', me)).toBe(me.id);
		expect(await failure(() => refs.userId(db, 'nobody', me))).toMatchObject({ code: 'not_found' });
	});

	it('finds a Quest by id', async () => {
		const quest = await createQuest(db, await seedActor(db), {
			realmId: await anyRealmId(db),
			name: 'Q',
			ownerId: await seedUser(db)
		});

		expect(await refs.questId(db, quest.id, viewer)).toBe(quest.id);
		expect(await failure(() => refs.questId(db, 999, viewer))).toMatchObject({ code: 'not_found' });
	});
});

describe('stateId and substateId', () => {
	it('resolves a State key within its Realm, and lists the keys when it is missing', async () => {
		const realm = await seedRealm(db, 'AM');
		const todo = (await listStates(db, realm.id)).find((s) => s.key === 'todo')!;

		expect(await refs.stateId(db, realm.id, 'TODO')).toBe(todo.id);
		expect(await refs.stateId(db, undefined, todo.id)).toBe(todo.id);
		expect(await failure(() => refs.stateId(db, realm.id, 'doing'))).toMatchObject({
			code: 'not_found',
			message: 'No State "doing" in AM; its States are todo, closed'
		});
	});

	it('needs the Realm for a key, and rejects an id from another Realm', async () => {
		const am = await seedRealm(db, 'AM');
		const ops = await seedRealm(db, 'OPS');
		const opsTodo = (await listStates(db, ops.id))[0];

		expect(await failure(() => refs.stateId(db, undefined, 'todo'))).toMatchObject({
			code: 'invalid'
		});
		expect(await failure(() => refs.stateId(db, am.id, opsTodo.id))).toMatchObject({
			code: 'invalid',
			message: 'The State belongs to another Realm'
		});
	});

	it('resolves a Substate key within its State', async () => {
		const realm = await seedRealm(db, 'AM');
		const todo = (await listStates(db, realm.id))[0];
		const ready = await createSubstate(db, await seedActor(db), todo.id, style('ready'));

		expect(await refs.substateId(db, todo.id, 'ready')).toBe(ready.id);
		expect(await refs.substateId(db, undefined, ready.id)).toBe(ready.id);
		expect(await failure(() => refs.substateId(db, todo.id, 'done'))).toMatchObject({
			code: 'not_found',
			message: 'No Substate "done" in State "todo"; its Substates are ready'
		});
		expect(await failure(() => refs.substateId(db, undefined, 'ready'))).toMatchObject({
			code: 'invalid'
		});
	});
});

describe('placement', () => {
	it('takes at most one of position, before and after, resolving Labour references', async () => {
		const realm = await seedRealm(db, 'AM');
		const labour = await seedLabour(db, { realmId: realm.id });

		expect(await refs.placement(db, {}, viewer)).toBeUndefined();
		expect(await refs.placement(db, { position: 'top' }, viewer)).toBe('top');
		expect(await refs.placement(db, { before: 'am-1' }, viewer)).toEqual({ before: labour.id });
		expect(await refs.placement(db, { after: labour.id }, viewer)).toEqual({ after: labour.id });
		expect(
			await failure(() => refs.placement(db, { position: 'top', after: 'AM-1' }, viewer))
		).toMatchObject({
			code: 'invalid'
		});
	});
});
