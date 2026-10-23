import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { seedHuman } from '#lib/server/auth/fixtures.ts';
import type { AuthUser } from '#lib/server/auth/users.ts';
import type { Db } from '#lib/server/db/client.ts';
import { setAccessEnforced } from '#lib/server/domain/access.ts';
import { testDb } from '#lib/server/test/db.ts';
import { createMcpServer } from './server.ts';

let db: Db;
let ada: AuthUser;
let bob: AuthUser;
let eve: AuthUser;
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

async function ok(client: Client, name: string, args: Record<string, unknown> = {}) {
	const result = await call(client, name, args);
	expect(result.isError, `${name}: ${JSON.stringify(result.content)}`).toBeFalsy();
	return result.structuredContent as any;
}

const errorCode = async (client: Client, name: string, args: Record<string, unknown> = {}) => {
	const result = await call(client, name, args);
	expect(result.isError).toBe(true);
	return (result.structuredContent as any).error.code as string;
};

beforeEach(async () => {
	setAccessEnforced(true);
	db = testDb();
	ada = seedHuman(db, 'ada');
	bob = seedHuman(db, 'bob');
	eve = seedHuman(db, 'eve');
	const owner = await connect(ada);
	await ok(owner, 'create_realm', { name: 'Atlas', key: 'am' });
	await ok(owner, 'create_labour', { realm: 'AM', title: 'Secret plan' });
});

afterEach(async () => {
	setAccessEnforced(false);
	await Promise.all(clients.splice(0).map((client) => client.close()));
	db.$client.close();
});

describe('a stranger over MCP', () => {
	it('finds no trace of a private Realm or its Labours', async () => {
		const stranger = await connect(eve);

		expect((await ok(stranger, 'list_realms')).realms).toEqual([]);
		expect((await ok(stranger, 'list_labours')).labours).toEqual([]);
		for (const [tool, args] of [
			['get_realm', { realm: 'AM' }],
			['get_labour', { labour: 'AM-1' }],
			['get_appraisal', { labour: 'AM-1' }],
			['list_comments', { labour: 'AM-1' }],
			['create_labour', { realm: 'AM', title: 'x' }],
			['update_labour', { labour: 'AM-1', title: 'x' }],
			['list_members', { realm: 'AM' }]
		] as const) {
			expect(await errorCode(stranger, tool, args), tool).toBe('not_found');
		}
	});

	it('is told the same of a Realm that does not exist', async () => {
		const stranger = await connect(eve);

		const hidden = await call(stranger, 'get_realm', { realm: 'AM' });
		const absent = await call(stranger, 'get_realm', { realm: 'ZZ' });

		expect((hidden.structuredContent as any).error.message.replace('AM', 'ZZ')).toBe(
			(absent.structuredContent as any).error.message
		);
	});
});

describe('Offers over MCP', () => {
	it('grant access only after they are accepted, with the role offered', async () => {
		const owner = await connect(ada);
		const invitee = await connect(bob);

		await ok(owner, 'offer_membership', { realm: 'AM', user: 'bob', role: 'viewer' });
		expect(await errorCode(invitee, 'get_realm', { realm: 'AM' })).toBe('not_found');
		expect((await ok(invitee, 'list_offers')).offers).toMatchObject([
			{ realm: 'AM', role: 'viewer', invitedBy: 'ada' }
		]);

		await ok(invitee, 'accept_offer', { realm: 'am' });

		expect((await ok(invitee, 'get_labour', { labour: 'AM-1' })).labour.title).toBe('Secret plan');
		expect(await errorCode(invitee, 'update_labour', { labour: 'AM-1', title: 'x' })).toBe(
			'forbidden'
		);

		await ok(owner, 'set_member_role', { realm: 'AM', user: 'bob', role: 'editor' });
		await ok(invitee, 'update_labour', { labour: 'AM-1', title: 'Renamed' });
	});

	it('can be declined, after which the Realm stays invisible', async () => {
		const owner = await connect(ada);
		const invitee = await connect(bob);
		await ok(owner, 'offer_membership', { realm: 'AM', user: 'bob', role: 'editor' });

		await ok(invitee, 'decline_offer', { realm: 'AM' });

		expect(await errorCode(invitee, 'get_realm', { realm: 'AM' })).toBe('not_found');
		expect((await ok(invitee, 'list_offers')).offers).toEqual([]);
	});
});
