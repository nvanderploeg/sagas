import { and, asc, count, eq, inArray, or, sql } from 'drizzle-orm';
import type { Handle } from '../db/client.ts';
import { realmKeys, realms, quests, states, labours } from '../db/schema.ts';
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
export function findRealmByKey(db: Handle, input: string): Realm | null {
	const row = db
		.select({ realmId: realmKeys.realmId })
		.from(realmKeys)
		.where(eq(realmKeys.key, input.trim().toUpperCase()))
		.get();
	return row ? getRealm(db, row.realmId) : null;
}

export function readAllRealms(db: Handle): RealmView[] {
	return listRealms(db).map((p) => readRealm(db, p.id));
}

export function readHome(db: Handle, userId: number) {
	const mine = selectLabourViews(db)
		.where(
			and(or(eq(labours.ownerId, userId), eq(labours.assigneeId, userId)), eq(states.isOpen, true))
		)
		.orderBy(asc(labours.id))
		.all()
		.map(toLabourView);
	const owned = db
		.select({ id: quests.id })
		.from(quests)
		.where(eq(quests.ownerId, userId))
		.orderBy(asc(quests.id))
		.all();
	return { realms: readAllRealms(db), mine, quests: owned.map((q) => readQuest(db, q.id)) };
}

export function readLabourPage(db: Handle, labourId: number) {
	const labour = readLabour(db, labourId);
	return {
		labour,
		parent: labour.parentId === null ? null : readLabour(db, labour.parentId),
		children: listChildren(db, labourId),
		realms: readAllRealms(db),
		quests: db
			.select({ id: quests.id, name: quests.name })
			.from(quests)
			.orderBy(asc(quests.id))
			.all(),
		memberOf: listLabourQuests(db, labourId).map((q) => q.id),
		comments: listComments(db, labourId)
	};
}

export function readQuestPage(db: Handle, questId: number) {
	return { quest: readQuest(db, questId), realms: readAllRealms(db) };
}

export function readQuestList(db: Handle): { quests: QuestView[]; realms: RealmView[] } {
	return { quests: listQuests(db), realms: readAllRealms(db) };
}

export type LabourMatch = LabourView & { childCount: number };

// Matches a Labour key, current or former, then key prefixes and titles.
export function searchLabours(db: Handle, input: string, limit = 12): LabourMatch[] {
	const query = input.trim();
	if (query === '') return [];
	const exact = resolveLabourKey(db, query);
	const pattern = `%${query.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
	const keyPrefix = `${query.toUpperCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
	const found = selectLabourViews(db)
		.where(
			or(
				sql`${labours.title} LIKE ${pattern} ESCAPE '\\'`,
				sql`(${realms.key} || '-' || ${labours.number}) LIKE ${keyPrefix} ESCAPE '\\'`
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
