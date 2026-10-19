import type {
	BoardView,
	HomeView,
	LiveEvent,
	Realm,
	Quest,
	QuestListView,
	QuestOption,
	QuestPageView,
	SettingsView,
	Labour,
	LabourPageView
} from './types.ts';

// The rules are "Applying Events" in docs/events.md.

// The view needs data no Event carries: load it again.
export const RELOAD = Symbol('reload');

export type Applied<T> = T | null | typeof RELOAD;
// `shown` is the view with the client's own pending writes over it, when it has any.
export type Apply<T> = (view: T, event: LiveEvent, shown?: T) => Applied<T>;

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

function changedLabour(event: LiveEvent): Labour | null {
	switch (event.type) {
		case 'labour.created':
		case 'labour.updated':
		case 'labour.moved':
		case 'labour.reparented':
			return event.data.labour;
		default:
			return null;
	}
}

export function touchedLabours(event: LiveEvent): number[] {
	const labour = changedLabour(event);
	if (labour) return [labour.id];
	return event.type === 'labour.ranked' ? [event.data.id] : [];
}

// Null when the Event is not a rank, rekey or delete.
function patchLabours(list: Labour[], event: LiveEvent): Labour[] | null {
	switch (event.type) {
		case 'labour.ranked': {
			const { id, stateId, rank } = event.data;
			if (!list.some((t) => t.id === id)) return list;
			return list.map((t) => (t.id === id ? { ...t, stateId, rank } : t));
		}
		case 'labour.rekeyed': {
			const keys = new Map(event.data.labours.map((t) => [t.id, t.key]));
			if (!list.some((t) => keys.has(t.id))) return list;
			return list.map((t) => (keys.has(t.id) ? { ...t, key: keys.get(t.id)! } : t));
		}
		case 'labour.deleted':
			return without(list, [event.data.id]);
		case 'realm.deleted':
			return without(list, event.data.labourIds);
		default:
			return null;
	}
}

export function applyToRealms(realms: Realm[], event: LiveEvent): Realm[] {
	switch (event.type) {
		case 'realm.created':
			return upsert(realms, event.data.realm);
		case 'realm.updated':
		case 'state.created':
		case 'state.updated':
		case 'state.deleted':
		case 'substate.created':
		case 'substate.updated':
		case 'substate.deleted':
			return realms.some((p) => p.id === event.data.realm.id)
				? upsert(realms, event.data.realm)
				: realms;
		case 'realm.deleted':
			return without(realms, [event.data.realmId]);
		default:
			return realms;
	}
}

export function applyToBoard(
	realmId: number
): (board: BoardView, e: LiveEvent) => BoardView | null {
	return (board, event) => {
		switch (event.type) {
			case 'realm.created':
			case 'realm.updated':
			case 'state.created':
			case 'state.updated':
			case 'state.deleted':
			case 'substate.created':
			case 'substate.updated':
			case 'substate.deleted':
				return event.data.realm.id === realmId ? { ...board, realm: event.data.realm } : board;
			case 'realm.deleted':
				if (event.data.realmId === realmId) return null;
				break;
		}
		const labour = changedLabour(event);
		if (labour) {
			const rest = without(board.labours, [labour.id]);
			if (labour.realmId === realmId) return { ...board, labours: [...rest, labour] };
			return rest === board.labours ? board : { ...board, labours: rest };
		}
		const patched = patchLabours(board.labours, event);
		return patched && patched !== board.labours ? { ...board, labours: patched } : board;
	};
}

function withMembers(quest: Quest, labours: Labour[]): Quest {
	return {
		...quest,
		labours,
		progress: { closed: labours.filter((t) => t.closed).length, total: labours.length }
	};
}

