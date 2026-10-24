import { and, asc, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import { generateNKeysBetween } from 'fractional-indexing';
import type { Db, Handle } from '../db/client.ts';
import { scrollPaths, scrollRefs, scrolls, users } from '../db/schema.ts';
import { mentionTargets } from '../agent/mentions.ts';
import { matchExpression } from '../agent/search.ts';
import type { EventSpec } from '../events/types.ts';
import { DEPTH_MAX, SLUG, normalizePath, slugify } from '../../ui/scroll-path.ts';
import { scrollLinks } from '../../ui/markdown.ts';
import { requireRealmRole } from './access.ts';
import { DomainError } from './errors.ts';
import { getRealm } from './lookup.ts';
import { rankAt, type Placement } from './rank.ts';
import {
	getScroll,
	readScroll,
	type PathChange,
	type Scroll,
	type ScrollView
} from './scroll-view.ts';
import { requireText } from './validate.ts';
import { write, type Actor } from './write.ts';

export {
	getScroll,
	readScroll,
	type PathChange,
	type Scroll,
	type ScrollView
} from './scroll-view.ts';

export const TITLE_MAX = 120;
export const BODY_MAX = 100_000;

export type ScrollSpec = {
	realmId: number;
	title: string;
	parentId?: number | null;
	slug?: string;
	body?: string;
	placement?: Placement;
};

export type ScrollPatch = { title?: string; slug?: string; body?: string; version?: number };

// `parentId: null` moves to the top level; undefined keeps the parent.
export type ScrollMove = { parentId?: number | null; placement?: Placement };

export type ChildChoice = 'move' | 'delete';

export type ScrollDeletion = {
	deleted: { id: number; path: string }[];
	moved: (PathChange & { parentId: number | null })[];
};

export type ScrollNode = Pick<Scroll, 'id' | 'parentId' | 'slug' | 'path' | 'title' | 'rank'> & {
	depth: number;
};

export type ScrollLinkTarget = { id: number; path: string; title: string };

const depthOf = (path: string) => path.split('/').length;
const join = (parent: string | null, slug: string) =>
	parent === null ? slug : `${parent}/${slug}`;

function checkSlug(slug: string): string {
	if (!SLUG.test(slug)) {
		throw new DomainError(
			'invalid',
			'Slug must be 1 to 64 lowercase letters, digits and hyphens, starting and ending with a letter or digit'
		);
	}
	return slug;
}

function checkBody(body: string): string {
	if (body.length > BODY_MAX) {
		throw new DomainError('invalid', `Scroll body must be at most ${BODY_MAX} characters`);
	}
	return body;
}

function editable(tx: Handle, actor: Actor, scrollId: number): Scroll {
	const scroll = getScroll(tx, scrollId);
	requireRealmRole(tx, actor, scroll.realmId, 'editor');
	return scroll;
}

function parentIn(tx: Handle, realmId: number, parentId: number): Scroll {
	const parent = getScroll(tx, parentId);
	if (parent.realmId !== realmId) {
		throw new DomainError('invalid', 'The parent Scroll is in another Realm');
	}
	return parent;
}

function siblings(tx: Handle, realmId: number, parentId: number | null) {
	return tx
		.select({ id: scrolls.id, rank: scrolls.rank, slug: scrolls.slug, path: scrolls.path })
		.from(scrolls)
		.where(
			and(
				eq(scrolls.realmId, realmId),
				parentId === null ? isNull(scrolls.parentId) : eq(scrolls.parentId, parentId)
			)
		)
		.orderBy(asc(scrolls.rank))
		.all();
}

// The Scroll and everything under it, the Scroll first.
function subtree(tx: Handle, rootId: number): { id: number; path: string }[] {
	return tx.all<{ id: number; path: string }>(sql`
		WITH RECURSIVE t(id) AS (
			SELECT ${rootId} UNION ALL SELECT s.id FROM scrolls s JOIN t ON s.parent_id = t.id
		)
		SELECT scrolls.id AS id, scrolls.path AS path FROM t JOIN scrolls ON scrolls.id = t.id
		ORDER BY length(scrolls.path), scrolls.path
	`);
}

function requireFreePath(tx: Handle, realmId: number, path: string, self: number | null): void {
	const taken = tx
		.select({ id: scrolls.id })
		.from(scrolls)
		.where(
			and(
				eq(scrolls.realmId, realmId),
				eq(scrolls.path, path),
				self === null ? undefined : ne(scrolls.id, self)
			)
		)
		.get();
	if (taken !== undefined)
		throw new DomainError('conflict', `A Scroll already has the Path ${path}`);
}

function requireDepth(path: string, below = 0): void {
	if (depthOf(path) + below > DEPTH_MAX) {
		throw new DomainError('invalid', `Scrolls nest at most ${DEPTH_MAX} deep`);
	}
}

// Placement anchors must be siblings; checked here so rankAt never words them as Labours.
function siblingRank(
	tx: Handle,
	column: { id: number; rank: string; path: string }[],
	subject: { id: number | null; rank?: string },
	placement: Placement
): string {
	if (typeof placement === 'object') {
		const anchor = 'before' in placement ? placement.before : placement.after;
		if (anchor === subject.id) {
			throw new DomainError('invalid', 'A Scroll cannot be placed relative to itself');
		}
		if (!column.some((entry) => entry.id === anchor)) {
			const path = tx
				.select({ path: scrolls.path })
				.from(scrolls)
				.where(eq(scrolls.id, anchor))
				.get();
			throw new DomainError(
				'invalid',
				`${path ? `Scroll ${path.path}` : `Scroll ${anchor}`} is not a sibling`
			);
		}
	}
	return rankAt(column, subject, placement, 'Scroll');
}

function holdPath(tx: Handle, realmId: number, path: string, scrollId: number): void {
	tx.insert(scrollPaths)
		.values({ realmId, path, scrollId })
		.onConflictDoUpdate({
			target: [scrollPaths.realmId, scrollPaths.path],
			set: { scrollId, createdAt: new Date() }
		})
		.run();
}

// Rewrites the Path of the root and everything under it; old Paths stay with their Scrolls.
function repath(tx: Handle, realmId: number, rootId: number, rootPath: string): PathChange[] {
	const rows = subtree(tx, rootId);
	const oldRoot = rows[0].path;
	if (oldRoot === rootPath) return [];
	const changes = rows.map((row) => ({
		id: row.id,
		previousPath: row.path,
		path: rootPath + row.path.slice(oldRoot.length)
	}));
	for (const change of changes) {
		tx.update(scrolls).set({ path: change.path }).where(eq(scrolls.id, change.id)).run();
		holdPath(tx, realmId, change.path, change.id);
	}
	return changes;
}

function deepestBelow(tx: Handle, rootId: number): number {
	const rows = subtree(tx, rootId);
	const base = depthOf(rows[0].path);
	return Math.max(...rows.map((row) => depthOf(row.path) - base));
}

function refreshText(tx: Handle, scroll: { id: number; title: string; body: string }): void {
	tx.run(sql`INSERT OR REPLACE INTO scroll_text(rowid, title, body)
		VALUES (${scroll.id}, ${scroll.title}, ${scroll.body})`);
}

export function removeScrollText(tx: Handle, ids: number[]): void {
	if (ids.length === 0) return;
	tx.run(
		sql`DELETE FROM scroll_text WHERE rowid IN (SELECT value FROM json_each(${JSON.stringify(ids)}))`
	);
}

type RefKey = { targetPath: string | null; labourId: number | null; userId: number | null };
const refKey = (ref: RefKey) => `${ref.targetPath ?? ''}|${ref.labourId ?? 0}|${ref.userId ?? 0}`;

// Kept rows keep their firstSeenAt.
function refreshRefs(tx: Handle, scrollId: number, body: string, now: Date): void {
	const named = mentionTargets(tx, body);
	const wanted: RefKey[] = [
		...scrollLinks(body).map((link) => ({ targetPath: link.target, labourId: null, userId: null })),
		...[...named.labourIds].map((labourId) => ({ targetPath: null, labourId, userId: null })),
		...[...named.userIds].map((userId) => ({ targetPath: null, labourId: null, userId }))
	];
	const wantedKeys = new Set(wanted.map(refKey));
	const held = tx.select().from(scrollRefs).where(eq(scrollRefs.scrollId, scrollId)).all();
	const heldKeys = new Set(held.map(refKey));
	const gone = held.filter((row) => !wantedKeys.has(refKey(row))).map((row) => row.id);
	if (gone.length > 0) tx.delete(scrollRefs).where(inArray(scrollRefs.id, gone)).run();
	const fresh = wanted.filter((ref) => !heldKeys.has(refKey(ref)));
	if (fresh.length > 0) {
		tx.insert(scrollRefs)
			.values(fresh.map((ref) => ({ ...ref, scrollId, firstSeenAt: now })))
			.run();
	}
}

export function createScroll(db: Db, actor: Actor, input: ScrollSpec): ScrollView {
	const title = requireText(input.title, 'Scroll title', TITLE_MAX);
	const slug = checkSlug(input.slug?.trim() || slugify(title));
	const body = checkBody(input.body ?? '');
	return write(db, actor, (tx) => {
		getRealm(tx, input.realmId);
		requireRealmRole(tx, actor, input.realmId, 'editor');
		const parentId = input.parentId ?? null;
		const parent = parentId === null ? null : parentIn(tx, input.realmId, parentId);
		const path = join(parent?.path ?? null, slug);
		requireDepth(path);
		requireFreePath(tx, input.realmId, path, null);
		const rank = siblingRank(
			tx,
			siblings(tx, input.realmId, parentId),
			{ id: null },
			input.placement ?? 'bottom'
		);
		const now = new Date();
		const { id } = tx
			.insert(scrolls)
			.values({
				realmId: input.realmId,
				parentId,
				slug,
				path,
				title,
				body,
				rank,
				createdById: actor.id,
				updatedById: actor.id,
				createdAt: now,
				updatedAt: now
			})
			.returning({ id: scrolls.id })
			.get();
		holdPath(tx, input.realmId, path, id);
		refreshText(tx, { id, title, body });
		refreshRefs(tx, id, body, now);
		const scroll = readScroll(tx, id);
		return { value: scroll, events: [{ type: 'scroll.created', data: { scroll } }] };
	});
}

function staleVersion(tx: Handle, scroll: Scroll, version: number): DomainError {
	const by = tx
		.select({ username: users.username })
		.from(users)
		.where(eq(users.id, scroll.updatedById))
		.get();
	return new DomainError(
		'conflict',
		`This Scroll changed after version ${version}: it is at version ${scroll.version}, saved by ${by?.username ?? 'someone'}`
	);
}

export function updateScroll(
	db: Db,
	actor: Actor,
	scrollId: number,
	patch: ScrollPatch
): ScrollView {
	return write(db, actor, (tx) => {
		const scroll = editable(tx, actor, scrollId);
		if (patch.version !== undefined && patch.version !== scroll.version) {
			throw staleVersion(tx, scroll, patch.version);
		}
		const title =
			patch.title === undefined
				? scroll.title
				: requireText(patch.title, 'Scroll title', TITLE_MAX);
		const body = patch.body === undefined ? scroll.body : checkBody(patch.body);
		const slug = patch.slug === undefined ? scroll.slug : checkSlug(patch.slug.trim());
		const textChanged = title !== scroll.title || body !== scroll.body;
		if (!textChanged && slug === scroll.slug) return { value: scroll, events: [] };

		const now = new Date();
		let paths: PathChange[] = [];
		if (slug !== scroll.slug) {
			const parentPath = scroll.parentId === null ? null : getScroll(tx, scroll.parentId).path;
			const path = join(parentPath, slug);
			requireFreePath(tx, scroll.realmId, path, scroll.id);
			tx.update(scrolls).set({ slug }).where(eq(scrolls.id, scrollId)).run();
			paths = repath(tx, scroll.realmId, scrollId, path);
		}
		tx.update(scrolls)
			.set({ title, body, version: scroll.version + 1, updatedById: actor.id, updatedAt: now })
			.where(eq(scrolls.id, scrollId))
			.run();
		if (textChanged) refreshText(tx, { id: scrollId, title, body });
		if (body !== scroll.body) refreshRefs(tx, scrollId, body, now);

		const view = readScroll(tx, scrollId);
		const events: EventSpec[] = [];
		if (textChanged) events.push({ type: 'scroll.updated', data: { scroll: view } });
		if (paths.length > 0) events.push({ type: 'scroll.moved', data: { scroll: view, paths } });
		return { value: view, events };
	});
}

export function moveScroll(db: Db, actor: Actor, scrollId: number, move: ScrollMove): ScrollView {
	if (move.parentId === undefined && move.placement === undefined) {
		throw new DomainError('invalid', 'Give a parent or a placement');
	}
	return write(db, actor, (tx) => {
		const scroll = editable(tx, actor, scrollId);
		const parentId = move.parentId === undefined ? scroll.parentId : move.parentId;
		const placement = move.placement ?? 'bottom';

		if (parentId === scroll.parentId) {
			const rank = siblingRank(tx, siblings(tx, scroll.realmId, parentId), scroll, placement);
			if (rank === scroll.rank) return { value: scroll, events: [] };
			tx.update(scrolls).set({ rank }).where(eq(scrolls.id, scrollId)).run();
			const view = readScroll(tx, scrollId);
			return { value: view, events: [{ type: 'scroll.moved', data: { scroll: view, paths: [] } }] };
		}

		const parent = parentId === null ? null : parentIn(tx, scroll.realmId, parentId);
		if (parent !== null && subtree(tx, scrollId).some((row) => row.id === parent.id)) {
			throw new DomainError('invalid', 'A Scroll cannot move under itself or a Scroll beneath it');
		}
		const path = join(parent?.path ?? null, scroll.slug);
		requireDepth(path, deepestBelow(tx, scrollId));
		requireFreePath(tx, scroll.realmId, path, scroll.id);
		const rank = siblingRank(
			tx,
			siblings(tx, scroll.realmId, parentId),
			{ id: scroll.id },
			placement
		);
		tx.update(scrolls).set({ parentId, rank }).where(eq(scrolls.id, scrollId)).run();
		const paths = repath(tx, scroll.realmId, scrollId, path);
		const view = readScroll(tx, scrollId);
		return { value: view, events: [{ type: 'scroll.moved', data: { scroll: view, paths } }] };
	});
}

// Every direct child needs a choice, per docs/scrolls.md.
export function deleteScroll(
	db: Db,
	actor: Actor,
	scrollId: number,
	choices: Map<number, ChildChoice> = new Map()
): ScrollDeletion {
	return write(db, actor, (tx) => {
		const scroll = editable(tx, actor, scrollId);
		const children = siblings(tx, scroll.realmId, scroll.id);
		const childIds = new Set(children.map((child) => child.id));
		for (const id of choices.keys()) {
			if (!childIds.has(id)) {
				throw new DomainError('invalid', `Scroll ${id} is not a child of ${scroll.path}`);
			}
		}
		const undecided = children.filter((child) => !choices.has(child.id));
		if (undecided.length > 0) {
			throw new DomainError(
				'invalid',
				`Choose move or delete for each child of ${scroll.path}: ${undecided.map((c) => c.path).join(', ')}`
			);
		}

		const movers = children.filter((child) => choices.get(child.id) === 'move');
		const level = siblings(tx, scroll.realmId, scroll.parentId);
		const parentPath = scroll.parentId === null ? null : getScroll(tx, scroll.parentId).path;
		for (const mover of movers) {
			const clash = level.find((s) => s.id !== scroll.id && s.slug === mover.slug);
			if (clash) {
				throw new DomainError(
					'conflict',
					`${mover.path} cannot move up: ${clash.path} already has its Path`
				);
			}
		}

		const doomed = [
			{ id: scroll.id, path: scroll.path },
			...children
				.filter((child) => choices.get(child.id) === 'delete')
				.flatMap((child) => subtree(tx, child.id))
		];

		const moved: ScrollDeletion['moved'] = [];
		if (movers.length > 0) {
			// Ranks after the deleted Scroll's and before its next sibling take its place once it goes.
			const at = level.findIndex((s) => s.id === scroll.id);
			const ranks = generateNKeysBetween(scroll.rank, level[at + 1]?.rank ?? null, movers.length);
			movers.forEach((mover, i) => {
				tx.update(scrolls)
					.set({ parentId: scroll.parentId, rank: ranks[i] })
					.where(eq(scrolls.id, mover.id))
					.run();
				const changes = repath(tx, scroll.realmId, mover.id, join(parentPath, mover.slug));
				for (const change of changes) {
					moved.push({
						...change,
						parentId: change.id === mover.id ? scroll.parentId : getScroll(tx, change.id).parentId
					});
				}
			});
		}

		const ids = doomed.map((row) => row.id);
		removeScrollText(tx, ids);
		tx.delete(scrolls).where(inArray(scrolls.id, ids)).run();
		return {
			value: { deleted: doomed, moved },
			events: [
				{
					type: 'scroll.deleted',
					data: { realmId: scroll.realmId, ids, moved }
				}
			]
		};
	});
}

// Depth first, siblings in rank order.
export function listScrollTree(db: Handle, realmId: number): ScrollNode[] {
	const rows = db
		.select({
			id: scrolls.id,
			parentId: scrolls.parentId,
			slug: scrolls.slug,
			path: scrolls.path,
			title: scrolls.title,
			rank: scrolls.rank
		})
		.from(scrolls)
		.where(eq(scrolls.realmId, realmId))
		.orderBy(asc(scrolls.rank))
		.all();
	const byParent = new Map<number | null, typeof rows>();
	for (const row of rows) byParent.set(row.parentId, [...(byParent.get(row.parentId) ?? []), row]);
	const out: ScrollNode[] = [];
	const visit = (parentId: number | null, depth: number) => {
		for (const row of byParent.get(parentId) ?? []) {
			out.push({ ...row, depth });
			visit(row.id, depth + 1);
		}
	};
	visit(null, 0);
	return out;
}

export function listScrollChildren(db: Handle, scrollId: number): ScrollNode[] {
	const scroll = getScroll(db, scrollId);
	const depth = depthOf(scroll.path);
	return db
		.select({
			id: scrolls.id,
			parentId: scrolls.parentId,
			slug: scrolls.slug,
			path: scrolls.path,
			title: scrolls.title,
			rank: scrolls.rank
		})
		.from(scrolls)
		.where(eq(scrolls.parentId, scrollId))
		.orderBy(asc(scrolls.rank))
		.all()
		.map((row) => ({ ...row, depth }));
}

export function countDescendants(db: Handle, scrollIds: number[]): Map<number, number> {
	return new Map(scrollIds.map((id) => [id, subtree(db, id).length - 1]));
}

// `current` is false when the Path is one the Scroll held before.
export function resolveScrollPath(
	db: Handle,
	realmId: number,
	raw: string
): { scroll: Scroll; current: boolean } | null {
	const path = normalizePath(raw);
	if (path === null) return null;
	const row = db
		.select({ scrollId: scrollPaths.scrollId })
		.from(scrollPaths)
		.where(and(eq(scrollPaths.realmId, realmId), eq(scrollPaths.path, path)))
		.get();
	if (row === undefined) return null;
	const scroll = getScroll(db, row.scrollId);
	return { scroll, current: scroll.path === path };
}

// The Scroll each normalized target resolves to, old Paths included; missing targets are absent.
export function resolveScrollLinks(
	db: Handle,
	realmId: number,
	targets: string[]
): Map<string, ScrollLinkTarget> {
	if (targets.length === 0) return new Map();
	const rows = db
		.select({
			target: scrollPaths.path,
			id: scrolls.id,
			path: scrolls.path,
			title: scrolls.title
		})
		.from(scrollPaths)
		.innerJoin(scrolls, eq(scrolls.id, scrollPaths.scrollId))
		.where(and(eq(scrollPaths.realmId, realmId), inArray(scrollPaths.path, targets)))
		.all();
	return new Map(rows.map(({ target, ...scroll }) => [target, scroll]));
}

// Scrolls of the same Realm whose links name any Path this Scroll holds, by Path.
export function listBacklinks(db: Handle, scrollId: number): ScrollLinkTarget[] {
	const scroll = getScroll(db, scrollId);
	return db.all<ScrollLinkTarget>(sql`
		SELECT DISTINCT src.id AS id, src.path AS path, src.title AS title
		FROM scroll_refs r
		JOIN scrolls src ON src.id = r.scroll_id
		WHERE src.realm_id = ${scroll.realmId} AND src.id <> ${scroll.id}
			AND r.target_path IN (SELECT path FROM scroll_paths WHERE scroll_id = ${scroll.id})
		ORDER BY src.path
	`);
}

// Scrolls whose body names the Labour, in the given Realms (all when null), by Realm then Path.
export function listLabourScrolls(
	db: Handle,
	labourId: number,
	realmIds: number[] | null
): (ScrollLinkTarget & { realmId: number })[] {
	return db
		.selectDistinct({
			id: scrolls.id,
			realmId: scrolls.realmId,
			path: scrolls.path,
			title: scrolls.title
		})
		.from(scrollRefs)
		.innerJoin(scrolls, eq(scrolls.id, scrollRefs.scrollId))
		.where(
			and(
				eq(scrollRefs.labourId, labourId),
				realmIds === null ? undefined : inArray(scrolls.realmId, realmIds)
			)
		)
		.orderBy(asc(scrolls.realmId), asc(scrolls.path))
		.all();
}

export type ScrollHit = ScrollLinkTarget & { snippet: string };

export function searchScrolls(db: Handle, realmId: number, query: string, limit = 20): ScrollHit[] {
	const expression = matchExpression(query);
	if (expression === null) return [];
	return db.all<ScrollHit>(sql`
		SELECT s.id AS id, s.path AS path, s.title AS title,
			snippet(scroll_text, 1, '', '', '…', 16) AS snippet
		FROM scroll_text
		JOIN scrolls s ON s.id = scroll_text.rowid
		WHERE scroll_text MATCH ${expression} AND s.realm_id = ${realmId}
		ORDER BY bm25(scroll_text, 4, 1), s.path
		LIMIT ${limit}
	`);
}
