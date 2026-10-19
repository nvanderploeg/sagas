import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '#lib/server/db/client.ts';
import type { Actor } from './write.ts';
import { testDb } from '#lib/server/test/db.ts';
import { seedActor, seedRealm, seedLabour, seedUser } from '#lib/server/test/fixtures.ts';
import { DomainError } from './errors.ts';
import {
	createState,
	createSubstate,
	deleteState,
	deleteSubstate,
	listStates,
	listSubstates,
	moveState,
	moveSubstate,
	setDefaultSubstate,
	setNextStates,
	updateState,
	updateSubstate
} from './states.ts';
import { getState } from './lookup.ts';
import { createLabour, updateLabour } from './labours.ts';
import { readRealm } from './realm-view.ts';

let db: Db;
let actor: Actor;

beforeEach(() => {
	db = testDb();
	actor = seedActor(db);
});

afterEach(() => {
	db.$client.close();
});

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

const spec = (key: string) => ({ key, label: key, color: '#abcdef', icon: 'dot' });

const order = (realmId: number) => listStates(db, realmId).map((s) => s.key);

describe('open States', () => {
	it('is open by default, and createState can start one not open', () => {
		const realm = seedRealm(db, 'AM');

		const doing = createState(db, actor, realm.id, spec('doing'));
		const backlog = createState(db, actor, realm.id, spec('backlog'), undefined, false);

		expect([doing.isOpen, backlog.isOpen]).toEqual([true, false]);
	});

	it('toggles with updateState and emits a state.updated Event', () => {
		const realm = seedRealm(db, 'AM');
		const doing = createState(db, actor, realm.id, spec('doing'));

		expect(updateState(db, actor, doing.id, { open: false }).isOpen).toBe(false);
		expect(updateState(db, actor, doing.id, { open: true }).isOpen).toBe(true);
	});

	it('keeps Closed never open', () => {
		const realm = seedRealm(db, 'AM');
		const closed = listStates(db, realm.id).find((s) => s.isClosed)!;

		expect(closed.isOpen).toBe(false);
		expectDomainError(() => updateState(db, actor, closed.id, { open: true }), 'forbidden');
	});
});

describe('next States', () => {
	const nextOf = (realmId: number, key: string) =>
		readRealm(db, realmId).states.find((s) => s.key === key)!.next;

	it("lists a State's next States in the Realm view, in board order", () => {
		const realm = seedRealm(db, 'AM');
		const a = createState(db, actor, realm.id, spec('a'));
		const b = createState(db, actor, realm.id, spec('b'));
		const c = createState(db, actor, realm.id, spec('c'));

		setNextStates(db, actor, a.id, [c.id, b.id]);

		expect(nextOf(realm.id, 'a')).toEqual([b.id, c.id]);
		expect(nextOf(realm.id, 'b')).toEqual([]);
	});

	it('replaces the previous set and can clear it', () => {
		const realm = seedRealm(db, 'AM');
		const a = createState(db, actor, realm.id, spec('a'));
		const b = createState(db, actor, realm.id, spec('b'));
		const c = createState(db, actor, realm.id, spec('c'));

		setNextStates(db, actor, a.id, [b.id]);
		setNextStates(db, actor, a.id, [c.id]);
		expect(nextOf(realm.id, 'a')).toEqual([c.id]);

		setNextStates(db, actor, a.id, []);
		expect(nextOf(realm.id, 'a')).toEqual([]);
	});

	it('rejects itself and States of another Realm', () => {
		const realm = seedRealm(db, 'AM');
		const other = seedRealm(db, 'BN');
		const a = createState(db, actor, realm.id, spec('a'));
		const foreign = createState(db, actor, other.id, spec('x'));

		expectDomainError(() => setNextStates(db, actor, a.id, [a.id]), 'invalid');
		expectDomainError(() => setNextStates(db, actor, a.id, [foreign.id]), 'invalid');
	});

	it('gives Closed no next States', () => {
		const realm = seedRealm(db, 'AM');
		const a = createState(db, actor, realm.id, spec('a'));
		const closed = listStates(db, realm.id).find((s) => s.isClosed)!;

		expectDomainError(() => setNextStates(db, actor, closed.id, [a.id]), 'forbidden');
	});

	it('drops a flow when its target State is deleted', () => {
		const realm = seedRealm(db, 'AM');
		const a = createState(db, actor, realm.id, spec('a'));
		const b = createState(db, actor, realm.id, spec('b'));
		setNextStates(db, actor, a.id, [b.id]);

		deleteState(db, actor, b.id);

		expect(nextOf(realm.id, 'a')).toEqual([]);
	});

	it('does not restrict moves', () => {
		const realm = seedRealm(db, 'AM');
		const a = createState(db, actor, realm.id, spec('a'));
		const b = createState(db, actor, realm.id, spec('b'));
		const c = createState(db, actor, realm.id, spec('c'));
		setNextStates(db, actor, a.id, [b.id]);
		const labour = seedLabour(db, { realmId: realm.id });
		updateLabour(db, actor, labour.id, { stateId: a.id });

		expect(updateLabour(db, actor, labour.id, { stateId: c.id }).stateId).toBe(c.id);
	});
});

