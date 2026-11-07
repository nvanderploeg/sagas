import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { seedHuman } from '#lib/server/auth/fixtures.ts';
import type { AuthUser } from '#lib/server/auth/users.ts';
import type { Db } from '#lib/server/db/client.ts';
import { setAccessEnforced } from '#lib/server/domain/access.ts';
import { testDb } from '#lib/server/test/db.ts';
import { createMcpServer } from '../server.ts';

let db: Db;
let ada: AuthUser;
let bob: AuthUser;
let eve: AuthUser;
let owner: Client;
const clients: Client[] = [];

async function connect(actor: AuthUser): Promise<Client> {
	const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
	await createMcpServer(db, actor, 'http://sagas.test').connect(serverSide);
	const client = new Client({ name: 'spec', version: '0' });
	await client.connect(clientSide);
	clients.push(client);
	return client;
}

const call = async (client: Client, name: string, args: Record<string, unknown> = {}) =>
	(await client.callTool({ name, arguments: args })) as CallToolResult;

const text = (result: CallToolResult) =>
	result.content.map((part) => (part.type === 'text' ? part.text : '')).join('');

async function ok(client: Client, name: string, args: Record<string, unknown> = {}) {
	const result = await call(client, name, args);
	expect(result.isError, `${name}: ${text(result)}`).toBeFalsy();
	return result.structuredContent as any;
}

async function fail(client: Client, name: string, args: Record<string, unknown> = {}) {
	const result = await call(client, name, args);
	expect(result.isError, `${name} should fail`).toBe(true);
	return (result.structuredContent as any).error as { code: string; message: string };
}

const create = async (args: Record<string, unknown>, client = owner) =>
	(await ok(client, 'create_scroll', { realm: 'AM', ...args })).scroll;

const tree = async (client = owner) =>
	(await ok(client, 'list_scrolls', { realm: 'AM' })).scrolls.map(
		(s: { path: string; depth: number }) => `${s.depth}:${s.path}`
	);

async function join(user: string, role: 'viewer' | 'editor', client: Client) {
	await ok(owner, 'offer_membership', { realm: 'AM', user, role });
	await ok(client, 'accept_offer', { realm: 'AM' });
}

beforeEach(async () => {
	setAccessEnforced(true);
	db = await testDb();
	ada = await seedHuman(db, 'ada');
	bob = await seedHuman(db, 'bob');
	eve = await seedHuman(db, 'eve');
	owner = await connect(ada);
	await ok(owner, 'create_realm', { key: 'am', name: 'Atlas' });
});

afterEach(async () => {
	setAccessEnforced(false);
	await Promise.all(clients.splice(0).map((client) => client.close()));
});

describe('tool registration', () => {
	it('lists reads as read-only, delete_scroll as destructive and the rest as writes', async () => {
		const { tools } = await owner.listTools();
		const kinds = Object.fromEntries(
			tools
				.filter((t) => t.name.includes('scroll'))
				.map((t) => [
					t.name,
					t.annotations?.readOnlyHint
						? 'read'
						: t.annotations?.destructiveHint
							? 'destroy'
							: 'write'
				])
		);

		expect(kinds).toEqual({
			list_scrolls: 'read',
			get_scroll: 'read',
			search_scrolls: 'read',
			create_scroll: 'write',
			update_scroll: 'write',
			move_scroll: 'write',
			delete_scroll: 'destroy'
		});
	});
});

