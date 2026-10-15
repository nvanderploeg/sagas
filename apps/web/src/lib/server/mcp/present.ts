import { asc, eq } from 'drizzle-orm';
import type { Handle } from '../db/client.ts';
import { projectKeys, ticketKeys, users } from '../db/schema.ts';
import { getProject, getState, getSubstate } from '../domain/lookup.ts';
import { readProject } from '../domain/project-view.ts';
import { questProgress, type QuestProgress, type QuestView } from '../domain/quest-view.ts';
import { listTicketQuests } from '../domain/quests.ts';
import { readTicket, type TicketView } from '../domain/ticket-view.ts';
import { listChildren } from '../domain/tickets.ts';
import type { AuthUser } from '../auth/users.ts';

export type Label = { key: string; label: string };

export type TicketSummary = {
	id: number;
	key: string;
	title: string;
	project: string;
	state: Label;
	substate: Label | null;
	closed: boolean;
	owner: string;
	assignee: string | null;
	parent: string | null;
};

export type TicketDetail = TicketSummary & {
	description: string;
	aliases: string[];
	createdAt: string;
	updatedAt: string;
	parentTicket: TicketSummary | null;
	children: TicketSummary[];
	quests: { id: number; name: string; progress: QuestProgress }[];
};

// Use one Presenter per tool call: its memo goes stale after a write.
export class Presenter {
	readonly db: Handle;
	private readonly memo = new Map<string, unknown>();

	constructor(db: Handle) {
		this.db = db;
	}

	private once<T>(key: string, read: () => T): T {
		if (!this.memo.has(key)) this.memo.set(key, read());
		return this.memo.get(key) as T;
	}

	username(id: number): string {
		return this.once(`user:${id}`, () => {
			const row = this.db
				.select({ username: users.username })
				.from(users)
				.where(eq(users.id, id))
				.get();
			return row?.username ?? `#${id}`;
		});
	}

	private state(id: number): Label {
		return this.once(`state:${id}`, () => {
			const { key, label } = getState(this.db, id);
			return { key, label };
		});
	}

	private substate(id: number): Label {
		return this.once(`substate:${id}`, () => {
			const { key, label } = getSubstate(this.db, id);
			return { key, label };
		});
	}

	private projectKey(id: number): string {
		return this.once(`project:${id}`, () => getProject(this.db, id).key);
	}

	private ticketKey(id: number): string {
		return this.once(`ticket:${id}`, () => readTicket(this.db, id).key);
	}

	ticket(view: TicketView): TicketSummary {
		return {
			id: view.id,
			key: view.key,
			title: view.title,
			project: this.projectKey(view.projectId),
			state: this.state(view.stateId),
			substate: view.substateId === null ? null : this.substate(view.substateId),
			closed: view.closed,
			owner: this.username(view.ownerId),
			assignee: view.assigneeId === null ? null : this.username(view.assigneeId),
			parent: view.parentId === null ? null : this.ticketKey(view.parentId)
		};
	}

	detail(view: TicketView): TicketDetail {
		return {
			...this.ticket(view),
			description: view.description,
			aliases: this.aliases(view),
			createdAt: view.createdAt.toISOString(),
			updatedAt: view.updatedAt.toISOString(),
			parentTicket: view.parentId === null ? null : this.ticket(readTicket(this.db, view.parentId)),
			children: listChildren(this.db, view.id).map((child) => this.ticket(child)),
			quests: listTicketQuests(this.db, view.id).map((quest) => ({
				id: quest.id,
				name: quest.name,
				progress: questProgress(this.db, quest.id)
			}))
		};
	}

	aliases(view: TicketView): string[] {
		return this.db
			.select({ key: ticketKeys.key })
			.from(ticketKeys)
			.where(eq(ticketKeys.ticketId, view.id))
			.orderBy(asc(ticketKeys.createdAt), asc(ticketKeys.key))
			.all()
			.map((row) => row.key)
			.filter((key) => key !== view.key);
	}

	project(projectId: number) {
		const view = readProject(this.db, projectId);
		const formerKeys = this.db
			.select({ key: projectKeys.key })
			.from(projectKeys)
			.where(eq(projectKeys.projectId, projectId))
			.orderBy(asc(projectKeys.createdAt), asc(projectKeys.key))
			.all()
			.map((row) => row.key)
			.filter((key) => key !== view.key);
		const keyOf = (id: number | null, rows: { id: number; key: string }[]) =>
			rows.find((row) => row.id === id)?.key ?? null;
		return {
			id: view.id,
			key: view.key,
			name: view.name,
			aliases: formerKeys,
			initialState: keyOf(view.initialStateId, view.states),
			states: view.states.map((state) => ({
				id: state.id,
				key: state.key,
				label: state.label,
				color: state.color,
				icon: state.icon,
				closed: state.isClosed,
				defaultSubstate: keyOf(state.defaultSubstateId, state.substates),
				substates: state.substates.map(({ id, key, label, color, icon }) => ({
					id,
					key,
					label,
					color,
					icon
				}))
			}))
		};
	}

	questSummary(view: QuestView) {
		return {
			id: view.id,
			name: view.name,
			description: view.description,
			owner: this.username(view.ownerId),
			progress: view.progress
		};
	}

	quest(view: QuestView) {
		return { ...this.questSummary(view), tickets: view.tickets.map((t) => this.ticket(t)) };
	}
}

export type ProjectSummary = ReturnType<Presenter['project']>;

export function userSummary(user: AuthUser) {
	return {
		id: user.id,
		username: user.username,
		displayName: user.displayName,
		kind: user.kind,
		isAdmin: user.isAdmin
	};
}

export function ticketLine(t: TicketSummary): string {
	const where = t.substate ? `${t.state.label} › ${t.substate.label}` : t.state.label;
	const people = [`owner ${t.owner}`, t.assignee ? `assignee ${t.assignee}` : 'unassigned'];
	if (t.parent) people.push(`parent ${t.parent}`);
	return `${t.key} [${where}] ${t.title} (${people.join(', ')})`;
}

export function ticketText(t: TicketDetail): string {
	const lines = [ticketLine(t)];
	if (t.aliases.length > 0) lines.push(`Aliases: ${t.aliases.join(', ')}`);
	if (t.quests.length > 0) {
		lines.push(`Quests: ${t.quests.map((q) => `${q.name} (#${q.id})`).join(', ')}`);
	}
	if (t.children.length > 0) {
		lines.push('Children:', ...t.children.map((c) => `  ${ticketLine(c)}`));
	}
	if (t.description.trim() !== '') lines.push('', t.description);
	return lines.join('\n');
}

export function projectText(p: ProjectSummary): string {
	const states = p.states.map((s) => {
		const marks = [s.key === p.initialState ? 'initial' : null, s.closed ? 'closed' : null].filter(
			Boolean
		);
		const named = s.substates.map((x) =>
			x.key === s.defaultSubstate ? `${x.key} (default)` : x.key
		);
		const subs = named.length === 0 ? '' : ` › ${named.join(', ')}`;
		return `  ${s.key} "${s.label}"${marks.length ? ` (${marks.join(', ')})` : ''}${subs}`;
	});
	const aliases = p.aliases.length > 0 ? ` (formerly ${p.aliases.join(', ')})` : '';
	return [`${p.key} ${p.name}${aliases}`, 'States:', ...states].join('\n');
}

export function questLine(q: { id: number; name: string; owner: string; progress: QuestProgress }) {
	return `#${q.id} ${q.name} (owner ${q.owner}, ${q.progress.closed}/${q.progress.total} closed)`;
}
