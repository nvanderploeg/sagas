import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import type { Db } from '#lib/server/db/client.ts';
import { eventsSince } from '#lib/server/events/log.ts';
import { seedActor, seedLabour, seedRealm, seedUser, TODO } from '#lib/server/test/fixtures.ts';
import { testDb } from '#lib/server/test/db.ts';
import { acceptOffer, offerMembership } from './memberships.ts';
import { setAccessEnforced } from './access.ts';
import { DomainError } from './errors.ts';
import { createRealm, deleteRealm } from './realms.ts';
import {
	BODY_MAX,
	createScroll,
	deleteScroll,
	listBacklinks,
	listLabourScrolls,
	listScrollTree,
	moveScroll,
	readScroll,
	resolveScrollPath,
	searchScrolls,
	updateScroll,
	type ChildChoice
} from './scrolls.ts';
import type { Actor } from './write.ts';

let db: Db;
let actor: Actor;
let realmId: number;

beforeEach(() => {
	db = testDb();
	actor = seedActor(db);
	realmId = seedRealm(db, 'AM').id;
});

afterEach(() => {
	db.$client.close();
});

function errorOf(action: () => unknown): DomainError {
	try {
		action();
	} catch (error) {
		if (error instanceof DomainError) return error;
		throw error;
	}
	throw new Error('expected a DomainError');
}

const make = (
	title: string,
	parentId: number | null = null,
	extra: { body?: string; slug?: string } = {}
) => createScroll(db, actor, { realmId, title, parentId, ...extra });
const tree = () =>
	listScrollTree(db, realmId).map((node) => `${'  '.repeat(node.depth)}${node.path}`);
const lastEvents = (since: number) => eventsSince(db, since);
const seqNow = () => eventsSince(db, 0).at(-1)?.seq ?? 0;
const choices = (entries: [number, ChildChoice][]) => new Map(entries);
const textRows = () => db.all<{ rowid: number }>(sql`SELECT rowid FROM scroll_text ORDER BY rowid`);

describe('creating a Scroll', () => {
	it('makes its slug from the title and its Path from its ancestors', () => {
		const ops = make('Ops & Releases');
		const release = make('Release process', ops.id);

		expect(ops).toMatchObject({ slug: 'ops-releases', path: 'ops-releases', version: 1 });
		expect(release.path).toBe('ops-releases/release-process');
		expect(resolveScrollPath(db, realmId, 'Ops-Releases/Release Process')).toMatchObject({
			scroll: { id: release.id },
			current: true
		});
	});

	it('records scroll.created with the whole Scroll', () => {
		const before = seqNow();
		const scroll = make('Home', null, { body: 'Hello' });
		expect(lastEvents(before)).toMatchObject([
			{ type: 'scroll.created', data: { scroll: { id: scroll.id, body: 'Hello', path: 'home' } } }
		]);
	});

	it('refuses a Path a sibling already holds', () => {
		make('Home');
		expect(errorOf(() => make('home!')).code).toBe('conflict');
	});

	it('refuses a bad slug, an empty title and an overlong body', () => {
		expect(errorOf(() => make('Home', null, { slug: 'Bad Slug' })).code).toBe('invalid');
		expect(errorOf(() => make('  ')).code).toBe('invalid');
		expect(errorOf(() => make('Big', null, { body: 'x'.repeat(BODY_MAX + 1) })).code).toBe(
			'invalid'
		);
	});

	it('nests at most ten deep', () => {
		let parent: number | null = null;
		for (let i = 0; i < 10; i++) parent = make(`L${i}`, parent).id;
		expect(errorOf(() => make('Too deep', parent)).message).toMatch(/at most 10 deep/);
	});

	it('refuses a parent in another Realm', () => {
		const other = seedRealm(db, 'BO').id;
		const elsewhere = createScroll(db, actor, { realmId: other, title: 'There' });
		expect(errorOf(() => make('Here', elsewhere.id)).code).toBe('invalid');
	});

	it('orders siblings by placement, new ones last', () => {
		const b = make('B');
		make('C');
		createScroll(db, actor, { realmId, title: 'A', placement: { before: b.id } });
		expect(tree()).toEqual(['a', 'b', 'c']);
	});
});

