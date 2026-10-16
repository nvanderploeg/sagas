import { asc, eq, inArray, lt, sql } from 'drizzle-orm';
import type { Db, Handle } from '../../db/client.ts';
import { attributes, comments, labourAttributes, labours, surveys } from '../../db/schema.ts';
import type { Actor } from '../../domain/write.ts';
import { hashContent } from '../content.ts';
import { loadCandidates, type Candidate } from './candidates.ts';
import type { FeatureContext } from './features/types.ts';
import { sentimentBlock, type SurveySentiment } from './sentiment-block.ts';
import { checkRequest, type SurveyInput, type SurveyRequest } from './request.ts';
import { applyWeights, readVocabulary, type Applied } from './weights.ts';

export type { IncludeClosed, SurveyInput } from './request.ts';
export { ASSIGNEES_MAX, HAS_MAX, REALMS_MAX } from './request.ts';
export type { SurveySentiment } from './sentiment-block.ts';

export type SurveyResultItem = {
	labourId: number;
	key: string;
	title: string;
	realmKey: string;
	stateKey: string;
	assigneeId: number | null;
	brief: string;
	score: number;
	contributions: Record<string, number>;
	values?: Record<string, unknown>;
};

export type SurveyCoverage = {
	candidates: number;
	unappraised: number;
	stale: number;
	unembedded: number;
	missing: Record<string, number>;
};

export type SurveyResult = {
	surveyId: number;
	results: SurveyResultItem[];
	sentiment: SurveySentiment[];
	coverage: SurveyCoverage;
	ignored: string[];
};

const CONTRIBUTIONS_MAX = 5;
const EDGE = 1e-12;
const SENTIMENT_FEATURES = ['sentiment', 'pain', 'delight'];

export function survey(
	db: Db,
	actor: Actor,
	input: SurveyInput,
	opts: { now?: Date; random?: () => number; queryVector?: Float32Array } = {}
): SurveyResult {
	const now = opts.now ?? new Date();
	const random = opts.random ?? Math.random;
	return db.transaction((tx) => {
		const request = checkRequest(tx, actor, input);
		return runSurvey(tx, actor, request, now, random, opts.queryVector);
	});
}

export function pruneSurveys(db: Handle, retentionMs: number, now = Date.now()): number {
	return db
		.delete(surveys)
		.where(lt(surveys.createdAt, new Date(now - retentionMs)))
		.run().changes;
}

function runSurvey(
	tx: Handle,
	actor: Actor,
	request: SurveyRequest,
	now: Date,
	random: () => number,
	queryVector?: Float32Array
): SurveyResult {
	const candidates = loadCandidates(
		tx,
		{
			...request.filter,
			realmIds: request.realmIds,
			has: request.filter.has ?? [],
			labels: request.filter.labels ?? [],
			unblocked: request.filter.unblocked ?? false
		},
		now.getTime()
	);

	const vocabulary = readVocabulary(tx, request.realmIds);
	const context: FeatureContext = {
		db: tx,
		candidates,
		candidateIds: JSON.stringify(candidates.map((candidate) => candidate.id)),
		query: request.query,
		forUserId: request.forUserId,
		now,
		queryVector
	};
	const { applied, ignored } = applyWeights(context, request.weights, vocabulary);
	const shown = (request.show ?? []).filter((key) => vocabulary.attributeKeys.has(key));
	for (const key of request.show ?? []) {
		if (!vocabulary.attributeKeys.has(key) && !ignored.includes(key)) ignored.push(key);
	}

	const scores = candidates.map((candidate) => {
		let score = 0;
		for (const column of applied) score += column.weight * (column.values.get(candidate.id) ?? 0);
		return score;
	});
	const order = arrange(scores, request.temperature, random);

	const top = order.slice(0, request.limit);
	const picked = top.map((index) => candidates[index]);
	const attributeValues = request.show === undefined ? undefined : readShown(tx, picked, shown);
	const results = top.map((index): SurveyResultItem => {
		const candidate = candidates[index];
		return {
			labourId: candidate.id,
			key: candidate.key,
			title: candidate.title,
			realmKey: candidate.realmKey,
			stateKey: candidate.stateKey,
			assigneeId: candidate.assigneeId,
			brief: candidate.brief,
			score: scores[index],
			contributions: contributionsOf(applied, candidate.id),
			...(attributeValues === undefined ? {} : { values: attributeValues.get(candidate.id) })
		};
	});

	const sentiment = applied.some((column) => SENTIMENT_FEATURES.includes(column.key))
		? sentimentBlock(context, picked)
		: [];

	const missing: Record<string, number> = {};
	for (const column of applied) if (column.missing > 0) missing[column.key] = column.missing;
	const stamped = candidates.filter((candidate) => candidate.contentHash !== null);
	const coverage: SurveyCoverage = {
		candidates: candidates.length,
		unappraised: candidates.length - stamped.length,
		stale: countStale(tx, stamped),
		unembedded: candidates.length,
		missing
	};

	const { id } = tx
		.insert(surveys)
		.values({
			actorId: actor.id,
			forId: request.forUserId,
			request,
			results: results.map(({ labourId, score }) => ({ labour: labourId, score })),
			createdAt: now
		})
		.returning({ id: surveys.id })
		.get();
	return { surveyId: id, results, sentiment, coverage, ignored };
}

