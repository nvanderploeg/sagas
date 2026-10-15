import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from './client.ts';
import { realmKeys, realms, states, substates, labourKeys, labours, users } from './schema.ts';
import { testDb } from '#lib/server/test/db.ts';

let db: Db;

beforeEach(() => {
	db = testDb();
});

afterEach(() => {
	db.$client.close();
});

const human = (username = 'ada') => ({
	kind: 'human' as const,
	username,
	displayName: username,
	passwordHash: 'hash'
});

const agent = (username = 'bot') => ({
	kind: 'agent' as const,
	username,
	displayName: username
});

const addUser = (values: typeof users.$inferInsert) =>
	db.insert(users).values(values).returning().get();

const addRealm = (key = 'AM', name = 'Amber') =>
	db.insert(realms).values({ name, key }).returning().get();

const addState = (
	realmId: number,
	values: Partial<typeof states.$inferInsert> & { key: string; position: number }
) =>
	db
		.insert(states)
		.values({ label: values.key, color: '#000000', icon: 'dot', realmId, ...values })
		.returning()
		.get();

const addSubstate = (stateId: number, key: string, position: number) =>
	db
		.insert(substates)
		.values({ stateId, key, label: key, color: '#000000', icon: 'dot', position })
		.returning()
		.get();

const defaultOf = (stateId: number) =>
	db.select().from(states).where(eq(states.id, stateId)).get()?.defaultSubstateId;

let ranks = 0;

const addLabour = (
	values: Omit<typeof labours.$inferInsert, 'number' | 'title' | 'rank'> & {
		number?: number;
		rank?: string;
	}
) =>
	db
		.insert(labours)
		.values({ number: 1, title: 'labour', rank: `a${++ranks}`, ...values })
		.returning()
		.get();

describe('users', () => {
	it('stores a human with a password and an agent without one', () => {
		expect(addUser(human()).id).toBeTypeOf('number');
		expect(addUser(agent()).id).toBeTypeOf('number');
	});

	it('rejects a human without a password hash', () => {
		expect(() => addUser({ ...human(), passwordHash: null })).toThrow();
	});

	it('rejects an agent that has a password hash', () => {
		expect(() => addUser({ ...agent(), passwordHash: 'hash' })).toThrow();
	});

	it('rejects an agent flagged as Admin', () => {
		expect(() => addUser({ ...agent(), isAdmin: true })).toThrow();
	});

	it('rejects a kind other than human or agent', () => {
		expect(() => addUser({ ...human(), kind: 'robot' as 'human' })).toThrow();
	});

	it('rejects a username that is not lowercase, and a duplicate one', () => {
		expect(() => addUser(human('Ada'))).toThrow();
		addUser(human('ada'));
		expect(() => addUser(human('ada'))).toThrow();
	});
});

describe('realms', () => {
	it('rejects a realm key that is not uppercase letters and digits of 2 to 6 characters', () => {
		expect(() => addRealm('am')).toThrow();
		expect(() => addRealm('A')).toThrow();
		expect(() => addRealm('AAAAAAA')).toThrow();
		expect(() => addRealm('1AB')).toThrow();
		expect(() => addRealm('A-B')).toThrow();
		expect(addRealm('A1B2C3').key).toBe('A1B2C3');
	});

	it('rejects a duplicate realm key', () => {
		addRealm('AM');
		expect(() => addRealm('AM', 'Other')).toThrow();
	});

	it('rejects an Initial State that belongs to another realm', () => {
		const first = addRealm('AM');
		const second = addRealm('BL');
		const state = addState(first.id, { key: 'todo', position: 0 });

		expect(() =>
			db.update(realms).set({ initialStateId: state.id }).where(eq(realms.id, second.id)).run()
		).toThrow();
		db.update(realms).set({ initialStateId: state.id }).where(eq(realms.id, first.id)).run();
	});
});

describe('states', () => {
	it('allows one Closed State per realm', () => {
		const realm = addRealm();
		addState(realm.id, { key: 'closed', position: 0, isClosed: true });

		expect(() => addState(realm.id, { key: 'done', position: 1, isClosed: true })).toThrow();
		expect(
			addState(addRealm('BL').id, { key: 'closed', position: 0, isClosed: true }).id
		).toBeTypeOf('number');
	});

	it('gives each State of a realm a distinct position and key', () => {
		const realm = addRealm();
		addState(realm.id, { key: 'todo', position: 0 });

		expect(() => addState(realm.id, { key: 'other', position: 0 })).toThrow();
		expect(() => addState(realm.id, { key: 'todo', position: 1 })).toThrow();
	});

	it('gives each Substate of a State a distinct position and key', () => {
		const realm = addRealm();
		const state = addState(realm.id, { key: 'todo', position: 0 });
		addSubstate(state.id, 'review', 0);

		expect(() => addSubstate(state.id, 'other', 0)).toThrow();
		expect(() => addSubstate(state.id, 'review', 1)).toThrow();
	});

	it('removes the Substates of a deleted State, its default among them', () => {
		const realm = addRealm();
		const state = addState(realm.id, { key: 'todo', position: 0 });
		const review = addSubstate(state.id, 'review', 0);
		db.update(states).set({ defaultSubstateId: review.id }).where(eq(states.id, state.id)).run();

		db.delete(states).where(eq(states.id, state.id)).run();

		expect(db.select().from(states).all()).toEqual([]);
		expect(db.select().from(substates).all()).toEqual([]);
	});

	it('clears the default when the default Substate is deleted', () => {
		const realm = addRealm();
		const state = addState(realm.id, { key: 'todo', position: 0 });
		const review = addSubstate(state.id, 'review', 0);
		db.update(states).set({ defaultSubstateId: review.id }).where(eq(states.id, state.id)).run();
		expect(defaultOf(state.id)).toBe(review.id);

		db.delete(substates).where(eq(substates.id, review.id)).run();

		expect(defaultOf(state.id)).toBeNull();
	});

	it('rejects a default Substate that belongs to another State', () => {
		const realm = addRealm();
		const todo = addState(realm.id, { key: 'todo', position: 0 });
		const doing = addState(realm.id, { key: 'doing', position: 1 });
		const foreign = addSubstate(doing.id, 'review', 0);

		expect(() =>
			db.update(states).set({ defaultSubstateId: foreign.id }).where(eq(states.id, todo.id)).run()
		).toThrow();
		expect(defaultOf(todo.id)).toBeNull();
	});
});

