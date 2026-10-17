import { inArray } from 'drizzle-orm';
import { z } from 'zod';
import {
	ASSIGNEES_MAX,
	checkSurvey,
	HAS_MAX,
	REALMS_MAX,
	survey,
	type SurveyInput
} from '../../agent/survey/index.ts';
import { getEmbedder } from '../../agent/vectors/embedder.ts';
import { realms as realmsTable } from '../../db/schema.ts';
import { LABELS_MAX, normalizeLabels } from '../../domain/labels.ts';
import { count } from '../present.ts';
import * as refs from '../refs.ts';
import { reply } from '../result.ts';
import { questRef, realmRef, userRef, type Tools } from '../tool.ts';
import { pulseDto } from './sentiment.ts';

const filterShape = z.strictObject({
	include_closed: z
		.union([z.literal(true), z.strictObject({ within_days: z.number() })])
		.optional()
		.describe(
			'Candidates are open Labours. true adds every Closed one; { within_days } adds those updated within that many days (above 0, at most 3650)'
		),
	assignee: z
		.array(userRef.nullable())
		.max(ASSIGNEES_MAX)
		.optional()
		.describe(
			`Keep Labours assigned to one of these Users (at most ${ASSIGNEES_MAX}); null matches unassigned`
		),
	has: z
		.array(z.string())
		.max(HAS_MAX)
		.optional()
		.describe(
			`\`attr:member\` keys of tags Attributes the Labour must hold, all of them (at most ${HAS_MAX})`
		),
	labels: z
		.array(z.string())
		.max(LABELS_MAX)
		.optional()
		.describe(`Labels the Labour must carry, all of them (at most ${LABELS_MAX})`),
	quest: questRef.optional().describe('Keep Labours in this Quest'),
	unblocked: z.boolean().optional().describe('true drops every Labour that an open Labour blocks')
});

const EMBED_TIMEOUT_MS = 10_000;

// Set while query embedding fails, so an outage logs once.
let embedFailing = false;

// Never fails the Survey: without a query vector, `similarity` counts as missing.
async function queryVectorFor(query: string): Promise<Float32Array | undefined> {
	const embedder = getEmbedder();
	if (embedder === null) return undefined;
	let timer: NodeJS.Timeout | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(
			() => reject(new Error(`no query vector within ${EMBED_TIMEOUT_MS} ms`)),
			EMBED_TIMEOUT_MS
		);
	});
	try {
		const vector = await Promise.race([embedder.embedQuery(query), timeout]);
		embedFailing = false;
		return vector;
	} catch (error) {
		if (!embedFailing) {
			console.warn('sagas survey: embedding the query failed; similarity counts as missing', error);
		}
		embedFailing = true;
		return undefined;
	} finally {
		clearTimeout(timer);
	}
}

