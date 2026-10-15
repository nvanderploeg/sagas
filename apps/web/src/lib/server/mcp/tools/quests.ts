import { z } from 'zod';
import { DomainError } from '../../domain/errors.ts';
import {
	addQuestTicket,
	createQuest,
	deleteQuest,
	listQuests,
	listQuestTickets,
	rankQuestTicket,
	readQuest,
	removeQuestTicket,
	updateQuest
} from '../../domain/quests.ts';
import type { Placement } from '../../domain/rank.ts';
import { questLine, ticketLine, type Presenter } from '../present.ts';
import * as refs from '../refs.ts';
import { reply } from '../result.ts';
import { placementShape, questRef, ticketRef, userRef, type Tools } from '../tool.ts';

function questReply(present: Presenter, questId: number) {
	const quest = present.quest(readQuest(present.db, questId));
	const lines = [questLine(quest)];
	if (quest.description.trim() !== '') lines.push(quest.description);
	lines.push(...quest.tickets.map((t, i) => `${i + 1}. ${ticketLine(t)}`));
	return reply({ quest }, lines.join('\n'));
}

const ticketList = z.array(ticketRef).min(1).max(100);

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
			return reply({ quests }, quests.map(questLine).join('\n') || 'No Quests.');
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
				ownerId: args.owner === undefined ? actor.id : refs.userId(db, args.owner)
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
				ownerId: args.owner === undefined ? undefined : refs.userId(db, args.owner)
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
			return reply({ deleted: { id: quest.id, name: quest.name } }, `Deleted Quest ${quest.name}`);
		}
	);

	define(
		'add_quest_tickets',
		{
			kind: 'write',
			description:
				'Add Tickets to a Quest, in the order given, at the bottom unless a position is given. Membership is explicit: adding a Ticket never adds its Children; add them too if you want them. A Ticket can be in any number of Quests, but only once in each.',
			input: { quest: questRef, tickets: ticketList, ...placementShape }
		},
		(args, present) => {
			const questId = refs.questId(db, args.quest);
			const ticketIds = args.tickets.map((ref) => refs.ticketId(db, ref));
			const members = new Set(listQuestTickets(db, questId).map((t) => t.id));
			const already = ticketIds.filter((id, i) => members.has(id) || ticketIds.indexOf(id) < i);
			if (already.length > 0) {
				throw new DomainError('conflict', 'A Ticket is listed twice or already in the Quest');
			}
			let placement: Placement = refs.placement(db, args) ?? 'bottom';
			for (const id of ticketIds) {
				addQuestTicket(db, actor, questId, id, placement);
				placement = { after: id };
			}
			return questReply(present, questId);
		}
	);

	define(
		'remove_quest_tickets',
		{
			kind: 'write',
			description: 'Remove Tickets from a Quest. The Tickets themselves are untouched.',
			input: { quest: questRef, tickets: ticketList }
		},
		(args, present) => {
			const questId = refs.questId(db, args.quest);
			const ticketIds = args.tickets.map((ref) => refs.ticketId(db, ref));
			const members = new Set(listQuestTickets(db, questId).map((t) => t.id));
			if (ticketIds.some((id) => !members.has(id))) {
				throw new DomainError('not_found', 'A Ticket is not in the Quest');
			}
			for (const id of new Set(ticketIds)) removeQuestTicket(db, actor, questId, id);
			return questReply(present, questId);
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
			rankQuestTicket(db, actor, questId, ticketId, placement);
			return questReply(present, questId);
		}
	);
}
