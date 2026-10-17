import { eq, sql } from 'drizzle-orm';
import type { Handle } from '../../db/client.ts';
import { quests, realms, users } from '../../db/schema.ts';
import { DomainError } from '../../domain/errors.ts';
import { LABELS_MAX, normalizeLabels } from '../../domain/labels.ts';
import { STATE_KEY } from '../../domain/validate.ts';
import type { Actor } from '../../domain/write.ts';

export type IncludeClosed = true | { withinDays: number };

export type SurveyInput = {
	realmIds?: number[];
	forUserId?: number;
	query?: string;
	weights: Record<string, number>;
	filter?: {
		includeClosed?: IncludeClosed;
		assigneeIds?: (number | null)[];
		has?: string[];
		labels?: string[];
		questId?: number;
		unblocked?: boolean;
	};
	temperature?: number;
	limit?: number;
	show?: string[];
};

// The request as stored: defaults filled, references as ids, labels normalized.
export type SurveyRequest = {
	realmIds: number[];
	forUserId: number;
	query?: string;
	weights: Record<string, number>;
	filter: NonNullable<SurveyInput['filter']>;
	temperature: number;
	limit: number;
	show?: string[];
};

export const QUERY_MAX = 500;
export const WEIGHTS_MAX = 64;
export const WEIGHT_LIMIT = 10;
export const TEMPERATURE_MAX = 2;
export const TEMPERATURE_DEFAULT = 0.3;
export const LIMIT_MAX = 50;
export const LIMIT_DEFAULT = 15;
export const SHOW_MAX = 16;
export const WITHIN_DAYS_MAX = 3650;
export const REALMS_MAX = 64;
export const ASSIGNEES_MAX = 64;
export const HAS_MAX = 32;

const WEIGHT_KEY = /^[a-z][a-z0-9_-]{0,31}(:[a-z][a-z0-9-]{0,31})?$/;
const HAS_KEY = /^[a-z][a-z0-9-]{0,31}:[a-z][a-z0-9-]{0,31}$/;

function invalid(message: string): never {
	throw new DomainError('invalid', message);
}

const isObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value);

const isId = (value: unknown): value is number =>
	typeof value === 'number' && Number.isInteger(value) && value > 0;

function stringList(value: unknown, what: string): string[] {
	if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
		invalid(`${what} must be a list of strings`);
	}
	return value as string[];
}

const anyOf = (ids: number[]) => sql`(SELECT value FROM json_each(${JSON.stringify(ids)}))`;

function requireAll(ids: number[], found: { id: number }[], what: string): void {
	const have = new Set(found.map((row) => row.id));
	const missing = ids.find((id) => !have.has(id));
	if (missing !== undefined) throw new DomainError('not_found', `${what} ${missing} not found`);
}

// Shape and limits first (`invalid`), then that every referenced id exists (`not_found`).
export function checkRequest(tx: Handle, actor: Actor, input: SurveyInput): SurveyRequest {
	if (!isObject(input)) invalid('A Survey needs a request object');

	const weights = checkWeights(input.weights);
	const query = checkQuery(input.query);
	const filter = checkFilter(input.filter);
	const temperature = input.temperature ?? TEMPERATURE_DEFAULT;
	if (typeof temperature !== 'number' || !(temperature >= 0 && temperature <= TEMPERATURE_MAX)) {
		invalid(`Temperature must be a number from 0 to ${TEMPERATURE_MAX}`);
	}
	const limit = input.limit ?? LIMIT_DEFAULT;
	if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > LIMIT_MAX) {
		invalid(`Limit must be an integer from 1 to ${LIMIT_MAX}`);
	}
	const show = checkShow(input.show);
	const forUserId = input.forUserId ?? actor.id;
	if (!isId(forUserId)) invalid('forUserId must be a User id');

	let realmIds = input.realmIds;
	if (realmIds !== undefined) {
		if (!Array.isArray(realmIds) || realmIds.length === 0 || !realmIds.every(isId)) {
			invalid('realmIds must be a list of one or more Realm ids');
		}
		realmIds = [...new Set(realmIds)];
		if (realmIds.length > REALMS_MAX) invalid(`realmIds takes at most ${REALMS_MAX} Realms`);
		requireAll(
			realmIds,
			tx
				.select({ id: realms.id })
				.from(realms)
				.where(sql`${realms.id} IN ${anyOf(realmIds)}`)
				.all(),
			'Realm'
		);
	} else {
		realmIds = tx
			.select({ id: realms.id })
			.from(realms)
			.all()
			.map((row) => row.id)
			.sort((a, b) => a - b);
	}

	const userIds = [
		...new Set([forUserId, ...(filter.assigneeIds ?? []).filter((id) => id !== null)])
	];
	requireAll(
		userIds,
		tx
			.select({ id: users.id })
			.from(users)
			.where(sql`${users.id} IN ${anyOf(userIds)}`)
			.all(),
		'User'
	);
	if (filter.questId !== undefined) {
		requireAll(
			[filter.questId],
			tx.select({ id: quests.id }).from(quests).where(eq(quests.id, filter.questId)).all(),
			'Quest'
		);
	}

	return {
		realmIds,
		forUserId,
		...(query === undefined ? {} : { query }),
		weights,
		filter,
		temperature,
		limit,
		...(show === undefined ? {} : { show })
	};
}

