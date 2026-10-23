import { z } from 'zod';
import { OUTCOMES_MAX, reportOutcomes, VERDICTS } from '../../agent/outcomes.ts';
import { count } from '../present.ts';
import * as refs from '../refs.ts';
import { reply } from '../result.ts';
import { labourRef, type Tools } from '../tool.ts';

export function registerOutcomeTools({ db, actor, define }: Tools): void {
	define(
		'report_outcomes',
		{
			kind: 'write',
			description: `Report what became of Labours a Survey returned: \`picked\` (you took it on), \`skipped\` (you passed it over) or \`done\` (it got finished), in up to ${OUTCOMES_MAX} Outcomes in one all-or-nothing call. Each Labour must be among that Survey's results. Each new Outcome adds Pulses to the Affinity of the User the Survey was for, which the \`affinity\` feature reads: a pick or a finish pulls towards Labours holding the same Attribute values and members, a skip pushes away. Reporting a verdict a Labour has for that Survey changes nothing (\`recorded\` is false); \`picked\` and then \`done\` are two Outcomes. Any User may report.`,
			input: {
				survey: z.number().int().positive().describe('Survey id, from the survey tool'),
				outcomes: z
					.array(
						z.strictObject({
							labour: labourRef,
							verdict: z.enum(VERDICTS).describe('`picked`, `skipped` or `done`')
						})
					)
					.min(1)
					.max(OUTCOMES_MAX)
					.describe(`1 to ${OUTCOMES_MAX} Outcomes`)
			}
		},
		(args) => {
			const results = reportOutcomes(
				db,
				actor,
				args.survey,
				args.outcomes.map((item) => ({
					labourId: refs.labourId(db, item.labour, actor),
					verdict: item.verdict
				}))
			);
			const data = {
				outcomes: results.map((result) => ({
					labour: refs.labourKey(db, result.labourId),
					verdict: result.verdict,
					recorded: result.recorded
				}))
			};
			const fresh = results.filter((result) => result.recorded).length;
			return reply(
				data,
				`Recorded ${fresh} of ${count(results.length, 'Outcome')} for Survey ${args.survey}`
			);
		}
	);
}
