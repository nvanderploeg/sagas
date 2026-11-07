import { mapSeq } from '#lib/server/async.ts';
import { asc, eq } from 'drizzle-orm';
import type { Db, Handle } from '../db/client.ts';
import { labours, recurrenceQuests, recurrences, states } from '../db/schema.ts';
import { DomainError } from './errors.ts';
import { normalizeLabels } from './labels.ts';
import { DESCRIPTION_MAX, createLabour } from './labours.ts';
import { getRealm, requireUser } from './lookup.ts';
import { getQuest } from './quest-view.ts';
import { addQuestLabour } from './quests.ts';
import { nextOccurrence, occurrence, parseDate, requireTimezone, type Unit } from './schedule.ts';
import { requireText } from './validate.ts';
import { requireActiveMember, requireRealmRole } from './access.ts';
import type { Actor } from './write.ts';
import { transact } from '#lib/server/db/tx.ts';

const TITLE_MAX = 200;
const EVERY_MAX = 1000;
const UNITS: Unit[] = ['day', 'week', 'month', 'year'];

export type Recurrence = typeof recurrences.$inferSelect;
export type RecurrenceView = Recurrence & { questIds: number[] };

export type RecurrenceSpec = {
	realmId: number;
	title: string;
	description?: string;
	ownerId: number;
	assigneeId?: number | null;
	labels?: string[];
	questIds?: number[];
	unit: Unit;
	every?: number;
	// Defaults to today in `timezone`.
	startsOn?: string;
	timezone?: string;
};

export type RecurrencePatch = Partial<Omit<RecurrenceSpec, 'realmId'>> & { paused?: boolean };

function todayIn(zone: string, now: Date): string {
	return new Intl.DateTimeFormat('en-CA', {
		timeZone: zone,
		year: 'numeric',
		month: '2-digit',
		day: '2-digit'
	}).format(now);
}

async function questIdsOf(db: Handle, recurrenceId: number): Promise<number[]> {
	return (
		await db
			.select({ id: recurrenceQuests.questId })
			.from(recurrenceQuests)
			.where(eq(recurrenceQuests.recurrenceId, recurrenceId))
			.orderBy(asc(recurrenceQuests.questId))
	).map((row) => row.id);
}

export async function getRecurrence(db: Handle, id: number): Promise<Recurrence> {
	const row = (await db.select().from(recurrences).where(eq(recurrences.id, id)).limit(1))[0];
	if (row === undefined) throw new DomainError('not_found', 'Recurrence not found');
	return row;
}

export async function readRecurrence(db: Handle, id: number): Promise<RecurrenceView> {
	return { ...(await getRecurrence(db, id)), questIds: await questIdsOf(db, id) };
}

export async function listRecurrences(db: Handle, realmId: number): Promise<RecurrenceView[]> {
	const rows = await db
		.select({ id: recurrences.id })
		.from(recurrences)
		.where(eq(recurrences.realmId, realmId))
		.orderBy(asc(recurrences.id));
	return mapSeq(rows, (row) => readRecurrence(db, row.id));
}

function requireCadence(unit: string, every: number): void {
	if (!UNITS.includes(unit as Unit)) {
		throw new DomainError('invalid', `Unit must be one of ${UNITS.join(', ')}`);
	}
	if (!Number.isInteger(every) || every < 1 || every > EVERY_MAX) {
		throw new DomainError('invalid', `Every must be a whole number from 1 to ${EVERY_MAX}`);
	}
}

async function requireQuests(db: Handle, actor: Actor, questIds: number[]): Promise<number[]> {
	const distinct = [...new Set(questIds)];
	for (const id of distinct)
		await requireRealmRole(db, actor, (await getQuest(db, id)).realmId, 'editor');
	return distinct;
}

async function setQuests(db: Handle, recurrenceId: number, questIds: number[]): Promise<void> {
	await db.delete(recurrenceQuests).where(eq(recurrenceQuests.recurrenceId, recurrenceId));
	if (questIds.length > 0) {
		await db
			.insert(recurrenceQuests)
			.values(questIds.map((questId) => ({ recurrenceId, questId })));
	}
}

function checkDescription(value: string): string {
	if (value.length > DESCRIPTION_MAX) {
		throw new DomainError(
			'invalid',
			`Recurrence description must be at most ${DESCRIPTION_MAX} characters`
		);
	}
	return value;
}

export async function createRecurrence(
	db: Db,
	actor: Actor,
	input: RecurrenceSpec,
	now = new Date()
): Promise<RecurrenceView> {
	const created = await transact(db, async (tx) => {
		const realm = await getRealm(tx, input.realmId);
		await requireRealmRole(tx, actor, realm.id, 'editor');
		const title = requireText(input.title, 'Recurrence title', TITLE_MAX);
		const every = input.every ?? 1;
		requireCadence(input.unit, every);
		const timezone = requireTimezone(input.timezone ?? 'UTC');
		const startsOn = input.startsOn ?? todayIn(timezone, now);
		parseDate(startsOn);
		const ownerId = await requireUser(tx, input.ownerId, 'Owner');
		await requireActiveMember(tx, realm.id, ownerId, 'Owner');
		const assigneeId =
			input.assigneeId == null ? null : await requireUser(tx, input.assigneeId, 'Assignee');
		if (assigneeId !== null) await requireActiveMember(tx, realm.id, assigneeId, 'Assignee');
		const questIds = await requireQuests(tx, actor, input.questIds ?? []);

		const row = (
			await tx
				.insert(recurrences)
				.values({
					realmId: realm.id,
					title,
					description: checkDescription(input.description ?? ''),
					ownerId,
					assigneeId,
					labels: normalizeLabels(input.labels ?? []),
					unit: input.unit,
					every,
					startsOn,
					timezone,
					nextDueAt: occurrence({ unit: input.unit, every, startsOn, timezone }, 0)
				})
				.returning()
		)[0];
		await setQuests(tx, row.id, questIds);
		return row.id;
	});
	await runRecurrences(db, now);
	return readRecurrence(db, created);
}

