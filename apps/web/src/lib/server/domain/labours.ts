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

export function labourKeyOf(db: Handle, labour: { realmId: number; number: number }): string {
	return formatLabourKey(getRealm(db, labour.realmId).key, labour.number);
}

export function listLabours(db: Handle, realmId: number): LabourView[] {
	return selectLabourViews(db)
		.where(eq(labours.realmId, realmId))
		.orderBy(asc(labours.number))
		.all()
		.map(toLabourView);
}

export function listColumn(db: Handle, stateId: number): LabourView[] {
	return selectLabourViews(db)
		.where(eq(labours.stateId, stateId))
		.orderBy(asc(labours.rank))
		.all()
		.map(toLabourView);
}

function columnOf(db: Handle, stateId: number) {
	return db
		.select({ id: labours.id, rank: labours.rank })
		.from(labours)
		.where(eq(labours.stateId, stateId))
		.orderBy(asc(labours.rank))
		.all();
}

export function listChildren(db: Handle, labourId: number): LabourView[] {
	return selectLabourViews(db)
		.where(eq(labours.parentId, labourId))
		.orderBy(asc(labours.id))
		.all()
		.map(toLabourView);
}

export function resolveLabourKey(db: Handle, input: string): LabourView | null {
	const parsed = parseLabourKey(input);
	if (!parsed) return null;
	const row = db
		.select({ labourId: labourKeys.labourId })
		.from(labourKeys)
		.where(eq(labourKeys.key, formatLabourKey(parsed.realmKey, parsed.number)))
		.get();
	return row ? readLabour(db, row.labourId) : null;
}

// Record every key a Labour comes to hold, so that key resolves to it for as long as it exists.
export function recordLabourKey(db: Handle, labourId: number, key: string): void {
	const holder = db.select().from(labourKeys).where(eq(labourKeys.key, key)).get();
	if (holder?.labourId === labourId) return;
	if (holder) throw new DomainError('conflict', `Labour key ${key} is already taken`);
	db.insert(labourKeys).values({ key, labourId }).run();
}

function labourOutcome(
	db: Handle,
	type: 'labour.created' | 'labour.updated' | 'labour.reparented',
	labourId: number
): { value: LabourView; events: EventSpec[] } {
	const labour = readLabour(db, labourId);
	return { value: labour, events: [{ type, data: { labour } }] };
}

