import { beforeEach, describe, expect, it } from 'vitest';
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

beforeEach(async () => {
	db = await testDb();
	actor = await seedActor(db);
});

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

const spec = (key: string) => ({ key, label: key, color: '#abcdef', icon: 'dot' });

const order = async (realmId: number) => (await listStates(db, realmId)).map((s) => s.key);

describe('open States', () => {
	it('is open by default, and createState can start one not open', async () => {
		const realm = await seedRealm(db, 'AM');

		const doing = await createState(db, actor, realm.id, spec('doing'));
		const backlog = await createState(db, actor, realm.id, spec('backlog'), undefined, false);

		expect([doing.isOpen, backlog.isOpen]).toEqual([true, false]);
	});

	it('toggles with updateState and emits a state.updated Event', async () => {
		const realm = await seedRealm(db, 'AM');
		const doing = await createState(db, actor, realm.id, spec('doing'));

		expect((await updateState(db, actor, doing.id, { open: false })).isOpen).toBe(false);
		expect((await updateState(db, actor, doing.id, { open: true })).isOpen).toBe(true);
	});

	it('keeps Closed never open', async () => {
		const realm = await seedRealm(db, 'AM');
		const closed = (await listStates(db, realm.id)).find((s) => s.isClosed)!;

		expect(closed.isOpen).toBe(false);
		await expectDomainError(() => updateState(db, actor, closed.id, { open: true }), 'forbidden');
	});
});

describe('next States', () => {
	const nextOf = async (realmId: number, key: string) =>
		(await readRealm(db, realmId)).states.find((s) => s.key === key)!.next;

	it("lists a State's next States in the Realm view, in board order", async () => {
		const realm = await seedRealm(db, 'AM');
		const a = await createState(db, actor, realm.id, spec('a'));
		const b = await createState(db, actor, realm.id, spec('b'));
		const c = await createState(db, actor, realm.id, spec('c'));

		await setNextStates(db, actor, a.id, [c.id, b.id]);

		expect(await nextOf(realm.id, 'a')).toEqual([b.id, c.id]);
		expect(await nextOf(realm.id, 'b')).toEqual([]);
	});

	it('replaces the previous set and can clear it', async () => {
		const realm = await seedRealm(db, 'AM');
		const a = await createState(db, actor, realm.id, spec('a'));
		const b = await createState(db, actor, realm.id, spec('b'));
		const c = await createState(db, actor, realm.id, spec('c'));

		await setNextStates(db, actor, a.id, [b.id]);
		await setNextStates(db, actor, a.id, [c.id]);
		expect(await nextOf(realm.id, 'a')).toEqual([c.id]);

		await setNextStates(db, actor, a.id, []);
		expect(await nextOf(realm.id, 'a')).toEqual([]);
	});

	it('rejects itself and States of another Realm', async () => {
		const realm = await seedRealm(db, 'AM');
		const other = await seedRealm(db, 'BN');
		const a = await createState(db, actor, realm.id, spec('a'));
		const foreign = await createState(db, actor, other.id, spec('x'));

		await expectDomainError(() => setNextStates(db, actor, a.id, [a.id]), 'invalid');
		await expectDomainError(() => setNextStates(db, actor, a.id, [foreign.id]), 'invalid');
	});

	it('gives Closed no next States', async () => {
		const realm = await seedRealm(db, 'AM');
		const a = await createState(db, actor, realm.id, spec('a'));
		const closed = (await listStates(db, realm.id)).find((s) => s.isClosed)!;

		await expectDomainError(() => setNextStates(db, actor, closed.id, [a.id]), 'forbidden');
	});

	it('drops a flow when its target State is deleted', async () => {
		const realm = await seedRealm(db, 'AM');
		const a = await createState(db, actor, realm.id, spec('a'));
		const b = await createState(db, actor, realm.id, spec('b'));
		await setNextStates(db, actor, a.id, [b.id]);

		await deleteState(db, actor, b.id);

		expect(await nextOf(realm.id, 'a')).toEqual([]);
	});

	it('does not restrict moves', async () => {
		const realm = await seedRealm(db, 'AM');
		const a = await createState(db, actor, realm.id, spec('a'));
		const b = await createState(db, actor, realm.id, spec('b'));
		const c = await createState(db, actor, realm.id, spec('c'));
		await setNextStates(db, actor, a.id, [b.id]);
		const labour = await seedLabour(db, { realmId: realm.id });
		await updateLabour(db, actor, labour.id, { stateId: a.id });

		expect((await updateLabour(db, actor, labour.id, { stateId: c.id })).stateId).toBe(c.id);
	});
});

