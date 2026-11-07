import { z } from 'zod';
import {
	createRecurrence,
	deleteRecurrence,
	listRecurrences,
	readRecurrence,
	updateRecurrence
} from '../../domain/recurrences.ts';
import { count } from '../present.ts';
import * as refs from '../refs.ts';
import { reply } from '../result.ts';
import { questRef, realmRef, userRef, type Tools } from '../tool.ts';
import { mapAll } from '#lib/server/async.ts';

const recurrenceRef = z
	.number({ error: 'expected a Recurrence id as a JSON number' })
	.int()
	.positive()
	.describe('Recurrence id');

const schedule = {
	unit: z.enum(['day', 'week', 'month', 'year']).describe('The cadence unit'),
	every: z.number().int().optional().describe('Every this many units; defaults to 1'),
	starts_on: z
		.string()
		.optional()
		.describe('The first occurrence, a calendar date YYYY-MM-DD; defaults to today'),
	timezone: z
		.string()
		.optional()
		.describe('An IANA zone name such as America/Edmonton; the date is midnight there. Default UTC')
};

const recurrenceLine = (r: { id: number; title: string; unit: string; every: number }) =>
	`Recurrence ${r.id} ${r.title}, every ${r.every === 1 ? '' : `${r.every} `}${r.unit}${r.every === 1 ? '' : 's'}`;

export function registerRecurrenceTools({ db, actor, define }: Tools): void {
	const present = async (id: number) => {
		const recurrence = await readRecurrence(db, id);
		return reply({ recurrence }, recurrenceLine(recurrence));
	};

	define(
		'list_recurrences',
		{
			kind: 'read',
			description:
				'List the Recurrences in a Realm: schedules that create a Labour on a cadence. `labourId` is the Labour created last; `nextDueAt` is when the next is due, and is null while the last is unfinished.',
			input: { realm: realmRef }
		},
		async (args) => {
			const recurrences = await listRecurrences(db, await refs.realmId(db, args.realm, actor));
			return reply(
				{ recurrences },
				recurrences.length === 0 ? 'No Recurrences' : count(recurrences.length, 'Recurrence')
			);
		}
	);

	define(
		'create_recurrence',
		{
			kind: 'write',
			description:
				'Create a Recurrence: a Labour template with a cadence. It creates its first Labour on the start date. When that Labour is finished (moved to Closed), the next is created at the next occurrence after that moment; occurrences missed while a Labour was unfinished are skipped, so Labours never pile up. Each Labour is added to the Recurrence’s Quests. Owner defaults to you and must be a member of the Realm.',
			input: {
				realm: realmRef,
				title: z.string().describe('1 to 200 characters'),
				description: z.string().optional().describe('Markdown'),
				owner: userRef.optional(),
				assignee: userRef.optional(),
				labels: z.array(z.string()).optional(),
				quests: z.array(questRef).optional().describe('Quests every new Labour is added to'),
				...schedule
			}
		},
		async (args) => {
			const recurrence = await createRecurrence(db, actor, {
				realmId: await refs.realmId(db, args.realm, actor),
				title: args.title,
				description: args.description,
				ownerId: args.owner === undefined ? actor.id : await refs.userId(db, args.owner, actor),
				assigneeId:
					args.assignee === undefined ? undefined : await refs.userId(db, args.assignee, actor),
				labels: args.labels,
				questIds: await mapAll(args.quests, (id) => refs.questId(db, id, actor)),
				unit: args.unit,
				every: args.every,
				startsOn: args.starts_on,
				timezone: args.timezone
			});
			return present(recurrence.id);
		}
	);

	define(
		'update_recurrence',
		{
			kind: 'write',
			description:
				'Change a Recurrence. New text, Owner, Assignee, labels and Quests apply to the next Labour; Labours already created are untouched. `paused` stops it creating Labours until it is false again. Changing the cadence reschedules a Recurrence that is waiting; one with an unfinished Labour is scheduled when that Labour is finished.',
			input: {
				recurrence: recurrenceRef,
				title: z.string().optional(),
				description: z.string().optional().describe('Markdown; replaces the whole description'),
				owner: userRef.optional(),
				assignee: userRef.nullable().optional().describe('null clears the Assignee'),
				labels: z.array(z.string()).optional().describe('Replaces the set'),
				quests: z.array(questRef).optional().describe('Replaces the set'),
				paused: z.boolean().optional(),
				unit: schedule.unit.optional(),
				every: schedule.every,
				starts_on: schedule.starts_on,
				timezone: schedule.timezone
			}
		},
		async (args) => {
			const id = await refs.recurrenceId(db, args.recurrence, actor);
			await updateRecurrence(db, actor, id, {
				title: args.title,
				description: args.description,
				ownerId: args.owner === undefined ? undefined : await refs.userId(db, args.owner, actor),
				assigneeId:
					args.assignee === undefined || args.assignee === null
						? args.assignee
						: await refs.userId(db, args.assignee, actor),
				labels: args.labels,
				questIds: await mapAll(args.quests, (quest) => refs.questId(db, quest, actor)),
				paused: args.paused,
				unit: args.unit,
				every: args.every,
				startsOn: args.starts_on,
				timezone: args.timezone
			});
			return present(id);
		}
	);

	define(
		'delete_recurrence',
		{
			kind: 'destroy',
			description: 'Delete a Recurrence. The Labours it created are untouched.',
			input: { recurrence: recurrenceRef }
		},
		async (args) => {
			const recurrence = await readRecurrence(
				db,
				await refs.recurrenceId(db, args.recurrence, actor)
			);
			await deleteRecurrence(db, actor, recurrence.id);
			return reply(
				{ deleted: { id: recurrence.id, title: recurrence.title } },
				`Deleted Recurrence ${recurrence.id} ${recurrence.title}`
			);
		}
	);
}