// Board order breaks every tie.
function arrange(scores: number[], temperature: number, random: () => number): number[] {
	let keys = scores;
	if (temperature > 0) {
		const mean = scores.reduce((sum, score) => sum + score, 0) / Math.max(scores.length, 1);
		const spread =
			scores.length < 2
				? 0
				: Math.sqrt(scores.reduce((sum, score) => sum + (score - mean) ** 2, 0) / scores.length);
		keys = scores.map((score) => {
			const u = Math.min(Math.max(random(), EDGE), 1 - EDGE);
			return score + temperature * spread * -Math.log(-Math.log(u));
		});
	}
	return scores.map((_, index) => index).sort((a, b) => keys[b] - keys[a]);
}

function contributionsOf(applied: Applied[], labourId: number): Record<string, number> {
	const parts = applied
		.map((column) => ({
			key: column.key,
			value: column.weight * (column.values.get(labourId) ?? 0)
		}))
		.filter((part) => part.value !== 0);
	parts.sort((a, b) => Math.abs(b.value) - Math.abs(a.value));
	return Object.fromEntries(
		parts.slice(0, CONTRIBUTIONS_MAX).map((part) => [part.key, part.value])
	);
}

// Format as readValues in agent/attributes.ts: the stored value.
function readShown(
	tx: Handle,
	picked: Candidate[],
	keys: string[]
): Map<number, Record<string, unknown>> {
	const byLabour = new Map(
		picked.map((candidate) => [candidate.id, {} as Record<string, unknown>])
	);
	if (keys.length === 0 || picked.length === 0) return byLabour;
	const rows = tx
		.select({
			labourId: labourAttributes.labourId,
			key: attributes.key,
			value: labourAttributes.value
		})
		.from(labourAttributes)
		.innerJoin(attributes, eq(attributes.id, labourAttributes.attributeId))
		.where(
			sql`${labourAttributes.labourId} IN (SELECT value FROM json_each(${JSON.stringify(picked.map((candidate) => candidate.id))})) AND ${inArray(attributes.key, keys)}`
		)
		.all();
	const held = new Map(rows.map((row) => [`${row.labourId}:${row.key}`, row.value]));
	for (const candidate of picked) {
		const values = byLabour.get(candidate.id)!;
		for (const key of keys) {
			const value = held.get(`${candidate.id}:${key}`);
			if (value !== undefined) values[key] = value;
		}
	}
	return byLabour;
}

// Rebuilds each stamped candidate's hash from two batched reads, never one read per Labour.
function countStale(tx: Handle, stamped: Candidate[]): number {
	if (stamped.length === 0) return 0;
	const ids = JSON.stringify(stamped.map((candidate) => candidate.id));
	const rows = tx
		.select({
			id: labours.id,
			title: labours.title,
			description: labours.description,
			labels: labours.labels
		})
		.from(labours)
		.where(sql`${labours.id} IN (SELECT value FROM json_each(${ids}))`)
		.all();
	const bodies = new Map<number, string[]>();
	const comment = tx
		.select({ labourId: comments.labourId, body: comments.body })
		.from(comments)
		.where(sql`${comments.labourId} IN (SELECT value FROM json_each(${ids}))`)
		.orderBy(asc(comments.labourId), asc(comments.id))
		.all();
	for (const { labourId, body } of comment) {
		const list = bodies.get(labourId);
		if (list === undefined) bodies.set(labourId, [body]);
		else list.push(body);
	}
	const current = new Map(
		rows.map((row) => [row.id, hashContent({ ...row, comments: bodies.get(row.id) ?? [] })])
	);
	return stamped.filter((candidate) => current.get(candidate.id) !== candidate.contentHash).length;
}
