import { and, asc, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import { generateNKeysBetween } from 'fractional-indexing';
import type { Db, Handle } from '../db/client.ts';
import { scrollPaths, scrollRefs, scrolls, scrollText, users } from '../db/schema.ts';
import { mentionTargets } from '../agent/mentions.ts';
import { tsQuery } from '../agent/search.ts';
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

async function editable(tx: Handle, actor: Actor, scrollId: number): Promise<Scroll> {
	const scroll = await getScroll(tx, scrollId);
	await requireRealmRole(tx, actor, scroll.realmId, 'editor');
	return scroll;
}

async function parentIn(tx: Handle, realmId: number, parentId: number): Promise<Scroll> {
	const parent = await getScroll(tx, parentId);
	if (parent.realmId !== realmId) {
		throw new DomainError('invalid', 'The parent Scroll is in another Realm');
	}
	return parent;
}

async function siblings(tx: Handle, realmId: number, parentId: number | null) {
	return await tx
		.select({ id: scrolls.id, rank: scrolls.rank, slug: scrolls.slug, path: scrolls.path })
		.from(scrolls)
		.where(
			and(
				eq(scrolls.realmId, realmId),
				parentId === null ? isNull(scrolls.parentId) : eq(scrolls.parentId, parentId)
			)
		)
		.orderBy(asc(scrolls.rank));
}

// The Scroll and everything under it, the Scroll first.
async function subtree(tx: Handle, rootId: number): Promise<{ id: number; path: string }[]> {
	return (
		await tx.execute<{ id: number; path: string }>(sql`
		WITH RECURSIVE t(id) AS (
			SELECT ${rootId}::int UNION ALL SELECT s.id FROM scrolls s JOIN t ON s.parent_id = t.id
		)
		SELECT scrolls.id AS id, scrolls.path AS path FROM t JOIN scrolls ON scrolls.id = t.id
		ORDER BY length(scrolls.path), scrolls.path
	`)
	).rows;
}

async function requireFreePath(
	tx: Handle,
	realmId: number,
	path: string,
	self: number | null
): Promise<void> {
	const taken = (
		await tx
			.select({ id: scrolls.id })
			.from(scrolls)
			.where(
				and(
					eq(scrolls.realmId, realmId),
					eq(scrolls.path, path),
					self === null ? undefined : ne(scrolls.id, self)
				)
			)
			.limit(1)
	)[0];
	if (taken !== undefined)
		throw new DomainError('conflict', `A Scroll already has the Path ${path}`);
}

function requireDepth(path: string, below = 0): void {
	if (depthOf(path) + below > DEPTH_MAX) {
		throw new DomainError('invalid', `Scrolls nest at most ${DEPTH_MAX} deep`);
	}
}

// Placement anchors must be siblings; checked here so rankAt never words them as Labours.
async function siblingRank(
	tx: Handle,
	column: { id: number; rank: string; path: string }[],
	subject: { id: number | null; rank?: string },
	placement: Placement
): Promise<string> {
	if (typeof placement === 'object') {
		const anchor = 'before' in placement ? placement.before : placement.after;
		if (anchor === subject.id) {
			throw new DomainError('invalid', 'A Scroll cannot be placed relative to itself');
		}
		if (!column.some((entry) => entry.id === anchor)) {
			const path = (
				await tx.select({ path: scrolls.path }).from(scrolls).where(eq(scrolls.id, anchor)).limit(1)
			)[0];
			throw new DomainError(
				'invalid',
				`${path ? `Scroll ${path.path}` : `Scroll ${anchor}`} is not a sibling`
			);
		}
	}
	return rankAt(column, subject, placement, 'Scroll');
}

async function holdPath(
	tx: Handle,
	realmId: number,
	path: string,
	scrollId: number
): Promise<void> {
	await tx
		.insert(scrollPaths)
		.values({ realmId, path, scrollId })
		.onConflictDoUpdate({
			target: [scrollPaths.realmId, scrollPaths.path],
			set: { scrollId, createdAt: new Date() }
		});
}

// Rewrites the Path of the root and everything under it; old Paths stay with their Scrolls.
async function repath(
	tx: Handle,
	realmId: number,
	rootId: number,
	rootPath: string
): Promise<PathChange[]> {
	const rows = await subtree(tx, rootId);
	const oldRoot = rows[0].path;
	if (oldRoot === rootPath) return [];
	const changes = rows.map((row) => ({
		id: row.id,
		previousPath: row.path,
		path: rootPath + row.path.slice(oldRoot.length)
	}));
	for (const change of changes) {
		await tx.update(scrolls).set({ path: change.path }).where(eq(scrolls.id, change.id));
		await holdPath(tx, realmId, change.path, change.id);
	}
	return changes;
}

async function deepestBelow(tx: Handle, rootId: number): Promise<number> {
	const rows = await subtree(tx, rootId);
	const base = depthOf(rows[0].path);
	return Math.max(...rows.map((row) => depthOf(row.path) - base));
}

async function refreshText(
	tx: Handle,
	scroll: { id: number; title: string; body: string }
): Promise<void> {
	const row = { title: scroll.title, body: scroll.body };
	await tx
		.insert(scrollText)
		.values({ scrollId: scroll.id, ...row })
		.onConflictDoUpdate({ target: scrollText.scrollId, set: row });
}

type RefKey = { targetPath: string | null; labourId: number | null; userId: number | null };
const refKey = (ref: RefKey) => `${ref.targetPath ?? ''}|${ref.labourId ?? 0}|${ref.userId ?? 0}`;

// Kept rows keep their firstSeenAt.
async function refreshRefs(tx: Handle, scrollId: number, body: string, now: Date): Promise<void> {
	const named = await mentionTargets(tx, body);
	const wanted: RefKey[] = [
		...scrollLinks(body).map((link) => ({ targetPath: link.target, labourId: null, userId: null })),
		...[...named.labourIds].map((labourId) => ({ targetPath: null, labourId, userId: null })),
		...[...named.userIds].map((userId) => ({ targetPath: null, labourId: null, userId }))
	];
	const wantedKeys = new Set(wanted.map(refKey));
	const held = await tx.select().from(scrollRefs).where(eq(scrollRefs.scrollId, scrollId));
	const heldKeys = new Set(held.map(refKey));
	const gone = held.filter((row) => !wantedKeys.has(refKey(row))).map((row) => row.id);
	if (gone.length > 0) await tx.delete(scrollRefs).where(inArray(scrollRefs.id, gone));
	const fresh = wanted.filter((ref) => !heldKeys.has(refKey(ref)));
	if (fresh.length > 0) {
		await tx
			.insert(scrollRefs)
			.values(fresh.map((ref) => ({ ...ref, scrollId, firstSeenAt: now })));
	}
}

export async function createScroll(db: Db, actor: Actor, input: ScrollSpec): Promise<ScrollView> {
	const title = requireText(input.title, 'Scroll title', TITLE_MAX);
	const slug = checkSlug(input.slug?.trim() || slugify(title));
	const body = checkBody(input.body ?? '');
	return write(db, actor, async (tx) => {
		await getRealm(tx, input.realmId);
		await requireRealmRole(tx, actor, input.realmId, 'editor');
		const parentId = input.parentId ?? null;
		const parent = parentId === null ? null : await parentIn(tx, input.realmId, parentId);
		const path = join(parent?.path ?? null, slug);
		requireDepth(path);
		await requireFreePath(tx, input.realmId, path, null);
		const rank = await siblingRank(
			tx,
			await siblings(tx, input.realmId, parentId),
			{ id: null },
			input.placement ?? 'bottom'
		);
		const now = new Date();
		const { id } = (
			await tx
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
		)[0];
		await holdPath(tx, input.realmId, path, id);
		await refreshText(tx, { id, title, body });
		await refreshRefs(tx, id, body, now);
		const scroll = await readScroll(tx, id);
		return { value: scroll, events: [{ type: 'scroll.created', data: { scroll } }] };
	});
}

async function staleVersion(tx: Handle, scroll: Scroll, version: number): Promise<DomainError> {
	const by = (
		await tx
			.select({ username: users.username })
			.from(users)
			.where(eq(users.id, scroll.updatedById))
			.limit(1)
	)[0];
	return new DomainError(
		'conflict',
		`This Scroll changed after version ${version}: it is at version ${scroll.version}, saved by ${by?.username ?? 'someone'}`
	);
}

export async function updateScroll(
	db: Db,
	actor: Actor,
	scrollId: number,
	patch: ScrollPatch
): Promise<ScrollView> {
	return write(db, actor, async (tx) => {
		const scroll = await editable(tx, actor, scrollId);
		if (patch.version !== undefined && patch.version !== scroll.version) {
			throw await staleVersion(tx, scroll, patch.version);
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
			const parentPath =
				scroll.parentId === null ? null : (await getScroll(tx, scroll.parentId)).path;
			const path = join(parentPath, slug);
			await requireFreePath(tx, scroll.realmId, path, scroll.id);
			await tx.update(scrolls).set({ slug }).where(eq(scrolls.id, scrollId));
			paths = await repath(tx, scroll.realmId, scrollId, path);
		}
		await tx
			.update(scrolls)
			.set({ title, body, version: scroll.version + 1, updatedById: actor.id, updatedAt: now })
			.where(eq(scrolls.id, scrollId));
		if (textChanged) await refreshText(tx, { id: scrollId, title, body });
		if (body !== scroll.body) await refreshRefs(tx, scrollId, body, now);

		const view = await readScroll(tx, scrollId);
		const events: EventSpec[] = [];
		if (textChanged) events.push({ type: 'scroll.updated', data: { scroll: view } });
		if (paths.length > 0) events.push({ type: 'scroll.moved', data: { scroll: view, paths } });
		return { value: view, events };
	});
}

export async function moveScroll(
	db: Db,
	actor: Actor,
	scrollId: number,
	move: ScrollMove
): Promise<ScrollView> {
	if (move.parentId === undefined && move.placement === undefined) {
		throw new DomainError('invalid', 'Give a parent or a placement');
	}
	return write(db, actor, async (tx) => {
		const scroll = await editable(tx, actor, scrollId);
		const parentId = move.parentId === undefined ? scroll.parentId : move.parentId;
		const placement = move.placement ?? 'bottom';

		if (parentId === scroll.parentId) {
			const rank = await siblingRank(
				tx,
				await siblings(tx, scroll.realmId, parentId),
				scroll,
				placement
			);
			if (rank === scroll.rank) return { value: scroll, events: [] };
			await tx.update(scrolls).set({ rank }).where(eq(scrolls.id, scrollId));
			const view = await readScroll(tx, scrollId);
			return { value: view, events: [{ type: 'scroll.moved', data: { scroll: view, paths: [] } }] };
		}

		const parent = parentId === null ? null : await parentIn(tx, scroll.realmId, parentId);
		if (parent !== null && (await subtree(tx, scrollId)).some((row) => row.id === parent.id)) {
			throw new DomainError('invalid', 'A Scroll cannot move under itself or a Scroll beneath it');
		}
		const path = join(parent?.path ?? null, scroll.slug);
		requireDepth(path, await deepestBelow(tx, scrollId));
		await requireFreePath(tx, scroll.realmId, path, scroll.id);
		const rank = await siblingRank(
			tx,
			await siblings(tx, scroll.realmId, parentId),
			{ id: scroll.id },
			placement
		);
		await tx.update(scrolls).set({ parentId, rank }).where(eq(scrolls.id, scrollId));
		const paths = await repath(tx, scroll.realmId, scrollId, path);
		const view = await readScroll(tx, scrollId);
		return { value: view, events: [{ type: 'scroll.moved', data: { scroll: view, paths } }] };
	});
}

// Every direct child needs a choice, per docs/scrolls.md.
export async function deleteScroll(
	db: Db,
	actor: Actor,
	scrollId: number,
	choices: Map<number, ChildChoice> = new Map()
): Promise<ScrollDeletion> {
	return write(db, actor, async (tx) => {
		const scroll = await editable(tx, actor, scrollId);
		const children = await siblings(tx, scroll.realmId, scroll.id);
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
		const level = await siblings(tx, scroll.realmId, scroll.parentId);
		const parentPath =
			scroll.parentId === null ? null : (await getScroll(tx, scroll.parentId)).path;
		for (const mover of movers) {
			const clash = level.find((s) => s.id !== scroll.id && s.slug === mover.slug);
			if (clash) {
				throw new DomainError(
					'conflict',
					`${mover.path} cannot move up: ${clash.path} already has its Path`
				);
			}
		}

		const doomed = [{ id: scroll.id, path: scroll.path }];
		for (const child of children) {
			if (choices.get(child.id) === 'delete') doomed.push(...(await subtree(tx, child.id)));
		}

		const moved: ScrollDeletion['moved'] = [];
		if (movers.length > 0) {
			// Ranks after the deleted Scroll's and before its next sibling take its place once it goes.
			const at = level.findIndex((s) => s.id === scroll.id);
			const ranks = generateNKeysBetween(scroll.rank, level[at + 1]?.rank ?? null, movers.length);
			for (const [i, mover] of movers.entries()) {
				await tx
					.update(scrolls)
					.set({ parentId: scroll.parentId, rank: ranks[i] })
					.where(eq(scrolls.id, mover.id));
				const changes = await repath(tx, scroll.realmId, mover.id, join(parentPath, mover.slug));
				for (const change of changes) {
					moved.push({
						...change,
						parentId:
							change.id === mover.id ? scroll.parentId : (await getScroll(tx, change.id)).parentId
					});
				}
			}
		}

		const ids = doomed.map((row) => row.id);
		await tx.delete(scrolls).where(inArray(scrolls.id, ids));
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
export async function listScrollTree(db: Handle, realmId: number): Promise<ScrollNode[]> {
	const rows = await db
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
		.orderBy(asc(scrolls.rank));
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

export async function listScrollChildren(db: Handle, scrollId: number): Promise<ScrollNode[]> {
	const scroll = await getScroll(db, scrollId);
	const depth = depthOf(scroll.path);
	return (
		await db
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
	).map((row) => ({ ...row, depth }));
}

export async function countDescendants(
	db: Handle,
	scrollIds: number[]
): Promise<Map<number, number>> {
	return new Map(
		await Promise.all(
			scrollIds.map(async (id): Promise<[number, number]> => [
				id,
				(await subtree(db, id)).length - 1
			])
		)
	);
}

// `current` is false when the Path is one the Scroll held before.
export async function resolveScrollPath(
	db: Handle,
	realmId: number,
	raw: string
): Promise<{ scroll: Scroll; current: boolean } | null> {
	const path = normalizePath(raw);
	if (path === null) return null;
	const row = (
		await db
			.select({ scrollId: scrollPaths.scrollId })
			.from(scrollPaths)
			.where(and(eq(scrollPaths.realmId, realmId), eq(scrollPaths.path, path)))
			.limit(1)
	)[0];
	if (row === undefined) return null;
	const scroll = await getScroll(db, row.scrollId);
	return { scroll, current: scroll.path === path };
}

// The Scroll each normalized target resolves to, old Paths included; missing targets are absent.
export async function resolveScrollLinks(
	db: Handle,
	realmId: number,
	targets: string[]
): Promise<Map<string, ScrollLinkTarget>> {
	if (targets.length === 0) return new Map();
	const rows = await db
		.select({
			target: scrollPaths.path,
			id: scrolls.id,
			path: scrolls.path,
			title: scrolls.title
		})
		.from(scrollPaths)
		.innerJoin(scrolls, eq(scrolls.id, scrollPaths.scrollId))
		.where(and(eq(scrollPaths.realmId, realmId), inArray(scrollPaths.path, targets)));
	return new Map(rows.map(({ target, ...scroll }) => [target, scroll]));
}

// Scrolls of the same Realm whose links name any Path this Scroll holds, by Path.
export async function listBacklinks(db: Handle, scrollId: number): Promise<ScrollLinkTarget[]> {
	const scroll = await getScroll(db, scrollId);
	return (
		await db.execute<ScrollLinkTarget>(sql`
		SELECT DISTINCT src.id AS id, src.path AS path, src.title AS title
		FROM scroll_refs r
		JOIN scrolls src ON src.id = r.scroll_id
		WHERE src.realm_id = ${scroll.realmId} AND src.id <> ${scroll.id}
			AND r.target_path IN (SELECT path FROM scroll_paths WHERE scroll_id = ${scroll.id})
		ORDER BY src.path
	`)
	).rows;
}

// Scrolls whose body names the Labour, in the given Realms (all when null), by Realm then Path.
export async function listLabourScrolls(
	db: Handle,
	labourId: number,
	realmIds: number[] | null
): Promise<(ScrollLinkTarget & { realmId: number })[]> {
	return await db
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
		.orderBy(asc(scrolls.realmId), asc(scrolls.path));
}

export type ScrollHit = ScrollLinkTarget & { snippet: string };

export async function searchScrolls(
	db: Handle,
	realmId: number,
	query: string,
	limit = 20
): Promise<ScrollHit[]> {
	const expression = tsQuery(query);
	if (expression === null) return [];
	return (
		await db.execute<ScrollHit>(sql`
		SELECT s.id AS id, s.path AS path, s.title AS title,
			ts_headline('sagas_english', t.body, q,
				'StartSel=, StopSel=, MaxWords=16, MinWords=8, ShortWord=0, FragmentDelimiter=…') AS snippet
		FROM scroll_text t
		JOIN scrolls s ON s.id = t.scroll_id, to_tsquery('sagas_english', ${expression}) q
		WHERE t.search @@ q AND s.realm_id = ${realmId}
		ORDER BY ts_rank_cd('{0.1, 0.1, 0.25, 1.0}'::float4[], t.search, q, 1) DESC, s.path
		LIMIT ${limit}
	`)
	).rows;
}
