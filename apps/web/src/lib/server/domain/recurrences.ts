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

function questIdsOf(db: Handle, recurrenceId: number): number[] {
	return db
		.select({ id: recurrenceQuests.questId })
		.from(recurrenceQuests)
		.where(eq(recurrenceQuests.recurrenceId, recurrenceId))
		.orderBy(asc(recurrenceQuests.questId))
		.all()
		.map((row) => row.id);
}

export function getRecurrence(db: Handle, id: number): Recurrence {
	const row = db.select().from(recurrences).where(eq(recurrences.id, id)).get();
	if (row === undefined) throw new DomainError('not_found', 'Recurrence not found');
	return row;
}

export function readRecurrence(db: Handle, id: number): RecurrenceView {
	return { ...getRecurrence(db, id), questIds: questIdsOf(db, id) };
}

export function listRecurrences(db: Handle, realmId: number): RecurrenceView[] {
	return db
		.select({ id: recurrences.id })
		.from(recurrences)
		.where(eq(recurrences.realmId, realmId))
		.orderBy(asc(recurrences.id))
		.all()
		.map((row) => readRecurrence(db, row.id));
}

function requireCadence(unit: string, every: number): void {
	if (!UNITS.includes(unit as Unit)) {
		throw new DomainError('invalid', `Unit must be one of ${UNITS.join(', ')}`);
	}
	if (!Number.isInteger(every) || every < 1 || every > EVERY_MAX) {
		throw new DomainError('invalid', `Every must be a whole number from 1 to ${EVERY_MAX}`);
	}
}

function requireQuests(db: Handle, actor: Actor, questIds: number[]): number[] {
	const distinct = [...new Set(questIds)];
	for (const id of distinct) requireRealmRole(db, actor, getQuest(db, id).realmId, 'editor');
	return distinct;
}

function setQuests(db: Handle, recurrenceId: number, questIds: number[]): void {
	db.delete(recurrenceQuests).where(eq(recurrenceQuests.recurrenceId, recurrenceId)).run();
	if (questIds.length > 0) {
		db.insert(recurrenceQuests)
			.values(questIds.map((questId) => ({ recurrenceId, questId })))
			.run();
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

export function createRecurrence(
	db: Db,
	actor: Actor,
	input: RecurrenceSpec,
	now = new Date()
): RecurrenceView {
	const created = db.transaction((tx) => {
		const realm = getRealm(tx, input.realmId);
		requireRealmRole(tx, actor, realm.id, 'editor');
		const title = requireText(input.title, 'Recurrence title', TITLE_MAX);
		const every = input.every ?? 1;
		requireCadence(input.unit, every);
		const timezone = requireTimezone(input.timezone ?? 'UTC');
		const startsOn = input.startsOn ?? todayIn(timezone, now);
		parseDate(startsOn);
		const ownerId = requireUser(tx, input.ownerId, 'Owner');
		requireActiveMember(tx, realm.id, ownerId, 'Owner');
		const assigneeId =
			input.assigneeId == null ? null : requireUser(tx, input.assigneeId, 'Assignee');
		if (assigneeId !== null) requireActiveMember(tx, realm.id, assigneeId, 'Assignee');
		const questIds = requireQuests(tx, actor, input.questIds ?? []);

		const row = tx
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
			.get();
		setQuests(tx, row.id, questIds);
		return row.id;
	});
	runRecurrences(db, now);
	return readRecurrence(db, created);
}

export function updateRecurrence(
	db: Db,
	actor: Actor,
	id: number,
	patch: RecurrencePatch,
	now = new Date()
): RecurrenceView {
	db.transaction((tx) => {
		const current = getRecurrence(tx, id);
		requireRealmRole(tx, actor, current.realmId, 'editor');
		const changes: Partial<typeof recurrences.$inferInsert> = {};
		if (patch.title !== undefined) {
			changes.title = requireText(patch.title, 'Recurrence title', TITLE_MAX);
		}
		if (patch.description !== undefined) {
			changes.description = checkDescription(patch.description);
		}
		if (patch.ownerId !== undefined) {
			changes.ownerId = requireUser(tx, patch.ownerId, 'Owner');
			requireActiveMember(tx, current.realmId, changes.ownerId, 'Owner');
		}
		if (patch.assigneeId !== undefined) {
			changes.assigneeId =
				patch.assigneeId === null ? null : requireUser(tx, patch.assigneeId, 'Assignee');
			if (changes.assigneeId !== null) {
				requireActiveMember(tx, current.realmId, changes.assigneeId, 'Assignee');
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
			setQuests(tx, id, requireQuests(tx, actor, patch.questIds));
		}
		tx.update(recurrences)
			.set({ ...changes, updatedAt: new Date() })
			.where(eq(recurrences.id, id))
			.run();
	});
	runRecurrences(db, now);
	return readRecurrence(db, id);
}

// The Labours it created stay; only the schedule goes.
export function deleteRecurrence(db: Db, actor: Actor, id: number): void {
	db.transaction((tx) => {
		const current = getRecurrence(tx, id);
		requireRealmRole(tx, actor, current.realmId, 'editor');
		tx.delete(recurrences).where(eq(recurrences.id, id)).run();
	});
}

function isFinished(db: Handle, labourId: number): { at: Date } | null {
	const row = db
		.select({ closed: states.isClosed, at: labours.updatedAt })
		.from(labours)
		.innerJoin(states, eq(states.id, labours.stateId))
		.where(eq(labours.id, labourId))
		.get();
	return row?.closed ? { at: row.at } : null;
}

// One pass over every unpaused Recurrence: schedule the next Labour for any whose last one is
// finished, then create the Labour of any that is due. Returns the ids of the Labours created.
export function runRecurrences(db: Db, now = new Date()): number[] {
	const created: number[] = [];
	const rows = db.select().from(recurrences).where(eq(recurrences.paused, false)).all();
	for (const row of rows) {
		try {
			let dueAt = row.nextDueAt;
			if (dueAt === null) {
				const finished = row.labourId === null ? { at: now } : isFinished(db, row.labourId);
				if (finished === null) continue;
				dueAt = nextOccurrence(row, finished.at);
				db.update(recurrences).set({ nextDueAt: dueAt }).where(eq(recurrences.id, row.id)).run();
			}
			if (dueAt.getTime() > now.getTime()) continue;
			created.push(spawn(db, row));
		} catch (error) {
			console.error(`sagas recurrence ${row.id} could not run`, error);
		}
	}
	return created;
}

function spawn(db: Db, row: Recurrence): number {
	const actor: Actor = { id: row.ownerId };
	const labour = createLabour(db, actor, {
		realmId: row.realmId,
		title: row.title,
		description: row.description,
		ownerId: row.ownerId,
		assigneeId: row.assigneeId,
		labels: row.labels,
		recurrenceId: row.id
	});
	db.update(recurrences)
		.set({ labourId: labour.id, nextDueAt: null, updatedAt: new Date() })
		.where(eq(recurrences.id, row.id))
		.run();
	const questIds = questIdsOf(db, row.id);
	for (const questId of questIds) {
		try {
			addQuestLabour(db, actor, questId, labour.id);
		} catch (error) {
			console.error(`sagas recurrence ${row.id} could not add ${labour.key} to a Quest`, error);
		}
	}
	return labour.id;
}

export function scheduleRecurrences(db: Db, everyMs = 60 * 1000): () => void {
	const tick = () => {
		try {
			runRecurrences(db);
		} catch (error) {
			console.error('sagas recurrences failed', error);
		}
	};
	tick();
	const timer = setInterval(tick, everyMs);
	timer.unref();
	return () => clearInterval(timer);
}
