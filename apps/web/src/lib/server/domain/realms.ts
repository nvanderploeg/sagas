import { asc, count, eq } from 'drizzle-orm';
import type { Db, Handle } from '../db/client.ts';
import type { EventSpec } from '../events/types.ts';
import { realmKeys, realms, labours, quests, users } from '../db/schema.ts';
import { falloutEvents, prepareLabourDelete } from './cascade.ts';
import { DomainError } from './errors.ts';
import { getRealm, getState } from './lookup.ts';
import { realmEvent } from './realm-view.ts';
import { CLOSED_STATE, insertState, type StyleSpec } from './states.ts';
import { formatLabourKey, normalizeRealmKey } from './keys.ts';
import { recordLabourKey } from './labours.ts';
import { requireRealmRole } from './access.ts';
import { addOwner } from './memberships.ts';
import { requireText } from './validate.ts';
import { write, type Actor } from './write.ts';

export type Realm = typeof realms.$inferSelect;
export { readBoard, readRealm, type BoardView, type RealmView } from './realm-view.ts';

export async function listRealms(db: Handle) {
	return await db.select().from(realms).orderBy(asc(realms.id));
}

export async function createRealm(
	db: Db,
	actor: Actor,
	input: { name: string; key: string; initialState: StyleSpec }
): Promise<Realm> {
	return createRealmWithStates(db, actor, { ...input, states: [] });
}

// `states` are States before Closed, after the Initial State, in order. One write and one Event.
export async function createRealmWithStates(
	db: Db,
	actor: Actor,
	input: { name: string; key: string; initialState: StyleSpec; states: StyleSpec[] }
): Promise<Realm> {
	const name = requireText(input.name, 'Realm name', 120);
	const key = normalizeRealmKey(input.key);
	return write(db, actor, async (tx) => {
		await assertRealmLimit(tx, actor.id);
		await assertKeyAvailable(tx, key, null);
		const realm = (
			await tx.insert(realms).values({ name, key, createdByUserId: actor.id }).returning()
		)[0];
		await tx.insert(realmKeys).values({ key, realmId: realm.id });
		await addOwner(tx, realm.id, actor.id);
		await insertState(tx, realm.id, CLOSED_STATE, { closed: true });
		const initial = await insertState(tx, realm.id, input.initialState);
		for (const state of input.states) await insertState(tx, realm.id, state);
		const value = (
			await tx
				.update(realms)
				.set({ initialStateId: initial.id })
				.where(eq(realms.id, realm.id))
				.returning()
		)[0];
		return { value, events: [await realmEvent(tx, 'realm.created', realm.id)] };
	});
}

async function assertRealmLimit(tx: Handle, userId: number): Promise<void> {
	const limit = (
		await tx.select({ n: users.realmLimit }).from(users).where(eq(users.id, userId)).limit(1)
	)[0]?.n;
	if (limit === undefined) throw new DomainError('not_found', 'No such User');
	const made = (
		await tx.select({ n: count() }).from(realms).where(eq(realms.createdByUserId, userId))
	)[0].n;
	if (made >= limit) {
		throw new DomainError(
			'forbidden',
			`Realm limit reached: you may create ${limit} ${limit === 1 ? 'Realm' : 'Realms'}. Ask an Admin to raise it.`
		);
	}
}

export async function updateRealm(
	db: Db,
	actor: Actor,
	realmId: number,
	patch: { name: string }
): Promise<Realm> {
	return write(db, actor, async (tx) => {
		const realm = await getRealm(tx, realmId);
		await requireRealmRole(tx, actor, realmId, 'owner');
		const name = requireText(patch.name, 'Realm name', 120);
		if (name === realm.name) return { value: realm, events: [] };
		const value = (
			await tx.update(realms).set({ name }).where(eq(realms.id, realmId)).returning()
		)[0];
		return { value, events: [await realmEvent(tx, 'realm.updated', realmId)] };
	});
}

export async function renameRealmKey(
	db: Db,
	actor: Actor,
	realmId: number,
	input: string
): Promise<Realm> {
	return write(db, actor, async (tx) => {
		const realm = await getRealm(tx, realmId);
		await requireRealmRole(tx, actor, realmId, 'owner');
		const key = normalizeRealmKey(input);
		if (key === realm.key) return { value: realm, events: [] };
		await assertKeyAvailable(tx, key, realmId);

		await tx.insert(realmKeys).values({ key, realmId }).onConflictDoNothing();
		const held = await tx
			.select({ id: labours.id, number: labours.number })
			.from(labours)
			.where(eq(labours.realmId, realmId))
			.orderBy(asc(labours.id));
		const rekeyed = held.map((labour) => ({
			id: labour.id,
			previousKey: formatLabourKey(realm.key, labour.number),
			key: formatLabourKey(key, labour.number)
		}));
		for (const labour of rekeyed) await recordLabourKey(tx, labour.id, labour.key);
		const value = (
			await tx.update(realms).set({ key }).where(eq(realms.id, realmId)).returning()
		)[0];
		const events: EventSpec[] = [await realmEvent(tx, 'realm.updated', realmId)];
		if (rekeyed.length > 0) {
			events.push({ type: 'labour.rekeyed', data: { realmId, labours: rekeyed } });
		}
		return { value, events };
	});
}

export async function setInitialState(
	db: Db,
	actor: Actor,
	realmId: number,
	stateId: number
): Promise<Realm> {
	return write(db, actor, async (tx) => {
		const realm = await getRealm(tx, realmId);
		await requireRealmRole(tx, actor, realmId, 'owner');
		const state = await getState(tx, stateId);
		if (state.realmId !== realmId) {
			throw new DomainError('invalid', 'The Initial State must belong to the Realm');
		}
		if (state.isClosed) throw new DomainError('invalid', 'The Initial State cannot be Closed');
		if (realm.initialStateId === stateId) return { value: realm, events: [] };
		const value = (
			await tx
				.update(realms)
				.set({ initialStateId: stateId })
				.where(eq(realms.id, realmId))
				.returning()
		)[0];
		return { value, events: [await realmEvent(tx, 'realm.updated', realmId)] };
	});
}

export async function deleteRealm(db: Db, actor: Actor, realmId: number): Promise<void> {
	await write(db, actor, async (tx) => {
		await getRealm(tx, realmId);
		await requireRealmRole(tx, actor, realmId, 'owner');
		const held = eq(labours.realmId, realmId);
		const labourIds = (
			await tx.select({ id: labours.id }).from(labours).where(held).orderBy(asc(labours.id))
		).map((row) => row.id);
		const fallout = await prepareLabourDelete(tx, held);
		// The Realm's Quests go with it: they get a deletion each, not a removal of Labours.
		const ownQuests = (
			await tx
				.select({ id: quests.id })
				.from(quests)
				.where(eq(quests.realmId, realmId))
				.orderBy(asc(quests.id))
		).map((row) => row.id);
		for (const questId of ownQuests) fallout.quests.delete(questId);
		await tx.delete(realms).where(eq(realms.id, realmId));
		return {
			value: undefined,
			events: [
				{ type: 'realm.deleted', data: { realmId, labourIds } },
				...ownQuests.map((id): EventSpec => ({ type: 'quest.deleted', data: { id, realmId } })),
				...(await falloutEvents(tx, fallout))
			]
		};
	});
}

async function assertKeyAvailable(db: Handle, key: string, selfId: number | null): Promise<void> {
	const holder = (await db.select().from(realmKeys).where(eq(realmKeys.key, key)).limit(1))[0];
	if (holder && holder.realmId !== selfId) {
		throw new DomainError('conflict', `Realm key ${key} is already in use`);
	}
}