describe('editing a Scroll', () => {
	it('bumps the version and records who saved it', () => {
		const editor = { id: seedUser(db, 'bea') };
		const scroll = make('Home');
		const saved = updateScroll(db, editor, scroll.id, { body: 'New', version: 1 });
		expect(saved).toMatchObject({ body: 'New', version: 2, updatedById: editor.id });
	});

	it('refuses a save from an older version, naming who saved since, and changes nothing', () => {
		const scroll = make('Home');
		updateScroll(db, { id: seedUser(db, 'bea') }, scroll.id, { body: 'Theirs', version: 1 });

		const error = errorOf(() => updateScroll(db, actor, scroll.id, { body: 'Mine', version: 1 }));
		expect(error.code).toBe('conflict');
		expect(error.message).toMatch(/version 2, saved by bea/);
		expect(readScroll(db, scroll.id).body).toBe('Theirs');
	});

	it('saves over whatever is there when no version is given', () => {
		const scroll = make('Home');
		updateScroll(db, actor, scroll.id, { body: 'One' });
		expect(updateScroll(db, actor, scroll.id, { body: 'Two' }).version).toBe(3);
	});

	it('records nothing when nothing changes', () => {
		const scroll = make('Home');
		const before = seqNow();
		updateScroll(db, actor, scroll.id, { title: 'Home', body: '' });
		expect(lastEvents(before)).toEqual([]);
	});

	it('renames the slug, repaths everything under it and keeps the old Paths resolving', () => {
		const ops = make('Ops');
		const release = make('Release', ops.id);
		const before = seqNow();

		updateScroll(db, actor, ops.id, { title: 'Operations', slug: 'operations' });

		expect(tree()).toEqual(['operations', '  operations/release']);
		expect(resolveScrollPath(db, realmId, 'ops/release')).toMatchObject({
			scroll: { id: release.id, path: 'operations/release' },
			current: false
		});
		expect(lastEvents(before).map((e) => e.type)).toEqual(['scroll.updated', 'scroll.moved']);
		expect(lastEvents(before)[1].data).toMatchObject({
			paths: [
				{ id: ops.id, previousPath: 'ops', path: 'operations' },
				{ id: release.id, previousPath: 'ops/release', path: 'operations/release' }
			]
		});
	});

	it('lets a new Scroll take over a Path another Scroll only held before', () => {
		const old = make('Guide');
		updateScroll(db, actor, old.id, { slug: 'handbook' });
		const fresh = make('Guide');

		expect(resolveScrollPath(db, realmId, 'guide')).toMatchObject({
			scroll: { id: fresh.id },
			current: true
		});
		expect(resolveScrollPath(db, realmId, 'handbook')?.scroll.id).toBe(old.id);
	});
});

