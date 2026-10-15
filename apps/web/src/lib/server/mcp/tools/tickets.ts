import { z } from 'zod';
import { DomainError } from '../../domain/errors.ts';
import { getProject, getTicket } from '../../domain/lookup.ts';
import { listStates } from '../../domain/states.ts';
import { queryTickets } from '../../domain/ticket-query.ts';
import {
	createTicket,
	deleteTicket,
	moveTicket,
	rankTicket,
	readTicket,
	setParent,
	updateTicket
} from '../../domain/tickets.ts';
import { count, ticketLine, type Presenter } from '../present.ts';
import * as refs from '../refs.ts';
import { reply } from '../result.ts';
import {
	pageShape,
	placementShape,
	projectRef,
	questRef,
	stateRef,
	substateRef,
	ticketRef,
	userRef,
	type Tools
} from '../tool.ts';

function pageLine(total: number, offset: number, end: number, next: number | null): string {
	if (total === 0) return 'No Tickets match';
	if (offset >= total) return `No Tickets at offset ${offset}; ${count(total, 'Ticket')} match`;
	const more = next === null ? '' : `; next offset ${next}`;
	return `Tickets ${offset + 1}-${end} of ${total}${more}`;
}

function ticketReply(present: Presenter, ticketId: number) {
	const ticket = present.detail(readTicket(present.db, ticketId));
	return reply({ ticket }, ticketLine(ticket));
}