describe('create_scroll', () => {
	it('answers with the whole Scroll, its Slug made from the title', async () => {
		const result = await call(owner, 'create_scroll', {
			realm: 'am',
			title: 'Release Process',
			body: 'Ship it.'
		});

		expect(text(result).split('\n')[0]).toBe('Scroll release-process in AM (v1): Release Process');
		expect((result.structuredContent as any).scroll).toEqual({
			id: expect.any(Number),
			realm: 'AM',
			path: 'release-process',
			url: 'http://sagas.test/r/AM/s/release-process',
			title: 'Release Process',
			body: 'Ship it.',
			version: 1,
			parent: null,
			children: [],
			backlinks: [],
			labours: [],
			createdBy: 'ada',
			updatedBy: 'ada',
			createdAt: expect.any(String),
			updatedAt: expect.any(String)
		});
	});

	it('takes a parent by Path or by id, and a placement among siblings by Path', async () => {
		const ops = await create({ title: 'Ops' });
		await create({ title: 'Deploy', parent: 'ops' });
		await create({ title: 'Backups', parent: ops.id, slug: 'bak' });
		const first = await create({ title: 'Alerts', parent: 'ops', before: 'ops/deploy' });

		expect(first).toMatchObject({ path: 'ops/alerts', parent: 'ops' });
		expect(await tree()).toEqual(['0:ops', '1:ops/alerts', '1:ops/deploy', '1:ops/bak']);
		expect((await ok(owner, 'get_scroll', { realm: 'AM', scroll: 'ops' })).scroll.children).toEqual(
			[
				{ path: 'ops/alerts', title: 'Alerts' },
				{ path: 'ops/deploy', title: 'Deploy' },
				{ path: 'ops/bak', title: 'Backups' }
			]
		);
	});

	it('refuses more than one placement, and a parent that does not exist', async () => {
		await create({ title: 'Ops' });

		expect(
			await fail(owner, 'create_scroll', {
				realm: 'AM',
				title: 'x',
				position: 'top',
				after: 'ops'
			})
		).toMatchObject({ code: 'invalid', message: expect.stringContaining('at most one') });
		expect(
			await fail(owner, 'create_scroll', { realm: 'AM', title: 'x', parent: 'nowhere' })
		).toEqual({ code: 'not_found', message: 'No Scroll has the Path nowhere in AM' });
	});
});

describe('Scroll refs', () => {
	it('resolve a Path within the Realm or an id on its own', async () => {
		const scroll = await create({ title: 'Ops' });

		expect((await ok(owner, 'get_scroll', { realm: 'AM', scroll: 'Ops' })).scroll.id).toBe(
			scroll.id
		);
		expect((await ok(owner, 'get_scroll', { scroll: scroll.id })).scroll.path).toBe('ops');
	});

	it('read a string of digits as a Path, since a Slug may be all digits', async () => {
		await create({ title: '2024' });

		expect((await ok(owner, 'get_scroll', { realm: 'AM', scroll: '2024' })).scroll.path).toBe(
			'2024'
		);
	});

	it('need the Realm for a Path', async () => {
		await create({ title: 'Ops' });

		expect(await fail(owner, 'get_scroll', { scroll: 'ops' })).toMatchObject({
			code: 'invalid',
			message: expect.stringContaining('Name the Realm')
		});
	});

	it('refuse an id from another Realm than the one named', async () => {
		await ok(owner, 'create_realm', { key: 'zz', name: 'Other' });
		const other = await create({ realm: 'ZZ', title: 'Elsewhere' });

		expect(await fail(owner, 'get_scroll', { realm: 'AM', scroll: other.id })).toMatchObject({
			code: 'invalid'
		});
	});

	it('resolve a former Path to the Scroll, which shows its current Path', async () => {
		const ops = await create({ title: 'Ops' });
		await create({ title: 'Deploy', parent: 'ops' });
		await ok(owner, 'update_scroll', { realm: 'AM', scroll: 'ops', slug: 'operations' });

		const moved = await ok(owner, 'get_scroll', { realm: 'AM', scroll: 'ops/deploy' });
		expect(moved.scroll).toMatchObject({
			path: 'operations/deploy',
			url: 'http://sagas.test/r/AM/s/operations/deploy',
			parent: 'operations'
		});
		expect((await ok(owner, 'get_scroll', { realm: 'AM', scroll: 'ops' })).scroll.id).toBe(ops.id);
	});
});

