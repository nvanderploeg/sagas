import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Db } from './client.ts';
import { realmKeys, realms, states, substates, labourKeys, labours, users } from './schema.ts';
import { testDb } from '#lib/server/test/db.ts';

let db: Db;

beforeEach(async () => {
	db = await testDb();
});

const human = (username = 'ada') => ({
	kind: 'human' as const,
	username,
	displayName: username
});

const agent = (username = 'bot') => ({
	kind: 'agent' as const,
	username,
	displayName: username
});

const addUser = async (values: typeof users.$inferInsert) =>
	(await db.insert(users).values(values).returning())[0];

const addRealm = async (key = 'AM', name = 'Amber') =>
	(await db.insert(realms).values({ name, key }).returning())[0];

const addState = async (
	realmId: number,
	values: Partial<typeof states.$inferInsert> & { key: string; position: number }
) =>
	(
		await db
			.insert(states)
			.values({ label: values.key, color: '#000000', icon: 'dot', realmId, ...values })
			.returning()
	)[0];

const addSubstate = async (stateId: number, key: string, position: number) =>
	(
		await db
			.insert(substates)
			.values({ stateId, key, label: key, color: '#000000', icon: 'dot', position })
			.returning()
	)[0];

const defaultOf = async (stateId: number) =>
	(await db.select().from(states).where(eq(states.id, stateId)).limit(1))[0]?.defaultSubstateId;

let ranks = 0;

const addLabour = async (
	values: Omit<typeof labours.$inferInsert, 'number' | 'title' | 'rank'> & {
		number?: number;
		rank?: string;
	}
) =>
	(
		await db
			.insert(labours)
			.values({ number: 1, title: 'labour', rank: `a${++ranks}`, ...values })
			.returning()
	)[0];

describe('users', () => {
	it('stores a human and an agent without passwords', async () => {
		expect((await addUser(human())).id).toBeTypeOf('number');
		expect((await addUser(agent())).id).toBeTypeOf('number');
	});

	it('rejects an agent with a Firebase uid', async () => {
		await expect(addUser({ ...agent(), firebaseUid: 'uid' })).rejects.toThrow();
	});

	it('rejects a negative realm limit', async () => {
		await expect(addUser({ ...human(), realmLimit: -1 })).rejects.toThrow();
	});

	it('rejects two Users with one email and a mixed-case email', async () => {
		await addUser({ ...human('ada'), email: 'a@x.test' });
		await expect(addUser({ ...human('bob'), email: 'a@x.test' })).rejects.toThrow();
		await expect(addUser({ ...human('cy'), email: 'C@x.test' })).rejects.toThrow();
	});

	it('rejects an agent flagged as Admin', async () => {
		await expect(addUser({ ...agent(), isAdmin: true })).rejects.toThrow();
	});

	it('rejects a kind other than human or agent', async () => {
		await expect(addUser({ ...human(), kind: 'robot' as 'human' })).rejects.toThrow();
	});

	it('rejects a username that is not lowercase, and a duplicate one', async () => {
		await expect(addUser(human('Ada'))).rejects.toThrow();
		await addUser(human('ada'));
		await expect(addUser(human('ada'))).rejects.toThrow();
	});
});

describe('realms', () => {
	it('rejects a realm key that is not uppercase letters and digits of 2 to 6 characters', async () => {
		await expect(addRealm('am')).rejects.toThrow();
		await expect(addRealm('A')).rejects.toThrow();
		await expect(addRealm('AAAAAAA')).rejects.toThrow();
		await expect(addRealm('1AB')).rejects.toThrow();
		await expect(addRealm('A-B')).rejects.toThrow();
		expect((await addRealm('A1B2C3')).key).toBe('A1B2C3');
	});

	it('rejects a duplicate realm key', async () => {
		await addRealm('AM');
		await expect(addRealm('AM', 'Other')).rejects.toThrow();
	});

	it('rejects an Initial State that belongs to another realm', async () => {
		const first = await addRealm('AM');
		const second = await addRealm('BL');
		const state = await addState(first.id, { key: 'todo', position: 0 });

		await expect(
			db.update(realms).set({ initialStateId: state.id }).where(eq(realms.id, second.id))
		).rejects.toThrow();
		await db.update(realms).set({ initialStateId: state.id }).where(eq(realms.id, first.id));
	});
});

