import { and, asc, eq, inArray } from 'drizzle-orm';
import type { Db, Handle } from '../db/client.ts';
import { realmKeys, realms, states, labourKeys, labours } from '../db/schema.ts';
import { attachValues, detachValues } from '../agent/attributes.ts';
import { refreshMentions } from '../agent/mentions.ts';
import { refreshLabourText } from '../agent/search.ts';
import { embeddingTextChanged } from '../agent/vectors/hook.ts';
import { refreshEmbeddingInput } from '../agent/vectors/input.ts';
import type { EventSpec } from '../events/types.ts';
import { falloutEvents, prepareLabourDelete } from './cascade.ts';
import { DomainError } from './errors.ts';
import { formatLabourKey, parseLabourKey } from './keys.ts';
import { normalizeLabels } from './labels.ts';
import { getRealm, getState, getSubstate, getLabour, requireUser } from './lookup.ts';
import { rankAt, type Placement } from './rank.ts';
import { listSubstates } from './states.ts';
import {
	readLabour,
	selectLabourViews,
	labourName,
	toLabourView,
	type Labour,
	type LabourView
} from './labour-view.ts';
import { requireText } from './validate.ts';
import { requireActiveMember, requireRealmRole } from './access.ts';
import { write, type Actor } from './write.ts';

export {
	readLabour,
	selectLabourViews,
	toLabourView,
	type Labour,
	type LabourView
} from './labour-view.ts';

const TITLE_MAX = 200;
export const DESCRIPTION_MAX = 50_000;

export type LabourSpec = {
	realmId: number;
	title: string;
	description?: string;
	ownerId: number;
	assigneeId?: number | null;
	stateId?: number;
	substateId?: number | null;
	parentId?: number | null;
	labels?: string[];
	recurrenceId?: number | null;
	placement?: Placement;
};

// A placement applies in the State the Labour ends up in; a new State without one means bottom.
export type LabourPatch = {
	title?: string;
	description?: string;
	ownerId?: number;
	assigneeId?: number | null;
	stateId?: number;
	substateId?: number | null;
	// `labels` replaces the set; `addLabels` and `removeLabels` then adjust it.
	labels?: string[];
	addLabels?: string[];
	removeLabels?: string[];
	placement?: Placement;
};

export async function labourKeyOf(
	db: Handle,
	labour: { realmId: number; number: number }
): Promise<string> {
	return formatLabourKey((await getRealm(db, labour.realmId)).key, labour.number);
}

export async function listLabours(db: Handle, realmId: number): Promise<LabourView[]> {
	return (
		await selectLabourViews(db).where(eq(labours.realmId, realmId)).orderBy(asc(labours.number))
	).map(toLabourView);
}

export async function listColumn(db: Handle, stateId: number): Promise<LabourView[]> {
	return (
		await selectLabourViews(db).where(eq(labours.stateId, stateId)).orderBy(asc(labours.rank))
	).map(toLabourView);
}

async function columnOf(db: Handle, stateId: number) {
	return await db
		.select({ id: labours.id, rank: labours.rank })
		.from(labours)
		.where(eq(labours.stateId, stateId))
		.orderBy(asc(labours.rank));
}

export async function listChildren(db: Handle, labourId: number): Promise<LabourView[]> {
	return (
		await selectLabourViews(db).where(eq(labours.parentId, labourId)).orderBy(asc(labours.id))
	).map(toLabourView);
}

export async function resolveLabourKey(db: Handle, input: string): Promise<LabourView | null> {
	const parsed = parseLabourKey(input);
	if (!parsed) return null;
	const row = (
		await db
			.select({ labourId: labourKeys.labourId })
			.from(labourKeys)
			.where(eq(labourKeys.key, formatLabourKey(parsed.realmKey, parsed.number)))
			.limit(1)
	)[0];
	return row ? await readLabour(db, row.labourId) : null;
}

// Record every key a Labour comes to hold, so that key resolves to it for as long as it exists.
export async function recordLabourKey(db: Handle, labourId: number, key: string): Promise<void> {
	const holder = (await db.select().from(labourKeys).where(eq(labourKeys.key, key)).limit(1))[0];
	if (holder?.labourId === labourId) return;
	if (holder) throw new DomainError('conflict', `Labour key ${key} is already taken`);
	await db.insert(labourKeys).values({ key, labourId });
}

async function labourOutcome(
	db: Handle,
	type: 'labour.created' | 'labour.updated' | 'labour.reparented',
	labourId: number
): Promise<{ value: LabourView; events: EventSpec[] }> {
	const labour = await readLabour(db, labourId);
	return { value: labour, events: [{ type, data: { labour } }] };
}

