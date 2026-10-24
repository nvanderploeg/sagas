import { z } from 'zod';
import { DomainError } from '../../domain/errors.ts';
import { getRealm } from '../../domain/lookup.ts';
import {
	createScroll,
	deleteScroll,
	getScroll,
	listScrollChildren,
	listScrollTree,
	moveScroll,
	searchScrolls,
	updateScroll,
	type ChildChoice
} from '../../domain/scrolls.ts';
import { count, scrollLine, type Presenter } from '../present.ts';
import * as refs from '../refs.ts';
import { reply } from '../result.ts';
import { realmRef, scrollPlacementShape, scrollRef, type Tools } from '../tool.ts';

const SEARCH_MAX = 100;

function scrollReply(present: Presenter, scrollId: number) {
	const scroll = present.scroll(getScroll(present.db, scrollId));
	return reply({ scroll }, scrollLine(scroll));
}

const childList = (choice: ChildChoice) =>
	z
		.array(scrollRef)
		.min(1)
		.optional()
		.describe(`Direct children to ${choice}${choice === 'move' ? ' up to the parent' : ''}`);

export function registerScrollTools({ db, actor, define }: Tools): void {
	const realmOf = (ref: refs.Ref | undefined) =>
		ref === undefined ? undefined : refs.realmId(db, ref, actor);
	const target = (realm: refs.Ref | undefined, scroll: refs.Ref) =>
		getScroll(db, refs.scrollId(db, realmOf(realm), scroll, actor));

	define(
		'list_scrolls',
		{
			kind: 'read',
			description:
				"List a Realm's Scrolls (its wiki pages) as a tree: depth first, siblings in their order, `depth` 0 at the top level. Bodies are left out; read one with get_scroll.",
			input: { realm: realmRef }
		},
		(args, present) => {
			const realmId = refs.realmId(db, args.realm, actor);
			const scrolls = listScrollTree(db, realmId).map((node) => ({
				id: node.id,
				path: node.path,
				url: present.scrollUrl(realmId, node.path),
				title: node.title,
				depth: node.depth
			}));
			const key = getRealm(db, realmId).key;
			return reply(
				{ scrolls },
				scrolls.length === 0
					? `No Scrolls in ${key}`
					: `${count(scrolls.length, 'Scroll')} in ${key}`
			);
		}
	);

	define(
		'get_scroll',
		{
			kind: 'read',
			description:
				'Get a Scroll with its Markdown body, version, children, Backlinks (Scrolls linking to it) and the Labours its body names. A former Path resolves to the Scroll; the result shows its current Path.',
			input: {
				realm: realmRef.optional().describe('Needed when `scroll` is a Path'),
				scroll: scrollRef
			}
		},
		(args, present) => scrollReply(present, target(args.realm, args.scroll).id)
	);

	define(
		'create_scroll',
		{
			kind: 'write',
			description:
				'Create a Scroll in a Realm, last among its siblings unless placed. The Slug defaults to one made from the title. Link other Scrolls in the body with [[path]] or [[path|label]]. Needs editor access.',
			input: {
				realm: realmRef,
				title: z.string().describe('1 to 120 characters'),
				parent: scrollRef.nullable().optional().describe('Parent Scroll; top level when left out'),
				slug: z
					.string()
					.optional()
					.describe('Lowercase letters, digits and hyphens, unique among siblings'),
				body: z.string().optional().describe('Markdown, at most 100,000 characters'),
				...scrollPlacementShape
			}
		},
		(args, present) => {
			const realmId = refs.realmId(db, args.realm, actor);
			const scroll = createScroll(db, actor, {
				realmId,
				title: args.title,
				parentId:
					args.parent === undefined || args.parent === null
						? null
						: refs.scrollId(db, realmId, args.parent, actor),
				slug: args.slug,
				body: args.body,
				placement: refs.scrollPlacement(db, realmId, args, actor)
			});
			return scrollReply(present, scroll.id);
		}
	);

	define(
		'update_scroll',
		{
			kind: 'write',
			description:
				"Change a Scroll's title, Slug or body. Give the `version` you read to refuse the save if someone changed it since; without it the save overwrites. A new Slug changes the Path of the Scroll and everything under it; old Paths keep resolving. Needs editor access.",
			input: {
				realm: realmRef.optional().describe('Needed when `scroll` is a Path'),
				scroll: scrollRef,
				version: z.number().int().positive().optional().describe('The version you edited from'),
				title: z.string().optional(),
				slug: z.string().optional(),
				body: z.string().optional().describe('Markdown; replaces the whole body')
			}
		},
		(args, present) => {
			const scroll = target(args.realm, args.scroll);
			updateScroll(db, actor, scroll.id, {
				version: args.version,
				title: args.title,
				slug: args.slug,
				body: args.body
			});
			return scrollReply(present, scroll.id);
		}
	);

	define(
		'move_scroll',
		{
			kind: 'write',
			description:
				'Move a Scroll, with everything under it, to another parent in its Realm (`parent: null` for the top level; leave `parent` out to keep it), or reorder it among its siblings. It lands last unless placed. Old Paths keep resolving. Needs editor access.',
			input: {
				realm: realmRef.optional().describe('Needed when `scroll` is a Path'),
				scroll: scrollRef,
				parent: scrollRef
					.nullable()
					.optional()
					.describe('New parent Scroll; null for the top level'),
				...scrollPlacementShape
			}
		},
		(args, present) => {
			const scroll = target(args.realm, args.scroll);
			moveScroll(db, actor, scroll.id, {
				parentId:
					args.parent === undefined
						? undefined
						: args.parent === null
							? null
							: refs.scrollId(db, scroll.realmId, args.parent, actor),
				placement: refs.scrollPlacement(db, scroll.realmId, args, actor)
			});
			return scrollReply(present, scroll.id);
		}
	);

	define(
		'delete_scroll',
		{
			kind: 'destroy',
			description:
				"Delete a Scroll. Each direct child needs a choice: `move` it, with everything under it, up to the deleted Scroll's parent, or `delete` it with everything under it. List children in `move` and `delete`, and use `children` for every child not listed. A child left without a choice refuses the whole call. Needs editor access.",
			input: {
				realm: realmRef.optional().describe('Needed when `scroll` is a Path'),
				scroll: scrollRef,
				children: z
					.enum(['move', 'delete'])
					.optional()
					.describe('The choice for every direct child not listed in `move` or `delete`'),
				move: childList('move'),
				delete: childList('delete')
			}
		},
		(args) => {
			const scroll = target(args.realm, args.scroll);
			const children = listScrollChildren(db, scroll.id);
			const choices = new Map<number, ChildChoice>();
			const lists: [ChildChoice, refs.Ref[] | undefined][] = [
				['move', args.move],
				['delete', args.delete]
			];
			for (const [choice, list] of lists) {
				for (const ref of list ?? []) {
					const childId = refs.scrollId(db, scroll.realmId, ref, actor);
					const child = children.find((c) => c.id === childId);
					if (child === undefined) {
						throw new DomainError(
							'invalid',
							`${getScroll(db, childId).path} is not a direct child of ${scroll.path}`
						);
					}
					if ((choices.get(childId) ?? choice) !== choice) {
						throw new DomainError('invalid', `${child.path} is listed in both move and delete`);
					}
					choices.set(childId, choice);
				}
			}
			if (args.children !== undefined) {
				for (const child of children) {
					if (!choices.has(child.id)) choices.set(child.id, args.children);
				}
			}
			const result = deleteScroll(db, actor, scroll.id, choices);
			const deleted = result.deleted.map((row) => row.path);
			const moved = result.moved.map((change) => ({ from: change.previousPath, to: change.path }));
			const also = deleted.length > 1 ? ` and ${count(deleted.length - 1, 'Scroll')} under it` : '';
			const up = moved.length > 0 ? `; ${count(moved.length, 'Path')} changed` : '';
			return reply({ deleted, moved }, `Deleted Scroll ${scroll.path}${also}${up}`);
		}
	);

	define(
		'search_scrolls',
		{
			kind: 'read',
			description:
				"Full-text search over the titles and bodies of a Realm's Scrolls, best match first; a title match counts more than a body match.",
			input: {
				realm: realmRef,
				query: z.string().trim().min(1).describe('Words to find'),
				limit: z
					.number()
					.int()
					.min(1)
					.max(SEARCH_MAX)
					.default(20)
					.describe(`At most this many, 1 to ${SEARCH_MAX}`)
			}
		},
		(args, present) => {
			const realmId = refs.realmId(db, args.realm, actor);
			const scrolls = searchScrolls(db, realmId, args.query, args.limit).map((hit) => ({
				id: hit.id,
				path: hit.path,
				url: present.scrollUrl(realmId, hit.path),
				title: hit.title,
				snippet: hit.snippet
			}));
			return reply(
				{ scrolls },
				`${scrolls.length === 0 ? 'No Scrolls' : count(scrolls.length, 'Scroll')} match "${args.query}"`
			);
		}
	);
}
