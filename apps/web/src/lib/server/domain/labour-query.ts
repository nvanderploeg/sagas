import { and, asc, count, eq, isNull, sql, type SQL } from 'drizzle-orm';
import type { Handle } from '../db/client.ts';
import { questLabours, states, labours } from '../db/schema.ts';
import { selectLabourViews, toLabourView, type LabourView } from './labour-view.ts';

// `null` for assigneeId or parentId matches Labours without one.
export type LabourFilter = {
	realmId?: number;
	stateId?: number;
	substateId?: number;
	ownerId?: number;
	assigneeId?: number | null;
	parentId?: number | null;
	closed?: boolean;
	questId?: number;
	// Labels the Labour must all carry.
	labels?: string[];
};

export type LabourPage = { labours: LabourView[]; total: number };

function conditions(filter: LabourFilter): SQL | undefined {
	const where: SQL[] = [];
	if (filter.realmId !== undefined) where.push(eq(labours.realmId, filter.realmId));
	if (filter.stateId !== undefined) where.push(eq(labours.stateId, filter.stateId));
	if (filter.substateId !== undefined) where.push(eq(labours.substateId, filter.substateId));
	if (filter.ownerId !== undefined) where.push(eq(labours.ownerId, filter.ownerId));
	if (filter.assigneeId !== undefined) {
		where.push(
			filter.assigneeId === null
				? isNull(labours.assigneeId)
				: eq(labours.assigneeId, filter.assigneeId)
		);
	}
	if (filter.parentId !== undefined) {
		where.push(
			filter.parentId === null ? isNull(labours.parentId) : eq(labours.parentId, filter.parentId)
		);
	}
	if (filter.closed !== undefined) where.push(eq(states.isClosed, filter.closed));
	if (filter.questId !== undefined) where.push(eq(questLabours.questId, filter.questId));
	for (const label of filter.labels ?? []) {
		where.push(
			sql`exists (select 1 from json_each(${labours.labels}) where json_each.value = ${label})`
		);
	}
	return where.length > 0 ? and(...where) : undefined;
}

export function queryLabours(
	db: Handle,
	filter: LabourFilter,
	page: { offset: number; limit: number }
): LabourPage {
	const where = conditions(filter);
	const inQuest = filter.questId !== undefined;

	const rows = inQuest
		? selectLabourViews(db)
				.innerJoin(questLabours, eq(questLabours.labourId, labours.id))
				.where(where)
				.orderBy(asc(questLabours.rank))
		: selectLabourViews(db)
				.where(where)
				.orderBy(asc(labours.realmId), asc(states.position), asc(labours.rank));

	const counted = db
		.select({ n: count() })
		.from(labours)
		.innerJoin(states, eq(states.id, labours.stateId));
	const total = inQuest
		? counted.innerJoin(questLabours, eq(questLabours.labourId, labours.id)).where(where).get()
		: counted.where(where).get();

	return {
		labours: rows.limit(page.limit).offset(page.offset).all().map(toLabourView),
		total: total?.n ?? 0
	};
}