export function createLabour(db: Db, actor: Actor, input: LabourSpec): LabourView {
	const created = write(db, actor, (tx) => {
		const realm = getRealm(tx, input.realmId);
		requireRealmRole(tx, actor, realm.id, 'editor');
		const title = requireText(input.title, 'Labour title', TITLE_MAX);
		const description = checkDescription(input.description ?? '');
		const ownerId = requireUser(tx, input.ownerId, 'Owner');
		const assigneeId =
			input.assigneeId == null ? null : requireUser(tx, input.assigneeId, 'Assignee');
		requireActiveMember(tx, realm.id, ownerId, 'Owner');
		if (assigneeId !== null) requireActiveMember(tx, realm.id, assigneeId, 'Assignee');

		const stateId = input.stateId ?? realm.initialStateId;
		if (stateId === null) throw new DomainError('conflict', 'The Realm has no Initial State');
		const state = getState(tx, stateId);
		if (state.realmId !== realm.id) {
			throw new DomainError('invalid', 'The State belongs to another Realm');
		}
		const substateId = substateFor(tx, state, input.substateId);
		const parentId = input.parentId ?? null;
		if (parentId !== null) {
			requireRealmRole(tx, actor, getLabour(tx, parentId).realmId, 'editor');
			assertParent(tx, null, parentId);
		}
		const labels = normalizeLabels(input.labels ?? []);

		const rank = rankAt(
			columnOf(tx, state.id),
			{ id: null },
			input.placement ?? 'bottom',
			'State',
			labourName(tx)
		);
		const number = allocateNumber(tx, realm.id);
		const labour = tx
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
				rank
			})
			.returning()
			.get();
		recordLabourKey(tx, labour.id, formatLabourKey(realm.key, number));
		refreshLabourText(tx, labour.id);
		refreshEmbeddingInput(tx, labour.id);
		refreshMentions(tx, {
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

export function updateLabour(
	db: Db,
	actor: Actor,
	labourId: number,
	patch: LabourPatch
): LabourView {
	let retext = false;
	const updated = write(db, actor, (tx) => {
		const labour = getLabour(tx, labourId);
		requireRealmRole(tx, actor, labour.realmId, 'editor');
		const changes: Partial<typeof labours.$inferInsert> = {};

		if (patch.title !== undefined) {
			changes.title = requireText(patch.title, 'Labour title', TITLE_MAX);
		}
		if (patch.description !== undefined) {
			changes.description = checkDescription(patch.description);
		}
		if (patch.ownerId !== undefined) {
			changes.ownerId = requireUser(tx, patch.ownerId, 'Owner');
			requireActiveMember(tx, labour.realmId, changes.ownerId, 'Owner');
		}
		if (patch.assigneeId !== undefined) {
			changes.assigneeId =
				patch.assigneeId === null ? null : requireUser(tx, patch.assigneeId, 'Assignee');
			if (changes.assigneeId !== null) {
				requireActiveMember(tx, labour.realmId, changes.assigneeId, 'Assignee');
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
			const state = getState(tx, patch.stateId);
			if (state.realmId !== labour.realmId) {
				throw new DomainError('invalid', 'The State belongs to another Realm');
			}
			changes.stateId = state.id;
			if (moving || patch.substateId !== undefined) {
				changes.substateId = substateFor(tx, state, patch.substateId);
			}
		} else if (patch.substateId !== undefined) {
			changes.substateId = substateFor(tx, getState(tx, labour.stateId), patch.substateId);
		}
		if (moving || patch.placement !== undefined) {
			const stateId = changes.stateId ?? labour.stateId;
			changes.rank = rankAt(
				columnOf(tx, stateId),
				{ id: labourId, rank: moving ? undefined : labour.rank },
				patch.placement ?? 'bottom',
				'State',
				labourName(tx)
			);
		}

		const changed = (Object.keys(changes) as (keyof typeof changes)[]).filter(
			(key) => JSON.stringify(changes[key]) !== JSON.stringify(labour[key as keyof Labour])
		);
		if (changed.length === 0) return { value: readLabour(tx, labourId), events: [] };
		if (changed.length === 1 && changed[0] === 'rank') {
			const rank = changes.rank!;
			tx.update(labours).set({ rank }).where(eq(labours.id, labourId)).run();
			return {
				value: readLabour(tx, labourId),
				events: [{ type: 'labour.ranked', data: { id: labourId, stateId: labour.stateId, rank } }]
			};
		}
		changes.updatedAt = new Date();
		tx.update(labours).set(changes).where(eq(labours.id, labourId)).run();
		if (changed.includes('title') || changed.includes('description')) {
			refreshLabourText(tx, labourId);
			refreshEmbeddingInput(tx, labourId);
			retext = true;
		}
		if (changed.includes('description')) {
			refreshMentions(tx, {
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

export function setParent(
	db: Db,
	actor: Actor,
	labourId: number,
	parentId: number | null
): LabourView {
	return write(db, actor, (tx) => {
		const labour = getLabour(tx, labourId);
		requireRealmRole(tx, actor, labour.realmId, 'editor');
		if (parentId !== null) {
			requireRealmRole(tx, actor, getLabour(tx, parentId).realmId, 'editor');
			assertParent(tx, labourId, parentId);
		}
		if (parentId === labour.parentId) return { value: readLabour(tx, labourId), events: [] };
		tx.update(labours)
			.set({ parentId, updatedAt: new Date() })
			.where(eq(labours.id, labourId))
			.run();
		return labourOutcome(tx, 'labour.reparented', labourId);
	});
}

export type MoveTarget = {
	realmId: number;
	stateId?: number;
	substateId?: number | null;
	placement?: Placement;
};

// Moving follows the Moving a Labour decision in docs/mvp.md.
export function moveLabour(db: Db, actor: Actor, labourId: number, input: MoveTarget): LabourView {
	return write(db, actor, (tx) => {
		const labour = getLabour(tx, labourId);
		requireRealmRole(tx, actor, labour.realmId, 'editor');
		if (labour.realmId === input.realmId) {
			throw new DomainError('invalid', 'The Labour is already in that Realm');
		}
		const target = getRealm(tx, input.realmId);
		requireRealmRole(tx, actor, target.id, 'editor');
		const state = targetState(tx, target, getState(tx, labour.stateId).isClosed, input.stateId);
		const substateId = substateFor(tx, state, input.substateId);
		const rank = rankAt(
			columnOf(tx, state.id),
			{ id: labourId },
			input.placement ?? 'bottom',
			'State',
			labourName(tx)
		);

		const number = allocateNumber(tx, target.id);
		recordLabourKey(tx, labourId, formatLabourKey(target.key, number));
		const detached = detachValues(tx, labourId);
		const movedAt = new Date();
		tx.update(labours)
			.set({
				realmId: target.id,
				number,
				stateId: state.id,
				substateId,
				rank,
				updatedAt: movedAt
			})
			.where(eq(labours.id, labourId))
			.run();
		attachValues(tx, labourId, labour.realmId, target.id, detached, movedAt);
		refreshLabourText(tx, labourId);
		const value = readLabour(tx, labourId);
		return {
			value,
			events: [{ type: 'labour.moved', data: { labour: value, fromRealmId: labour.realmId } }]
		};
	});
}

// Rank follows the Rank decision in docs/mvp.md: write only this Labour's row.
export function rankLabour(
	db: Db,
	actor: Actor,
	labourId: number,
	placement: Placement
): LabourView {
	return write(db, actor, (tx) => {
		const labour = getLabour(tx, labourId);
		requireRealmRole(tx, actor, labour.realmId, 'editor');
		const rank = rankAt(columnOf(tx, labour.stateId), labour, placement, 'State', labourName(tx));
		if (rank === labour.rank) return { value: readLabour(tx, labourId), events: [] };
		tx.update(labours).set({ rank }).where(eq(labours.id, labourId)).run();
		return {
			value: readLabour(tx, labourId),
			events: [{ type: 'labour.ranked', data: { id: labourId, stateId: labour.stateId, rank } }]
		};
	});
}

export function deleteLabour(db: Db, actor: Actor, labourId: number): void {
	write(db, actor, (tx) => {
		const labour = getLabour(tx, labourId);
		requireRealmRole(tx, actor, labour.realmId, 'editor');
		const fallout = prepareLabourDelete(tx, eq(labours.id, labourId));
		tx.delete(labours).where(eq(labours.id, labourId)).run();
		return {
			value: undefined,
			events: [
				{ type: 'labour.deleted', data: { id: labourId, realmId: labour.realmId } },
				...falloutEvents(tx, fallout)
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

function targetState(
	db: Handle,
	target: { id: number; initialStateId: number | null },
	closed: boolean,
	requested: number | undefined
) {
	if (closed) {
		const state = db
			.select()
			.from(states)
			.where(and(eq(states.realmId, target.id), eq(states.isClosed, true)))
			.get();
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
	const state = getState(db, stateId);
	if (state.realmId !== target.id) {
		throw new DomainError('invalid', 'The State belongs to another Realm');
	}
	return state;
}

// Substate placement follows the Substate rule in CONTEXT.md.
function substateFor(
	db: Handle,
	state: { id: number; defaultSubstateId: number | null },
	requested: number | null | undefined
): number | null {
	if (listSubstates(db, state.id).length === 0) {
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
	const substate = getSubstate(db, requested);
	if (substate.stateId !== state.id) {
		throw new DomainError('invalid', 'The Substate belongs to another State');
	}
	return substate.id;
}

// Skip every number whose key under any of the Realm's keys, current or former, is held: a
// Realm must always be able to take back a former key.
function allocateNumber(db: Handle, realmId: number): number {
	const keys = db
		.select({ key: realmKeys.key })
		.from(realmKeys)
		.where(eq(realmKeys.realmId, realmId))
		.all()
		.map((row) => row.key);
	const held = (number: number) =>
		db
			.select()
			.from(labourKeys)
			.where(
				inArray(
					labourKeys.key,
					keys.map((key) => formatLabourKey(key, number))
				)
			)
			.get() !== undefined;

	let number = getRealm(db, realmId).labourCounter + 1;
	while (held(number)) number += 1;
	db.update(realms).set({ labourCounter: number }).where(eq(realms.id, realmId)).run();
	return number;
}

function assertParent(db: Handle, labourId: number | null, parentId: number): void {
	if (parentId === labourId) throw new DomainError('invalid', 'A Labour cannot be its own Parent');
	let cursor: number | null = parentId;
	const seen = new Set<number>();
	while (cursor !== null) {
		const row = getLabour(db, cursor);
		if (cursor === labourId) throw new DomainError('conflict', 'The Parent would create a cycle');
		if (seen.has(cursor)) throw new Error(`Parent chain loops at Labour ${cursor}`);
		seen.add(cursor);
		cursor = row.parentId;
	}
}