export async function updateRecurrence(
	db: Db,
	actor: Actor,
	id: number,
	patch: RecurrencePatch,
	now = new Date()
): Promise<RecurrenceView> {
	await transact(db, async (tx) => {
		const current = await getRecurrence(tx, id);
		await requireRealmRole(tx, actor, current.realmId, 'editor');
		const changes: Partial<typeof recurrences.$inferInsert> = {};
		if (patch.title !== undefined) {
			changes.title = requireText(patch.title, 'Recurrence title', TITLE_MAX);
		}
		if (patch.description !== undefined) {
			changes.description = checkDescription(patch.description);
		}
		if (patch.ownerId !== undefined) {
			changes.ownerId = await requireUser(tx, patch.ownerId, 'Owner');
			await requireActiveMember(tx, current.realmId, changes.ownerId, 'Owner');
		}
		if (patch.assigneeId !== undefined) {
			changes.assigneeId =
				patch.assigneeId === null ? null : await requireUser(tx, patch.assigneeId, 'Assignee');
			if (changes.assigneeId !== null) {
				await requireActiveMember(tx, current.realmId, changes.assigneeId, 'Assignee');
			}
		}
		if (patch.labels !== undefined) changes.labels = normalizeLabels(patch.labels);
		if (patch.paused !== undefined) changes.paused = patch.paused;

		const unit = patch.unit ?? current.unit;
		const every = patch.every ?? current.every;
		const startsOn = patch.startsOn ?? current.startsOn;
		const timezone = patch.timezone ?? current.timezone;
		const cadenceChanged =
			unit !== current.unit ||
			every !== current.every ||
			startsOn !== current.startsOn ||
			timezone !== current.timezone;
		if (cadenceChanged) {
			requireCadence(unit, every);
			requireTimezone(timezone);
			parseDate(startsOn);
			Object.assign(changes, { unit, every, startsOn, timezone });
			// One with an unfinished Labour is scheduled when that Labour is finished.
			if (current.nextDueAt !== null) {
				changes.nextDueAt = nextOccurrence({ unit, every, startsOn, timezone }, now);
			}
		}
		if (patch.questIds !== undefined) {
			await setQuests(tx, id, await requireQuests(tx, actor, patch.questIds));
		}
		await tx
			.update(recurrences)
			.set({ ...changes, updatedAt: new Date() })
			.where(eq(recurrences.id, id));
	});
	await runRecurrences(db, now);
	return readRecurrence(db, id);
}

// The Labours it created stay; only the schedule goes.
export async function deleteRecurrence(db: Db, actor: Actor, id: number): Promise<void> {
	await transact(db, async (tx) => {
		const current = await getRecurrence(tx, id);
		await requireRealmRole(tx, actor, current.realmId, 'editor');
		await tx.delete(recurrences).where(eq(recurrences.id, id));
	});
}

async function isFinished(db: Handle, labourId: number): Promise<{ at: Date } | null> {
	const row = (
		await db
			.select({ closed: states.isClosed, at: labours.updatedAt })
			.from(labours)
			.innerJoin(states, eq(states.id, labours.stateId))
			.where(eq(labours.id, labourId))
			.limit(1)
	)[0];
	return row?.closed ? { at: row.at } : null;
}

// One pass over every unpaused Recurrence: schedule the next Labour for any whose last one is
// finished, then create the Labour of any that is due. Returns the ids of the Labours created.
export async function runRecurrences(db: Db, now = new Date()): Promise<number[]> {
	const created: number[] = [];
	const rows = await db.select().from(recurrences).where(eq(recurrences.paused, false));
	for (const row of rows) {
		try {
			let dueAt = row.nextDueAt;
			if (dueAt === null) {
				const finished = row.labourId === null ? { at: now } : await isFinished(db, row.labourId);
				if (finished === null) continue;
				dueAt = nextOccurrence(row, finished.at);
				await db.update(recurrences).set({ nextDueAt: dueAt }).where(eq(recurrences.id, row.id));
			}
			if (dueAt.getTime() > now.getTime()) continue;
			created.push(await spawn(db, row));
		} catch (error) {
			console.error(`sagas recurrence ${row.id} could not run`, error);
		}
	}
	return created;
}

async function spawn(db: Db, row: Recurrence): Promise<number> {
	const actor: Actor = { id: row.ownerId };
	const labour = await createLabour(db, actor, {
		realmId: row.realmId,
		title: row.title,
		description: row.description,
		ownerId: row.ownerId,
		assigneeId: row.assigneeId,
		labels: row.labels,
		recurrenceId: row.id
	});
	await db
		.update(recurrences)
		.set({ labourId: labour.id, nextDueAt: null, updatedAt: new Date() })
		.where(eq(recurrences.id, row.id));
	const questIds = await questIdsOf(db, row.id);
	for (const questId of questIds) {
		try {
			await addQuestLabour(db, actor, questId, labour.id);
		} catch (error) {
			console.error(`sagas recurrence ${row.id} could not add ${labour.key} to a Quest`, error);
		}
	}
	return labour.id;
}

export async function scheduleRecurrences(db: Db, everyMs = 60 * 1000): Promise<() => void> {
	const tick = async () => {
		try {
			await runRecurrences(db);
		} catch (error) {
			console.error('sagas recurrences failed', error);
		}
	};
	await tick();
	const timer = setInterval(tick, everyMs);
	timer.unref();
	return () => clearInterval(timer);
}
