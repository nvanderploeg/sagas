import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { seedHuman } from '#lib/server/auth/fixtures.ts';
import { createFirstAdmin, type AuthUser } from '#lib/server/auth/users.ts';
import type { Db } from '#lib/server/db/client.ts';
import { DomainError } from '#lib/server/domain/errors.ts';
import { eventsSince, eventWindow } from '#lib/server/events/log.ts';
import { testDb } from '#lib/server/test/db.ts';
import { toErrorResult } from './result.ts';
import { createMcpServer } from './server.ts';

let db: Db;
let admin: AuthUser;
const clients: Client[] = [];

beforeEach(async () => {
	db = testDb();
	admin = await createFirstAdmin(db, {
		username: 'root',
		displayName: 'Root',
		password: 'a long enough password'
	});
});

afterEach(async () => {
	await Promise.all(clients.splice(0).map((client) => client.close()));
	db.$client.close();
});

async function connect(actor: AuthUser): Promise<Client> {
	const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
	await createMcpServer(db, actor).connect(serverSide);
	const client = new Client({ name: 'spec', version: '0' });
	await client.connect(clientSide);
	clients.push(client);
	return client;
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
	return (await client.callTool({ name, arguments: args })) as CallToolResult;
}

async function ok(client: Client, name: string, args: Record<string, unknown> = {}) {
	const result = await call(client, name, args);
	expect(result.isError, `${name}: ${text(result)}`).toBeFalsy();
	return result.structuredContent as any;
}

const text = (result: CallToolResult) =>
	result.content.map((part) => (part.type === 'text' ? part.text : '')).join('');

const lastSeq = () => eventWindow(db).last;

async function seedRealm(client: Client, labourCount = 0) {
	await ok(client, 'create_realm', { name: 'Atlas', key: 'am' });
	for (let i = 1; i <= labourCount; i++) {
		await ok(client, 'create_labour', { realm: 'AM', title: `Labour ${i}` });
	}
}

describe('toErrorResult', () => {
	it('carries a DomainError code and message', () => {
		expect(toErrorResult(new DomainError('conflict', 'Realm key AM is already in use'))).toEqual({
			isError: true,
			content: [{ type: 'text', text: 'Realm key AM is already in use' }],
			structuredContent: {
				error: { code: 'conflict', message: 'Realm key AM is already in use' }
			}
		});
	});

	it('hides any other error behind a generic message', () => {
		const result = toErrorResult(new TypeError('secret at /srv/app/db.ts:12'));
		expect(result).toMatchObject({ isError: true, content: [{ text: 'Internal error' }] });
		expect(JSON.stringify(result)).not.toContain('secret');
	});
});

