import { and, asc, eq, inArray, isNotNull } from 'drizzle-orm';
import type { Handle } from '../db/client.ts';
import { appraisals, realmAgent, realmKeys, labourKeys, scrollRefs, users } from '../db/schema.ts';
import { getRealm, getState, getSubstate } from '../domain/lookup.ts';
import { readRealm } from '../domain/realm-view.ts';
import {
	readQuest,
	restrictQuest,
	type QuestProgress,
	type QuestView
} from '../domain/quest-view.ts';
import { canSeeRealm, visibleRealmIds } from '../domain/access.ts';
import { listLabourQuests } from '../domain/quests.ts';
import { readLabour, type LabourView } from '../domain/labour-view.ts';
import type { CommentView } from '../domain/comments.ts';
import { listChildren } from '../domain/labours.ts';
import type { AuthUser } from '../auth/users.ts';
import { listBacklinks, listScrollChildren, type Scroll } from '../domain/scrolls.ts';
import { parentPath } from '../../ui/scroll-path.ts';
import { filterAsync } from '#lib/server/async.ts';

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

	readonly viewer: { id: number };

	constructor(db: Handle, origin: string, viewer: { id: number }) {
		this.db = db;
		this.origin = origin;
		this.viewer = viewer;
	}

	// What a Labour in a Realm the viewer cannot see reveals: nothing.
	private async visibleLabour(id: number): Promise<boolean> {
		return canSeeRealm(this.db, this.viewer, (await readLabour(this.db, id)).realmId);
	}

	url(path: string): string {
		return this.origin + path;
	}

	private once<T>(key: string, read: () => T): T {
		if (!this.memo.has(key)) this.memo.set(key, read());
		return this.memo.get(key) as T;
	}

	async username(id: number): Promise<string> {
		return this.once(`user:${id}`, async () => {
			const row = (
				await this.db
					.select({ username: users.username })
					.from(users)
					.where(eq(users.id, id))
					.limit(1)
			)[0];
			return row?.username ?? `#${id}`;
		});
	}

	private async state(id: number): Promise<Label> {
		return this.once(`state:${id}`, async () => {
			const { key, label } = await getState(this.db, id);
			return { key, label };
		});
	}

	private async substate(id: number): Promise<Label> {
		return this.once(`substate:${id}`, async () => {
			const { key, label } = await getSubstate(this.db, id);
			return { key, label };
		});
	}

	private async realmKey(id: number): Promise<string> {
		return this.once(`realm:${id}`, async () => (await getRealm(this.db, id)).key);
	}

	private async labourKey(id: number): Promise<string> {
		return this.once(`labour:${id}`, async () => (await readLabour(this.db, id)).key);
	}

	private async brief(labourId: number): Promise<string> {
		if (!this.briefs.has(labourId)) await this.loadBriefs([labourId]);
		return this.briefs.get(labourId)!;
	}

	private async loadBriefs(labourIds: number[]): Promise<void> {
		const wanted = labourIds.filter((id) => !this.briefs.has(id));
		if (wanted.length === 0) return;
		for (const id of wanted) this.briefs.set(id, '');
		const rows = await this.db
			.select({ labourId: appraisals.labourId, brief: appraisals.brief })
			.from(appraisals)
			.where(inArray(appraisals.labourId, wanted));
		for (const row of rows) this.briefs.set(row.labourId, row.brief);
	}

	async labour(view: LabourView): Promise<LabourSummary> {
		const path = `/l/${view.key}`;
		return {
			id: view.id,
			key: view.key,
			path,
			url: this.url(path),
			title: view.title,
			brief: await this.brief(view.id),
			realm: await this.realmKey(view.realmId),
			state: await this.state(view.stateId),
			substate: view.substateId === null ? null : await this.substate(view.substateId),
			closed: view.closed,
			owner: await this.username(view.ownerId),
			assignee: view.assigneeId === null ? null : await this.username(view.assigneeId),
			parent:
				view.parentId === null || !(await this.visibleLabour(view.parentId))
					? null
					: await this.labourKey(view.parentId),
			labels: view.labels
		};
	}

	// Map every list of Labours through here: it reads their Briefs in one statement.
	async labours(views: LabourView[]): Promise<LabourSummary[]> {
		await this.loadBriefs(views.map((view) => view.id));
		return Promise.all(views.map((view) => this.labour(view)));
	}

	async detail(view: LabourView): Promise<LabourDetail> {
		return {
			...(await this.labour(view)),
			description: view.description,
			aliases: await this.aliases(view),
			createdAt: view.createdAt.toISOString(),
			updatedAt: view.updatedAt.toISOString(),
			parentLabour:
				view.parentId === null || !(await this.visibleLabour(view.parentId))
					? null
					: await this.labour(await readLabour(this.db, view.parentId)),
			children: await this.labours(
				await filterAsync(await listChildren(this.db, view.id), (child) =>
					canSeeRealm(this.db, this.viewer, child.realmId)
				)
			),
			quests: await Promise.all(
				(await listLabourQuests(this.db, view.id)).map(async (quest) => ({
					id: quest.id,
					name: quest.name,
					progress: (await this.restricted(await readQuest(this.db, quest.id))).progress
				}))
			)
		};
	}

	async comment(view: CommentView) {
		return {
			id: view.id,
			labour: await this.labourKey(view.labourId),
			author: await this.username(view.authorId),
			body: view.body,
			createdAt: view.createdAt.toISOString(),
			updatedAt: view.updatedAt?.toISOString() ?? null
		};
	}

	async aliases(view: LabourView): Promise<string[]> {
		return (
			await this.db
				.select({ key: labourKeys.key })
				.from(labourKeys)
				.where(eq(labourKeys.labourId, view.id))
				.orderBy(asc(labourKeys.createdAt), asc(labourKeys.key))
		)
			.map((row) => row.key)
			.filter((key) => key !== view.key);
	}

	async realm(realmId: number) {
		const view = await readRealm(this.db, realmId);
		const formerKeys = (
			await this.db
				.select({ key: realmKeys.key })
				.from(realmKeys)
				.where(eq(realmKeys.realmId, realmId))
				.orderBy(asc(realmKeys.createdAt), asc(realmKeys.key))
		)
			.map((row) => row.key)
			.filter((key) => key !== view.key);
		const keyOf = (id: number | null, rows: { id: number; key: string }[]) =>
			rows.find((row) => row.id === id)?.key ?? null;
		const notes =
			(
				await this.db
					.select({ notes: realmAgent.notes })
					.from(realmAgent)
					.where(eq(realmAgent.realmId, realmId))
					.limit(1)
			)[0]?.notes ?? '';
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

	// A Quest as the viewer sees it: other Realms' Labours are neither listed nor counted.
	async restricted(view: QuestView): Promise<QuestView> {
		return restrictQuest(
			view,
			await this.once('visible', async () => {
				const ids = await visibleRealmIds(this.db, this.viewer);
				return ids === null ? null : new Set(ids);
			})
		);
	}

	async questSummary(view: QuestView) {
		const path = `/quests/${view.id}`;
		return {
			id: view.id,
			path,
			url: this.url(path),
			name: view.name,
			description: view.description,
			realm: await this.realmKey(view.realmId),
			owner: await this.username(view.ownerId),
			progress: (await this.restricted(view)).progress
		};
	}

	async scrollUrl(realmId: number, path: string): Promise<string> {
		return this.url(`/r/${await this.realmKey(realmId)}/s/${path}`);
	}

	private async scrollLabours(scrollId: number): Promise<string[]> {
		const rows = await this.db
			.select({ labourId: scrollRefs.labourId })
			.from(scrollRefs)
			.where(and(eq(scrollRefs.scrollId, scrollId), isNotNull(scrollRefs.labourId)))
			.orderBy(asc(scrollRefs.firstSeenAt), asc(scrollRefs.id));
		const found = await Promise.all(rows.map((row) => readLabour(this.db, row.labourId!)));
		return (
			await filterAsync(found, (labour) => canSeeRealm(this.db, this.viewer, labour.realmId))
		).map((labour) => labour.key);
	}

	async scroll(view: Scroll) {
		const link = ({ path, title }: { path: string; title: string }) => ({ path, title });
		return {
			id: view.id,
			realm: await this.realmKey(view.realmId),
			path: view.path,
			url: await this.scrollUrl(view.realmId, view.path),
			title: view.title,
			body: view.body,
			version: view.version,
			parent: parentPath(view.path),
			children: (await listScrollChildren(this.db, view.id)).map(link),
			backlinks: (await listBacklinks(this.db, view.id)).map(link),
			labours: await this.scrollLabours(view.id),
			createdBy: await this.username(view.createdById),
			updatedBy: await this.username(view.updatedById),
			createdAt: view.createdAt.toISOString(),
			updatedAt: view.updatedAt.toISOString()
		};
	}

	async quest(view: QuestView) {
		const shown = await this.restricted(view);
		return { ...(await this.questSummary(shown)), labours: await this.labours(shown.labours) };
	}
}

export type RealmSummary = Awaited<ReturnType<Presenter['realm']>>;

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

export function scrollLine(s: { realm: string; path: string; version: number; title: string }) {
	return `Scroll ${s.path} in ${s.realm} (v${s.version}): ${s.title}`;
}

export function count(n: number, one: string, many = `${one}s`): string {
	return `${n} ${n === 1 ? one : many}`;
}