describe('get_scroll', () => {
	it('lists Backlinks and the Labours its body names', async () => {
		await ok(owner, 'create_labour', { realm: 'AM', title: 'Plan' });
		await create({ title: 'Ops' });
		await create({ title: 'Runbook', body: 'See [[Ops]] and AM-1.' });

		const ops = (await ok(owner, 'get_scroll', { realm: 'AM', scroll: 'ops' })).scroll;
		const runbook = (await ok(owner, 'get_scroll', { realm: 'AM', scroll: 'runbook' })).scroll;

		expect(ops.backlinks).toEqual([{ path: 'runbook', title: 'Runbook' }]);
		expect(runbook.labours).toEqual(['AM-1']);
	});

	it("leaves out Labours in Realms the caller can't see", async () => {
		const stranger = await connect(eve);
		await ok(stranger, 'create_realm', { key: 'ev', name: 'Eden' });
		await ok(stranger, 'create_labour', { realm: 'EV', title: 'Secret' });
		await ok(owner, 'create_labour', { realm: 'AM', title: 'Plan' });
		await create({ title: 'Notes', body: 'AM-1 and EV-1' });

		expect(
			(await ok(owner, 'get_scroll', { realm: 'AM', scroll: 'notes' })).scroll.labours
		).toEqual(['AM-1']);
		await join('eve', 'viewer', stranger);
		expect(
			(await ok(stranger, 'get_scroll', { realm: 'AM', scroll: 'notes' })).scroll.labours
		).toEqual(['AM-1', 'EV-1']);
	});
});

describe('update_scroll', () => {
	it('saves title and body, raising the version and recording who changed it', async () => {
		const editor = await connect(bob);
		await join('bob', 'editor', editor);
		await create({ title: 'Ops' });

		const { scroll } = await ok(editor, 'update_scroll', {
			realm: 'AM',
			scroll: 'ops',
			version: 1,
			title: 'Operations',
			body: 'New'
		});

		expect(scroll).toMatchObject({
			path: 'ops',
			title: 'Operations',
			body: 'New',
			version: 2,
			createdBy: 'ada',
			updatedBy: 'bob'
		});
	});

	it('refuses a save from an older version as a conflict naming who saved since', async () => {
		await create({ title: 'Ops' });
		await ok(owner, 'update_scroll', { realm: 'AM', scroll: 'ops', body: 'first' });

		const result = await call(owner, 'update_scroll', {
			realm: 'AM',
			scroll: 'ops',
			version: 1,
			body: 'stale'
		});

		expect(result.isError).toBe(true);
		expect(text(result)).toBe(
			'This Scroll changed after version 1: it is at version 2, saved by ada'
		);
		expect((result.structuredContent as any).error.code).toBe('conflict');
		expect((await ok(owner, 'get_scroll', { realm: 'AM', scroll: 'ops' })).scroll.body).toBe(
			'first'
		);
	});

	it('saves over whatever is there when no version is given', async () => {
		await create({ title: 'Ops' });
		await ok(owner, 'update_scroll', { realm: 'AM', scroll: 'ops', body: 'first' });

		expect(
			(await ok(owner, 'update_scroll', { realm: 'AM', scroll: 'ops', body: 'second' })).scroll
		).toMatchObject({ body: 'second', version: 3 });
	});
});

describe('move_scroll', () => {
	beforeEach(async () => {
		await create({ title: 'Ops' });
		await create({ title: 'Guides' });
		await create({ title: 'Deploy', parent: 'ops' });
	});

	it('moves a Scroll and everything under it to a new parent', async () => {
		const { scroll } = await ok(owner, 'move_scroll', {
			realm: 'AM',
			scroll: 'ops',
			parent: 'guides'
		});

		expect(scroll).toMatchObject({ path: 'guides/ops', parent: 'guides' });
		expect(await tree()).toEqual(['0:guides', '1:guides/ops', '2:guides/ops/deploy']);
	});

	it('moves to the top level with parent null, and keeps the parent when it is left out', async () => {
		await ok(owner, 'move_scroll', { realm: 'AM', scroll: 'ops/deploy', parent: null });
		expect(await tree()).toEqual(['0:ops', '0:guides', '0:deploy']);

		await ok(owner, 'move_scroll', { realm: 'AM', scroll: 'deploy', before: 'ops' });
		expect(await tree()).toEqual(['0:deploy', '0:ops', '0:guides']);
	});

	it('resolves parent and sibling Paths in the Realm of a Scroll given by id', async () => {
		const deploy = (await ok(owner, 'get_scroll', { realm: 'AM', scroll: 'ops/deploy' })).scroll;

		await ok(owner, 'move_scroll', { scroll: deploy.id, parent: 'guides' });

		expect(await tree()).toEqual(['0:ops', '0:guides', '1:guides/deploy']);
	});

	it('refuses an anchor that is not a sibling', async () => {
		expect(
			await fail(owner, 'move_scroll', { realm: 'AM', scroll: 'guides', after: 'ops/deploy' })
		).toEqual({ code: 'invalid', message: 'Scroll ops/deploy is not a sibling' });
	});
});

