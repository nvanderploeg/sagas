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

async function questReply(present: Presenter, questId: number) {
	const quest = await present.quest(await readQuest(present.db, questId));
	return reply({ quest }, questLine(quest));
}

async function changeReply(
	present: Presenter,
	change: QuestLaboursChange,
	verb: 'added' | 'removed',
	skippedBecause: string
) {
	const quest = await present.quest(change.quest);
	const keys = async (ids: number[]) =>
		await Promise.all(ids.map((id) => refs.labourKey(present.db, id)));
	const skipped = await keys(change.skipped);
	const note = skipped.length > 0 ? `, skipped ${skipped.length} ${skippedBecause}` : '';
	return reply(
		{ quest, [verb]: await keys(change.labourIds), skipped },
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
		async (_args, present) => {
			const visible = await visibleRealmIds(db, actor);
			const quests = await Promise.all(
				(await listQuests(db))
					.filter((q) => visible === null || visible.includes(q.realmId))
					.map((q) => present.questSummary(q))
			);
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
		async (args, present) => questReply(present, await refs.questId(db, args.quest, actor))
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
		async (args, present) => {
			const quest = await createQuest(db, actor, {
				realmId: await refs.realmId(db, args.realm, actor),
				name: args.name,
				description: args.description,
				ownerId: args.owner === undefined ? actor.id : await refs.userId(db, args.owner, actor)
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
		async (args, present) => {
			const questId = await refs.questId(db, args.quest, actor);
			await updateQuest(db, actor, questId, {
				name: args.name,
				description: args.description,
				ownerId: args.owner === undefined ? undefined : await refs.userId(db, args.owner, actor)
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
		async (args) => {
			const quest = await readQuest(db, await refs.questId(db, args.quest, actor));
			await deleteQuest(db, actor, quest.id);
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
		async (args, present) => {
			const questId = await refs.questId(db, args.quest, actor);
			const labourIds = await Promise.all(args.labours.map((ref) => refs.labourId(db, ref, actor)));
			const placement = await refs.placement(db, args, actor);
			const change = await addQuestLabours(db, actor, questId, labourIds, placement);
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
		async (args, present) => {
			const questId = await refs.questId(db, args.quest, actor);
			const labourIds = await Promise.all(args.labours.map((ref) => refs.labourId(db, ref, actor)));
			const change = await removeQuestLabours(db, actor, questId, labourIds);
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
		async (args, present) => {
			const questId = await refs.questId(db, args.quest, actor);
			const labourId = await refs.labourId(db, args.labour, actor);
			const placement = await refs.placement(db, args, actor);
			if (placement === undefined) {
				throw new DomainError('invalid', 'Give one of position, before or after');
			}
			if (!(await listQuestLabours(db, questId)).some((t) => t.id === labourId)) {
				throw new DomainError(
					'not_found',
					`${await refs.labourKey(db, labourId)} is not in Quest ${questId}`
				);
			}
			await rankQuestLabour(db, actor, questId, labourId, placement);
			return questReply(present, questId);
		}
	);
}