export async function createLabour(db: Db, actor: Actor, input: LabourSpec): Promise<LabourView> {
	const created = await write(db, actor, async (tx) => {
		const realm = await getRealm(tx, input.realmId);
		await requireRealmRole(tx, actor, realm.id, 'editor');
		const title = requireText(input.title, 'Labour title', TITLE_MAX);
		const description = checkDescription(input.description ?? '');
		const ownerId = await requireUser(tx, input.ownerId, 'Owner');
		const assigneeId =
			input.assigneeId == null ? null : await requireUser(tx, input.assigneeId, 'Assignee');
		await requireActiveMember(tx, realm.id, ownerId, 'Owner');
		if (assigneeId !== null) await requireActiveMember(tx, realm.id, assigneeId, 'Assignee');

		const stateId = input.stateId ?? realm.initialStateId;
		if (stateId === null) throw new DomainError('conflict', 'The Realm has no Initial State');
		const state = await getState(tx, stateId);
		if (state.realmId !== realm.id) {
			throw new DomainError('invalid', 'The State belongs to another Realm');
		}
		const substateId = await substateFor(tx, state, input.substateId);
		const parentId = input.parentId ?? null;
		if (parentId !== null) {
			await requireRealmRole(tx, actor, (await getLabour(tx, parentId)).realmId, 'editor');
			await assertParent(tx, null, parentId);
		}
		const labels = normalizeLabels(input.labels ?? []);

		const rank = await rankAt(
			await columnOf(tx, state.id),
			{ id: null },
			input.placement ?? 'bottom',
			'State',
			labourName(tx)
		);
		const number = await allocateNumber(tx, realm.id);
		const labour = (
			await tx
				.insert(labours)
				.values({
					realmId: realm.id,
					number,
					title,
					description,
					ownerId,
					assigneeId,
					stateId: state.id,
					substateId,
					parentId,
					labels,
					recurrenceId: input.recurrenceId ?? null,
					rank
				})
				.returning()
		)[0];
		await recordLabourKey(tx, labour.id, formatLabourKey(realm.key, number));
		await refreshLabourText(tx, labour.id);
		await refreshEmbeddingInput(tx, labour.id);
		await refreshMentions(tx, {
			sourceLabourId: labour.id,
			commentId: null,
			text: description,
			authorId: actor.id,
			firstSeenAt: labour.createdAt
		});
		return labourOutcome(tx, 'labour.created', labour.id);
	});
	embeddingTextChanged(created.id);
	return created;
}

export async function updateLabour(
	db: Db,
	actor: Actor,
	labourId: number,
	patch: LabourPatch
): Promise<LabourView> {
	let retext = false;
	const updated = await write(db, actor, async (tx) => {
		const labour = await getLabour(tx, labourId);
		await requireRealmRole(tx, actor, labour.realmId, 'editor');
		const changes: Partial<typeof labours.$inferInsert> = {};

		if (patch.title !== undefined) {
			changes.title = requireText(patch.title, 'Labour title', TITLE_MAX);
		}
		if (patch.description !== undefined) {
			changes.description = checkDescription(patch.description);
		}
		if (patch.ownerId !== undefined) {
			changes.ownerId = await requireUser(tx, patch.ownerId, 'Owner');
			await requireActiveMember(tx, labour.realmId, changes.ownerId, 'Owner');
		}
		if (patch.assigneeId !== undefined) {
			changes.assigneeId =
				patch.assigneeId === null ? null : await requireUser(tx, patch.assigneeId, 'Assignee');
			if (changes.assigneeId !== null) {
				await requireActiveMember(tx, labour.realmId, changes.assigneeId, 'Assignee');
			}
		}

		if (
			patch.labels !== undefined ||
			patch.addLabels !== undefined ||
			patch.removeLabels !== undefined
		) {
			const drop = new Set(normalizeLabels(patch.removeLabels ?? []));
			const next = normalizeLabels([
				...(patch.labels ?? labour.labels),
				...(patch.addLabels ?? [])
			]);
			changes.labels = next.filter((label) => !drop.has(label));
		}

		const moving = patch.stateId !== undefined && patch.stateId !== labour.stateId;
		if (patch.stateId !== undefined) {
			const state = await getState(tx, patch.stateId);
			if (state.realmId !== labour.realmId) {
				throw new DomainError('invalid', 'The State belongs to another Realm');
			}
			changes.stateId = state.id;
			if (moving || patch.substateId !== undefined) {
				changes.substateId = await substateFor(tx, state, patch.substateId);
			}
		} else if (patch.substateId !== undefined) {
			changes.substateId = await substateFor(
				tx,
				await getState(tx, labour.stateId),
				patch.substateId
			);
		}
		if (moving || patch.placement !== undefined) {
			const stateId = changes.stateId ?? labour.stateId;
			changes.rank = await rankAt(
				await columnOf(tx, stateId),
				{ id: labourId, rank: moving ? undefined : labour.rank },
				patch.placement ?? 'bottom',
				'State',
				labourName(tx)
			);
		}

		const changed = (Object.keys(changes) as (keyof typeof changes)[]).filter(
			(key) => JSON.stringify(changes[key]) !== JSON.stringify(labour[key as keyof Labour])
		);
		if (changed.length === 0) return { value: await readLabour(tx, labourId), events: [] };
		if (changed.length === 1 && changed[0] === 'rank') {
			const rank = changes.rank!;
			await tx.update(labours).set({ rank }).where(eq(labours.id, labourId));
			return {
				value: await readLabour(tx, labourId),
				events: [{ type: 'labour.ranked', data: { id: labourId, stateId: labour.stateId, rank } }]
			};
		}
		changes.updatedAt = new Date();
		await tx.update(labours).set(changes).where(eq(labours.id, labourId));
		if (changed.includes('title') || changed.includes('description')) {
			await refreshLabourText(tx, labourId);
			await refreshEmbeddingInput(tx, labourId);
			retext = true;
		}
		if (changed.includes('description')) {
			await refreshMentions(tx, {
				sourceLabourId: labourId,
				commentId: null,
				text: changes.description!,
				authorId: actor.id,
				firstSeenAt: changes.updatedAt
			});
		}
		return labourOutcome(tx, 'labour.updated', labourId);
	});
	if (retext) embeddingTextChanged(labourId);
	return updated;
}