describe('delete_scroll', () => {
	beforeEach(async () => {
		await create({ title: 'Ops' });
		await create({ title: 'Keep', parent: 'ops' });
		await create({ title: 'Drop', parent: 'ops' });
		await create({ title: 'Deep', parent: 'ops/drop' });
		await create({ title: 'Also', parent: 'ops' });
		await create({ title: 'Under', parent: 'ops/also' });
	});

	it('deletes a Scroll without children', async () => {
		const result = await call(owner, 'delete_scroll', { realm: 'AM', scroll: 'ops/keep' });

		expect(result.structuredContent).toEqual({ deleted: ['ops/keep'], moved: [] });
		expect(text(result).split('\n')[0]).toBe('Deleted Scroll ops/keep');
	});

	it('moves and deletes each direct child as chosen', async () => {
		const result = await call(owner, 'delete_scroll', {
			realm: 'AM',
			scroll: 'ops',
			delete: ['ops/drop'],
			children: 'move'
		});

		expect(result.structuredContent).toEqual({
			deleted: ['ops', 'ops/drop', 'ops/drop/deep'],
			moved: [
				{ from: 'ops/keep', to: 'keep' },
				{ from: 'ops/also', to: 'also' },
				{ from: 'ops/also/under', to: 'also/under' }
			]
		});
		expect(text(result).split('\n')[0]).toBe(
			'Deleted Scroll ops and 2 Scrolls under it; 3 Paths changed'
		);
		expect(await tree()).toEqual(['0:keep', '0:also', '1:also/under']);
	});

	it('takes children by id in the move and delete lists', async () => {
		const ops = (await ok(owner, 'get_scroll', { realm: 'AM', scroll: 'ops' })).scroll;
		const ids = Object.fromEntries(
			(await ok(owner, 'list_scrolls', { realm: 'AM' })).scrolls.map(
				(s: { path: string; id: number }) => [s.path, s.id]
			)
		);

		await ok(owner, 'delete_scroll', {
			scroll: ops.id,
			move: [ids['ops/keep'], 'ops/also'],
			delete: [ids['ops/drop']]
		});

		expect(await tree()).toEqual(['0:keep', '0:also', '1:also/under']);
	});

	it('refuses, changing nothing, when a child has no choice', async () => {
		const before = await tree();

		expect(
			await fail(owner, 'delete_scroll', { realm: 'AM', scroll: 'ops', move: ['ops/keep'] })
		).toMatchObject({ code: 'invalid', message: expect.stringContaining('ops/drop, ops/also') });
		expect(await tree()).toEqual(before);
	});

	it('refuses a child listed in both lists, and a Scroll that is not a direct child', async () => {
		const before = await tree();

		expect(
			await fail(owner, 'delete_scroll', {
				realm: 'AM',
				scroll: 'ops',
				move: ['ops/keep'],
				delete: ['ops/keep'],
				children: 'move'
			})
		).toEqual({ code: 'invalid', message: 'ops/keep is listed in both move and delete' });
		expect(
			await fail(owner, 'delete_scroll', {
				realm: 'AM',
				scroll: 'ops',
				delete: ['ops/drop/deep'],
				children: 'move'
			})
		).toEqual({ code: 'invalid', message: 'ops/drop/deep is not a direct child of ops' });
		expect(await tree()).toEqual(before);
	});
});