export function registerSurveyTools({ db, actor, define }: Tools): void {
	define(
		'survey',
		{
			kind: 'write',
			description:
				"Answer \"what's next\", \"what matters most\" or \"what should I pick up\": score Labours for a User and get the best back, with why. Choose weights from the Realm's notes (get_realm) and Attributes (get_attributes). `weights` maps keys to numbers in [-10, 10] (1 to 64 of them); a Labour's Score is the sum of weight times feature over the keys. A key is a `scale` Attribute (its value scaled to 0..1), a `tags` member as `attr:member` (1 when held, else 0), or a built-in feature in [0, 1] (`affinity` aside): `keywords` (text match to `query`; needs it), `similarity` (how close the Labour's title, Brief and description are in meaning to `query`, from the local embedding model; needs `query`, and without the model or a vector for the Labour it counts as missing), `mentions` (recent mentions of the Labour), `pulled_in` (recent mentions of the User in the Labour), `evidence`, `unblocks`, `quest_finish`, `column` (1 at the top of its State's column), `age`, `activity`, `sentiment`, `pain` and `delight` (how loudly, how badly and how happily people have reported on the Attributes the Labour holds; see get_sentiment), `skill_fit` (how well the User's Skills meet the Labour's needs; a Labour that needs none, or a User who holds none, counts as missing) and `affinity` (in [-1, 1]: how much the User's Affinity, built from the Outcomes they reported, favours or shuns the Attribute values the Labour holds; 0 without data; see report_outcomes). Keys that match nothing, and `keywords` or `similarity` without a `query`, come back in `ignored`. A Labour without the data for an Attribute key takes 0.5 for it and counts in `coverage.missing`. Results run highest Score first; a `temperature` above 0 shuffles them by noise scaled to how far Scores spread, and 0 sorts strictly. Scores from different Surveys do not compare. Each result carries `contributions` (the weight times feature behind its five largest terms) and, with `show`, the values of those Attribute keys. With `sentiment`, `pain` or `delight` weighted, the result's `sentiment` lists the keys behind them (at most 10, loudest first) with the two heaviest Pulses of each, notes and evidence. The Survey is stored with its results and kept for 30 days by default; report what became of its Labours with report_outcomes.",
			input: {
				realm: z
					.union([realmRef, z.array(realmRef).min(1).max(REALMS_MAX)])
					.optional()
					.describe(`A Realm, or a list of up to ${REALMS_MAX}; every Realm by default`),
				for: userRef.optional().describe('The User the Survey is for; you by default'),
				query: z
					.string()
					.optional()
					.describe('Text for `keywords` and `similarity`, up to 500 characters'),
				weights: z
					.record(z.string(), z.number())
					.describe('Key to weight, e.g. { "impact": 3, "topic:boss-hp": 2, "age": -1 }'),
				filter: filterShape.optional(),
				temperature: z.number().optional().describe('0 to 2; 0.3 by default'),
				limit: z.number().optional().describe('1 to 50 results; 15 by default'),
				show: z
					.array(z.string())
					.optional()
					.describe('Up to 16 Attribute keys whose values each result carries')
			}
		},
		async (args, present) => {
			const realms = args.realm === undefined ? undefined : [args.realm].flat();
			const filter = args.filter;
			const input: SurveyInput = {
				realmIds: realms?.map((ref) => refs.realmId(db, ref)),
				forUserId: args.for === undefined ? undefined : refs.userId(db, args.for, actor),
				query: args.query,
				weights: args.weights,
				filter:
					filter === undefined
						? undefined
						: {
								includeClosed:
									filter.include_closed === undefined || filter.include_closed === true
										? filter.include_closed
										: { withinDays: filter.include_closed.within_days },
								assigneeIds: filter.assignee?.map((ref) =>
									ref === null ? null : refs.userId(db, ref, actor)
								),
								has: filter.has,
								labels: filter.labels === undefined ? undefined : normalizeLabels(filter.labels),
								questId: filter.quest === undefined ? undefined : refs.questId(db, filter.quest),
								unblocked: filter.unblocked
							},
				temperature: args.temperature,
				limit: args.limit,
				show: args.show
			};
			const request = checkSurvey(db, actor, input);
			const queryVector =
				request.query !== undefined && Object.hasOwn(request.weights, 'similarity')
					? await queryVectorFor(request.query)
					: undefined;
			const result = survey(db, actor, input, { queryVector });
			const dto = pulseDto(db, present);
			const realmKeys = new Map(
				db
					.select({ id: realmsTable.id, key: realmsTable.key })
					.from(realmsTable)
					.where(
						inArray(realmsTable.id, [...new Set(result.sentiment.map((entry) => entry.realmId))])
					)
					.all()
					.map((row) => [row.id, row.key])
			);
			const data = {
				survey: result.surveyId,
				results: result.results.map((item) => ({
					key: item.key,
					path: `/l/${item.key}`,
					url: present.url(`/l/${item.key}`),
					title: item.title,
					realm: item.realmKey,
					state: item.stateKey,
					assignee: item.assigneeId === null ? null : present.username(item.assigneeId),
					brief: item.brief,
					score: item.score,
					contributions: item.contributions,
					...(item.values === undefined ? {} : { values: item.values })
				})),
				sentiment: result.sentiment.map((entry) => ({
					realm: realmKeys.get(entry.realmId)!,
					key: entry.key,
					volume: entry.volume,
					mood: entry.mood,
					pulses: entry.pulses.map(dto)
				})),
				coverage: result.coverage,
				ignored: result.ignored
			};
			return reply(
				data,
				`Survey ${result.surveyId}: ${result.results.length} of ${count(result.coverage.candidates, 'Labour')}`
			);
		}
	);
}