describe('State order', () => {
	it('places a new State before Closed, and Closed stays last', async () => {
		const realm = await seedRealm(db, 'AM');

		await createState(db, actor, realm.id, spec('doing'));
		await createState(db, actor, realm.id, spec('review'));

		expect(await order(realm.id)).toEqual(['todo', 'doing', 'review', 'closed']);
	});

	it('inserts a State at the given index among the open States', async () => {
		const realm = await seedRealm(db, 'AM');

		await createState(db, actor, realm.id, spec('doing'), 0);

		expect(await order(realm.id)).toEqual(['doing', 'todo', 'closed']);
	});

	it('rejects an index past the open States, which would land after Closed', async () => {
		const realm = await seedRealm(db, 'AM');

		await expectDomainError(() => createState(db, actor, realm.id, spec('doing'), 2), 'invalid');
		expect(await order(realm.id)).toEqual(['todo', 'closed']);
	});

	it('rejects a key already used in the Realm, and the built-in Closed key', async () => {
		const realm = await seedRealm(db, 'AM');

		await expectDomainError(() => createState(db, actor, realm.id, spec('todo')), 'conflict');
		await expectDomainError(() => createState(db, actor, realm.id, spec('closed')), 'conflict');
	});

	it('rejects a malformed key, color or icon', async () => {
		const realm = await seedRealm(db, 'AM');

		await expectDomainError(
			() => createState(db, actor, realm.id, { ...spec('Doing') }),
			'invalid'
		);
		await expectDomainError(
			() => createState(db, actor, realm.id, { ...spec('doing'), color: 'red' }),
			'invalid'
		);
		await expectDomainError(
			() => createState(db, actor, realm.id, { ...spec('doing'), icon: 'Dot Icon' }),
			'invalid'
		);
	});

	it('moves an open State to another open position', async () => {
		const realm = await seedRealm(db, 'AM');
		await createState(db, actor, realm.id, spec('doing'));
		await createState(db, actor, realm.id, spec('review'));

		await moveState(
			db,
			actor,
			(await listStates(db, realm.id)).find((s) => s.key === 'review')!.id,
			0
		);

		expect(await order(realm.id)).toEqual(['review', 'todo', 'doing', 'closed']);
	});

	it('refuses to move Closed', async () => {
		const realm = await seedRealm(db, 'AM');
		const closed = (await listStates(db, realm.id)).find((s) => s.isClosed)!;

		await expectDomainError(() => moveState(db, actor, closed.id, 0), 'forbidden');
	});

	it('refuses to move an open State past Closed', async () => {
		const realm = await seedRealm(db, 'AM');
		const todo = (await listStates(db, realm.id))[0];

		await expectDomainError(() => moveState(db, actor, todo.id, 1), 'invalid');
		expect(await order(realm.id)).toEqual(['todo', 'closed']);
	});
});

describe('updateState', () => {
	it('renames an open State and recolors it', async () => {
		const realm = await seedRealm(db, 'AM');
		const todo = (await listStates(db, realm.id))[0];

		const updated = await updateState(db, actor, todo.id, { label: 'Backlog', color: '#010203' });

		expect(updated).toMatchObject({ label: 'Backlog', color: '#010203', key: 'todo' });
	});

	it('refuses to rename Closed', async () => {
		const realm = await seedRealm(db, 'AM');
		const closed = (await listStates(db, realm.id)).find((s) => s.isClosed)!;

		await expectDomainError(
			() => updateState(db, actor, closed.id, { label: 'Done' }),
			'forbidden'
		);
		expect((await getState(db, closed.id)).label).toBe('Closed');
	});

	it('still recolors and re-icons Closed', async () => {
		const realm = await seedRealm(db, 'AM');
		const closed = (await listStates(db, realm.id)).find((s) => s.isClosed)!;

		const updated = await updateState(db, actor, closed.id, {
			label: 'Closed',
			color: '#123456',
			icon: 'flag'
		});

		expect(updated).toMatchObject({ color: '#123456', icon: 'flag', label: 'Closed' });
	});
});

describe('deleteState', () => {
	it('removes an open State and closes the gap in positions', async () => {
		const realm = await seedRealm(db, 'AM');
		const doing = await createState(db, actor, realm.id, spec('doing'));
		await createState(db, actor, realm.id, spec('review'));

		await deleteState(db, actor, doing.id);

		expect(await order(realm.id)).toEqual(['todo', 'review', 'closed']);
		expect((await listStates(db, realm.id)).map((s) => s.position)).toEqual([0, 1, 2]);
	});

	it('refuses to remove Closed', async () => {
		const realm = await seedRealm(db, 'AM');
		const closed = (await listStates(db, realm.id)).find((s) => s.isClosed)!;

		await expectDomainError(() => deleteState(db, actor, closed.id), 'forbidden');
	});

	it('refuses to remove the Initial State', async () => {
		const realm = await seedRealm(db, 'AM');
		const todo = (await listStates(db, realm.id))[0];

		await expectDomainError(() => deleteState(db, actor, todo.id), 'conflict');
	});

	it('refuses to remove a State that still holds Labours', async () => {
		const realm = await seedRealm(db, 'AM');
		const doing = await createState(db, actor, realm.id, spec('doing'));
		await seedLabour(db, { realmId: realm.id, stateId: doing.id });

		await expectDomainError(() => deleteState(db, actor, doing.id), 'conflict');
	});
});

