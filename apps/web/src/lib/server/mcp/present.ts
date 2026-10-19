import { asc, eq, inArray } from 'drizzle-orm';
import type { Handle } from '../db/client.ts';
import { appraisals, realmAgent, realmKeys, labourKeys, users } from '../db/schema.ts';
import { getRealm, getState, getSubstate } from '../domain/lookup.ts';
import { readRealm } from '../domain/realm-view.ts';
import { questProgress, type QuestProgress, type QuestView } from '../domain/quest-view.ts';
import { listLabourQuests } from '../domain/quests.ts';
import { readLabour, type LabourView } from '../domain/labour-view.ts';
import type { CommentView } from '../domain/comments.ts';
import { listChildren } from '../domain/labours.ts';
import type { AuthUser } from '../auth/users.ts';

export type Label = { key: string; label: string };

export type LabourSummary = {
	id: number;
	key: string;
	path: string;
	url: string;
	title: string;
	// An agent's one- or two-sentence summary; '' when none has been written.
	brief: string;
	realm: string;
	state: Label;
	substate: Label | null;
	closed: boolean;
	owner: string;
	assignee: string | null;
	parent: string | null;
	labels: string[];
};

export type LabourDetail = LabourSummary & {
	description: string;
	aliases: string[];
	createdAt: string;
	updatedAt: string;
	parentLabour: LabourSummary | null;
	children: LabourSummary[];
	quests: { id: number; name: string; progress: QuestProgress }[];
};

// Use one Presenter per tool call: its memo goes stale after a write.
export class Presenter {
	readonly db: Handle;
	readonly origin: string;
	private readonly memo = new Map<string, unknown>();
	private readonly briefs = new Map<number, string>();

	constructor(db: Handle, origin: string) {
		this.db = db;
		this.origin = origin;
	}

	url(path: string): string {
		return this.origin + path;
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

	private realmKey(id: number): string {
		return this.once(`realm:${id}`, () => getRealm(this.db, id).key);
	}

	private labourKey(id: number): string {
		return this.once(`labour:${id}`, () => readLabour(this.db, id).key);
	}

	private brief(labourId: number): string {
		if (!this.briefs.has(labourId)) this.loadBriefs([labourId]);
		return this.briefs.get(labourId)!;
	}

	private loadBriefs(labourIds: number[]): void {
		const wanted = labourIds.filter((id) => !this.briefs.has(id));
		if (wanted.length === 0) return;
		for (const id of wanted) this.briefs.set(id, '');
		const rows = this.db
			.select({ labourId: appraisals.labourId, brief: appraisals.brief })
			.from(appraisals)
			.where(inArray(appraisals.labourId, wanted))
			.all();
		for (const row of rows) this.briefs.set(row.labourId, row.brief);
	}

	labour(view: LabourView): LabourSummary {
		const path = `/l/${view.key}`;
		return {
			id: view.id,
			key: view.key,
			path,
			url: this.url(path),
			title: view.title,
			brief: this.brief(view.id),
			realm: this.realmKey(view.realmId),
			state: this.state(view.stateId),
			substate: view.substateId === null ? null : this.substate(view.substateId),
			closed: view.closed,
			owner: this.username(view.ownerId),
			assignee: view.assigneeId === null ? null : this.username(view.assigneeId),
			parent: view.parentId === null ? null : this.labourKey(view.parentId),
			labels: view.labels
		};
	}

	// Map every list of Labours through here: it reads their Briefs in one statement.
	labours(views: LabourView[]): LabourSummary[] {
		this.loadBriefs(views.map((view) => view.id));
		return views.map((view) => this.labour(view));
	}

	detail(view: LabourView): LabourDetail {
		return {
			...this.labour(view),
			description: view.description,
			aliases: this.aliases(view),
			createdAt: view.createdAt.toISOString(),
			updatedAt: view.updatedAt.toISOString(),
			parentLabour: view.parentId === null ? null : this.labour(readLabour(this.db, view.parentId)),
			children: this.labours(listChildren(this.db, view.id)),
			quests: listLabourQuests(this.db, view.id).map((quest) => ({
				id: quest.id,
				name: quest.name,
				progress: questProgress(this.db, quest.id)
			}))
		};
	}

	comment(view: CommentView) {
		return {
			id: view.id,
			labour: this.labourKey(view.labourId),
			author: this.username(view.authorId),
			body: view.body,
			createdAt: view.createdAt.toISOString(),
			updatedAt: view.updatedAt?.toISOString() ?? null
		};
	}

	aliases(view: LabourView): string[] {
		return this.db
			.select({ key: labourKeys.key })
			.from(labourKeys)
			.where(eq(labourKeys.labourId, view.id))
			.orderBy(asc(labourKeys.createdAt), asc(labourKeys.key))
			.all()
			.map((row) => row.key)
			.filter((key) => key !== view.key);
	}

	realm(realmId: number) {
		const view = readRealm(this.db, realmId);
		const formerKeys = this.db
			.select({ key: realmKeys.key })
			.from(realmKeys)
			.where(eq(realmKeys.realmId, realmId))
			.orderBy(asc(realmKeys.createdAt), asc(realmKeys.key))
			.all()
			.map((row) => row.key)
			.filter((key) => key !== view.key);
		const keyOf = (id: number | null, rows: { id: number; key: string }[]) =>
			rows.find((row) => row.id === id)?.key ?? null;
		const notes =
			this.db
				.select({ notes: realmAgent.notes })
				.from(realmAgent)
				.where(eq(realmAgent.realmId, realmId))
				.get()?.notes ?? '';
		const path = `/r/${view.key}`;
		return {
			id: view.id,
			key: view.key,
			path,
			url: this.url(path),
			name: view.name,
			aliases: formerKeys,
			notes,
			initialState: keyOf(view.initialStateId, view.states),
			states: view.states.map((state) => ({
				id: state.id,
				key: state.key,
				label: state.label,
				color: state.color,
				icon: state.icon,
				closed: state.isClosed,
				open: state.isOpen,
				next: state.next.map((id) => keyOf(id, view.states)),
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
		const path = `/quests/${view.id}`;
		return {
			id: view.id,
			path,
			url: this.url(path),
			name: view.name,
			description: view.description,
			owner: this.username(view.ownerId),
			progress: view.progress
		};
	}

	quest(view: QuestView) {
		return { ...this.questSummary(view), labours: this.labours(view.labours) };
	}
}

export type RealmSummary = ReturnType<Presenter['realm']>;

export function userSummary(user: AuthUser) {
	return {
		id: user.id,
		username: user.username,
		displayName: user.displayName,
		kind: user.kind,
		isAdmin: user.isAdmin
	};
}

const labelled = (x: Label) => `${x.key}: ${x.label}`;

export function labourLine(t: LabourSummary): string {
	const where = t.substate ? `${labelled(t.state)} › ${labelled(t.substate)}` : labelled(t.state);
	const labels = t.labels.length > 0 ? ` {${t.labels.join(', ')}}` : '';
	return `${t.key} [${where}] ${t.title}${labels}`;
}

export function realmLine(p: RealmSummary): string {
	const states = p.states.map((s) =>
		s.key === p.initialState ? `${labelled(s)} (initial)` : labelled(s)
	);
	return `${p.key} ${p.name} [${states.join(', ')}]`;
}

export function questLine(q: { id: number; name: string; progress: QuestProgress }) {
	return `Quest ${q.id} ${q.name}: ${q.progress.closed}/${q.progress.total} closed`;
}

export function count(n: number, one: string, many = `${one}s`): string {
	return `${n} ${n === 1 ? one : many}`;
}
