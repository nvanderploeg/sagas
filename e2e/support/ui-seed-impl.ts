import type { Db } from '../../apps/web/src/lib/server/db/client.ts';
import { acceptInvite, createInvite } from '../../apps/web/src/lib/server/auth/invites.ts';
import { createAgentUser, findUser } from '../../apps/web/src/lib/server/auth/users.ts';
import { appraise, type AppraiseItem } from '../../apps/web/src/lib/server/agent/appraisals.ts';
import {
	defineAttribute,
	setValues,
	tuneRealm,
	type AttributeInput
} from '../../apps/web/src/lib/server/agent/attributes.ts';
import { contentHash } from '../../apps/web/src/lib/server/agent/content.ts';
import { postPulses, type PulseInput } from '../../apps/web/src/lib/server/agent/sentiment.ts';
import {
	defineSkill,
	setSkills,
	type SkillInput
} from '../../apps/web/src/lib/server/agent/skills.ts';
import { pulses } from '../../apps/web/src/lib/server/db/schema.ts';
import { addComment } from '../../apps/web/src/lib/server/domain/comments.ts';
import { createRealm, readRealm } from '../../apps/web/src/lib/server/domain/realms.ts';
import {
	addQuestLabour,
	createQuest,
	readQuest
} from '../../apps/web/src/lib/server/domain/quests.ts';
import { createState, createSubstate } from '../../apps/web/src/lib/server/domain/states.ts';
import {
	createLabour,
	readLabour,
	updateLabour
} from '../../apps/web/src/lib/server/domain/labours.ts';

let counter = 0;

// A Realm key no other spec has used in this run.
export function freshKey(prefix = 'U'): string {
	counter += 1;
	const tail = (Date.now().toString(36) + counter.toString(36)).toUpperCase().slice(-5);
	return `${prefix}${tail}`.slice(0, 6);
}

// Writes go straight to the run's DB with the given User as actor; a running page sees them only
// after a reload, never live.
export function createUiSeed(db: Db, actorId: number) {
	const actor = findUser(db, actorId);
	if (!actor) throw new Error(`no user ${actorId} in the run database`);

	const self = {
		// A Realm with To do, In progress and Closed.
		realm(input: { key?: string; name?: string } = {}) {
			const key = input.key ?? freshKey();
			const realm = createRealm(db, actor, {
				name: input.name ?? `Board ${key}`,
				key,
				initialState: { key: 'todo', label: 'To do', color: '#94a3b8', icon: 'circle' }
			});
			const doing = createState(db, actor, realm.id, {
				key: 'doing',
				label: 'In progress',
				color: '#eab308',
				icon: 'half'
			});
			const view = readRealm(db, realm.id);
			const closed = view.states.find((s) => s.isClosed)!;
			return {
				id: realm.id,
				key: realm.key,
				name: view.name,
				todo: realm.initialStateId!,
				doing: doing.id,
				closed: closed.id
			};
		},

		labour(
			realmId: number,
			input: {
				title?: string;
				stateId?: number;
				parentId?: number | null;
				assigneeId?: number | null;
				description?: string;
			} = {}
		) {
			return createLabour(db, actor, {
				realmId,
				title: input.title ?? 'Labour',
				ownerId: actor.id,
				stateId: input.stateId,
				parentId: input.parentId ?? null,
				assigneeId: input.assigneeId ?? null,
				description: input.description
			});
		},

		substate(stateId: number, label: string, color = '#a855f7') {
			const key = label.toLowerCase().replace(/[^a-z0-9]+/g, '-');
			return createSubstate(db, actor, stateId, { key, label, color, icon: 'eye' });
		},

		close(labourId: number, closedStateId: number) {
			return updateLabour(db, actor, labourId, { stateId: closedStateId });
		},

		quest(name = 'Quest', description = '') {
			return createQuest(db, actor, { name, description, ownerId: actor.id });
		},

		addToQuest(questId: number, labourId: number) {
			return addQuestLabour(db, actor, questId, labourId);
		},

		comment: (labourId: number, body: string) => addComment(db, actor, labourId, body),

		attribute: (realmId: number, input: AttributeInput) =>
			defineAttribute(db, actor, realmId, input).attribute,
		tune: (realmId: number, input: { notes?: string; halfLifeDays?: number; loudness?: number }) =>
			tuneRealm(db, actor, realmId, input),
		values: (labourId: number, values: Record<string, unknown>) =>
			setValues(db, actor, labourId, values),
		appraise: (items: AppraiseItem[]) => appraise(db, actor, items),
		appraiseAs: (userId: number, items: AppraiseItem[]) =>
			appraise(db, findUser(db, userId)!, items),
		contentHash: (labourId: number) => contentHash(db, labourId),
		skill: (input: SkillInput) => defineSkill(db, actor, input),
		skills: (userId: number, levels: Record<string, number | null>) =>
			setSkills(db, actor, userId, levels),
		pulses: (realmId: number, items: PulseInput[]) => postPulses(db, actor, realmId, items),

		// `member` is null for a scale Attribute.
		affinity(userId: number, attributeId: number, member: string | null, rawKey: string) {
			db.insert(pulses)
				.values({
					userId,
					attributeId,
					member,
					rawKey,
					amount: 2,
					mood: 1,
					halfLifeDays: null,
					note: 'seeded',
					authorId: actor.id
				})
				.run();
		},

		readQuest: (questId: number) => readQuest(db, questId),
		readLabour: (labourId: number) => readLabour(db, labourId),

		agent(username: string, displayName: string) {
			return createAgentUser(db, actor, { username, displayName });
		},

		// A second human, signed up through an Invite.
		async human(username: string, displayName: string, password: string) {
			const { token } = createInvite(db, actor);
			return acceptInvite(db, token, { username, displayName, password });
		}
	};
	return self;
}

export type UiSeed = ReturnType<typeof createUiSeed>;