describe('labours', () => {
	const setup = () => {
		const realm = addRealm();
		const state = addState(realm.id, { key: 'todo', position: 0 });
		const owner = addUser(human());
		return { realm, state, owner };
	};

	it('rejects a State from another realm', () => {
		const { realm, owner } = setup();
		const otherState = addState(addRealm('BL').id, { key: 'todo', position: 0 });

		expect(() =>
			addLabour({ realmId: realm.id, stateId: otherState.id, ownerId: owner.id })
		).toThrow();
	});

	it('rejects a Substate that belongs to another State', () => {
		const { realm, state, owner } = setup();
		const other = addState(realm.id, { key: 'doing', position: 1 });
		const foreign = addSubstate(other.id, 'review', 0);

		expect(() =>
			addLabour({
				realmId: realm.id,
				stateId: state.id,
				substateId: foreign.id,
				ownerId: owner.id
			})
		).toThrow();
	});

	it('rejects a number below 1 and a repeated number within a realm', () => {
		const { realm, state, owner } = setup();

		expect(() =>
			addLabour({ realmId: realm.id, stateId: state.id, ownerId: owner.id, number: 0 })
		).toThrow();
		addLabour({ realmId: realm.id, stateId: state.id, ownerId: owner.id, number: 1 });
		expect(() =>
			addLabour({ realmId: realm.id, stateId: state.id, ownerId: owner.id, number: 1 })
		).toThrow();
	});

	it('rejects two Labours with one rank in a State', () => {
		const { realm, state, owner } = setup();

		addLabour({ realmId: realm.id, stateId: state.id, ownerId: owner.id, rank: 'a0' });
		expect(() =>
			addLabour({
				realmId: realm.id,
				stateId: state.id,
				ownerId: owner.id,
				number: 2,
				rank: 'a0'
			})
		).toThrow();
	});

	it('clears the Parent of children when the Parent is deleted', () => {
		const { realm, state, owner } = setup();
		const parent = addLabour({ realmId: realm.id, stateId: state.id, ownerId: owner.id });
		const child = addLabour({
			realmId: realm.id,
			stateId: state.id,
			ownerId: owner.id,
			number: 2,
			parentId: parent.id
		});

		db.delete(labours).where(eq(labours.id, parent.id)).run();

		expect(db.select().from(labours).where(eq(labours.id, child.id)).get()?.parentId).toBeNull();
	});

	it('deletes a realm with its States, Labours and keys', () => {
		const { realm, state, owner } = setup();
		const labour = addLabour({ realmId: realm.id, stateId: state.id, ownerId: owner.id });
		addSubstate(state.id, 'review', 0);
		db.update(realms).set({ initialStateId: state.id }).where(eq(realms.id, realm.id)).run();
		db.insert(labourKeys).values({ key: 'AM-9', labourId: labour.id }).run();
		db.insert(realmKeys).values({ key: 'OLD', realmId: realm.id }).run();

		db.delete(realms).where(eq(realms.id, realm.id)).run();

		expect(db.select().from(states).all()).toEqual([]);
		expect(db.select().from(labours).all()).toEqual([]);
		expect(db.select().from(labourKeys).all()).toEqual([]);
		expect(db.select().from(realmKeys).all()).toEqual([]);
	});
});

describe('keys', () => {
	const setup = () => {
		const realm = addRealm();
		const state = addState(realm.id, { key: 'todo', position: 0 });
		const ownerId = addUser(human()).id;
		const first = addLabour({ realmId: realm.id, stateId: state.id, ownerId });
		const second = addLabour({ realmId: realm.id, stateId: state.id, ownerId, number: 2 });
		return { realm, first, second };
	};

	it('stores labour and realm keys in uppercase only', () => {
		const { realm, first } = setup();

		expect(() => db.insert(realmKeys).values({ key: 'old', realmId: realm.id }).run()).toThrow();
		expect(() => db.insert(labourKeys).values({ key: 'am-1', labourId: first.id }).run()).toThrow();
	});

	it('rejects a malformed labour key', () => {
		const { first } = setup();

		for (const key of ['AM', 'AM-0', 'AM-1X', '-1', 'A M-1']) {
			expect(() => db.insert(labourKeys).values({ key, labourId: first.id }).run(), key).toThrow();
		}
	});

	it('gives a key to one Labour and a realm key to one Realm', () => {
		const { realm, first, second } = setup();
		db.insert(labourKeys).values({ key: 'AM-1', labourId: first.id }).run();
		db.insert(realmKeys).values({ key: 'AM', realmId: realm.id }).run();

		expect(() =>
			db.insert(labourKeys).values({ key: 'AM-1', labourId: second.id }).run()
		).toThrow();
		expect(() =>
			db
				.insert(realmKeys)
				.values({ key: 'AM', realmId: addRealm('BL').id })
				.run()
		).toThrow();
	});
});
