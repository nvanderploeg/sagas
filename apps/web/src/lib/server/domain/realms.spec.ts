import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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

describe('createRealm', () => {
	it('creates the built-in Closed State last, with the Initial State before it', () => {
		const realm = seedRealm(db, 'AM');

		expect(listStates(db, realm.id).map((s) => [s.key, s.isClosed])).toEqual([
			['todo', false],
			['closed', true]
		]);
		expect(realm.initialStateId).toBe(listStates(db, realm.id)[0].id);
	});

	it('stores the key uppercase', () => {
		seedRealm(db, 'am');

		expect(listRealms(db).map((p) => p.key)).toEqual(['AM']);
	});

	it('rejects an invalid key without creating anything', () => {
		expectDomainError(() => seedRealm(db, 'A'), 'invalid');
		expect(listRealms(db)).toEqual([]);
	});

	it('rejects a key already used, ignoring case', () => {
		seedRealm(db, 'AM');

		expectDomainError(() => seedRealm(db, 'am'), 'conflict');
	});

	it('rejects a Closed Initial State and creates nothing', () => {
		expectDomainError(
			() =>
				createRealm(db, actor, {
					name: 'Closed Initial',
					key: 'CI',
					initialState: { ...TODO, key: 'closed' }
				}),
			'conflict'
		);
		expect(listRealms(db)).toEqual([]);
	});

	it('rejects a blank name', () => {
		expectDomainError(
			() => createRealm(db, actor, { name: '  ', key: 'AM', initialState: TODO }),
			'invalid'
		);
	});
});

describe('createRealmWithStates', () => {
	const DOING = { key: 'doing', label: 'Doing', color: '#eab308', icon: 'half' };
	const REVIEW = { key: 'review', label: 'Review', color: '#a855f7', icon: 'eye' };

	it('creates the Realm and its open States in one write with one Event', () => {
		const realm = createRealmWithStates(db, actor, {
			name: 'Atlas',
			key: 'AM',
			initialState: TODO,
			states: [DOING, REVIEW]
		});

		expect(listStates(db, realm.id).map((s) => s.key)).toEqual([
			'todo',
			'doing',
			'review',
			'closed'
		]);
		expect(realm.initialStateId).toBe(listStates(db, realm.id)[0].id);
		const events = eventsSince(db, 0);
		expect(events.map((e) => e.type)).toEqual(['realm.created']);
		const created = events[0].data as { realm: { states: { key: string }[] } };
		expect(created.realm.states.map((s) => s.key)).toEqual(['todo', 'doing', 'review', 'closed']);
	});

	it('creates nothing when one of the States is refused', () => {
		expectDomainError(
			() =>
				createRealmWithStates(db, actor, {
					name: 'Atlas',
					key: 'AM',
					initialState: TODO,
					states: [DOING, { ...REVIEW, color: 'purple' }]
				}),
			'invalid'
		);
		expect(listRealms(db)).toEqual([]);
		expect(eventsSince(db, 0)).toEqual([]);
	});
});

describe('setInitialState', () => {
	it('picks an open State of the same Realm', () => {
		const realm = seedRealm(db, 'AM');
		const doing = createState(db, actor, realm.id, {
			key: 'doing',
			label: 'Doing',
			color: '#000000',
			icon: 'dot'
		});

		expect(setInitialState(db, actor, realm.id, doing.id).initialStateId).toBe(doing.id);
	});

	it('rejects the Closed State', () => {
		const realm = seedRealm(db, 'AM');
		const closed = listStates(db, realm.id).find((s) => s.isClosed)!;

		expectDomainError(() => setInitialState(db, actor, realm.id, closed.id), 'invalid');
	});

	it('rejects a State of another Realm', () => {
		const first = seedRealm(db, 'AM');
		const second = seedRealm(db, 'BL');
		const foreign = listStates(db, second.id)[0];

		expectDomainError(() => setInitialState(db, actor, first.id, foreign.id), 'invalid');
	});
});

describe('updateRealm', () => {
	it('renames the Realm without touching its key', () => {
		const realm = seedRealm(db, 'AM');

		const updated = updateRealm(db, actor, realm.id, { name: 'Amber' });

		expect(updated.name).toBe('Amber');
		expect(updated.key).toBe('AM');
	});
});

