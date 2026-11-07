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

beforeEach(async () => {
	db = await testDb();
	actor = await seedActor(db);
	realmId = (await seedRealm(db, 'AM')).id;
});

async function errorOf(action: () => unknown): Promise<DomainError> {
	try {
		await action();
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
const tree = async () =>
	(await listScrollTree(db, realmId)).map((node) => `${'  '.repeat(node.depth)}${node.path}`);
const lastEvents = (since: number) => eventsSince(db, since);
const seqNow = async () => (await eventsSince(db, 0)).at(-1)?.seq ?? 0;
const choices = (entries: [number, ChildChoice][]) => new Map(entries);
const textRows = async () =>
	(
		await db.execute<{ rowid: number }>(
			sql`SELECT scroll_id AS rowid FROM scroll_text ORDER BY scroll_id`
		)
	).rows;

describe('creating a Scroll', () => {
	it('makes its slug from the title and its Path from its ancestors', async () => {
		const ops = await make('Ops & Releases');
		const release = await make('Release process', ops.id);

		expect(ops).toMatchObject({ slug: 'ops-releases', path: 'ops-releases', version: 1 });
		expect(release.path).toBe('ops-releases/release-process');
		expect(await resolveScrollPath(db, realmId, 'Ops-Releases/Release Process')).toMatchObject({
			scroll: { id: release.id },
			current: true
		});
	});

	it('records scroll.created with the whole Scroll', async () => {
		const before = await seqNow();
		const scroll = await make('Home', null, { body: 'Hello' });
		expect(await lastEvents(before)).toMatchObject([
			{ type: 'scroll.created', data: { scroll: { id: scroll.id, body: 'Hello', path: 'home' } } }
		]);
	});

	it('refuses a Path a sibling already holds', async () => {
		await make('Home');
		expect((await errorOf(() => make('home!'))).code).toBe('conflict');
	});

	it('refuses a bad slug, an empty title and an overlong body', async () => {
		expect((await errorOf(() => make('Home', null, { slug: 'Bad Slug' }))).code).toBe('invalid');
		expect((await errorOf(() => make('  '))).code).toBe('invalid');
		expect((await errorOf(() => make('Big', null, { body: 'x'.repeat(BODY_MAX + 1) }))).code).toBe(
			'invalid'
		);
	});

	it('nests at most ten deep', async () => {
		let parent: number | null = null;
		for (let i = 0; i < 10; i++) parent = (await make(`L${i}`, parent)).id;
		expect((await errorOf(() => make('Too deep', parent))).message).toMatch(/at most 10 deep/);
	});

	it('refuses a parent in another Realm', async () => {
		const other = (await seedRealm(db, 'BO')).id;
		const elsewhere = await createScroll(db, actor, { realmId: other, title: 'There' });
		expect((await errorOf(() => make('Here', elsewhere.id))).code).toBe('invalid');
	});

	it('orders siblings by placement, new ones last', async () => {
		const b = await make('B');
		await make('C');
		await createScroll(db, actor, { realmId, title: 'A', placement: { before: b.id } });
		expect(await tree()).toEqual(['a', 'b', 'c']);
	});
});

describe('editing a Scroll', () => {
	it('bumps the version and records who saved it', async () => {
		const editor = { id: await seedUser(db, 'bea') };
		const scroll = await make('Home');
		const saved = await updateScroll(db, editor, scroll.id, { body: 'New', version: 1 });
		expect(saved).toMatchObject({ body: 'New', version: 2, updatedById: editor.id });
	});

	it('refuses a save from an older version, naming who saved since, and changes nothing', async () => {
		const scroll = await make('Home');
		await updateScroll(db, { id: await seedUser(db, 'bea') }, scroll.id, {
			body: 'Theirs',
			version: 1
		});

		const error = await errorOf(() =>
			updateScroll(db, actor, scroll.id, { body: 'Mine', version: 1 })
		);
		expect(error.code).toBe('conflict');
		expect(error.message).toMatch(/version 2, saved by bea/);
		expect((await readScroll(db, scroll.id)).body).toBe('Theirs');
	});

	it('saves over whatever is there when no version is given', async () => {
		const scroll = await make('Home');
		await updateScroll(db, actor, scroll.id, { body: 'One' });
		expect((await updateScroll(db, actor, scroll.id, { body: 'Two' })).version).toBe(3);
	});

	it('records nothing when nothing changes', async () => {
		const scroll = await make('Home');
		const before = await seqNow();
		await updateScroll(db, actor, scroll.id, { title: 'Home', body: '' });
		expect(await lastEvents(before)).toEqual([]);
	});

	it('renames the slug, repaths everything under it and keeps the old Paths resolving', async () => {
		const ops = await make('Ops');
		const release = await make('Release', ops.id);
		const before = await seqNow();

		await updateScroll(db, actor, ops.id, { title: 'Operations', slug: 'operations' });

		expect(await tree()).toEqual(['operations', '  operations/release']);
		expect(await resolveScrollPath(db, realmId, 'ops/release')).toMatchObject({
			scroll: { id: release.id, path: 'operations/release' },
			current: false
		});
		expect((await lastEvents(before)).map((e) => e.type)).toEqual([
			'scroll.updated',
			'scroll.moved'
		]);
		expect((await lastEvents(before))[1].data).toMatchObject({
			paths: [
				{ id: ops.id, previousPath: 'ops', path: 'operations' },
				{ id: release.id, previousPath: 'ops/release', path: 'operations/release' }
			]
		});
	});

	it('lets a new Scroll take over a Path another Scroll only held before', async () => {
		const old = await make('Guide');
		await updateScroll(db, actor, old.id, { slug: 'handbook' });
		const fresh = await make('Guide');

		expect(await resolveScrollPath(db, realmId, 'guide')).toMatchObject({
			scroll: { id: fresh.id },
			current: true
		});
		expect((await resolveScrollPath(db, realmId, 'handbook'))?.scroll.id).toBe(old.id);
	});
});

describe('moving a Scroll', () => {
	it('moves it under another Scroll with everything beneath it', async () => {
		const a = await make('A');
		const b = await make('B');
		const child = await make('Child', b.id);
		const before = await seqNow();

		await moveScroll(db, actor, b.id, { parentId: a.id });

		expect(await tree()).toEqual(['a', '  a/b', '    a/b/child']);
		expect((await resolveScrollPath(db, realmId, 'b/child'))?.scroll.id).toBe(child.id);
		expect(await lastEvents(before)).toMatchObject([
			{ type: 'scroll.moved', data: { scroll: { id: b.id } } }
		]);
	});

	it('never moves a Scroll under itself or beneath itself', async () => {
		const a = await make('A');
		const b = await make('B', a.id);
		expect((await errorOf(() => moveScroll(db, actor, a.id, { parentId: a.id }))).code).toBe(
			'invalid'
		);
		expect((await errorOf(() => moveScroll(db, actor, a.id, { parentId: b.id }))).code).toBe(
			'invalid'
		);
	});

	it('refuses a move onto a sibling Path', async () => {
		const a = await make('A');
		await make('Same', a.id);
		const loose = await make('Same');
		expect((await errorOf(() => moveScroll(db, actor, loose.id, { parentId: a.id }))).code).toBe(
			'conflict'
		);
	});

	it('refuses a move that would nest deeper than ten', async () => {
		let parent: number | null = null;
		for (let i = 0; i < 9; i++) parent = (await make(`L${i}`, parent)).id;
		const branch = await make('Branch');
		await make('Leaf', branch.id);
		expect(
			(await errorOf(() => moveScroll(db, actor, branch.id, { parentId: parent }))).message
		).toMatch(/at most 10 deep/);
	});

	it('reorders siblings with an empty paths list', async () => {
		const a = await make('A');
		const b = await make('B');
		const before = await seqNow();
		await moveScroll(db, actor, b.id, { placement: { before: a.id } });
		expect(await tree()).toEqual(['b', 'a']);
		expect(await lastEvents(before)).toMatchObject([{ type: 'scroll.moved', data: { paths: [] } }]);
	});

	it('refuses a placement next to a Scroll that is not a sibling', async () => {
		const a = await make('A');
		const inner = await make('Inner', a.id);
		const b = await make('B');
		expect(
			(await errorOf(() => moveScroll(db, actor, b.id, { placement: { after: inner.id } }))).message
		).toMatch(/a\/inner is not a sibling/);
	});
});

describe('deleting a Scroll', () => {
	it('deletes a leaf Scroll and its Paths', async () => {
		const leaf = await make('Leaf');
		await deleteScroll(db, actor, leaf.id);
		expect(await tree()).toEqual([]);
		expect(await resolveScrollPath(db, realmId, 'leaf')).toBeNull();
		expect(await textRows()).toEqual([]);
	});

	it('refuses until every child has a choice, and changes nothing', async () => {
		const parent = await make('Parent');
		const one = await make('One', parent.id);
		await make('Two', parent.id);

		const error = await errorOf(() =>
			deleteScroll(db, actor, parent.id, choices([[one.id, 'move']]))
		);
		expect(error.message).toMatch(/parent\/two/);
		expect(await tree()).toHaveLength(3);
	});

	it('refuses a choice for a Scroll that is not a direct child', async () => {
		const parent = await make('Parent');
		const child = await make('Child', parent.id);
		const grandchild = await make('Grandchild', child.id);
		expect(
			(
				await errorOf(() =>
					deleteScroll(
						db,
						actor,
						parent.id,
						choices([
							[child.id, 'move'],
							[grandchild.id, 'move']
						])
					)
				)
			).code
		).toBe('invalid');
	});

	it('moves some children up into its place and deletes the others with what is under them', async () => {
		await make('Before');
		const parent = await make('Parent');
		await make('After');
		const keep = await make('Keep', parent.id);
		const kept = await make('Kept leaf', keep.id);
		const drop = await make('Drop', parent.id);
		const dropped = await make('Dropped leaf', drop.id);
		const also = await make('Also', parent.id);
		const before = await seqNow();

		const result = await deleteScroll(
			db,
			actor,
			parent.id,
			choices([
				[keep.id, 'move'],
				[drop.id, 'delete'],
				[also.id, 'move']
			])
		);

		expect(await tree()).toEqual(['before', 'keep', '  keep/kept-leaf', 'also', 'after']);
		expect(result.deleted.map((d) => d.id).sort()).toEqual([parent.id, drop.id, dropped.id].sort());
		expect((await resolveScrollPath(db, realmId, 'parent/keep/kept-leaf'))?.scroll.id).toBe(
			kept.id
		);
		expect((await textRows()).map((r) => r.rowid)).not.toContain(dropped.id);
		expect(await lastEvents(before)).toMatchObject([
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

	it('refuses to move a child up onto a Path already taken there', async () => {
		await make('Notes');
		const parent = await make('Parent');
		const notes = await make('Notes', parent.id);
		const error = await errorOf(() =>
			deleteScroll(db, actor, parent.id, choices([[notes.id, 'move']]))
		);
		expect(error.code).toBe('conflict');
		expect(error.message).toMatch(/parent\/notes cannot move up/);
		expect(await tree()).toHaveLength(3);
	});

	it('goes with its Realm, search index included', async () => {
		await make('Home');
		await deleteRealm(db, actor, realmId);
		expect(await textRows()).toEqual([]);
	});
});

describe('links and Backlinks', () => {
	it('counts a link written before its target existed', async () => {
		const index = await make('Index', null, { body: 'See [[Guides/Setup]] and `[[not/this]]`.' });
		const guides = await make('Guides');
		const setup = await make('Setup', guides.id);
		expect(await listBacklinks(db, setup.id)).toEqual([
			{ id: index.id, path: 'index', title: 'Index' }
		]);
	});

	it('follows a Scroll through renames, by any Path it held', async () => {
		const target = await make('Target');
		const source = await make('Source', null, { body: '[[target]]' });
		await updateScroll(db, actor, target.id, { slug: 'renamed' });
		expect((await listBacklinks(db, target.id)).map((s) => s.id)).toEqual([source.id]);
	});

	it('drops a Backlink when the link leaves the body', async () => {
		const target = await make('Target');
		const source = await make('Source', null, { body: '[[target]]' });
		await updateScroll(db, actor, source.id, { body: 'nothing' });
		expect(await listBacklinks(db, target.id)).toEqual([]);
	});

	it('records Labours the body names, by key', async () => {
		const labour = await seedLabour(db, { realmId });
		const scroll = await make('Notes', null, {
			body: `Tracking ${labour.key.toLowerCase()} here.`
		});
		expect(await listLabourScrolls(db, labour.id, null)).toEqual([
			{ id: scroll.id, realmId, path: 'notes', title: 'Notes' }
		]);
		expect(await listLabourScrolls(db, labour.id, [])).toEqual([]);
	});
});

describe('search', () => {
	it('finds Scrolls in one Realm by title and body, title first', async () => {
		const inBody = await make('Notes', null, { body: 'How we deploy the server' });
		const inTitle = await make('Deploying');
		await createScroll(db, actor, {
			realmId: (await seedRealm(db, 'BO')).id,
			title: 'Deploy elsewhere'
		});

		const hits = await searchScrolls(db, realmId, 'deploy');
		expect(hits.map((h) => h.id)).toEqual([inTitle.id, inBody.id]);
		expect(hits[1].snippet).toContain('deploy');
	});

	it('answers a query of 20,000 words', async () => {
		const scroll = await make('Notes', null, { body: 'deploy the server' });
		const words = Array.from({ length: 20_000 }, (_, i) => `w${i}`);

		const hits = await searchScrolls(db, realmId, ['deploy', ...words].join(' '));

		expect(hits.map((h) => h.id)).toEqual([scroll.id]);
	});

	it('follows edits', async () => {
		const scroll = await make('Notes', null, { body: 'alpha' });
		await updateScroll(db, actor, scroll.id, { body: 'beta' });
		expect(await searchScrolls(db, realmId, 'alpha')).toEqual([]);
		expect((await searchScrolls(db, realmId, 'beta')).map((h) => h.id)).toEqual([scroll.id]);
	});
});

describe('access', () => {
	let viewer: Actor;
	let stranger: Actor;
	let owned: number;

	beforeEach(async () => {
		setAccessEnforced(true);
		viewer = { id: await seedUser(db, 'viewer') };
		stranger = { id: await seedUser(db, 'stranger') };
		owned = (await createRealm(db, actor, { name: 'Private', key: 'PV', initialState: TODO })).id;
		await offerMembership(db, actor, owned, viewer.id, 'viewer');
		await acceptOffer(db, viewer, owned);
	});

	afterEach(() => setAccessEnforced(false));

	it('lets editors write, refuses viewers, and hides the Realm from strangers', async () => {
		const scroll = await createScroll(db, actor, { realmId: owned, title: 'Home' });
		expect(
			(await errorOf(() => createScroll(db, viewer, { realmId: owned, title: 'Nope' }))).code
		).toBe('forbidden');
		expect((await errorOf(() => updateScroll(db, viewer, scroll.id, { body: 'x' }))).code).toBe(
			'forbidden'
		);
		expect((await errorOf(() => deleteScroll(db, stranger, scroll.id))).code).toBe('not_found');
	});
});
