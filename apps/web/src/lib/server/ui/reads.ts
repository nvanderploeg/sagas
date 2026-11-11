import { mapSeq } from '#lib/server/async.ts';
import { and, asc, count, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import type { Handle } from '../db/client.ts';
import { realmKeys, realms, quests, states, labours } from '../db/schema.ts';
import { canSeeRealm, requireRealmRole, visibleRealmIds } from '../domain/access.ts';
import { restrictQuest } from '../domain/quest-view.ts';
import { listComments } from '../domain/comments.ts';
import { listLabourScrolls } from '../domain/scrolls.ts';
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
export async function findRealmByKey(
	db: Handle,
	input: string,
	viewer: Viewer
): Promise<Realm | null> {
	const row = (
		await db
			.select({ realmId: realmKeys.realmId })
			.from(realmKeys)
			.where(eq(realmKeys.key, input.trim().toUpperCase()))
			.limit(1)
	)[0];
	return row && (await canSeeRealm(db, viewer, row.realmId))
		? await getRealm(db, row.realmId)
		: null;
}

type Viewer = { id: number };

const seen = async (db: Handle, viewer: Viewer): Promise<Set<number> | null> => {
	const ids = await visibleRealmIds(db, viewer);
	return ids === null ? null : new Set(ids);
};

export async function readAllRealms(db: Handle, viewer: Viewer): Promise<RealmView[]> {
	const visible = await seen(db, viewer);
	const shown = (await listRealms(db)).filter((p) => visible === null || visible.has(p.id));
	return mapSeq(shown, (p) => readRealm(db, p.id));
}

const inRealms = (visible: Set<number> | null) =>
	visible === null ? undefined : inArray(labours.realmId, [...visible]);

const inQuestRealms = (visible: Set<number> | null) =>
	visible === null ? undefined : inArray(quests.realmId, [...visible]);

export async function readHome(db: Handle, viewer: Viewer) {
	const userId = viewer.id;
	const visible = await seen(db, viewer);
	const mine = (
		await selectLabourViews(db)
			.where(
				and(
					or(eq(labours.ownerId, userId), eq(labours.assigneeId, userId)),
					eq(states.isOpen, true),
					inRealms(visible)
				)
			)
			.orderBy(asc(labours.id))
	).map(toLabourView);
	const owned = await db
		.select({ id: quests.id })
		.from(quests)
		.where(and(eq(quests.ownerId, userId), isNull(quests.archivedAt), inQuestRealms(visible)))
		.orderBy(asc(quests.id));
	return {
		realms: await readAllRealms(db, viewer),
		mine,
		quests: await mapSeq(owned, async (q) => restrictQuest(await readQuest(db, q.id), visible))
	};
}

export async function readLabourPage(db: Handle, viewer: Viewer, labourId: number) {
	const labour = await readLabour(db, labourId);
	await requireRealmRole(db, viewer, labour.realmId, 'viewer');
	const visible = await seen(db, viewer);
	const shown = (item: LabourView) => visible === null || visible.has(item.realmId);
	const parent = labour.parentId === null ? null : await readLabour(db, labour.parentId);
	const memberOf = (await listLabourQuests(db, labourId)).map((q) => q.id);
	return {
		labour,
		parent: parent !== null && shown(parent) ? parent : null,
		children: (await listChildren(db, labourId)).filter(shown),
		realms: await readAllRealms(db, viewer),
		quests: (
			await db
				.select({ id: quests.id, name: quests.name, archivedAt: quests.archivedAt })
				.from(quests)
				.where(inQuestRealms(visible))
				.orderBy(asc(quests.id))
		)
			.filter((q) => q.archivedAt === null || memberOf.includes(q.id))
			.map(({ id, name }) => ({ id, name })),
		memberOf,
		comments: await listComments(db, labourId),
		scrolls: await listLabourScrolls(db, labourId, visible === null ? null : [...visible])
	};
}

export async function readQuestPage(db: Handle, viewer: Viewer, questId: number) {
	const quest = await readQuest(db, questId);
	await requireRealmRole(db, viewer, quest.realmId, 'viewer');
	return {
		quest: restrictQuest(quest, await seen(db, viewer)),
		realms: await readAllRealms(db, viewer)
	};
}

export async function readQuestList(
	db: Handle,
	viewer: Viewer
): Promise<{ quests: QuestView[]; realms: RealmView[] }> {
	const visible = await seen(db, viewer);
	return {
		quests: (await listQuests(db))
			.filter((quest) => visible === null || visible.has(quest.realmId))
			.map((quest) => restrictQuest(quest, visible)),
		realms: await readAllRealms(db, viewer)
	};
}

const SEARCH_MAX = 200;

export type LabourMatch = LabourView & { childCount: number };

// Matches a Labour key, current or former, then key prefixes and titles.
export async function searchLabours(
	db: Handle,
	viewer: Viewer,
	input: string,
	limit = 12
): Promise<LabourMatch[]> {
	const query = input.trim().slice(0, SEARCH_MAX);
	if (query === '') return [];
	const visible = await seen(db, viewer);
	const found0 = await resolveLabourKey(db, query);
	const exact = found0 && (visible === null || visible.has(found0.realmId)) ? found0 : null;
	const pattern = `%${query.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
	const keyPrefix = `${query.toUpperCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
	const found = (
		await selectLabourViews(db)
			.where(
				and(
					or(
						sql`${labours.title} ILIKE ${pattern} ESCAPE '\\'`,
						sql`(${realms.key} || '-' || ${labours.number}) ILIKE ${keyPrefix} ESCAPE '\\'`
					),
					inRealms(visible)
				)
			)
			.orderBy(asc(labours.id))
			.limit(limit)
	).map(toLabourView);
	const matches = exact ? [exact, ...found.filter((t) => t.id !== exact.id)] : found;
	const shown = matches.slice(0, limit);
	return withChildCounts(db, shown);
}

async function withChildCounts(db: Handle, list: LabourView[]): Promise<LabourMatch[]> {
	if (list.length === 0) return [];
	const counts = new Map(
		(
			await db
				.select({ parentId: labours.parentId, n: count() })
				.from(labours)
				.where(
					inArray(
						labours.parentId,
						list.map((t) => t.id)
					)
				)
				.groupBy(labours.parentId)
		).map((row) => [row.parentId, row.n])
	);
	return list.map((t) => ({ ...t, childCount: counts.get(t.id) ?? 0 }));
}
