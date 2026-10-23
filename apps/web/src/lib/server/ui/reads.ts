import { and, asc, count, eq, inArray, or, sql } from 'drizzle-orm';
import type { Handle } from '../db/client.ts';
import { realmKeys, realms, quests, states, labours } from '../db/schema.ts';
import { canSeeRealm, requireRealmRole, visibleRealmIds } from '../domain/access.ts';
import { restrictQuest } from '../domain/quest-view.ts';
import { listComments } from '../domain/comments.ts';
import { getRealm } from '../domain/lookup.ts';
import { listRealms, readRealm, type Realm, type RealmView } from '../domain/realms.ts';
import { listQuests, listLabourQuests, readQuest, type QuestView } from '../domain/quests.ts';
import {
	listChildren,
	readLabour,
	resolveLabourKey,
	selectLabourViews,
	toLabourView,
	type LabourView
} from '../domain/labours.ts';
import type { Json } from '../events/types.ts';

// Page loads hand the client the JSON form Events carry, so loaded and live data share one shape.
export function toJson<T>(value: T): Json<T> {
	return JSON.parse(JSON.stringify(value)) as Json<T>;
}

// Resolves a current or former Realm key, in any case.
// A Realm the viewer cannot see reads as missing.
export function findRealmByKey(db: Handle, input: string, viewer: Viewer): Realm | null {
	const row = db
		.select({ realmId: realmKeys.realmId })
		.from(realmKeys)
		.where(eq(realmKeys.key, input.trim().toUpperCase()))
		.get();
	return row && canSeeRealm(db, viewer, row.realmId) ? getRealm(db, row.realmId) : null;
}

type Viewer = { id: number };

const seen = (db: Handle, viewer: Viewer): Set<number> | null => {
	const ids = visibleRealmIds(db, viewer);
	return ids === null ? null : new Set(ids);
};

export function readAllRealms(db: Handle, viewer: Viewer): RealmView[] {
	const visible = seen(db, viewer);
	return listRealms(db)
		.filter((p) => visible === null || visible.has(p.id))
		.map((p) => readRealm(db, p.id));
}

const inRealms = (visible: Set<number> | null) =>
	visible === null ? undefined : inArray(labours.realmId, [...visible]);

const inQuestRealms = (visible: Set<number> | null) =>
	visible === null ? undefined : inArray(quests.realmId, [...visible]);

export function readHome(db: Handle, viewer: Viewer) {
	const userId = viewer.id;
	const visible = seen(db, viewer);
	const mine = selectLabourViews(db)
		.where(
			and(
				or(eq(labours.ownerId, userId), eq(labours.assigneeId, userId)),
				eq(states.isOpen, true),
				inRealms(visible)
			)
		)
		.orderBy(asc(labours.id))
		.all()
		.map(toLabourView);
	const owned = db
		.select({ id: quests.id })
		.from(quests)
		.where(and(eq(quests.ownerId, userId), inQuestRealms(visible)))
		.orderBy(asc(quests.id))
		.all();
	return {
		realms: readAllRealms(db, viewer),
		mine,
		quests: owned.map((q) => restrictQuest(readQuest(db, q.id), visible))
	};
}

export function readLabourPage(db: Handle, viewer: Viewer, labourId: number) {
	const labour = readLabour(db, labourId);
	requireRealmRole(db, viewer, labour.realmId, 'viewer');
	const visible = seen(db, viewer);
	const shown = (item: LabourView) => visible === null || visible.has(item.realmId);
	const parent = labour.parentId === null ? null : readLabour(db, labour.parentId);
	return {
		labour,
		parent: parent !== null && shown(parent) ? parent : null,
		children: listChildren(db, labourId).filter(shown),
		realms: readAllRealms(db, viewer),
		quests: db
			.select({ id: quests.id, name: quests.name })
			.from(quests)
			.where(inQuestRealms(visible))
			.orderBy(asc(quests.id))
			.all(),
		memberOf: listLabourQuests(db, labourId).map((q) => q.id),
		comments: listComments(db, labourId)
	};
}

export function readQuestPage(db: Handle, viewer: Viewer, questId: number) {
	const quest = readQuest(db, questId);
	requireRealmRole(db, viewer, quest.realmId, 'viewer');
	return {
		quest: restrictQuest(quest, seen(db, viewer)),
		realms: readAllRealms(db, viewer)
	};
}

export function readQuestList(
	db: Handle,
	viewer: Viewer
): { quests: QuestView[]; realms: RealmView[] } {
	const visible = seen(db, viewer);
	return {
		quests: listQuests(db)
			.filter((quest) => visible === null || visible.has(quest.realmId))
			.map((quest) => restrictQuest(quest, visible)),
		realms: readAllRealms(db, viewer)
	};
}

export type LabourMatch = LabourView & { childCount: number };

// Matches a Labour key, current or former, then key prefixes and titles.
export function searchLabours(
	db: Handle,
	viewer: Viewer,
	input: string,
	limit = 12
): LabourMatch[] {
	const query = input.trim();
	if (query === '') return [];
	const visible = seen(db, viewer);
	const found0 = resolveLabourKey(db, query);
	const exact = found0 && (visible === null || visible.has(found0.realmId)) ? found0 : null;
	const pattern = `%${query.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
	const keyPrefix = `${query.toUpperCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
	const found = selectLabourViews(db)
		.where(
			and(
				or(
					sql`${labours.title} LIKE ${pattern} ESCAPE '\\'`,
					sql`(${realms.key} || '-' || ${labours.number}) LIKE ${keyPrefix} ESCAPE '\\'`
				),
				inRealms(visible)
			)
		)
		.orderBy(asc(labours.id))
		.limit(limit)
		.all()
		.map(toLabourView);
	const matches = exact ? [exact, ...found.filter((t) => t.id !== exact.id)] : found;
	const shown = matches.slice(0, limit);
	return withChildCounts(db, shown);
}

function withChildCounts(db: Handle, list: LabourView[]): LabourMatch[] {
	if (list.length === 0) return [];
	const counts = new Map(
		db
			.select({ parentId: labours.parentId, n: count() })
			.from(labours)
			.where(
				inArray(
					labours.parentId,
					list.map((t) => t.id)
				)
			)
			.groupBy(labours.parentId)
			.all()
			.map((row) => [row.parentId, row.n])
	);
	return list.map((t) => ({ ...t, childCount: counts.get(t.id) ?? 0 }));
}