describe('renameRealmKey', () => {
	it('keeps the old key resolving to every Labour of the Realm', () => {
		const realm = seedRealm(db, 'AM');
		const first = seedLabour(db, { realmId: realm.id });
		const second = seedLabour(db, { realmId: realm.id });

		renameRealmKey(db, actor, realm.id, 'BL');

		expect(resolveLabourKey(db, 'am-1')?.id).toBe(first.id);
		expect(resolveLabourKey(db, 'AM-2')?.id).toBe(second.id);
		expect(resolveLabourKey(db, 'BL-2')?.id).toBe(second.id);
	});

	it('reserves the current and former keys of a Realm while it exists', () => {
		const realm = seedRealm(db, 'AM');
		renameRealmKey(db, actor, realm.id, 'BL');
		const other = seedRealm(db, 'CX');

		expectDomainError(() => seedRealm(db, 'AM'), 'conflict');
		expectDomainError(() => seedRealm(db, 'bl'), 'conflict');
		expectDomainError(() => renameRealmKey(db, actor, other.id, 'AM'), 'conflict');
		expect(getRealm(db, other.id).key).toBe('CX');
	});

	it('lets a Realm take back a key it used to hold', () => {
		const realm = seedRealm(db, 'AM');
		seedLabour(db, { realmId: realm.id });
		renameRealmKey(db, actor, realm.id, 'BL');

		expect(renameRealmKey(db, actor, realm.id, 'am').key).toBe('AM');
		expect(resolveLabourKey(db, 'BL-1')?.realmId).toBe(realm.id);
	});

	it('lets a Realm take back its own former key after one of its Labours moved out', () => {
		const realm = seedRealm(db, 'AM');
		const other = seedRealm(db, 'XY');
		const leaving = seedLabour(db, { realmId: realm.id });
		const staying = seedLabour(db, { realmId: realm.id });
		moveLabour(db, actor, leaving.id, { realmId: other.id });
		renameRealmKey(db, actor, realm.id, 'BM');

		expect(renameRealmKey(db, actor, realm.id, 'AM').key).toBe('AM');
		expect(resolveLabourKey(db, 'AM-1')?.id).toBe(leaving.id);
		expect(resolveLabourKey(db, 'AM-2')?.id).toBe(staying.id);
	});

	it('releases the keys of a deleted Realm, while its moved Labours keep answering to them', () => {
		const old = seedRealm(db, 'AM');
		const other = seedRealm(db, 'BL');
		const labour = seedLabour(db, { realmId: old.id });
		moveLabour(db, actor, labour.id, { realmId: other.id });
		deleteRealm(db, actor, old.id);

		const reborn = seedRealm(db, 'AM');

		expect(labourKeyOf(db, seedLabour(db, { realmId: reborn.id }))).toBe('AM-2');
		expect(resolveLabourKey(db, 'AM-1')?.id).toBe(labour.id);
	});

	it('rejects a key already held by another Realm', () => {
		seedRealm(db, 'AM');
		const other = seedRealm(db, 'BL');

		expectDomainError(() => renameRealmKey(db, actor, other.id, 'AM'), 'conflict');
	});

	it('rejects an invalid key and leaves the Realm unchanged', () => {
		const realm = seedRealm(db, 'AM');

		expectDomainError(() => renameRealmKey(db, actor, realm.id, 'X'), 'invalid');
		expect(getRealm(db, realm.id).key).toBe('AM');
	});
});

describe('deleteRealm', () => {
	it('removes the Realm with its States, Labours and keys', () => {
		const realm = seedRealm(db, 'AM');
		seedLabour(db, { realmId: realm.id });
		renameRealmKey(db, actor, realm.id, 'BL');

		deleteRealm(db, actor, realm.id);

		expect(listRealms(db)).toEqual([]);
		expect(resolveLabourKey(db, 'BL-1')).toBeNull();
		expect(resolveLabourKey(db, 'AM-1')).toBeNull();
	});

	it('reports a missing Realm as not found', () => {
		expectDomainError(() => deleteRealm(db, actor, 999), 'not_found');
	});
});