export function applyToQuest(quest: Quest, event: LiveEvent): Quest | null {
	switch (event.type) {
		case 'quest.created':
		case 'quest.updated':
		case 'quest.labours_added':
		case 'quest.labours_removed':
		case 'quest.labour_ranked':
			return event.data.quest.id === quest.id ? event.data.quest : quest;
		case 'quest.deleted':
			return event.data.id === quest.id ? null : quest;
		case 'labour.created':
			return quest;
	}
	const labour = changedLabour(event);
	if (labour) {
		if (!quest.labours.some((t) => t.id === labour.id)) return quest;
		return withMembers(
			quest,
			quest.labours.map((t) => (t.id === labour.id ? labour : t))
		);
	}
	const patched = patchLabours(quest.labours, event);
	return patched && patched !== quest.labours ? withMembers(quest, patched) : quest;
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
		case 'quest.labours_added':
		case 'quest.labours_removed':
		case 'quest.labour_ranked': {
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
	const inOpenState = (realms: HomeView['realms'], t: Labour) =>
		realms.find((r) => r.id === t.realmId)?.states.find((s) => s.id === t.stateId)?.isOpen ??
		!t.closed;
	return (home, event) => {
		const realms = applyToRealms(home.realms, event);
		const mine = (t: Labour) =>
			inOpenState(realms, t) && (t.ownerId === userId || t.assigneeId === userId);
		const quests = applyToQuests(home.quests, event, (q) => q.ownerId === userId);
		let labours = realms === home.realms ? home.mine : home.mine.filter(mine);
		const labour = changedLabour(event);
		if (labour) {
			labours = mine(labour) ? upsert(labours, labour) : without(labours, [labour.id]);
		} else {
			labours = patchLabours(labours, event) ?? labours;
		}
		if (realms === home.realms && quests === home.quests && labours === home.mine) {
			return home;
		}
		return { realms, mine: labours, quests };
	};
}

export function applyToQuestPage(page: QuestPageView, event: LiveEvent): QuestPageView | null {
	const quest = applyToQuest(page.quest, event);
	if (quest === null) return null;
	const realms = applyToRealms(page.realms, event);
	return quest === page.quest && realms === page.realms ? page : { quest, realms };
}

export function applyToQuestList(list: QuestListView, event: LiveEvent): QuestListView {
	const quests = applyToQuests(list.quests, event);
	const realms = applyToRealms(list.realms, event);
	return quests === list.quests && realms === list.realms ? list : { quests, realms };
}

export function applyToSettings(view: SettingsView, event: LiveEvent): SettingsView | null {
	const id = view.realm.id;
	if (event.type === 'realm.deleted' && event.data.realmId === id) return null;
	const [realm] = applyToRealms([view.realm], event);
	return realm === view.realm ? view : { realm };
}

function applyToOptions(
	page: LabourPageView,
	event: LiveEvent
): Pick<LabourPageView, 'quests' | 'memberOf'> {
	const { quests, memberOf } = page;
	switch (event.type) {
		case 'quest.created':
		case 'quest.updated':
		case 'quest.labours_added':
		case 'quest.labours_removed':
		case 'quest.labour_ranked': {
			const { quest } = event.data;
			const option: QuestOption = { id: quest.id, name: quest.name };
			const member = quest.labours.some((t) => t.id === page.labour.id);
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

export function applyToLabourPage(
	page: LabourPageView,
	event: LiveEvent,
	shown?: LabourPageView
): Applied<LabourPageView> {
	const id = page.labour.id;
	if (event.type === 'labour.deleted' && event.data.id === id) return null;
	if (event.type === 'realm.deleted' && event.data.labourIds.includes(id)) return null;

	const next: LabourPageView = {
		...page,
		...applyToOptions(page, event),
		realms: applyToRealms(page.realms, event)
	};

	if (event.type === 'labour.commented') {
		const { comment } = event.data;
		if (comment.labourId !== id) return page;
		return page.comments.some((c) => c.id === comment.id)
			? page
			: { ...next, comments: [...page.comments, comment] };
	}
	if (event.type === 'labour.comment_edited') {
		const { comment } = event.data;
		if (comment.labourId !== id) return page;
		return { ...next, comments: page.comments.map((c) => (c.id === comment.id ? comment : c)) };
	}
	if (event.type === 'labour.comment_deleted') {
		if (event.data.labourId !== id) return page;
		return { ...next, comments: without(page.comments, [event.data.id]) };
	}

	const changed = changedLabour(event);
	if (changed) {
		if (changed.id === id) {
			if (changed.parentId !== null && changed.parentId !== page.labour.parentId) {
				// The Event names the new Parent but does not carry it; the client's own pending
				// write may already show it.
				if (shown?.parent?.id !== changed.parentId) return RELOAD;
				next.parent = shown.parent;
			}
			next.labour = changed;
			if (changed.parentId === null) next.parent = null;
		}
		if (changed.id === page.parent?.id) next.parent = changed;
		next.children =
			changed.parentId === id
				? upsert(page.children, changed)
				: without(page.children, [changed.id]);
	} else {
		const [labour] = patchLabours([page.labour], event) ?? [page.labour];
		next.labour = labour;
		if (page.parent) next.parent = (patchLabours([page.parent], event) ?? [page.parent])[0] ?? null;
		next.children = patchLabours(page.children, event) ?? page.children;
	}
	const same = (Object.keys(next) as (keyof LabourPageView)[]).every((k) => next[k] === page[k]);
	return same ? page : next;
}