describe('states', () => {
	it('allows one Closed State per realm', async () => {
		const realm = await addRealm();
		await addState(realm.id, { key: 'closed', position: 0, isClosed: true });

		await expect(
			addState(realm.id, { key: 'done', position: 1, isClosed: true })
		).rejects.toThrow();
		expect(
			(await addState((await addRealm('BL')).id, { key: 'closed', position: 0, isClosed: true })).id
		).toBeTypeOf('number');
	});

	it('gives each State of a realm a distinct position and key', async () => {
		const realm = await addRealm();
		await addState(realm.id, { key: 'todo', position: 0 });

		await expect(addState(realm.id, { key: 'other', position: 0 })).rejects.toThrow();
		await expect(addState(realm.id, { key: 'todo', position: 1 })).rejects.toThrow();
	});

	it('gives each Substate of a State a distinct position and key', async () => {
		const realm = await addRealm();
		const state = await addState(realm.id, { key: 'todo', position: 0 });
		await addSubstate(state.id, 'review', 0);

		await expect(addSubstate(state.id, 'other', 0)).rejects.toThrow();
		await expect(addSubstate(state.id, 'review', 1)).rejects.toThrow();
	});

	it('removes the Substates of a deleted State, its default among them', async () => {
		const realm = await addRealm();
		const state = await addState(realm.id, { key: 'todo', position: 0 });
		const review = await addSubstate(state.id, 'review', 0);
		await db.update(states).set({ defaultSubstateId: review.id }).where(eq(states.id, state.id));

		await db.delete(states).where(eq(states.id, state.id));

		expect(await db.select().from(states)).toEqual([]);
		expect(await db.select().from(substates)).toEqual([]);
	});

	it('clears the default when the default Substate is deleted', async () => {
		const realm = await addRealm();
		const state = await addState(realm.id, { key: 'todo', position: 0 });
		const review = await addSubstate(state.id, 'review', 0);
		await db.update(states).set({ defaultSubstateId: review.id }).where(eq(states.id, state.id));
		expect(await defaultOf(state.id)).toBe(review.id);

		await db.delete(substates).where(eq(substates.id, review.id));

		expect(await defaultOf(state.id)).toBeNull();
	});

	it('rejects a default Substate that belongs to another State', async () => {
		const realm = await addRealm();
		const todo = await addState(realm.id, { key: 'todo', position: 0 });
		const doing = await addState(realm.id, { key: 'doing', position: 1 });
		const foreign = await addSubstate(doing.id, 'review', 0);

		await expect(
			db.update(states).set({ defaultSubstateId: foreign.id }).where(eq(states.id, todo.id))
		).rejects.toThrow();
		expect(await defaultOf(todo.id)).toBeNull();
	});
});

