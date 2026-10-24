import { inArray } from 'drizzle-orm';
import type { Handle } from '../db/client.ts';
import { users } from '../db/schema.ts';
import { accessEnforced, atLeast, memberRole, requireRealmRole } from '../domain/access.ts';
import { getRealm } from '../domain/lookup.ts';
import {
	countDescendants,
	getScroll,
	listBacklinks,
	listScrollChildren,
	listScrollTree,
	readScroll,
	resolveScrollLinks,
	searchScrolls,
	type ScrollLinkTarget,
	type ScrollNode
} from '../domain/scrolls.ts';
import { lastSegment, normalizePath, parentPath } from '../../ui/scroll-path.ts';
import { scrollLinks } from '../../ui/markdown.ts';

type Viewer = { id: number };

export type ScrollRealm = { id: number; key: string; name: string };

function realmOf(db: Handle, viewer: Viewer, realmId: number) {
	requireRealmRole(db, viewer, realmId, 'viewer');
	const { id, key, name } = getRealm(db, realmId);
	const role = memberRole(db, realmId, viewer.id);
	return {
		realm: { id, key, name } satisfies ScrollRealm,
		canEdit: !accessEnforced() || (role !== null && atLeast(role, 'editor'))
	};
}

const withCounts = (db: Handle, nodes: ScrollNode[]) => {
	const counts = countDescendants(
		db,
		nodes.map((node) => node.id)
	);
	return nodes.map((node) => ({ ...node, descendants: counts.get(node.id) ?? 0 }));
};

export function readScrollIndex(db: Handle, viewer: Viewer, realmId: number, query: string) {
	const tree = listScrollTree(db, realmId);
	return {
		...realmOf(db, viewer, realmId),
		tree,
		top: withCounts(
			db,
			tree.filter((node) => node.depth === 0)
		),
		query,
		hits: query.trim() === '' ? null : searchScrolls(db, realmId, query)
	};
}

function names(db: Handle, ids: number[]): Map<number, string> {
	return new Map(
		db
			.select({ id: users.id, displayName: users.displayName })
			.from(users)
			.where(inArray(users.id, ids))
			.all()
			.map((row) => [row.id, row.displayName])
	);
}

export function readScrollPage(db: Handle, viewer: Viewer, scrollId: number) {
	const scroll = readScroll(db, scrollId);
	const base = realmOf(db, viewer, scroll.realmId);
	const ancestors: ScrollLinkTarget[] = [];
	for (let at = scroll.parentId; at !== null;) {
		const parent = getScroll(db, at);
		ancestors.unshift({ id: parent.id, path: parent.path, title: parent.title });
		at = parent.parentId;
	}
	const people = names(db, [scroll.createdById, scroll.updatedById]);
	const targets = scrollLinks(scroll.body).map((link) => link.target);
	return {
		...base,
		tree: listScrollTree(db, scroll.realmId),
		scroll,
		ancestors,
		children: withCounts(db, listScrollChildren(db, scrollId)),
		backlinks: listBacklinks(db, scrollId),
		links: Object.fromEntries(resolveScrollLinks(db, scroll.realmId, targets)),
		createdBy: people.get(scroll.createdById) ?? 'Someone',
		updatedBy: people.get(scroll.updatedById) ?? 'Someone'
	};
}

export function readMissingScroll(db: Handle, viewer: Viewer, realmId: number, raw: string) {
	const path = normalizePath(raw) ?? 'page';
	let parent: ScrollLinkTarget | null = null;
	for (let at = parentPath(path); at !== null && parent === null; at = parentPath(at)) {
		const found = resolveScrollLinks(db, realmId, [at]).get(at);
		if (found && found.path === at) parent = found;
	}
	const slug = lastSegment(path);
	return {
		...realmOf(db, viewer, realmId),
		tree: listScrollTree(db, realmId),
		path,
		parent,
		slug,
		title: slug.replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase())
	};
}
