import type { Db } from '../../apps/web/src/lib/server/db/client.ts';
import { acceptInvite, createInvite } from '../../apps/web/src/lib/server/auth/invites.ts';
import { createAgentUser, findUser } from '../../apps/web/src/lib/server/auth/users.ts';
import { createProject, readProject } from '../../apps/web/src/lib/server/domain/projects.ts';
import {
	addQuestTicket,
	createQuest,
	readQuest
} from '../../apps/web/src/lib/server/domain/quests.ts';
import { createState, createSubstate } from '../../apps/web/src/lib/server/domain/states.ts';
import {
	createTicket,
	readTicket,
	updateTicket
} from '../../apps/web/src/lib/server/domain/tickets.ts';

let counter = 0;

// A Project key no other spec has used in this run.
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
		// A Project with To do, In progress and Closed.
		project(input: { key?: string; name?: string } = {}) {
			const key = input.key ?? freshKey();
			const project = createProject(db, actor, {
				name: input.name ?? `Board ${key}`,
				key,
				initialState: { key: 'todo', label: 'To do', color: '#94a3b8', icon: 'circle' }
			});
			const doing = createState(db, actor, project.id, {
				key: 'doing',
				label: 'In progress',
				color: '#eab308',
				icon: 'half'
			});
			const view = readProject(db, project.id);
			const closed = view.states.find((s) => s.isClosed)!;
			return {
				id: project.id,
				key: project.key,
				name: view.name,
				todo: project.initialStateId!,
				doing: doing.id,
				closed: closed.id
			};
		},

		ticket(
			projectId: number,
			input: {
				title?: string;
				stateId?: number;
				parentId?: number | null;
				assigneeId?: number | null;
				description?: string;
			} = {}
		) {
			return createTicket(db, actor, {
				projectId,
				title: input.title ?? 'Ticket',
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

		close(ticketId: number, closedStateId: number) {
			return updateTicket(db, actor, ticketId, { stateId: closedStateId });
		},

		quest(name = 'Quest', description = '') {
			return createQuest(db, actor, { name, description, ownerId: actor.id });
		},

		addToQuest(questId: number, ticketId: number) {
			return addQuestTicket(db, actor, questId, ticketId);
		},

		readQuest: (questId: number) => readQuest(db, questId),
		readTicket: (ticketId: number) => readTicket(db, ticketId),

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
