import { z } from 'zod';
import { DomainError } from '../../domain/errors.ts';
import {
	addQuestTickets,
	createQuest,
	deleteQuest,
	listQuests,
	listQuestTickets,
	rankQuestTicket,
	readQuest,
	removeQuestTickets,
	updateQuest,
	type QuestTicketsChange
} from '../../domain/quests.ts';
import { count, questLine, type Presenter } from '../present.ts';
import * as refs from '../refs.ts';
import { reply } from '../result.ts';
import { placementShape, questRef, ticketRef, userRef, type Tools } from '../tool.ts';

function questReply(present: Presenter, questId: number) {
	const quest = present.quest(readQuest(present.db, questId));
	return reply({ quest }, questLine(quest));
}

function changeReply(
	present: Presenter,
	change: QuestTicketsChange,
	verb: 'added' | 'removed',
	skippedBecause: string
) {
	const quest = present.quest(change.quest);
	const keys = (ids: number[]) => ids.map((id) => refs.ticketKey(present.db, id));
	const skipped = keys(change.skipped);
	const note = skipped.length > 0 ? `, skipped ${skipped.length} ${skippedBecause}` : '';
	return reply(
		{ quest, [verb]: keys(change.ticketIds), skipped },
		`${questLine(quest)}; ${verb} ${count(change.ticketIds.length, 'Ticket')}${note}`
	);
}

const BULK_MAX = 100;

const ticketList = z
	.array(ticketRef)
	.min(1)
	.max(BULK_MAX)
	.describe(`1 to ${BULK_MAX} Tickets; a Ticket listed twice counts once`);

export function registerQuestTools({ db, actor, define }: Tools): void {
	define(
		'list_quests',
		{
			kind: 'read',
			description:
				'List every Quest with its Owner and progress: its Closed Tickets over all its Tickets.',
			input: {}
		},
		(_args, present) => {
			const quests = listQuests(db).map((q) => present.questSummary(q));
			return reply({ quests }, quests.length === 0 ? 'No Quests' : count(quests.length, 'Quest'));
		}
	);

	define(
		'get_quest',
		{
			kind: 'read',
			description:
				'Get a Quest with its Tickets in Quest order and its progress (Closed over total). A Quest has no State of its own.',
			input: { quest: questRef }
		},
		(args, present) => questReply(present, refs.questId(db, args.quest))
	);

	define(
		'create_quest',
		{
			kind: 'write',
			description:
				'Create a Quest: a named, ordered set of Tickets that may span Projects. Owner defaults to you.',
			input: {
				name: z.string().describe('1 to 120 characters'),
				description: z.string().optional().describe('Markdown'),
				owner: userRef.optional()
			}
		},
		(args, present) => {
			const quest = createQuest(db, actor, {
				name: args.name,
				description: args.description,
				ownerId: args.owner === undefined ? actor.id : refs.userId(db, args.owner, actor)
			});
			return questReply(present, quest.id);
		}
	);

	define(
		'update_quest',
		{
			kind: 'write',
			description: "Change a Quest's name, description or Owner.",
			input: {
				quest: questRef,
				name: z.string().optional(),
				description: z.string().optional().describe('Markdown; replaces the whole description'),
				owner: userRef.optional()
			}
		},
		(args, present) => {
			const questId = refs.questId(db, args.quest);
			updateQuest(db, actor, questId, {
				name: args.name,
				description: args.description,
				ownerId: args.owner === undefined ? undefined : refs.userId(db, args.owner, actor)
			});
			return questReply(present, questId);
		}
	);

	define(
		'delete_quest',
		{
			kind: 'destroy',
			description: 'Delete a Quest. Its Tickets are untouched.',
			input: { quest: questRef }
		},
		(args) => {
			const quest = readQuest(db, refs.questId(db, args.quest));
			deleteQuest(db, actor, quest.id);
			return reply(
				{ deleted: { id: quest.id, name: quest.name } },
				`Deleted Quest ${quest.id} ${quest.name}`
			);
		}
	);

	define(
		'add_quest_tickets',
		{
			kind: 'write',
			description:
				'Add Tickets to a Quest in one write, in the order given, at the bottom unless a position is given. Tickets already in the Quest are skipped and listed in `skipped`, so repeating a call is safe. Membership is explicit: adding a Ticket never adds its Children; list them too if you want them. An unknown Ticket fails the whole call.',
			input: { quest: questRef, tickets: ticketList, ...placementShape }
		},
		(args, present) => {
			const questId = refs.questId(db, args.quest);
			const ticketIds = args.tickets.map((ref) => refs.ticketId(db, ref));
			const placement = refs.placement(db, args);
			const change = addQuestTickets(db, actor, questId, ticketIds, placement);
			return changeReply(present, change, 'added', 'already in it');
		}
	);

	define(
		'remove_quest_tickets',
		{
			kind: 'write',
			description:
				'Remove Tickets from a Quest in one write. Tickets not in the Quest are skipped and listed in `skipped`, so repeating a call is safe. The Tickets themselves are untouched. An unknown Ticket fails the whole call.',
			input: { quest: questRef, tickets: ticketList }
		},
		(args, present) => {
			const questId = refs.questId(db, args.quest);
			const ticketIds = args.tickets.map((ref) => refs.ticketId(db, ref));
			const change = removeQuestTickets(db, actor, questId, ticketIds);
			return changeReply(present, change, 'removed', 'not in it');
		}
	);

	define(
		'rank_quest_ticket',
		{
			kind: 'write',
			description:
				"Reorder a Ticket within a Quest. Give exactly one of position, before or after; before and after name another member. Quest order is separate from the Ticket's Rank on its board.",
			input: { quest: questRef, ticket: ticketRef, ...placementShape }
		},
		(args, present) => {
			const questId = refs.questId(db, args.quest);
			const ticketId = refs.ticketId(db, args.ticket);
			const placement = refs.placement(db, args);
			if (placement === undefined) {
				throw new DomainError('invalid', 'Give one of position, before or after');
			}
			if (!listQuestTickets(db, questId).some((t) => t.id === ticketId)) {
				throw new DomainError(
					'not_found',
					`${refs.ticketKey(db, ticketId)} is not in Quest ${questId}`
				);
			}
			rankQuestTicket(db, actor, questId, ticketId, placement);
			return questReply(present, questId);
		}
	);
}
