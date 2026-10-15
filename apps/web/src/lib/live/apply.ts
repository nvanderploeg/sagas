import type {
	BoardView,
	HomeView,
	LiveEvent,
	Project,
	Quest,
	QuestListView,
	QuestOption,
	QuestPageView,
	SettingsView,
	Ticket,
	TicketPageView
} from './types.ts';

// The rules are "Applying Events" in docs/events.md.

// The view needs data no Event carries: load it again.
export const RELOAD = Symbol('reload');

export type Applied<T> = T | null | typeof RELOAD;
export type Apply<T> = (view: T, event: LiveEvent) => Applied<T>;

const byId = (a: { id: number }, b: { id: number }) => a.id - b.id;

// Ranks compare by code unit, as the database does.
export const byRank = (a: { rank: string }, b: { rank: string }) =>
	a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : 0;

function upsert<T extends { id: number }>(list: T[], item: T): T[] {
	const at = list.findIndex((x) => x.id === item.id);
	if (at < 0) return [...list, item].sort(byId);
	const next = [...list];
	next[at] = item;
	return next;
}

const without = <T extends { id: number }>(list: T[], ids: number[]) =>
	list.some((x) => ids.includes(x.id)) ? list.filter((x) => !ids.includes(x.id)) : list;

function changedTicket(event: LiveEvent): Ticket | null {
	switch (event.type) {
		case 'ticket.created':
		case 'ticket.updated':
		case 'ticket.moved':
		case 'ticket.reparented':
			return event.data.ticket;
		default:
			return null;
	}
}

export function touchedTickets(event: LiveEvent): number[] {
	const ticket = changedTicket(event);
	if (ticket) return [ticket.id];
	return event.type === 'ticket.ranked' ? [event.data.id] : [];
}

// Null when the Event is not a rank, rekey or delete.
function patchTickets(list: Ticket[], event: LiveEvent): Ticket[] | null {
	switch (event.type) {
		case 'ticket.ranked': {
			const { id, stateId, rank } = event.data;
			if (!list.some((t) => t.id === id)) return list;
			return list.map((t) => (t.id === id ? { ...t, stateId, rank } : t));
		}
		case 'ticket.rekeyed': {
			const keys = new Map(event.data.tickets.map((t) => [t.id, t.key]));
			if (!list.some((t) => keys.has(t.id))) return list;
			return list.map((t) => (keys.has(t.id) ? { ...t, key: keys.get(t.id)! } : t));
		}
		case 'ticket.deleted':
			return without(list, [event.data.id]);
		case 'project.deleted':
			return without(list, event.data.ticketIds);
		default:
			return null;
	}
}

export function applyToProjects(projects: Project[], event: LiveEvent): Project[] {
	switch (event.type) {
		case 'project.created':
			return upsert(projects, event.data.project);
		case 'project.updated':
		case 'state.created':
		case 'state.updated':
		case 'state.deleted':
		case 'substate.created':
		case 'substate.updated':
		case 'substate.deleted':
			return projects.some((p) => p.id === event.data.project.id)
				? upsert(projects, event.data.project)
				: projects;
		case 'project.deleted':
			return without(projects, [event.data.projectId]);
		default:
			return projects;
	}
}

export function applyToBoard(
	projectId: number
): (board: BoardView, e: LiveEvent) => BoardView | null {
	return (board, event) => {
		switch (event.type) {
			case 'project.created':
			case 'project.updated':
			case 'state.created':
			case 'state.updated':
			case 'state.deleted':
			case 'substate.created':
			case 'substate.updated':
			case 'substate.deleted':
				return event.data.project.id === projectId
					? { ...board, project: event.data.project }
					: board;
			case 'project.deleted':
				if (event.data.projectId === projectId) return null;
				break;
		}
		const ticket = changedTicket(event);
		if (ticket) {
			const rest = without(board.tickets, [ticket.id]);
			return {
				...board,
				tickets: ticket.projectId === projectId ? [...rest, ticket] : rest
			};
		}
		const patched = patchTickets(board.tickets, event);
		return patched && patched !== board.tickets ? { ...board, tickets: patched } : board;
	};
}

function withMembers(quest: Quest, tickets: Ticket[]): Quest {
	return {
		...quest,
		tickets,
		progress: { closed: tickets.filter((t) => t.closed).length, total: tickets.length }
	};
}

export function applyToQuest(quest: Quest, event: LiveEvent): Quest | null {
	switch (event.type) {
		case 'quest.created':
		case 'quest.updated':
		case 'quest.tickets_added':
		case 'quest.tickets_removed':
		case 'quest.ticket_ranked':
			return event.data.quest.id === quest.id ? event.data.quest : quest;
		case 'quest.deleted':
			return event.data.id === quest.id ? null : quest;
		case 'ticket.created':
			return quest;
	}
	const ticket = changedTicket(event);
	if (ticket) {
		if (!quest.tickets.some((t) => t.id === ticket.id)) return quest;
		return withMembers(
			quest,
			quest.tickets.map((t) => (t.id === ticket.id ? ticket : t))
		);
	}
	const patched = patchTickets(quest.tickets, event);
	return patched && patched !== quest.tickets ? withMembers(quest, patched) : quest;
}

