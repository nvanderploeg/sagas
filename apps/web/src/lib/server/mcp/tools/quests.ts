import { visibleRealmIds } from '../../domain/access.ts';
import { z } from 'zod';
import { DomainError } from '../../domain/errors.ts';
import {
	addQuestLabours,
	createQuest,
	deleteQuest,
	listQuests,
	listQuestLabours,
	rankQuestLabour,
	readQuest,
	removeQuestLabours,
	updateQuest,
	type QuestLaboursChange
} from '../../domain/quests.ts';
import { count, questLine, type Presenter } from '../present.ts';
import * as refs from '../refs.ts';
import { reply } from '../result.ts';
import { placementShape, questRef, labourRef, realmRef, userRef, type Tools } from '../tool.ts';

function questReply(present: Presenter, questId: number) {
	const quest = present.quest(readQuest(present.db, questId));
	return reply({ quest }, questLine(quest));
}

function changeReply(
	present: Presenter,
	change: QuestLaboursChange,
	verb: 'added' | 'removed',
	skippedBecause: string
) {
	const quest = present.quest(change.quest);
	const keys = (ids: number[]) => ids.map((id) => refs.labourKey(present.db, id));
	const skipped = keys(change.skipped);
	const note = skipped.length > 0 ? `, skipped ${skipped.length} ${skippedBecause}` : '';
	return reply(
		{ quest, [verb]: keys(change.labourIds), skipped },
		`${questLine(quest)}; ${verb} ${count(change.labourIds.length, 'Labour')}${note}`
	);
}

const BULK_MAX = 100;

const labourList = z
	.array(labourRef)
	.min(1)
	.max(BULK_MAX)
	.describe(`1 to ${BULK_MAX} Labours; a Labour listed twice counts once`);

export function registerQuestTools({ db, actor, define }: Tools): void {
	define(
		'list_quests',
		{
			kind: 'read',
			description:
				'List the Quests in Realms you can see, with their Realm, Owner and progress: Closed Labours over all the Labours you can see in them.',
			input: {}
		},
		(_args, present) => {
			const visible = visibleRealmIds(db, actor);
			const quests = listQuests(db)
				.filter((q) => visible === null || visible.includes(q.realmId))
				.map((q) => present.questSummary(q));
			return reply({ quests }, quests.length === 0 ? 'No Quests' : count(quests.length, 'Quest'));
		}
	);

	define(
		'get_quest',
		{
			kind: 'read',
			description:
				'Get a Quest with its Labours in Quest order and its progress (Closed over total). A Quest has no State of its own.',
			input: { quest: questRef }
		},
		(args, present) => questReply(present, refs.questId(db, args.quest, actor))
	);

	define(
		'create_quest',
		{
			kind: 'write',
			description:
				'Create a Quest in a Realm: a named, ordered set of Labours that may come from any Realm you can see. The Realm decides who sees and edits the Quest. Owner defaults to you and must be a member of the Realm.',
			input: {
				realm: realmRef,
				name: z.string().describe('1 to 120 characters'),
				description: z.string().optional().describe('Markdown'),
				owner: userRef.optional()
			}
		},
		(args, present) => {
			const quest = createQuest(db, actor, {
				realmId: refs.realmId(db, args.realm, actor),
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
			description:
				"Change a Quest's name, description or Owner (a member of its Realm). Needs editor access to the Quest's Realm.",
			input: {
				quest: questRef,
				name: z.string().optional(),
				description: z.string().optional().describe('Markdown; replaces the whole description'),
				owner: userRef.optional()
			}
		},
		(args, present) => {
			const questId = refs.questId(db, args.quest, actor);
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
			description: 'Delete a Quest. Its Labours are untouched.',
			input: { quest: questRef }
		},
		(args) => {
			const quest = readQuest(db, refs.questId(db, args.quest, actor));
			deleteQuest(db, actor, quest.id);
			return reply(
				{ deleted: { id: quest.id, name: quest.name } },
				`Deleted Quest ${quest.id} ${quest.name}`
			);
		}
	);

	define(
		'add_quest_labours',
		{
			kind: 'write',
			description:
				'Add Labours to a Quest in one write, in the order given, at the bottom unless a position is given. Labours already in the Quest are skipped and listed in `skipped`, so repeating a call is safe. Membership is explicit: adding a Labour never adds its Children; list them too if you want them. An unknown Labour fails the whole call.',
			input: { quest: questRef, labours: labourList, ...placementShape }
		},
		(args, present) => {
			const questId = refs.questId(db, args.quest, actor);
			const labourIds = args.labours.map((ref) => refs.labourId(db, ref, actor));
			const placement = refs.placement(db, args, actor);
			const change = addQuestLabours(db, actor, questId, labourIds, placement);
			return changeReply(present, change, 'added', 'already in it');
		}
	);

	define(
		'remove_quest_labours',
		{
			kind: 'write',
			description:
				'Remove Labours from a Quest in one write. Labours not in the Quest are skipped and listed in `skipped`, so repeating a call is safe. The Labours themselves are untouched. An unknown Labour fails the whole call.',
			input: { quest: questRef, labours: labourList }
		},
		(args, present) => {
			const questId = refs.questId(db, args.quest, actor);
			const labourIds = args.labours.map((ref) => refs.labourId(db, ref, actor));
			const change = removeQuestLabours(db, actor, questId, labourIds);
			return changeReply(present, change, 'removed', 'not in it');
		}
	);

	define(
		'rank_quest_labour',
		{
			kind: 'write',
			description:
				"Reorder a Labour within a Quest. Give exactly one of position, before or after; before and after name another member. Quest order is separate from the Labour's Rank on its board.",
			input: { quest: questRef, labour: labourRef, ...placementShape }
		},
		(args, present) => {
			const questId = refs.questId(db, args.quest, actor);
			const labourId = refs.labourId(db, args.labour, actor);
			const placement = refs.placement(db, args, actor);
			if (placement === undefined) {
				throw new DomainError('invalid', 'Give one of position, before or after');
			}
			if (!listQuestLabours(db, questId).some((t) => t.id === labourId)) {
				throw new DomainError(
					'not_found',
					`${refs.labourKey(db, labourId)} is not in Quest ${questId}`
				);
			}
			rankQuestLabour(db, actor, questId, labourId, placement);
			return questReply(present, questId);
		}
	);
}