describe('search_scrolls', () => {
	beforeEach(async () => {
		await create({ title: 'Deploy', body: 'How we ship.' });
		await create({ title: 'Ops', body: 'Before you deploy, read the checklist.' });
		await create({ title: 'Lunch', body: 'Sandwiches.' });
	});

	it('finds titles and bodies, a title match first', async () => {
		const result = await call(owner, 'search_scrolls', { realm: 'AM', query: 'deploy' });

		expect((result.structuredContent as any).scrolls).toEqual([
			{
				id: expect.any(Number),
				path: 'deploy',
				url: 'http://sagas.test/r/AM/s/deploy',
				title: 'Deploy',
				snippet: expect.any(String)
			},
			expect.objectContaining({ path: 'ops', snippet: expect.stringContaining('deploy') })
		]);
		expect(text(result).split('\n')[0]).toBe('2 Scrolls match "deploy"');
	});

	it('refuses a query past 500 characters', async () => {
		expect(
			await fail(owner, 'search_scrolls', { realm: 'AM', query: 'deploy '.repeat(100) })
		).toMatchObject({ code: 'invalid' });
	});

	it('stops at the limit, which is at most 100', async () => {
		expect(
			(await ok(owner, 'search_scrolls', { realm: 'AM', query: 'deploy', limit: 1 })).scrolls
		).toHaveLength(1);
		expect(
			await fail(owner, 'search_scrolls', { realm: 'AM', query: 'deploy', limit: 101 })
		).toMatchObject({ code: 'invalid' });
	});
});

describe('Realm access', () => {
	it("hides a Realm's Scrolls from a stranger, worded as for ones that do not exist", async () => {
		const scroll = await create({ title: 'Ops' });
		const stranger = await connect(eve);

		for (const [tool, args] of [
			['list_scrolls', { realm: 'AM' }],
			['get_scroll', { realm: 'AM', scroll: 'ops' }],
			['search_scrolls', { realm: 'AM', query: 'ops' }],
			['create_scroll', { realm: 'AM', title: 'x' }],
			['update_scroll', { scroll: scroll.id, body: 'x' }],
			['move_scroll', { scroll: scroll.id, position: 'top' }],
			['delete_scroll', { scroll: scroll.id }]
		] as const) {
			expect((await fail(stranger, tool, args)).code, tool).toBe('not_found');
		}
		const absent = scroll.id + 100;
		expect((await fail(stranger, 'get_scroll', { scroll: absent })).message).toBe(
			`No Scroll has the id ${absent}`
		);
		expect((await fail(stranger, 'get_scroll', { scroll: scroll.id })).message).toBe(
			`No Scroll has the id ${scroll.id}`
		);
		expect((await fail(stranger, 'get_scroll', { realm: 'AM', scroll: 'ops' })).message).toBe(
			(await fail(stranger, 'get_scroll', { realm: 'ZZ', scroll: 'ops' })).message.replace(
				'ZZ',
				'AM'
			)
		);
	});

	it('lets a viewer read and search but not write', async () => {
		await create({ title: 'Ops' });
		const viewer = await connect(bob);
		await join('bob', 'viewer', viewer);

		expect((await ok(viewer, 'get_scroll', { realm: 'AM', scroll: 'ops' })).scroll.title).toBe(
			'Ops'
		);
		expect(
			(await ok(viewer, 'search_scrolls', { realm: 'AM', query: 'ops' })).scrolls
		).toHaveLength(1);
		for (const [tool, args] of [
			['create_scroll', { realm: 'AM', title: 'x' }],
			['update_scroll', { realm: 'AM', scroll: 'ops', body: 'x' }],
			['move_scroll', { realm: 'AM', scroll: 'ops', position: 'top' }],
			['delete_scroll', { realm: 'AM', scroll: 'ops' }]
		] as const) {
			expect((await fail(viewer, tool, args)).code, tool).toBe('forbidden');
		}
	});
});