describe('moving a Scroll', () => {
	it('moves it under another Scroll with everything beneath it', () => {
		const a = make('A');
		const b = make('B');
		const child = make('Child', b.id);
		const before = seqNow();

		moveScroll(db, actor, b.id, { parentId: a.id });

		expect(tree()).toEqual(['a', '  a/b', '    a/b/child']);
		expect(resolveScrollPath(db, realmId, 'b/child')?.scroll.id).toBe(child.id);
		expect(lastEvents(before)).toMatchObject([
			{ type: 'scroll.moved', data: { scroll: { id: b.id } } }
		]);
	});

	it('never moves a Scroll under itself or beneath itself', () => {
		const a = make('A');
		const b = make('B', a.id);
		expect(errorOf(() => moveScroll(db, actor, a.id, { parentId: a.id })).code).toBe('invalid');
		expect(errorOf(() => moveScroll(db, actor, a.id, { parentId: b.id })).code).toBe('invalid');
	});

	it('refuses a move onto a sibling Path', () => {
		const a = make('A');
		make('Same', a.id);
		const loose = make('Same');
		expect(errorOf(() => moveScroll(db, actor, loose.id, { parentId: a.id })).code).toBe(
			'conflict'
		);
	});

	it('refuses a move that would nest deeper than ten', () => {
		let parent: number | null = null;
		for (let i = 0; i < 9; i++) parent = make(`L${i}`, parent).id;
		const branch = make('Branch');
		make('Leaf', branch.id);
		expect(errorOf(() => moveScroll(db, actor, branch.id, { parentId: parent })).message).toMatch(
			/at most 10 deep/
		);
	});

	it('reorders siblings with an empty paths list', () => {
		const a = make('A');
		const b = make('B');
		const before = seqNow();
		moveScroll(db, actor, b.id, { placement: { before: a.id } });
		expect(tree()).toEqual(['b', 'a']);
		expect(lastEvents(before)).toMatchObject([{ type: 'scroll.moved', data: { paths: [] } }]);
	});

	it('refuses a placement next to a Scroll that is not a sibling', () => {
		const a = make('A');
		const inner = make('Inner', a.id);
		const b = make('B');
		expect(
			errorOf(() => moveScroll(db, actor, b.id, { placement: { after: inner.id } })).message
		).toMatch(/a\/inner is not a sibling/);
	});
});

describe('deleting a Scroll', () => {
	it('deletes a leaf Scroll and its Paths', () => {
		const leaf = make('Leaf');
		deleteScroll(db, actor, leaf.id);
		expect(tree()).toEqual([]);
		expect(resolveScrollPath(db, realmId, 'leaf')).toBeNull();
		expect(textRows()).toEqual([]);
	});

	it('refuses until every child has a choice, and changes nothing', () => {
		const parent = make('Parent');
		const one = make('One', parent.id);
		make('Two', parent.id);

		const error = errorOf(() => deleteScroll(db, actor, parent.id, choices([[one.id, 'move']])));
		expect(error.message).toMatch(/parent\/two/);
		expect(tree()).toHaveLength(3);
	});

	it('refuses a choice for a Scroll that is not a direct child', () => {
		const parent = make('Parent');
		const child = make('Child', parent.id);
		const grandchild = make('Grandchild', child.id);
		expect(
			errorOf(() =>
				deleteScroll(
					db,
					actor,
					parent.id,
					choices([
						[child.id, 'move'],
						[grandchild.id, 'move']
					])
				)
			).code
		).toBe('invalid');
	});

	it('moves some children up into its place and deletes the others with what is under them', () => {
		make('Before');
		const parent = make('Parent');
		make('After');
		const keep = make('Keep', parent.id);
		const kept = make('Kept leaf', keep.id);
		const drop = make('Drop', parent.id);
		const dropped = make('Dropped leaf', drop.id);
		const also = make('Also', parent.id);
		const before = seqNow();

		const result = deleteScroll(
			db,
			actor,
			parent.id,
			choices([
				[keep.id, 'move'],
				[drop.id, 'delete'],
				[also.id, 'move']
			])
		);

		expect(tree()).toEqual(['before', 'keep', '  keep/kept-leaf', 'also', 'after']);
		expect(result.deleted.map((d) => d.id).sort()).toEqual([parent.id, drop.id, dropped.id].sort());
		expect(resolveScrollPath(db, realmId, 'parent/keep/kept-leaf')?.scroll.id).toBe(kept.id);
		expect(textRows().map((r) => r.rowid)).not.toContain(dropped.id);
		expect(lastEvents(before)).toMatchObject([
			{
				type: 'scroll.deleted',
				data: {
					realmId,
					moved: [
						{ id: keep.id, parentId: null, previousPath: 'parent/keep', path: 'keep' },
						{ id: kept.id, parentId: keep.id, path: 'keep/kept-leaf' },
						{ id: also.id, parentId: null, path: 'also' }
					]
				}
			}
		]);
	});

	it('refuses to move a child up onto a Path already taken there', () => {
		make('Notes');
		const parent = make('Parent');
		const notes = make('Notes', parent.id);
		const error = errorOf(() => deleteScroll(db, actor, parent.id, choices([[notes.id, 'move']])));
		expect(error.code).toBe('conflict');
		expect(error.message).toMatch(/parent\/notes cannot move up/);
		expect(tree()).toHaveLength(3);
	});

	it('goes with its Realm, search index included', () => {
		make('Home');
		deleteRealm(db, actor, realmId);
		expect(textRows()).toEqual([]);
	});
});