describe('Substates', () => {
	const todoId = async (realmId: number) => (await listStates(db, realmId))[0].id;

	it('makes the first Substate the default and moves existing Labours into it', async () => {
		const realm = await seedRealm(db, 'AM');
		const labour = await seedLabour(db, { realmId: realm.id });
		expect(labour.substateId).toBeNull();

		const review = await createSubstate(db, actor, await todoId(realm.id), spec('review'));

		expect((await getState(db, await todoId(realm.id))).defaultSubstateId).toBe(review.id);
		expect(
			(await db.$client.query('SELECT substate_id FROM sagas_labours WHERE id = $1', [labour.id]))
				.rows[0].substate_id
		).toBe(review.id);
	});

	it('lands a Labour without a Substate in the State default, and rejects a Substate of another State', async () => {
		const realm = await seedRealm(db, 'AM');
		const first = await createSubstate(db, actor, await todoId(realm.id), spec('review'));
		const doing = await createState(db, actor, realm.id, spec('doing'));
		const other = await createSubstate(db, actor, doing.id, spec('qa'));

		const labour = await seedLabour(db, { realmId: realm.id });
		expect(labour.substateId).toBe(first.id);

		await expectDomainError(
			() => updateLabour(db, actor, labour.id, { substateId: other.id }),
			'invalid'
		);
	});

	it('rejects a Substate on a State that has none, and a Substate of another State on create', async () => {
		const realm = await seedRealm(db, 'AM');
		const doing = await createState(db, actor, realm.id, spec('doing'));
		const qa = await createSubstate(db, actor, doing.id, spec('qa'));
		const ownerId = await seedUser(db, 'owner');

		await expectDomainError(
			() => createLabour(db, actor, { realmId: realm.id, title: 'x', ownerId, substateId: qa.id }),
			'invalid'
		);
	});

	it('keeps the default when another Substate is added, and reorders Substates', async () => {
		const realm = await seedRealm(db, 'AM');
		const review = await createSubstate(db, actor, await todoId(realm.id), spec('review'));
		const qa = await createSubstate(db, actor, await todoId(realm.id), spec('qa'));

		expect((await getState(db, await todoId(realm.id))).defaultSubstateId).toBe(review.id);
		await moveSubstate(db, actor, qa.id, 0);
		expect((await listSubstates(db, await todoId(realm.id))).map((s) => s.key)).toEqual([
			'qa',
			'review'
		]);
	});

	it('updates a Substate label without changing its key', async () => {
		const realm = await seedRealm(db, 'AM');
		const review = await createSubstate(db, actor, await todoId(realm.id), spec('review'));

		expect(await updateSubstate(db, actor, review.id, { label: 'Code review' })).toMatchObject({
			key: 'review',
			label: 'Code review'
		});
	});

	it('sets the default only to one of the State own Substates', async () => {
		const realm = await seedRealm(db, 'AM');
		const review = await createSubstate(db, actor, await todoId(realm.id), spec('review'));
		const doing = await createState(db, actor, realm.id, spec('doing'));
		const qa = await createSubstate(db, actor, doing.id, spec('qa'));

		await expectDomainError(
			async () => setDefaultSubstate(db, actor, await todoId(realm.id), qa.id),
			'invalid'
		);
		expect(
			(await setDefaultSubstate(db, actor, await todoId(realm.id), review.id)).defaultSubstateId
		).toBe(review.id);
	});

	it('refuses to remove the default Substate while others remain', async () => {
		const realm = await seedRealm(db, 'AM');
		const review = await createSubstate(db, actor, await todoId(realm.id), spec('review'));
		await createSubstate(db, actor, await todoId(realm.id), spec('qa'));

		await expectDomainError(() => deleteSubstate(db, actor, review.id), 'conflict');
	});

	it('refuses to remove a Substate that still holds Labours', async () => {
		const realm = await seedRealm(db, 'AM');
		const qa = await createSubstate(db, actor, await todoId(realm.id), spec('review'));
		const extra = await createSubstate(db, actor, await todoId(realm.id), spec('qa'));
		await seedLabour(db, { realmId: realm.id });
		await setDefaultSubstate(db, actor, await todoId(realm.id), extra.id);

		await expectDomainError(() => deleteSubstate(db, actor, qa.id), 'conflict');
	});

	it('clears the default when the last Substate is removed', async () => {
		const realm = await seedRealm(db, 'AM');
		const review = await createSubstate(db, actor, await todoId(realm.id), spec('review'));

		await deleteSubstate(db, actor, review.id);

		expect((await getState(db, await todoId(realm.id))).defaultSubstateId).toBeNull();
		expect(await listSubstates(db, await todoId(realm.id))).toEqual([]);
	});

	it('lets Closed hold Substates', async () => {
		const realm = await seedRealm(db, 'AM');
		const closed = (await listStates(db, realm.id)).find((s) => s.isClosed)!;

		const done = await createSubstate(db, actor, closed.id, spec('shipped'));

		expect((await getState(db, closed.id)).defaultSubstateId).toBe(done.id);
	});
});