describe('the MCP server', () => {
	it('lists every tool with a description and a closed object input schema', async () => {
		const { tools } = await (await connect(admin)).listTools();
		const names = tools.map((t) => t.name);

		for (const name of [
			'resolve',
			'list_labours',
			'create_labour',
			'add_quest_labours',
			'whoami'
		]) {
			expect(names).toContain(name);
		}
		for (const tool of tools) {
			expect(tool.description, tool.name).toBeTruthy();
			expect(tool.inputSchema.type, tool.name).toBe('object');
			expect(tool.inputSchema.additionalProperties, tool.name).toBe(false);
		}
	});

	it('declares tools without listChanged, which a stateless server cannot send', async () => {
		const client = await connect(admin);

		expect(client.getServerCapabilities()?.tools).toEqual({});
	});

	it('acts as the given User, who is the actor of every Event its writes record', async () => {
		const bob = seedHuman(db, 'bob');
		const client = await connect(bob);
		await seedRealm(client);
		const before = lastSeq();

		const result = await call(client, 'create_labour', { realm: 'AM', title: 'First' });

		expect(result.structuredContent).toMatchObject({
			labour: { key: 'AM-1', owner: 'bob', assignee: null }
		});
		const recorded = eventsSince(db, before);
		expect(recorded.map((e) => [e.type, e.actor])).toEqual([
			['labour.created', { id: bob.id, kind: 'human', username: 'bob', displayName: 'bob' }]
		]);
	});

	it('puts a one-line summary with State keys and labels, then the result as JSON, in the text', async () => {
		const client = await connect(admin);
		await seedRealm(client);

		const result = await call(client, 'create_labour', { realm: 'AM', title: 'First' });

		const [summary, ...rest] = text(result).split('\n');
		expect(summary).toBe('AM-1 [todo: To do] First');
		expect(JSON.parse(rest.join('\n'))).toEqual(result.structuredContent);
	});

	it('maps a DomainError to a tool error with the service message', async () => {
		const client = await connect(admin);
		await call(client, 'create_realm', { name: 'Atlas', key: 'AM' });
		const result = await call(client, 'create_realm', { name: 'Again', key: 'am' });

		expect(result.isError).toBe(true);
		expect(text(result)).toBe('Realm key AM is already in use');
		expect(result.structuredContent).toEqual({
			error: { code: 'conflict', message: 'Realm key AM is already in use' }
		});
	});

	it('reports a missing argument in the error contract', async () => {
		const result = await call(await connect(admin), 'get_labour', {});

		const message = 'Invalid arguments for get_labour: missing argument "labour"';
		expect(result).toMatchObject({
			isError: true,
			content: [{ type: 'text', text: message }],
			structuredContent: { error: { code: 'invalid', message } }
		});
	});

	it('rejects an unknown argument, naming it and the arguments the tool takes', async () => {
		const client = await connect(admin);
		await seedRealm(client, 1);

		const result = await call(client, 'get_labour', { labour: 'AM-1', verbose: true });

		expect(result.structuredContent).toEqual({
			error: {
				code: 'invalid',
				message:
					'Invalid arguments for get_labour: unknown argument "verbose"; get_labour takes labour'
			}
		});
	});

	it('rejects an unknown key inside an object argument', async () => {
		const result = await call(await connect(admin), 'create_realm', {
			name: 'Atlas',
			key: 'AM',
			initialState: { key: 'todo', label: 'To do', color: '#000000', icon: 'circle', x: 1 }
		});

		expect(result.structuredContent).toMatchObject({
			error: { code: 'invalid', message: expect.stringContaining('"initialState.x"') }
		});
	});

	it('reports an unknown tool in the error contract', async () => {
		const result = await call(await connect(admin), 'make_coffee');

		expect(result).toMatchObject({
			isError: true,
			structuredContent: { error: { code: 'not_found', message: 'No tool is named "make_coffee"' } }
		});
	});

	it('refuses a digit string where a Labour is named', async () => {
		const client = await connect(admin);
		await seedRealm(client, 1);
		const { labour } = await ok(client, 'get_labour', { labour: 'AM-1' });

		const result = await call(client, 'get_labour', { labour: String(labour.id) });

		expect(result.structuredContent).toMatchObject({
			error: { code: 'invalid', message: expect.stringContaining('JSON number') }
		});
		expect(await ok(client, 'get_labour', { labour: labour.id })).toMatchObject({
			labour: { key: 'AM-1' }
		});
	});

	it('adds and lists Comments as the calling User', async () => {
		const bob = seedHuman(db, 'bob');
		const client = await connect(bob);
		await seedRealm(client, 1);

		const { comment } = await ok(client, 'add_comment', {
			labour: 'AM-1',
			body: 'Resolved: **done**'
		});
		const listed = await ok(client, 'list_comments', { labour: 'AM-1' });

		expect(comment).toMatchObject({ labour: 'AM-1', author: 'bob', body: 'Resolved: **done**' });
		expect(listed.comments).toEqual([comment]);
		const edited = await ok(client, 'update_comment', { comment: comment.id, body: 'Revised' });
		expect(edited.comment).toMatchObject({ body: 'Revised' });
		const forbidden = await call(await connect(admin), 'delete_comment', { comment: comment.id });
		expect(forbidden.structuredContent).toMatchObject({ error: { code: 'forbidden' } });
		await ok(client, 'delete_comment', { comment: comment.id });
		expect((await ok(client, 'list_comments', { labour: 'AM-1' })).comments).toEqual([]);
		const refused = await call(client, 'add_comment', { labour: 'AM-1', body: ' ' });
		expect(refused.structuredContent).toMatchObject({ error: { code: 'invalid' } });
	});

	it('takes "me" for owner and assignee, in writes and filters', async () => {
		const bob = seedHuman(db, 'bob');
		const client = await connect(bob);
		await seedRealm(client);
		await ok(client, 'create_labour', { realm: 'AM', title: 'Mine', owner: 'root' });

		const { labour } = await ok(client, 'update_labour', {
			labour: 'AM-1',
			owner: 'me',
			assignee: 'me'
		});
		expect(labour).toMatchObject({ owner: 'bob', assignee: 'bob' });
		const page = await ok(client, 'list_labours', { owner: 'me', assignee: 'me' });
		expect(page.total).toBe(1);
	});

	it('names Labours by key in errors', async () => {
		const client = await connect(admin);
		await seedRealm(client, 2);
		await ok(client, 'create_state', {
			realm: 'AM',
			key: 'doing',
			label: 'Doing',
			color: '#000000',
			icon: 'play'
		});
		await ok(client, 'update_labour', { labour: 'AM-2', state: 'doing' });
		const { quest } = await ok(client, 'create_quest', { name: 'Launch' });

		const ranked = await call(client, 'rank_labour', { labour: 'AM-1', after: 'AM-2' });
		const outside = await call(client, 'rank_quest_labour', {
			quest: quest.id,
			labour: 'AM-1',
			position: 'top'
		});

		expect(text(ranked)).toBe('AM-2 is not in the same State');
		expect(text(outside)).toBe(`AM-1 is not in Quest ${quest.id}`);
	});

	it('resolves a Labour named by the labour argument', async () => {
		const client = await connect(admin);
		await seedRealm(client, 1);

		expect(await ok(client, 'resolve', { labour: 'am-1' })).toMatchObject({
			labour: { key: 'AM-1' },
			alias: false
		});
	});

	it('reorders States and Substates by index, never by position', async () => {
		const client = await connect(admin);
		await seedRealm(client);
		const style = { color: '#000000', icon: 'dot' };
		await ok(client, 'create_state', { realm: 'AM', key: 'doing', label: 'Doing', ...style });

		const { realm } = await ok(client, 'reorder_state', {
			realm: 'AM',
			state: 'doing',
			index: 0
		});
		const old = await call(client, 'reorder_state', {
			realm: 'AM',
			state: 'doing',
			position: 0
		});

		expect(realm.states.map((s: { key: string }) => s.key)).toEqual(['doing', 'todo', 'closed']);
		expect(text(old)).toContain('unknown argument "position"');
	});

	it('adds and removes 100 Labours of a Quest with one Event each', async () => {
		const client = await connect(admin);
		await seedRealm(client, 100);
		const { quest } = await ok(client, 'create_quest', { name: 'Launch' });
		const labours = Array.from({ length: 100 }, (_, i) => `AM-${i + 1}`);

		const before = lastSeq();
		const added = await ok(client, 'add_quest_labours', { quest: quest.id, labours });
		expect(eventsSince(db, before).map((e) => e.type)).toEqual(['quest.labours_added']);
		expect(added.quest.progress).toEqual({ closed: 0, total: 100 });
		expect(added.added).toEqual(labours);

		const middle = lastSeq();
		const removed = await ok(client, 'remove_quest_labours', { quest: quest.id, labours });
		expect(eventsSince(db, middle).map((e) => e.type)).toEqual(['quest.labours_removed']);
		expect(removed.quest.progress).toEqual({ closed: 0, total: 0 });
	});

	it('skips and reports Labours already as asked, without an error', async () => {
		const client = await connect(admin);
		await seedRealm(client, 3);
		const { quest } = await ok(client, 'create_quest', { name: 'Launch' });
		await ok(client, 'add_quest_labours', { quest: quest.id, labours: ['AM-1'] });

		const added = await call(client, 'add_quest_labours', {
			quest: quest.id,
			labours: ['AM-2', 'am-1', 'AM-3']
		});
		const removed = await ok(client, 'remove_quest_labours', {
			quest: quest.id,
			labours: ['AM-3', 'AM-2', 'AM-1']
		});
		const again = await ok(client, 'remove_quest_labours', { quest: quest.id, labours: ['AM-1'] });

		expect(added.structuredContent).toMatchObject({
			added: ['AM-2', 'AM-3'],
			skipped: ['AM-1']
		});
		expect(text(added).split('\n')[0]).toBe(
			`Quest ${quest.id} Launch: 0/3 closed; added 2 Labours, skipped 1 already in it`
		);
		expect(removed).toMatchObject({ removed: ['AM-3', 'AM-2', 'AM-1'], skipped: [] });
		expect(again).toMatchObject({ removed: [], skipped: ['AM-1'] });
	});

	it('refuses more than 100 Labours in one call', async () => {
		const client = await connect(admin);
		const { quest } = await ok(client, 'create_quest', { name: 'Launch' });

		const result = await call(client, 'add_quest_labours', {
			quest: quest.id,
			labours: Array.from({ length: 101 }, (_, i) => `AM-${i + 1}`)
		});

		expect(result.structuredContent).toMatchObject({
			error: { code: 'invalid', message: expect.stringContaining('argument "labours"') }
		});
	});

	it('summarises a page past the last Labour without a backwards range', async () => {
		const client = await connect(admin);
		await seedRealm(client, 3);

		const result = await call(client, 'list_labours', { offset: 10 });

		expect(text(result).split('\n')[0]).toBe('No Labours at offset 10; 3 Labours match');
		expect(result.structuredContent).toMatchObject({ labours: [], total: 3, nextOffset: null });
	});

	it('answers an unexpected failure without its details', async () => {
		const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
		const client = await connect(admin);
		db.$client.close();

		const result = await call(client, 'list_realms');

		expect(result).toMatchObject({ isError: true, content: [{ text: 'Internal error' }] });
		expect(quiet).toHaveBeenCalled();
		quiet.mockRestore();
		db = testDb();
	});

	it('refuses an Admin tool to a User who is not an Admin', async () => {
		const result = await call(await connect(seedHuman(db, 'bob')), 'create_invite');

		expect(result.isError).toBe(true);
		expect(text(result)).toBe('Only an Admin can do that');
	});
});