describe('State order', () => {
	it('places a new State before Closed, and Closed stays last', () => {
		const realm = seedRealm(db, 'AM');

		createState(db, actor, realm.id, spec('doing'));
		createState(db, actor, realm.id, spec('review'));

		expect(order(realm.id)).toEqual(['todo', 'doing', 'review', 'closed']);
	});

	it('inserts a State at the given index among the open States', () => {
		const realm = seedRealm(db, 'AM');

		createState(db, actor, realm.id, spec('doing'), 0);

		expect(order(realm.id)).toEqual(['doing', 'todo', 'closed']);
	});

	it('rejects an index past the open States, which would land after Closed', () => {
		const realm = seedRealm(db, 'AM');

		expectDomainError(() => createState(db, actor, realm.id, spec('doing'), 2), 'invalid');
		expect(order(realm.id)).toEqual(['todo', 'closed']);
	});

	it('rejects a key already used in the Realm, and the built-in Closed key', () => {
		const realm = seedRealm(db, 'AM');

		expectDomainError(() => createState(db, actor, realm.id, spec('todo')), 'conflict');
		expectDomainError(() => createState(db, actor, realm.id, spec('closed')), 'conflict');
	});

	it('rejects a malformed key, color or icon', () => {
		const realm = seedRealm(db, 'AM');

		expectDomainError(() => createState(db, actor, realm.id, { ...spec('Doing') }), 'invalid');
		expectDomainError(
			() => createState(db, actor, realm.id, { ...spec('doing'), color: 'red' }),
			'invalid'
		);
		expectDomainError(
			() => createState(db, actor, realm.id, { ...spec('doing'), icon: 'Dot Icon' }),
			'invalid'
		);
	});

	it('moves an open State to another open position', () => {
		const realm = seedRealm(db, 'AM');
		createState(db, actor, realm.id, spec('doing'));
		createState(db, actor, realm.id, spec('review'));

		moveState(db, actor, listStates(db, realm.id).find((s) => s.key === 'review')!.id, 0);

		expect(order(realm.id)).toEqual(['review', 'todo', 'doing', 'closed']);
	});

	it('refuses to move Closed', () => {
		const realm = seedRealm(db, 'AM');
		const closed = listStates(db, realm.id).find((s) => s.isClosed)!;

		expectDomainError(() => moveState(db, actor, closed.id, 0), 'forbidden');
	});

	it('refuses to move an open State past Closed', () => {
		const realm = seedRealm(db, 'AM');
		const todo = listStates(db, realm.id)[0];

		expectDomainError(() => moveState(db, actor, todo.id, 1), 'invalid');
		expect(order(realm.id)).toEqual(['todo', 'closed']);
	});
});

describe('updateState', () => {
	it('renames an open State and recolors it', () => {
		const realm = seedRealm(db, 'AM');
		const todo = listStates(db, realm.id)[0];

		const updated = updateState(db, actor, todo.id, { label: 'Backlog', color: '#010203' });

		expect(updated).toMatchObject({ label: 'Backlog', color: '#010203', key: 'todo' });
	});

	it('refuses to rename Closed', () => {
		const realm = seedRealm(db, 'AM');
		const closed = listStates(db, realm.id).find((s) => s.isClosed)!;

		expectDomainError(() => updateState(db, actor, closed.id, { label: 'Done' }), 'forbidden');
		expect(getState(db, closed.id).label).toBe('Closed');
	});

	it('still recolors and re-icons Closed', () => {
		const realm = seedRealm(db, 'AM');
		const closed = listStates(db, realm.id).find((s) => s.isClosed)!;

		const updated = updateState(db, actor, closed.id, {
			label: 'Closed',
			color: '#123456',
			icon: 'flag'
		});

		expect(updated).toMatchObject({ color: '#123456', icon: 'flag', label: 'Closed' });
	});
});

describe('deleteState', () => {
	it('removes an open State and closes the gap in positions', () => {
		const realm = seedRealm(db, 'AM');
		const doing = createState(db, actor, realm.id, spec('doing'));
		createState(db, actor, realm.id, spec('review'));

		deleteState(db, actor, doing.id);

		expect(order(realm.id)).toEqual(['todo', 'review', 'closed']);
		expect(listStates(db, realm.id).map((s) => s.position)).toEqual([0, 1, 2]);
	});

	it('refuses to remove Closed', () => {
		const realm = seedRealm(db, 'AM');
		const closed = listStates(db, realm.id).find((s) => s.isClosed)!;

		expectDomainError(() => deleteState(db, actor, closed.id), 'forbidden');
	});

	it('refuses to remove the Initial State', () => {
		const realm = seedRealm(db, 'AM');
		const todo = listStates(db, realm.id)[0];

		expectDomainError(() => deleteState(db, actor, todo.id), 'conflict');
	});

	it('refuses to remove a State that still holds Labours', () => {
		const realm = seedRealm(db, 'AM');
		const doing = createState(db, actor, realm.id, spec('doing'));
		seedLabour(db, { realmId: realm.id, stateId: doing.id });

		expectDomainError(() => deleteState(db, actor, doing.id), 'conflict');
	});
});

