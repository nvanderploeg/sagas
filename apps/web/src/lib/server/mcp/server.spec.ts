import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { seedHuman } from '#lib/server/auth/fixtures.ts';
import { createFirstAdmin, type AuthUser } from '#lib/server/auth/users.ts';
import type { Db } from '#lib/server/db/client.ts';
import { DomainError } from '#lib/server/domain/errors.ts';
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

const text = (result: CallToolResult) =>
	result.content.map((part) => (part.type === 'text' ? part.text : '')).join('');

describe('toErrorResult', () => {
	it('carries a DomainError code and message', () => {
		expect(toErrorResult(new DomainError('conflict', 'Project key AM is already in use'))).toEqual({
			isError: true,
			content: [{ type: 'text', text: 'Project key AM is already in use' }],
			structuredContent: {
				error: { code: 'conflict', message: 'Project key AM is already in use' }
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
	it('lists every tool with a description and an input schema', async () => {
		const { tools } = await (await connect(admin)).listTools();
		const names = tools.map((t) => t.name);

		for (const name of [
			'resolve',
			'list_tickets',
			'create_ticket',
			'add_quest_tickets',
			'whoami'
		]) {
			expect(names).toContain(name);
		}
		for (const tool of tools) {
			expect(tool.description, tool.name).toBeTruthy();
			expect(tool.inputSchema.type, tool.name).toBe('object');
		}
	});

	it('acts as the given User', async () => {
		const client = await connect(admin);
		await call(client, 'create_project', { name: 'Atlas', key: 'am' });
		const result = await call(client, 'create_ticket', { project: 'AM', title: 'First' });

		expect(result.isError).toBeFalsy();
		expect(result.structuredContent).toMatchObject({
			ticket: {
				key: 'AM-1',
				title: 'First',
				state: { key: 'todo', label: 'To do' },
				substate: null,
				closed: false,
				owner: 'root',
				assignee: null,
				parent: null
			}
		});
		expect(text(result)).toContain('AM-1 [To do] First');
	});

	it('maps a DomainError to a tool error with the service message', async () => {
		const client = await connect(admin);
		await call(client, 'create_project', { name: 'Atlas', key: 'AM' });
		const result = await call(client, 'create_project', { name: 'Again', key: 'am' });

		expect(result.isError).toBe(true);
		expect(text(result)).toBe('Project key AM is already in use');
		expect(result.structuredContent).toEqual({
			error: { code: 'conflict', message: 'Project key AM is already in use' }
		});
	});

	it('reports bad arguments as a tool error', async () => {
		const result = await call(await connect(admin), 'get_ticket', {});

		expect(result.isError).toBe(true);
		expect(text(result)).toContain('Input validation error');
	});

	it('answers an unexpected failure without its details', async () => {
		const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
		const client = await connect(admin);
		db.$client.close();

		const result = await call(client, 'list_projects');

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
