import { seedAdmin } from '#lib/server/auth/fixtures.ts';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '#lib/server/db/client.ts';
import { testDb } from '#lib/server/test/db.ts';
import { createMcpServer } from '../server.ts';
import { BOARD_URI } from '../ui/resources.ts';

let db: Db;
let client: Client;

beforeEach(async () => {
	db = await testDb();
	const admin = await seedAdmin(db, 'root', 'Root');
	const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
	await createMcpServer(db, admin, 'http://sagas.test').connect(serverSide);
	client = new Client({ name: 'spec', version: '0' });
	await client.connect(clientSide);
});

afterEach(async () => {
	await client.close();
});

describe('show_board', () => {
	it('points its tool at the board view resource', async () => {
		const { tools } = await client.listTools();
		const tool = tools.find((t) => t.name === 'show_board');
		expect(tool?._meta).toEqual({ ui: { resourceUri: BOARD_URI } });
	});

	it('serves the board view as an MCP App document', async () => {
		const { resources } = await client.listResources();
		expect(resources.map((r) => r.uri)).toContain(BOARD_URI);
		const read = await client.readResource({ uri: BOARD_URI });
		expect(read.contents[0]).toMatchObject({
			mimeType: 'text/html;profile=mcp-app',
			text: expect.stringContaining('<html')
		});
	});

	it('returns the Realm States and its Labours as structured content', async () => {
		await client.callTool({ name: 'create_realm', arguments: { name: 'Atlas', key: 'am' } });
		await client.callTool({ name: 'create_labour', arguments: { realm: 'AM', title: 'First' } });
		const result = await client.callTool({ name: 'show_board', arguments: { realm: 'AM' } });
		const board = result.structuredContent as any;
		expect(board.realm.states.at(-1).closed).toBe(true);
		expect(board.labours).toHaveLength(1);
		expect(board.labours[0]).toMatchObject({ key: 'AM-1', title: 'First', state: 'todo' });
		expect(board.truncated).toBe(false);
	});
});