describe('Substates', () => {
	const todoId = (realmId: number) => listStates(db, realmId)[0].id;

	it('makes the first Substate the default and moves existing Labours into it', () => {
		const realm = seedRealm(db, 'AM');
		const labour = seedLabour(db, { realmId: realm.id });
		expect(labour.substateId).toBeNull();

		const review = createSubstate(db, actor, todoId(realm.id), spec('review'));

		expect(getState(db, todoId(realm.id)).defaultSubstateId).toBe(review.id);
		expect(
			db.$client.prepare('SELECT substate_id FROM labours WHERE id = ?').pluck().get(labour.id)
		).toBe(review.id);
	});

	it('lands a Labour without a Substate in the State default, and rejects a Substate of another State', () => {
		const realm = seedRealm(db, 'AM');
		const first = createSubstate(db, actor, todoId(realm.id), spec('review'));
		const doing = createState(db, actor, realm.id, spec('doing'));
		const other = createSubstate(db, actor, doing.id, spec('qa'));

		const labour = seedLabour(db, { realmId: realm.id });
		expect(labour.substateId).toBe(first.id);

		expectDomainError(
			() => updateLabour(db, actor, labour.id, { substateId: other.id }),
			'invalid'
		);
	});

	it('rejects a Substate on a State that has none, and a Substate of another State on create', () => {
		const realm = seedRealm(db, 'AM');
		const doing = createState(db, actor, realm.id, spec('doing'));
		const qa = createSubstate(db, actor, doing.id, spec('qa'));
		const ownerId = seedUser(db, 'owner');

		expectDomainError(
			() => createLabour(db, actor, { realmId: realm.id, title: 'x', ownerId, substateId: qa.id }),
			'invalid'
		);
	});

	it('keeps the default when another Substate is added, and reorders Substates', () => {
		const realm = seedRealm(db, 'AM');
		const review = createSubstate(db, actor, todoId(realm.id), spec('review'));
		const qa = createSubstate(db, actor, todoId(realm.id), spec('qa'));

		expect(getState(db, todoId(realm.id)).defaultSubstateId).toBe(review.id);
		moveSubstate(db, actor, qa.id, 0);
		expect(listSubstates(db, todoId(realm.id)).map((s) => s.key)).toEqual(['qa', 'review']);
	});

	it('updates a Substate label without changing its key', () => {
		const realm = seedRealm(db, 'AM');
		const review = createSubstate(db, actor, todoId(realm.id), spec('review'));

		expect(updateSubstate(db, actor, review.id, { label: 'Code review' })).toMatchObject({
			key: 'review',
			label: 'Code review'
		});
	});

	it('sets the default only to one of the State own Substates', () => {
		const realm = seedRealm(db, 'AM');
		const review = createSubstate(db, actor, todoId(realm.id), spec('review'));
		const doing = createState(db, actor, realm.id, spec('doing'));
		const qa = createSubstate(db, actor, doing.id, spec('qa'));

		expectDomainError(() => setDefaultSubstate(db, actor, todoId(realm.id), qa.id), 'invalid');
		expect(setDefaultSubstate(db, actor, todoId(realm.id), review.id).defaultSubstateId).toBe(
			review.id
		);
	});

	it('refuses to remove the default Substate while others remain', () => {
		const realm = seedRealm(db, 'AM');
		const review = createSubstate(db, actor, todoId(realm.id), spec('review'));
		createSubstate(db, actor, todoId(realm.id), spec('qa'));

		expectDomainError(() => deleteSubstate(db, actor, review.id), 'conflict');
	});

	it('refuses to remove a Substate that still holds Labours', () => {
		const realm = seedRealm(db, 'AM');
		const qa = createSubstate(db, actor, todoId(realm.id), spec('review'));
		const extra = createSubstate(db, actor, todoId(realm.id), spec('qa'));
		seedLabour(db, { realmId: realm.id });
		setDefaultSubstate(db, actor, todoId(realm.id), extra.id);

		expectDomainError(() => deleteSubstate(db, actor, qa.id), 'conflict');
	});

	it('clears the default when the last Substate is removed', () => {
		const realm = seedRealm(db, 'AM');
		const review = createSubstate(db, actor, todoId(realm.id), spec('review'));

		deleteSubstate(db, actor, review.id);

		expect(getState(db, todoId(realm.id)).defaultSubstateId).toBeNull();
		expect(listSubstates(db, todoId(realm.id))).toEqual([]);
	});

	it('lets Closed hold Substates', () => {
		const realm = seedRealm(db, 'AM');
		const closed = listStates(db, realm.id).find((s) => s.isClosed)!;

		const done = createSubstate(db, actor, closed.id, spec('shipped'));

		expect(getState(db, closed.id).defaultSubstateId).toBe(done.id);
	});
});
