import { beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '#lib/server/db/client.ts';
import type { Actor } from './write.ts';
import { testDb } from '#lib/server/test/db.ts';
import { seedActor, seedRealm, seedLabour, TODO } from '#lib/server/test/fixtures.ts';
import { DomainError } from './errors.ts';
import { getRealm } from './lookup.ts';
import { eventsSince } from '../events/log.ts';
import {
	createRealm,
	createRealmWithStates,
	deleteRealm,
	listRealms,
	renameRealmKey,
	setInitialState,
	updateRealm
} from './realms.ts';
import { createState, listStates } from './states.ts';
import { moveLabour, resolveLabourKey, labourKeyOf } from './labours.ts';

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

describe('createRealm', () => {
	it('creates the built-in Closed State last, with the Initial State before it', async () => {
		const realm = await seedRealm(db, 'AM');

		expect((await listStates(db, realm.id)).map((s) => [s.key, s.isClosed])).toEqual([
			['todo', false],
			['closed', true]
		]);
		expect(realm.initialStateId).toBe((await listStates(db, realm.id))[0].id);
	});

	it('stores the key uppercase', async () => {
		await seedRealm(db, 'am');

		expect((await listRealms(db)).map((p) => p.key)).toEqual(['AM']);
	});

	it('rejects an invalid key without creating anything', async () => {
		await expectDomainError(() => seedRealm(db, 'A'), 'invalid');
		expect(await listRealms(db)).toEqual([]);
	});

	it('rejects a key already used, ignoring case', async () => {
		await seedRealm(db, 'AM');

		await expectDomainError(() => seedRealm(db, 'am'), 'conflict');
	});

	it('rejects a Closed Initial State and creates nothing', async () => {
		await expectDomainError(
			() =>
				createRealm(db, actor, {
					name: 'Closed Initial',
					key: 'CI',
					initialState: { ...TODO, key: 'closed' }
				}),
			'conflict'
		);
		expect(await listRealms(db)).toEqual([]);
	});

	it('rejects a blank name', async () => {
		await expectDomainError(
			() => createRealm(db, actor, { name: '  ', key: 'AM', initialState: TODO }),
			'invalid'
		);
	});
});

describe('createRealmWithStates', () => {
	const DOING = { key: 'doing', label: 'Doing', color: '#eab308', icon: 'half' };
	const REVIEW = { key: 'review', label: 'Review', color: '#a855f7', icon: 'eye' };

	it('creates the Realm and its open States in one write with one Event', async () => {
		const realm = await createRealmWithStates(db, actor, {
			name: 'Atlas',
			key: 'AM',
			initialState: TODO,
			states: [DOING, REVIEW]
		});

		expect((await listStates(db, realm.id)).map((s) => s.key)).toEqual([
			'todo',
			'doing',
			'review',
			'closed'
		]);
		expect(realm.initialStateId).toBe((await listStates(db, realm.id))[0].id);
		const events = await eventsSince(db, 0);
		expect(events.map((e) => e.type)).toEqual(['realm.created']);
		const created = events[0].data as { realm: { states: { key: string }[] } };
		expect(created.realm.states.map((s) => s.key)).toEqual(['todo', 'doing', 'review', 'closed']);
	});

	it('creates nothing when one of the States is refused', async () => {
		await expectDomainError(
			() =>
				createRealmWithStates(db, actor, {
					name: 'Atlas',
					key: 'AM',
					initialState: TODO,
					states: [DOING, { ...REVIEW, color: 'purple' }]
				}),
			'invalid'
		);
		expect(await listRealms(db)).toEqual([]);
		expect(await eventsSince(db, 0)).toEqual([]);
	});
});

describe('setInitialState', () => {
	it('picks an open State of the same Realm', async () => {
		const realm = await seedRealm(db, 'AM');
		const doing = await createState(db, actor, realm.id, {
			key: 'doing',
			label: 'Doing',
			color: '#000000',
			icon: 'dot'
		});

		expect((await setInitialState(db, actor, realm.id, doing.id)).initialStateId).toBe(doing.id);
	});

	it('rejects the Closed State', async () => {
		const realm = await seedRealm(db, 'AM');
		const closed = (await listStates(db, realm.id)).find((s) => s.isClosed)!;

		await expectDomainError(() => setInitialState(db, actor, realm.id, closed.id), 'invalid');
	});

	it('rejects a State of another Realm', async () => {
		const first = await seedRealm(db, 'AM');
		const second = await seedRealm(db, 'BL');
		const foreign = (await listStates(db, second.id))[0];

		await expectDomainError(() => setInitialState(db, actor, first.id, foreign.id), 'invalid');
	});
});

describe('updateRealm', () => {
	it('renames the Realm without touching its key', async () => {
		const realm = await seedRealm(db, 'AM');

		const updated = await updateRealm(db, actor, realm.id, { name: 'Amber' });

		expect(updated.name).toBe('Amber');
		expect(updated.key).toBe('AM');
	});
});

describe('renameRealmKey', () => {
	it('keeps the old key resolving to every Labour of the Realm', async () => {
		const realm = await seedRealm(db, 'AM');
		const first = await seedLabour(db, { realmId: realm.id });
		const second = await seedLabour(db, { realmId: realm.id });

		await renameRealmKey(db, actor, realm.id, 'BL');

		expect((await resolveLabourKey(db, 'am-1'))?.id).toBe(first.id);
		expect((await resolveLabourKey(db, 'AM-2'))?.id).toBe(second.id);
		expect((await resolveLabourKey(db, 'BL-2'))?.id).toBe(second.id);
	});

	it('reserves the current and former keys of a Realm while it exists', async () => {
		const realm = await seedRealm(db, 'AM');
		await renameRealmKey(db, actor, realm.id, 'BL');
		const other = await seedRealm(db, 'CX');

		await expectDomainError(() => seedRealm(db, 'AM'), 'conflict');
		await expectDomainError(() => seedRealm(db, 'bl'), 'conflict');
		await expectDomainError(() => renameRealmKey(db, actor, other.id, 'AM'), 'conflict');
		expect((await getRealm(db, other.id)).key).toBe('CX');
	});

	it('lets a Realm take back a key it used to hold', async () => {
		const realm = await seedRealm(db, 'AM');
		await seedLabour(db, { realmId: realm.id });
		await renameRealmKey(db, actor, realm.id, 'BL');

		expect((await renameRealmKey(db, actor, realm.id, 'am')).key).toBe('AM');
		expect((await resolveLabourKey(db, 'BL-1'))?.realmId).toBe(realm.id);
	});

	it('lets a Realm take back its own former key after one of its Labours moved out', async () => {
		const realm = await seedRealm(db, 'AM');
		const other = await seedRealm(db, 'XY');
		const leaving = await seedLabour(db, { realmId: realm.id });
		const staying = await seedLabour(db, { realmId: realm.id });
		await moveLabour(db, actor, leaving.id, { realmId: other.id });
		await renameRealmKey(db, actor, realm.id, 'BM');

		expect((await renameRealmKey(db, actor, realm.id, 'AM')).key).toBe('AM');
		expect((await resolveLabourKey(db, 'AM-1'))?.id).toBe(leaving.id);
		expect((await resolveLabourKey(db, 'AM-2'))?.id).toBe(staying.id);
	});

	it('releases the keys of a deleted Realm, while its moved Labours keep answering to them', async () => {
		const old = await seedRealm(db, 'AM');
		const other = await seedRealm(db, 'BL');
		const labour = await seedLabour(db, { realmId: old.id });
		await moveLabour(db, actor, labour.id, { realmId: other.id });
		await deleteRealm(db, actor, old.id);

		const reborn = await seedRealm(db, 'AM');

		expect(await labourKeyOf(db, await seedLabour(db, { realmId: reborn.id }))).toBe('AM-2');
		expect((await resolveLabourKey(db, 'AM-1'))?.id).toBe(labour.id);
	});

	it('rejects a key already held by another Realm', async () => {
		await seedRealm(db, 'AM');
		const other = await seedRealm(db, 'BL');

		await expectDomainError(() => renameRealmKey(db, actor, other.id, 'AM'), 'conflict');
	});

	it('rejects an invalid key and leaves the Realm unchanged', async () => {
		const realm = await seedRealm(db, 'AM');

		await expectDomainError(() => renameRealmKey(db, actor, realm.id, 'X'), 'invalid');
		expect((await getRealm(db, realm.id)).key).toBe('AM');
	});
});

describe('deleteRealm', () => {
	it('removes the Realm with its States, Labours and keys', async () => {
		const realm = await seedRealm(db, 'AM');
		await seedLabour(db, { realmId: realm.id });
		await renameRealmKey(db, actor, realm.id, 'BL');

		await deleteRealm(db, actor, realm.id);

		expect(await listRealms(db)).toEqual([]);
		expect(await resolveLabourKey(db, 'BL-1')).toBeNull();
		expect(await resolveLabourKey(db, 'AM-1')).toBeNull();
	});

	it('reports a missing Realm as not found', async () => {
		await expectDomainError(() => deleteRealm(db, actor, 999), 'not_found');
	});
});