function checkWeights(raw: unknown): Record<string, number> {
	if (!isObject(raw)) invalid('weights must be an object of keys to numbers');
	const entries = Object.entries(raw);
	if (entries.length < 1 || entries.length > WEIGHTS_MAX) {
		invalid(`A Survey takes 1 to ${WEIGHTS_MAX} weights`);
	}
	for (const [key, weight] of entries) {
		if (!WEIGHT_KEY.test(key)) {
			invalid(`Weight key "${key}" must be a feature or Attribute key, or attr:member`);
		}
		if (typeof weight !== 'number' || !Number.isFinite(weight) || Math.abs(weight) > WEIGHT_LIMIT) {
			invalid(`Weight "${key}" must be a number from -${WEIGHT_LIMIT} to ${WEIGHT_LIMIT}`);
		}
	}
	return Object.fromEntries(entries) as Record<string, number>;
}

function checkQuery(raw: unknown): string | undefined {
	if (raw === undefined) return undefined;
	if (typeof raw !== 'string') invalid('query must be text');
	const query = raw.trim();
	if (query.length > QUERY_MAX) invalid(`query must be at most ${QUERY_MAX} characters`);
	return query === '' ? undefined : query;
}

function checkShow(raw: unknown): string[] | undefined {
	if (raw === undefined) return undefined;
	const show = [...new Set(stringList(raw, 'show'))];
	if (show.length > SHOW_MAX) invalid(`show takes at most ${SHOW_MAX} Attribute keys`);
	for (const key of show) {
		if (!STATE_KEY.test(key)) invalid(`show key "${key}" must be an Attribute key`);
	}
	return show;
}

function checkFilter(raw: unknown): NonNullable<SurveyInput['filter']> {
	if (raw === undefined) return {};
	if (!isObject(raw)) invalid('filter must be an object');
	const filter: NonNullable<SurveyInput['filter']> = {};

	const closed = raw.includeClosed;
	if (closed !== undefined) {
		if (closed === true) {
			filter.includeClosed = true;
		} else if (
			isObject(closed) &&
			typeof closed.withinDays === 'number' &&
			closed.withinDays > 0 &&
			closed.withinDays <= WITHIN_DAYS_MAX
		) {
			filter.includeClosed = { withinDays: closed.withinDays };
		} else {
			invalid(
				`includeClosed must be true or { withinDays } above 0 and at most ${WITHIN_DAYS_MAX}`
			);
		}
	}

	const assignees = raw.assigneeIds;
	if (assignees !== undefined) {
		if (
			!Array.isArray(assignees) ||
			assignees.length === 0 ||
			!assignees.every((id) => id === null || isId(id))
		) {
			invalid('assigneeIds must be one or more User ids, or null for unassigned');
		}
		filter.assigneeIds = [...new Set(assignees as (number | null)[])];
		if (filter.assigneeIds.length > ASSIGNEES_MAX) {
			invalid(`assigneeIds takes at most ${ASSIGNEES_MAX} Users`);
		}
	}

	if (raw.has !== undefined) {
		const has = [...new Set(stringList(raw.has, 'has'))];
		if (has.length > HAS_MAX) invalid(`has takes at most ${HAS_MAX} keys`);
		for (const key of has) {
			if (!HAS_KEY.test(key)) invalid(`has key "${key}" must be attr:member`);
		}
		filter.has = has;
	}

	if (raw.labels !== undefined) {
		const labels = [...new Set(stringList(raw.labels, 'labels'))];
		if (labels.length > LABELS_MAX) invalid(`labels takes at most ${LABELS_MAX} Labels`);
		filter.labels = normalizeLabels(labels);
	}

	if (raw.questId !== undefined) {
		if (!isId(raw.questId)) invalid('questId must be a Quest id');
		filter.questId = raw.questId;
	}

	if (raw.unblocked !== undefined) {
		if (typeof raw.unblocked !== 'boolean') invalid('unblocked must be true or false');
		filter.unblocked = raw.unblocked;
	}
	return filter;
}