describe('links and Backlinks', () => {
	it('counts a link written before its target existed', () => {
		const index = make('Index', null, { body: 'See [[Guides/Setup]] and `[[not/this]]`.' });
		const guides = make('Guides');
		const setup = make('Setup', guides.id);
		expect(listBacklinks(db, setup.id)).toEqual([{ id: index.id, path: 'index', title: 'Index' }]);
	});

	it('follows a Scroll through renames, by any Path it held', () => {
		const target = make('Target');
		const source = make('Source', null, { body: '[[target]]' });
		updateScroll(db, actor, target.id, { slug: 'renamed' });
		expect(listBacklinks(db, target.id).map((s) => s.id)).toEqual([source.id]);
	});

	it('drops a Backlink when the link leaves the body', () => {
		const target = make('Target');
		const source = make('Source', null, { body: '[[target]]' });
		updateScroll(db, actor, source.id, { body: 'nothing' });
		expect(listBacklinks(db, target.id)).toEqual([]);
	});

	it('records Labours the body names, by key', () => {
		const labour = seedLabour(db, { realmId });
		const scroll = make('Notes', null, { body: `Tracking ${labour.key.toLowerCase()} here.` });
		expect(listLabourScrolls(db, labour.id, null)).toEqual([
			{ id: scroll.id, realmId, path: 'notes', title: 'Notes' }
		]);
		expect(listLabourScrolls(db, labour.id, [])).toEqual([]);
	});
});

describe('search', () => {
	it('finds Scrolls in one Realm by title and body, title first', () => {
		const inBody = make('Notes', null, { body: 'How we deploy the server' });
		const inTitle = make('Deploying');
		createScroll(db, actor, { realmId: seedRealm(db, 'BO').id, title: 'Deploy elsewhere' });

		const hits = searchScrolls(db, realmId, 'deploy');
		expect(hits.map((h) => h.id)).toEqual([inTitle.id, inBody.id]);
		expect(hits[1].snippet).toContain('deploy');
	});

	it('follows edits', () => {
		const scroll = make('Notes', null, { body: 'alpha' });
		updateScroll(db, actor, scroll.id, { body: 'beta' });
		expect(searchScrolls(db, realmId, 'alpha')).toEqual([]);
		expect(searchScrolls(db, realmId, 'beta').map((h) => h.id)).toEqual([scroll.id]);
	});
});

describe('access', () => {
	let viewer: Actor;
	let stranger: Actor;
	let owned: number;

	beforeEach(() => {
		setAccessEnforced(true);
		viewer = { id: seedUser(db, 'viewer') };
		stranger = { id: seedUser(db, 'stranger') };
		owned = createRealm(db, actor, { name: 'Private', key: 'PV', initialState: TODO }).id;
		offerMembership(db, actor, owned, viewer.id, 'viewer');
		acceptOffer(db, viewer, owned);
	});

	afterEach(() => setAccessEnforced(false));

	it('lets editors write, refuses viewers, and hides the Realm from strangers', () => {
		const scroll = createScroll(db, actor, { realmId: owned, title: 'Home' });
		expect(errorOf(() => createScroll(db, viewer, { realmId: owned, title: 'Nope' })).code).toBe(
			'forbidden'
		);
		expect(errorOf(() => updateScroll(db, viewer, scroll.id, { body: 'x' })).code).toBe(
			'forbidden'
		);
		expect(errorOf(() => deleteScroll(db, stranger, scroll.id)).code).toBe('not_found');
	});
});