export async function setParent(
	db: Db,
	actor: Actor,
	labourId: number,
	parentId: number | null
): Promise<LabourView> {
	return write(db, actor, async (tx) => {
		const labour = await getLabour(tx, labourId);
		await requireRealmRole(tx, actor, labour.realmId, 'editor');
		if (parentId !== null) {
			await requireRealmRole(tx, actor, (await getLabour(tx, parentId)).realmId, 'editor');
			await assertParent(tx, labourId, parentId);
		}
		if (parentId === labour.parentId) return { value: await readLabour(tx, labourId), events: [] };
		await tx
			.update(labours)
			.set({ parentId, updatedAt: new Date() })
			.where(eq(labours.id, labourId));
		return labourOutcome(tx, 'labour.reparented', labourId);
	});
}

export type MoveTarget = {
	realmId: number;
	stateId?: number;
	substateId?: number | null;
	placement?: Placement;
};

// Moving follows the Moving a Labour decision in the product/mvp Scroll.
export async function moveLabour(
	db: Db,
	actor: Actor,
	labourId: number,
	input: MoveTarget
): Promise<LabourView> {
	return write(db, actor, async (tx) => {
		const labour = await getLabour(tx, labourId);
		await requireRealmRole(tx, actor, labour.realmId, 'editor');
		if (labour.realmId === input.realmId) {
			throw new DomainError('invalid', 'The Labour is already in that Realm');
		}
		const target = await getRealm(tx, input.realmId);
		await requireRealmRole(tx, actor, target.id, 'editor');
		const state = await targetState(
			tx,
			target,
			(await getState(tx, labour.stateId)).isClosed,
			input.stateId
		);
		const substateId = await substateFor(tx, state, input.substateId);
		const rank = await rankAt(
			await columnOf(tx, state.id),
			{ id: labourId },
			input.placement ?? 'bottom',
			'State',
			labourName(tx)
		);

		const number = await allocateNumber(tx, target.id);
		await recordLabourKey(tx, labourId, formatLabourKey(target.key, number));
		const detached = await detachValues(tx, labourId);
		const movedAt = new Date();
		await tx
			.update(labours)
			.set({
				realmId: target.id,
				number,
				stateId: state.id,
				substateId,
				rank,
				updatedAt: movedAt
			})
			.where(eq(labours.id, labourId));
		await attachValues(tx, labourId, labour.realmId, target.id, detached, movedAt);
		await refreshLabourText(tx, labourId);
		const value = await readLabour(tx, labourId);
		return {
			value,
			events: [{ type: 'labour.moved', data: { labour: value, fromRealmId: labour.realmId } }]
		};
	});
}