describe('labours', () => {
	const setup = async () => {
		const realm = await addRealm();
		const state = await addState(realm.id, { key: 'todo', position: 0 });
		const owner = await addUser(human());
		return { realm, state, owner };
	};

	it('rejects a State from another realm', async () => {
		const { realm, owner } = await setup();
		const otherState = await addState((await addRealm('BL')).id, { key: 'todo', position: 0 });

		await expect(
			addLabour({ realmId: realm.id, stateId: otherState.id, ownerId: owner.id })
		).rejects.toThrow();
	});

	it('rejects a Substate that belongs to another State', async () => {
		const { realm, state, owner } = await setup();
		const other = await addState(realm.id, { key: 'doing', position: 1 });
		const foreign = await addSubstate(other.id, 'review', 0);

		await expect(
			addLabour({
				realmId: realm.id,
				stateId: state.id,
				substateId: foreign.id,
				ownerId: owner.id
			})
		).rejects.toThrow();
	});

	it('rejects a number below 1 and a repeated number within a realm', async () => {
		const { realm, state, owner } = await setup();

		await expect(
			addLabour({ realmId: realm.id, stateId: state.id, ownerId: owner.id, number: 0 })
		).rejects.toThrow();
		await addLabour({ realmId: realm.id, stateId: state.id, ownerId: owner.id, number: 1 });
		await expect(
			addLabour({ realmId: realm.id, stateId: state.id, ownerId: owner.id, number: 1 })
		).rejects.toThrow();
	});

	it('rejects two Labours with one rank in a State', async () => {
		const { realm, state, owner } = await setup();

		await addLabour({ realmId: realm.id, stateId: state.id, ownerId: owner.id, rank: 'a0' });
		await expect(
			addLabour({
				realmId: realm.id,
				stateId: state.id,
				ownerId: owner.id,
				number: 2,
				rank: 'a0'
			})
		).rejects.toThrow();
	});

	it('clears the Parent of children when the Parent is deleted', async () => {
		const { realm, state, owner } = await setup();
		const parent = await addLabour({ realmId: realm.id, stateId: state.id, ownerId: owner.id });
		const child = await addLabour({
			realmId: realm.id,
			stateId: state.id,
			ownerId: owner.id,
			number: 2,
			parentId: parent.id
		});

		await db.delete(labours).where(eq(labours.id, parent.id));

		expect(
			(await db.select().from(labours).where(eq(labours.id, child.id)).limit(1))[0]?.parentId
		).toBeNull();
	});

	it('deletes a realm with its States, Labours and keys', async () => {
		const { realm, state, owner } = await setup();
		const labour = await addLabour({ realmId: realm.id, stateId: state.id, ownerId: owner.id });
		await addSubstate(state.id, 'review', 0);
		await db.update(realms).set({ initialStateId: state.id }).where(eq(realms.id, realm.id));
		await db.insert(labourKeys).values({ key: 'AM-9', labourId: labour.id });
		await db.insert(realmKeys).values({ key: 'OLD', realmId: realm.id });

		await db.delete(realms).where(eq(realms.id, realm.id));

		expect(await db.select().from(states)).toEqual([]);
		expect(await db.select().from(labours)).toEqual([]);
		expect(await db.select().from(labourKeys)).toEqual([]);
		expect(await db.select().from(realmKeys)).toEqual([]);
	});
});

describe('keys', () => {
	const setup = async () => {
		const realm = await addRealm();
		const state = await addState(realm.id, { key: 'todo', position: 0 });
		const ownerId = (await addUser(human())).id;
		const first = await addLabour({ realmId: realm.id, stateId: state.id, ownerId });
		const second = await addLabour({ realmId: realm.id, stateId: state.id, ownerId, number: 2 });
		return { realm, first, second };
	};

	it('stores labour and realm keys in uppercase only', async () => {
		const { realm, first } = await setup();

		await expect(db.insert(realmKeys).values({ key: 'old', realmId: realm.id })).rejects.toThrow();
		await expect(
			db.insert(labourKeys).values({ key: 'am-1', labourId: first.id })
		).rejects.toThrow();
	});

	it('rejects a malformed labour key', async () => {
		const { first } = await setup();

		for (const key of ['AM', 'AM-0', 'AM-1X', '-1', 'A M-1']) {
			await expect(
				db.insert(labourKeys).values({ key, labourId: first.id }),
				key
			).rejects.toThrow();
		}
	});

	it('gives a key to one Labour and a realm key to one Realm', async () => {
		const { realm, first, second } = await setup();
		await db.insert(labourKeys).values({ key: 'AM-1', labourId: first.id });
		await db.insert(realmKeys).values({ key: 'AM', realmId: realm.id });

		await expect(
			db.insert(labourKeys).values({ key: 'AM-1', labourId: second.id })
		).rejects.toThrow();
		await expect(
			db.insert(realmKeys).values({ key: 'AM', realmId: (await addRealm('BL')).id })
		).rejects.toThrow();
	});
});