export function registerTicketTools({ db, actor, define }: Tools): void {
	define(
		'resolve',
		{
			kind: 'read',
			description:
				'Find the Ticket a Ticket key names. Keys are accepted in any case, and a former key (an Alias left by a move or a Project key rename) resolves forever to the same Ticket. Returns the Ticket with its current key.',
			input: { ticket: ticketRef }
		},
		(args, present) => {
			const ticket = present.ticket(readTicket(db, refs.ticketId(db, args.ticket)));
			const given = typeof args.ticket === 'string' ? args.ticket.toUpperCase() : ticket.key;
			const alias = given !== ticket.key;
			const note = alias ? `${given} is an Alias of ` : '';
			return reply({ ticket, alias }, note + ticketLine(ticket));
		}
	);

	define(
		'list_tickets',
		{
			kind: 'read',
			description:
				'List Tickets, filtered by any combination of the inputs. Ordered by Project, then board column (State order), then Rank within the column, top first; with `quest`, in Quest order instead. Paginate with limit and offset.',
			input: {
				project: projectRef.optional(),
				state: stateRef.optional().describe('State key (needs `project`) or id'),
				substate: substateRef.optional().describe('Substate key (needs `state`) or id'),
				owner: userRef.optional(),
				assignee: userRef.nullable().optional().describe('As owner; null for unassigned'),
				closed: z.boolean().optional().describe('true: only Closed Tickets; false: only open'),
				quest: questRef.optional().describe('Only members of this Quest, by Quest id'),
				parent: ticketRef
					.nullable()
					.optional()
					.describe('Only Children of this Ticket; null for Tickets with no Parent'),
				...pageShape
			}
		},
		(args, present) => {
			const projectId = args.project === undefined ? undefined : refs.projectId(db, args.project);
			const stateId =
				args.state === undefined ? undefined : refs.stateId(db, projectId, args.state);
			const page = queryTickets(
				db,
				{
					projectId,
					stateId,
					substateId:
						args.substate === undefined ? undefined : refs.substateId(db, stateId, args.substate),
					ownerId: args.owner === undefined ? undefined : refs.userId(db, args.owner, actor),
					assigneeId:
						args.assignee == null
							? (args.assignee as null | undefined)
							: refs.userId(db, args.assignee, actor),
					parentId:
						args.parent == null
							? (args.parent as null | undefined)
							: refs.ticketId(db, args.parent),
					closed: args.closed,
					questId: args.quest === undefined ? undefined : refs.questId(db, args.quest)
				},
				{ offset: args.offset, limit: args.limit }
			);
			const tickets = page.tickets.map((t) => present.ticket(t));
			const end = args.offset + tickets.length;
			const nextOffset = end < page.total ? end : null;
			return reply(
				{ tickets, total: page.total, offset: args.offset, nextOffset },
				pageLine(page.total, args.offset, end, nextOffset)
			);
		}
	);

	define(
		'get_ticket',
		{
			kind: 'read',
			description:
				'Get one Ticket with its description, former keys (aliases), Parent, Children and the Quests it is in.',
			input: { ticket: ticketRef }
		},
		({ ticket }, present) => ticketReply(present, refs.ticketId(db, ticket))
	);

	define(
		'create_ticket',
		{
			kind: 'write',
			description:
				"Create a Ticket in a Project. It lands in the Project's Initial State unless `state` is given, in the State's default Substate unless `substate` is given, and at the bottom of the column unless a position is given. Owner defaults to you.",
			input: {
				project: projectRef,
				title: z.string().describe('1 to 200 characters'),
				description: z.string().optional().describe('Markdown'),
				owner: userRef
					.optional()
					.describe('Accountable User: username, "me" or id; defaults to you'),
				assignee: userRef.optional().describe('User who takes the next step: username, "me" or id'),
				state: stateRef.optional(),
				substate: substateRef.optional(),
				parent: ticketRef.optional().describe('Parent Ticket, in any Project'),
				...placementShape
			}
		},
		(args, present) => {
			const projectId = refs.projectId(db, args.project);
			const stateId =
				args.state === undefined ? undefined : refs.stateId(db, projectId, args.state);
			const created = createTicket(db, actor, {
				projectId,
				title: args.title,
				description: args.description,
				ownerId: args.owner === undefined ? actor.id : refs.userId(db, args.owner, actor),
				assigneeId: args.assignee === undefined ? null : refs.userId(db, args.assignee, actor),
				stateId,
				substateId:
					args.substate === undefined
						? undefined
						: refs.substateId(
								db,
								stateId ?? getProject(db, projectId).initialStateId ?? undefined,
								args.substate
							),
				parentId: args.parent === undefined ? null : refs.ticketId(db, args.parent),
				placement: refs.placement(db, args)
			});
			return ticketReply(present, created.id);
		}
	);

	define(
		'update_ticket',
		{
			kind: 'write',
			description:
				'Change a Ticket\'s fields, State or Substate within its Project. Close a Ticket by setting `state` to "closed"; a Ticket is finished exactly when it is in Closed. Changing State puts it at the bottom of the new column unless a position is given. When the target State has Substates the Ticket always sits in one, its default unless `substate` is given. Use move_ticket to change Project, set_parent for the Parent, rank_ticket to reorder only.',
			input: {
				ticket: ticketRef,
				title: z.string().optional(),
				description: z.string().optional().describe('Markdown; replaces the whole description'),
				owner: userRef.optional(),
				assignee: userRef.nullable().optional().describe('Username, "me" or id; null clears it'),
				state: stateRef.optional(),
				substate: substateRef
					.nullable()
					.optional()
					.describe("null puts the Ticket in the State's default Substate"),
				...placementShape
			}
		},
		(args, present) => {
			const ticketId = refs.ticketId(db, args.ticket);
			const current = getTicket(db, ticketId);
			const stateId =
				args.state === undefined ? undefined : refs.stateId(db, current.projectId, args.state);
			updateTicket(db, actor, ticketId, {
				title: args.title,
				description: args.description,
				ownerId: args.owner === undefined ? undefined : refs.userId(db, args.owner, actor),
				assigneeId:
					args.assignee == null
						? (args.assignee as null | undefined)
						: refs.userId(db, args.assignee, actor),
				stateId,
				substateId:
					args.substate == null
						? (args.substate as null | undefined)
						: refs.substateId(db, stateId ?? current.stateId, args.substate),
				placement: refs.placement(db, args)
			});
			return ticketReply(present, ticketId);
		}
	);

	define(
		'move_ticket',
		{
			kind: 'write',
			description:
				"Move a Ticket to another Project. It gets a new Ticket key there and its old key stays an Alias that still resolves. It lands in `state`, or the target's Initial State; a Closed Ticket always lands in the target's Closed and stays Closed. Its Parent and Children stay where they are.",
			input: {
				ticket: ticketRef,
				project: projectRef.describe('Target Project key or id'),
				state: stateRef.optional().describe('State key in the target Project, or id'),
				substate: substateRef.optional(),
				...placementShape
			}
		},
		(args, present) => {
			const ticketId = refs.ticketId(db, args.ticket);
			const projectId = refs.projectId(db, args.project);
			const stateId =
				args.state === undefined ? undefined : refs.stateId(db, projectId, args.state);
			const landing = () => {
				if (readTicket(db, ticketId).closed) {
					return listStates(db, projectId).find((s) => s.isClosed)?.id;
				}
				return getProject(db, projectId).initialStateId ?? undefined;
			};
			moveTicket(db, actor, ticketId, {
				projectId,
				stateId,
				substateId:
					args.substate === undefined
						? undefined
						: refs.substateId(db, stateId ?? landing(), args.substate),
				placement: refs.placement(db, args)
			});
			return ticketReply(present, ticketId);
		}
	);

	define(
		'rank_ticket',
		{
			kind: 'write',
			description:
				"Set a Ticket's Rank: its position within its State's board column. Top is next. There is no priority field; Rank is the order of work. Give exactly one of position, before or after; before and after name a Ticket in the same column.",
			input: { ticket: ticketRef, ...placementShape }
		},
		(args, present) => {
			const ticketId = refs.ticketId(db, args.ticket);
			const placement = refs.placement(db, args);
			if (placement === undefined) {
				throw new DomainError('invalid', 'Give one of position, before or after');
			}
			rankTicket(db, actor, ticketId, placement);
			return ticketReply(present, ticketId);
		}
	);

	define(
		'set_parent',
		{
			kind: 'write',
			description:
				'Set or clear the Parent of a Ticket. A Ticket has at most one Parent, possibly in another Project, and the Parent chain never loops.',
			input: {
				ticket: ticketRef,
				parent: ticketRef.nullable().describe('The new Parent, or null to clear it')
			}
		},
		(args, present) => {
			const ticketId = refs.ticketId(db, args.ticket);
			setParent(db, actor, ticketId, args.parent === null ? null : refs.ticketId(db, args.parent));
			return ticketReply(present, ticketId);
		}
	);

	define(
		'delete_ticket',
		{
			kind: 'destroy',
			description:
				'Delete a Ticket for good. Its Children lose their Parent and it leaves every Quest. Its number is never reused.',
			input: { ticket: ticketRef }
		},
		(args) => {
			const ticket = readTicket(db, refs.ticketId(db, args.ticket));
			deleteTicket(db, actor, ticket.id);
			return reply({ deleted: { id: ticket.id, key: ticket.key } }, `Deleted ${ticket.key}`);
		}
	);
}