// Rank follows the Rank decision in the product/mvp Scroll: write only this Labour's row.
export async function rankLabour(
	db: Db,
	actor: Actor,
	labourId: number,
	placement: Placement
): Promise<LabourView> {
	return write(db, actor, async (tx) => {
		const labour = await getLabour(tx, labourId);
		await requireRealmRole(tx, actor, labour.realmId, 'editor');
		const rank = await rankAt(
			await columnOf(tx, labour.stateId),
			labour,
			placement,
			'State',
			labourName(tx)
		);
		if (rank === labour.rank) return { value: await readLabour(tx, labourId), events: [] };
		await tx.update(labours).set({ rank }).where(eq(labours.id, labourId));
		return {
			value: await readLabour(tx, labourId),
			events: [{ type: 'labour.ranked', data: { id: labourId, stateId: labour.stateId, rank } }]
		};
	});
}

export async function deleteLabour(db: Db, actor: Actor, labourId: number): Promise<void> {
	await write(db, actor, async (tx) => {
		const labour = await getLabour(tx, labourId);
		await requireRealmRole(tx, actor, labour.realmId, 'editor');
		const fallout = await prepareLabourDelete(tx, eq(labours.id, labourId));
		await tx.delete(labours).where(eq(labours.id, labourId));
		return {
			value: undefined,
			events: [
				{ type: 'labour.deleted', data: { id: labourId, realmId: labour.realmId } },
				...(await falloutEvents(tx, fallout))
			]
		};
	});
}

function checkDescription(value: string): string {
	if (value.length > DESCRIPTION_MAX) {
		throw new DomainError(
			'invalid',
			`Labour description must be at most ${DESCRIPTION_MAX} characters`
		);
	}
	return value;
}

async function targetState(
	db: Handle,
	target: { id: number; initialStateId: number | null },
	closed: boolean,
	requested: number | undefined
) {
	if (closed) {
		const state = (
			await db
				.select()
				.from(states)
				.where(and(eq(states.realmId, target.id), eq(states.isClosed, true)))
				.limit(1)
		)[0];
		if (state === undefined) {
			throw new DomainError('conflict', 'The target Realm has no Closed State');
		}
		if (requested !== undefined && requested !== state.id) {
			throw new DomainError(
				'invalid',
				"A Closed Labour moves into the target Realm's Closed State"
			);
		}
		return state;
	}
	const stateId = requested ?? target.initialStateId;
	if (stateId === null) {
		throw new DomainError('conflict', 'The target Realm has no Initial State');
	}
	const state = await getState(db, stateId);
	if (state.realmId !== target.id) {
		throw new DomainError('invalid', 'The State belongs to another Realm');
	}
	return state;
}

// Substate placement follows the Substate rule in CONTEXT.md.
async function substateFor(
	db: Handle,
	state: { id: number; defaultSubstateId: number | null },
	requested: number | null | undefined
): Promise<number | null> {
	if ((await listSubstates(db, state.id)).length === 0) {
		if (typeof requested === 'number') {
			throw new DomainError('invalid', 'The State has no Substates');
		}
		return null;
	}
	if (requested == null) {
		if (state.defaultSubstateId === null) {
			throw new DomainError('conflict', 'The State has no default Substate');
		}
		return state.defaultSubstateId;
	}
	const substate = await getSubstate(db, requested);
	if (substate.stateId !== state.id) {
		throw new DomainError('invalid', 'The Substate belongs to another State');
	}
	return substate.id;
}

// Skip every number whose key under any of the Realm's keys, current or former, is held: a
// Realm must always be able to take back a former key.
async function allocateNumber(db: Handle, realmId: number): Promise<number> {
	const keys = (
		await db.select({ key: realmKeys.key }).from(realmKeys).where(eq(realmKeys.realmId, realmId))
	).map((row) => row.key);
	const held = async (number: number) =>
		(
			await db
				.select()
				.from(labourKeys)
				.where(
					inArray(
						labourKeys.key,
						keys.map((key) => formatLabourKey(key, number))
					)
				)
				.limit(1)
		)[0] !== undefined;

	let number = (await getRealm(db, realmId)).labourCounter + 1;
	while (await held(number)) number += 1;
	await db.update(realms).set({ labourCounter: number }).where(eq(realms.id, realmId));
	return number;
}

async function assertParent(db: Handle, labourId: number | null, parentId: number): Promise<void> {
	if (parentId === labourId) throw new DomainError('invalid', 'A Labour cannot be its own Parent');
	let cursor: number | null = parentId;
	const seen = new Set<number>();
	while (cursor !== null) {
		const row = await getLabour(db, cursor);
		if (cursor === labourId) throw new DomainError('conflict', 'The Parent would create a cycle');
		if (seen.has(cursor)) throw new Error(`Parent chain loops at Labour ${cursor}`);
		seen.add(cursor);
		cursor = row.parentId;
	}
}
