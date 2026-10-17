import { z } from 'zod';
import { DomainError } from '../../domain/errors.ts';
import { getRealm, getLabour } from '../../domain/lookup.ts';
import { listStates } from '../../domain/states.ts';
import { addComment, deleteComment, editComment, listComments } from '../../domain/comments.ts';
import { normalizeLabels } from '../../domain/labels.ts';
import { queryLabours } from '../../domain/labour-query.ts';
import {
	createLabour,
	deleteLabour,
	moveLabour,
	rankLabour,
	readLabour,
	setParent,
	updateLabour
} from '../../domain/labours.ts';
import { count, labourLine, type Presenter } from '../present.ts';
import * as refs from '../refs.ts';
import { reply } from '../result.ts';
import {
	pageShape,
	placementShape,
	realmRef,
	questRef,
	stateRef,
	substateRef,
	labourRef,
	userRef,
	type Tools
} from '../tool.ts';

const LABELS_HELP =
	'Labels: lowercase letters, digits and : . _ - (1 to 40 characters, e.g. "wayfinder:map"), at most 20 per Labour';
const labelsShape = z.array(z.string()).optional().describe(LABELS_HELP);

function pageLine(total: number, offset: number, end: number, next: number | null): string {
	if (total === 0) return 'No Labours match';
	if (offset >= total) return `No Labours at offset ${offset}; ${count(total, 'Labour')} match`;
	const more = next === null ? '' : `; next offset ${next}`;
	return `Labours ${offset + 1}-${end} of ${total}${more}`;
}

function labourReply(present: Presenter, labourId: number) {
	const labour = present.detail(readLabour(present.db, labourId));
	return reply({ labour }, labourLine(labour));
}