// Quests in id order; `keep` decides which Quests the list holds.
export function applyToQuests(
	quests: Quest[],
	event: LiveEvent,
	keep: (quest: Quest) => boolean = () => true
): Quest[] {
	switch (event.type) {
		case 'quest.created':
		case 'quest.updated':
		case 'quest.tickets_added':
		case 'quest.tickets_removed':
		case 'quest.ticket_ranked': {
			const { quest } = event.data;
			return keep(quest) ? upsert(quests, quest) : without(quests, [quest.id]);
		}
		case 'quest.deleted':
			return without(quests, [event.data.id]);
	}
	let changed = false;
	const next = quests.map((quest) => {
		const applied = applyToQuest(quest, event) ?? quest;
		if (applied !== quest) changed = true;
		return applied;
	});
	return changed ? next : quests;
}

export function applyToHome(userId: number): (home: HomeView, e: LiveEvent) => HomeView {
	const mine = (t: Ticket) => !t.closed && (t.ownerId === userId || t.assigneeId === userId);
	return (home, event) => {
		const projects = applyToProjects(home.projects, event);
		const quests = applyToQuests(home.quests, event, (q) => q.ownerId === userId);
		let tickets = home.mine;
		const ticket = changedTicket(event);
		if (ticket) {
			tickets = mine(ticket) ? upsert(tickets, ticket) : without(tickets, [ticket.id]);
		} else {
			tickets = patchTickets(tickets, event) ?? tickets;
		}
		if (projects === home.projects && quests === home.quests && tickets === home.mine) {
			return home;
		}
		return { projects, mine: tickets, quests };
	};
}

export function applyToQuestPage(page: QuestPageView, event: LiveEvent): QuestPageView | null {
	const quest = applyToQuest(page.quest, event);
	if (quest === null) return null;
	const projects = applyToProjects(page.projects, event);
	return quest === page.quest && projects === page.projects ? page : { quest, projects };
}

export function applyToQuestList(list: QuestListView, event: LiveEvent): QuestListView {
	const quests = applyToQuests(list.quests, event);
	const projects = applyToProjects(list.projects, event);
	return quests === list.quests && projects === list.projects ? list : { quests, projects };
}

export function applyToSettings(view: SettingsView, event: LiveEvent): SettingsView | null {
	const id = view.project.id;
	if (event.type === 'project.deleted' && event.data.projectId === id) return null;
	const [project] = applyToProjects([view.project], event);
	return project === view.project ? view : { project };
}

function applyToOptions(
	page: TicketPageView,
	event: LiveEvent
): Pick<TicketPageView, 'quests' | 'memberOf'> {
	const { quests, memberOf } = page;
	switch (event.type) {
		case 'quest.created':
		case 'quest.updated':
		case 'quest.tickets_added':
		case 'quest.tickets_removed':
		case 'quest.ticket_ranked': {
			const { quest } = event.data;
			const option: QuestOption = { id: quest.id, name: quest.name };
			const member = quest.tickets.some((t) => t.id === page.ticket.id);
			const ids = memberOf.filter((id) => id !== quest.id);
			return {
				quests: upsert(quests, option),
				memberOf: member ? [...ids, quest.id].sort((a, b) => a - b) : ids
			};
		}
		case 'quest.deleted':
			return {
				quests: without(quests, [event.data.id]),
				memberOf: memberOf.filter((id) => id !== event.data.id)
			};
		default:
			return { quests, memberOf };
	}
}

export function applyToTicketPage(page: TicketPageView, event: LiveEvent): Applied<TicketPageView> {
	const id = page.ticket.id;
	if (event.type === 'ticket.deleted' && event.data.id === id) return null;
	if (event.type === 'project.deleted' && event.data.ticketIds.includes(id)) return null;

	const next: TicketPageView = {
		...page,
		...applyToOptions(page, event),
		projects: applyToProjects(page.projects, event)
	};

	const changed = changedTicket(event);
	if (changed) {
		if (changed.id === id) {
			if (changed.parentId !== page.ticket.parentId && changed.parentId !== null) return RELOAD;
			next.ticket = changed;
			if (changed.parentId === null) next.parent = null;
		}
		if (changed.id === page.parent?.id) next.parent = changed;
		next.children =
			changed.parentId === id
				? upsert(page.children, changed)
				: without(page.children, [changed.id]);
	} else {
		const [ticket] = patchTickets([page.ticket], event) ?? [page.ticket];
		next.ticket = ticket;
		if (page.parent) next.parent = (patchTickets([page.parent], event) ?? [page.parent])[0] ?? null;
		next.children = patchTickets(page.children, event) ?? page.children;
	}
	return next;
}
