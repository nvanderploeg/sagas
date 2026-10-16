import { z } from 'zod';
import {
	ASSIGNEES_MAX,
	HAS_MAX,
	REALMS_MAX,
	survey,
	type SurveyInput
} from '../../agent/survey/index.ts';
import { LABELS_MAX, normalizeLabels } from '../../domain/labels.ts';
import { count } from '../present.ts';
import * as refs from '../refs.ts';
import { reply } from '../result.ts';
import { questRef, realmRef, userRef, type Tools } from '../tool.ts';

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

export function registerSurveyTools({ db, actor, define }: Tools): void {
	define(
		'survey',
		{
			kind: 'write',
			description:
				"Score Labours for a User and get the best back, with why. `weights` maps keys to numbers in [-10, 10] (1 to 64 of them); a Labour's Score is the sum of weight times feature over the keys. A key is a `scale` Attribute (its value scaled to 0..1), a `tags` member as `attr:member` (1 when held, else 0), or a built-in feature in [0, 1]: `keywords` (text match to `query`; needs it), `mentions` (recent mentions of the Labour), `pulled_in` (recent mentions of the User in the Labour), `evidence`, `unblocks`, `quest_finish`, `column` (1 at the top of its State's column), `age`, `activity`. Keys that match nothing, and features this server doesn't compute (`similarity`, `sentiment`, `pain`, `delight`, `affinity`, `skill_fit`), come back in `ignored`. A Labour without the data for an Attribute key takes 0.5 for it and counts in `coverage.missing`. Results run highest Score first; a `temperature` above 0 shuffles them by noise scaled to how far Scores spread, and 0 sorts strictly. Scores from different Surveys do not compare. Each result carries `contributions` (the weight times feature behind its five largest terms) and, with `show`, the values of those Attribute keys. The Survey is stored with its results and kept for 30 days by default.",
			input: {
				realm: z
					.union([realmRef, z.array(realmRef).min(1).max(REALMS_MAX)])
					.optional()
					.describe(`A Realm, or a list of up to ${REALMS_MAX}; every Realm by default`),
				for: userRef.optional().describe('The User the Survey is for; you by default'),
				query: z.string().optional().describe('Text for `keywords`, up to 500 characters'),
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
		(args, present) => {
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
			const result = survey(db, actor, input);
			const data = {
				survey: result.surveyId,
				results: result.results.map((item) => ({
					key: item.key,
					path: `/l/${item.key}`,
					title: item.title,
					realm: item.realmKey,
					state: item.stateKey,
					assignee: item.assigneeId === null ? null : present.username(item.assigneeId),
					brief: item.brief,
					score: item.score,
					contributions: item.contributions,
					...(item.values === undefined ? {} : { values: item.values })
				})),
				sentiment: result.sentiment,
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