export function registerLabourTools({ db, actor, define }: Tools): void {
	define(
		'resolve',
		{
			kind: 'read',
			description:
				'Find the Labour a Labour key names. Keys are accepted in any case, and a former key (an Alias left by a move or a Realm key rename) resolves forever to the same Labour. Returns the Labour with its current key.',
			input: { labour: labourRef }
		},
		(args, present) => {
			const labour = present.labour(readLabour(db, refs.labourId(db, args.labour)));
			const given = typeof args.labour === 'string' ? args.labour.toUpperCase() : labour.key;
			const alias = given !== labour.key;
			const note = alias ? `${given} is an Alias of ` : '';
			return reply({ labour, alias }, note + labourLine(labour));
		}
	);

	define(
		'list_labours',
		{
			kind: 'read',
			description:
				'List Labours, filtered by any combination of the inputs. Ordered by Realm, then board column (State order), then Rank within the column, top first; with `quest`, in Quest order instead. Paginate with limit and offset.',
			input: {
				realm: realmRef.optional(),
				state: stateRef.optional().describe('State key (needs `realm`) or id'),
				substate: substateRef.optional().describe('Substate key (needs `state`) or id'),
				owner: userRef.optional(),
				assignee: userRef.nullable().optional().describe('As owner; null for unassigned'),
				closed: z.boolean().optional().describe('true: only Closed Labours; false: only open'),
				quest: questRef.optional().describe('Only members of this Quest, by Quest id'),
				parent: labourRef
					.nullable()
					.optional()
					.describe('Only Children of this Labour; null for Labours with no Parent'),
				labels: z
					.array(z.string())
					.optional()
					.describe('Only Labours carrying every one of these Labels'),
				...pageShape
			}
		},
		(args, present) => {
			const realmId = args.realm === undefined ? undefined : refs.realmId(db, args.realm);
			const stateId = args.state === undefined ? undefined : refs.stateId(db, realmId, args.state);
			const page = queryLabours(
				db,
				{
					realmId,
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
							: refs.labourId(db, args.parent),
					closed: args.closed,
					labels: args.labels === undefined ? undefined : normalizeLabels(args.labels),
					questId: args.quest === undefined ? undefined : refs.questId(db, args.quest)
				},
				{ offset: args.offset, limit: args.limit }
			);
			const labours = present.labours(page.labours);
			const end = args.offset + labours.length;
			const nextOffset = end < page.total ? end : null;
			return reply(
				{ labours, total: page.total, offset: args.offset, nextOffset },
				pageLine(page.total, args.offset, end, nextOffset)
			);
		}
	);

	define(
		'get_labour',
		{
			kind: 'read',
			description:
				'Get one Labour with its description, Labels, former keys (aliases), Parent, Children and the Quests it is in.',
			input: { labour: labourRef }
		},
		({ labour }, present) => labourReply(present, refs.labourId(db, labour))
	);

	define(
		'create_labour',
		{
			kind: 'write',
			description:
				"Create a Labour in a Realm. It lands in the Realm's Initial State unless `state` is given, in the State's default Substate unless `substate` is given, and at the bottom of the column unless a position is given. Owner defaults to you.",
			input: {
				realm: realmRef,
				title: z.string().describe('1 to 200 characters'),
				description: z.string().optional().describe('Markdown'),
				owner: userRef
					.optional()
					.describe('Accountable User: username, "me" or id; defaults to you'),
				assignee: userRef.optional().describe('User who takes the next step: username, "me" or id'),
				state: stateRef.optional(),
				substate: substateRef.optional(),
				parent: labourRef.optional().describe('Parent Labour, in any Realm'),
				labels: labelsShape,
				...placementShape
			}
		},
		(args, present) => {
			const realmId = refs.realmId(db, args.realm);
			const stateId = args.state === undefined ? undefined : refs.stateId(db, realmId, args.state);
			const created = createLabour(db, actor, {
				realmId,
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
								stateId ?? getRealm(db, realmId).initialStateId ?? undefined,
								args.substate
							),
				parentId: args.parent === undefined ? null : refs.labourId(db, args.parent),
				labels: args.labels,
				placement: refs.placement(db, args)
			});
			return labourReply(present, created.id);
		}
	);

	define(
		'update_labour',
		{
			kind: 'write',
			description:
				'Change a Labour\'s fields, State or Substate within its Realm. Close a Labour by setting `state` to "closed"; a Labour is finished exactly when it is in Closed. Changing State puts it at the bottom of the new column unless a position is given. When the target State has Substates the Labour always sits in one, its default unless `substate` is given. Use move_labour to change Realm, set_parent for the Parent, rank_labour to reorder only.',
			input: {
				labour: labourRef,
				title: z.string().optional(),
				description: z.string().optional().describe('Markdown; replaces the whole description'),
				owner: userRef.optional(),
				assignee: userRef.nullable().optional().describe('Username, "me" or id; null clears it'),
				state: stateRef.optional(),
				substate: substateRef
					.nullable()
					.optional()
					.describe("null puts the Labour in the State's default Substate"),
				labels: labelsShape.describe(`${LABELS_HELP}; replaces the whole set`),
				add_labels: z.array(z.string()).optional().describe('Labels to add to the set'),
				remove_labels: z.array(z.string()).optional().describe('Labels to take off the set'),
				...placementShape
			}
		},
		(args, present) => {
			const labourId = refs.labourId(db, args.labour);
			const current = getLabour(db, labourId);
			const stateId =
				args.state === undefined ? undefined : refs.stateId(db, current.realmId, args.state);
			updateLabour(db, actor, labourId, {
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
				labels: args.labels,
				addLabels: args.add_labels,
				removeLabels: args.remove_labels,
				placement: refs.placement(db, args)
			});
			return labourReply(present, labourId);
		}
	);

	define(
		'move_labour',
		{
			kind: 'write',
			description:
				"Move a Labour to another Realm. It gets a new Labour key there and its old key stays an Alias that still resolves. It lands in `state`, or the target's Initial State; a Closed Labour always lands in the target's Closed and stays Closed. Its Parent and Children stay where they are.",
			input: {
				labour: labourRef,
				realm: realmRef.describe('Target Realm key or id'),
				state: stateRef.optional().describe('State key in the target Realm, or id'),
				substate: substateRef.optional(),
				...placementShape
			}
		},
		(args, present) => {
			const labourId = refs.labourId(db, args.labour);
			const realmId = refs.realmId(db, args.realm);
			const stateId = args.state === undefined ? undefined : refs.stateId(db, realmId, args.state);
			const landing = () => {
				if (readLabour(db, labourId).closed) {
					return listStates(db, realmId).find((s) => s.isClosed)?.id;
				}
				return getRealm(db, realmId).initialStateId ?? undefined;
			};
			moveLabour(db, actor, labourId, {
				realmId,
				stateId,
				substateId:
					args.substate === undefined
						? undefined
						: refs.substateId(db, stateId ?? landing(), args.substate),
				placement: refs.placement(db, args)
			});
			return labourReply(present, labourId);
		}
	);

	define(
		'rank_labour',
		{
			kind: 'write',
			description:
				"Set a Labour's Rank: its position within its State's board column, top first, as people order the board. Give exactly one of position, before or after; before and after name a Labour in the same column.",
			input: { labour: labourRef, ...placementShape }
		},
		(args, present) => {
			const labourId = refs.labourId(db, args.labour);
			const placement = refs.placement(db, args);
			if (placement === undefined) {
				throw new DomainError('invalid', 'Give one of position, before or after');
			}
			rankLabour(db, actor, labourId, placement);
			return labourReply(present, labourId);
		}
	);

	define(
		'set_parent',
		{
			kind: 'write',
			description:
				'Set or clear the Parent of a Labour. A Labour has at most one Parent, possibly in another Realm, and the Parent chain never loops.',
			input: {
				labour: labourRef,
				parent: labourRef.nullable().describe('The new Parent, or null to clear it')
			}
		},
		(args, present) => {
			const labourId = refs.labourId(db, args.labour);
			setParent(db, actor, labourId, args.parent === null ? null : refs.labourId(db, args.parent));
			return labourReply(present, labourId);
		}
	);

	define(
		'add_comment',
		{
			kind: 'write',
			description:
				'Add a Comment to a Labour, as you. Only the author can edit or delete one with update_comment and delete_comment, and they go when the Labour does. Use one to record why a Labour was resolved before you close it.',
			input: { labour: labourRef, body: z.string().describe('Markdown, 1 to 20000 characters') }
		},
		(args, present) => {
			const labourId = refs.labourId(db, args.labour);
			const comment = present.comment(addComment(db, actor, labourId, args.body));
			return reply({ comment }, `Commented on ${comment.labour} as ${comment.author}`);
		}
	);

	define(
		'update_comment',
		{
			kind: 'write',
			description:
				'Replace the body of a Comment you wrote. Only its author can edit it. Find ids with list_comments.',
			input: {
				comment: z.number().int().describe('Comment id'),
				body: z.string().describe('Markdown, 1 to 20000 characters')
			}
		},
		(args, present) => {
			const comment = present.comment(editComment(db, actor, args.comment, args.body));
			return reply({ comment }, `Edited Comment ${comment.id} on ${comment.labour}`);
		}
	);

	define(
		'delete_comment',
		{
			kind: 'destroy',
			description: 'Delete a Comment you wrote for good. Only its author can delete it.',
			input: { comment: z.number().int().describe('Comment id') }
		},
		(args, present) => {
			const comment = present.comment(deleteComment(db, actor, args.comment));
			return reply(
				{ deleted: { id: comment.id, labour: comment.labour } },
				`Deleted Comment ${comment.id} on ${comment.labour}`
			);
		}
	);

	define(
		'list_comments',
		{
			kind: 'read',
			description: "List a Labour's Comments, oldest first, each with its author and time.",
			input: { labour: labourRef }
		},
		(args, present) => {
			const labour = readLabour(db, refs.labourId(db, args.labour));
			const comments = listComments(db, labour.id).map((c) => present.comment(c));
			return reply({ comments }, `${labour.key}: ${count(comments.length, 'Comment')}`);
		}
	);

	define(
		'delete_labour',
		{
			kind: 'destroy',
			description:
				'Delete a Labour for good. Its Children lose their Parent and it leaves every Quest. Its number is never reused.',
			input: { labour: labourRef }
		},
		(args) => {
			const labour = readLabour(db, refs.labourId(db, args.labour));
			deleteLabour(db, actor, labour.id);
			return reply({ deleted: { id: labour.id, key: labour.key } }, `Deleted ${labour.key}`);
		}
	);
}
