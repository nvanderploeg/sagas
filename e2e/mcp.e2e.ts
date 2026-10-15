import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { cookieHeader, uniqueName } from './support/http.ts';
import {
	connectMcp,
	expect,
	mcpTransport,
	test,
	uniqueProjectKey,
	type Mcp
} from './fixtures/mcp.ts';

const TOOLS = [
	'resolve',
	'list_tickets',
	'get_ticket',
	'create_ticket',
	'update_ticket',
	'move_ticket',
	'rank_ticket',
	'set_parent',
	'delete_ticket',
	'list_projects',
	'get_project',
	'create_project',
	'update_project',
	'rename_project_key',
	'delete_project',
	'set_initial_state',
	'create_state',
	'update_state',
	'reorder_state',
	'delete_state',
	'create_substate',
	'update_substate',
	'reorder_substate',
	'delete_substate',
	'set_default_substate',
	'list_quests',
	'get_quest',
	'create_quest',
	'update_quest',
	'delete_quest',
	'add_quest_tickets',
	'remove_quest_tickets',
	'rank_quest_ticket',
	'whoami',
	'list_users',
	'create_invite',
	'list_invites',
	'create_agent_user',
	'list_api_tokens',
	'create_api_token',
	'revoke_api_token'
];

const keysOf = (tickets: { key: string }[]) => tickets.map((t) => t.key);

async function newProject(mcp: Mcp, name = 'MCP'): Promise<string> {
	const key = uniqueProjectKey();
	await mcp.ok('create_project', { name, key: key.toLowerCase() });
	return key;
}

const initialize = {
	jsonrpc: '2.0',
	id: 1,
	method: 'initialize',
	params: {
		protocolVersion: '2025-06-18',
		capabilities: {},
		clientInfo: { name: 'curl', version: '0' }
	}
};

test.describe('MCP at /mcp', () => {
	test('lists every tool, each with a description and an object input schema', async ({ mcp }) => {
		const { tools } = await mcp.client.listTools();

		expect(tools.map((t) => t.name).sort()).toEqual([...TOOLS].sort());
		for (const tool of tools) {
			expect(tool.description, tool.name).toBeTruthy();
			expect(tool.inputSchema.type, tool.name).toBe('object');
		}
		expect(mcp.client.getServerVersion()?.name).toBe('workload');
	});

	test('acts as the token User', async ({ mcp, admin }) => {
		const { user } = await mcp.ok('whoami');
		expect(user).toEqual({
			id: admin.id,
			username: admin.username,
			displayName: admin.displayName,
			kind: 'human',
			isAdmin: true
		});
	});

	test('runs a Ticket through its lifecycle', async ({ mcp, admin }) => {
		const key = await newProject(mcp);
		await mcp.ok('create_state', {
			project: key,
			key: 'doing',
			label: 'Doing',
			color: '#2563eb',
			icon: 'play'
		});
		await mcp.ok('create_substate', {
			project: key,
			state: 'doing',
			key: 'review',
			label: 'Review',
			color: '#7c3aed',
			icon: 'eye'
		});

		const { ticket: first } = await mcp.ok('create_ticket', {
			project: key.toLowerCase(),
			title: 'Ship the MCP server',
			description: 'Over **Streamable HTTP**',
			assignee: admin.username
		});
		expect(first).toMatchObject({
			key: `${key}-1`,
			title: 'Ship the MCP server',
			project: key,
			state: { key: 'todo', label: 'To do' },
			substate: null,
			closed: false,
			owner: admin.username,
			assignee: admin.username,
			parent: null,
			description: 'Over **Streamable HTTP**',
			children: [],
			quests: []
		});

		const child = await mcp.call('create_ticket', {
			project: key,
			title: 'Write the docs',
			parent: first.key.toLowerCase()
		});
		expect(child.isError).toBe(false);
		expect(child.data.ticket).toMatchObject({ key: `${key}-2`, parent: `${key}-1` });
		expect(child.text).toContain(`${key}-2 [To do] Write the docs`);

		const { ticket: parent } = await mcp.ok('get_ticket', { ticket: first.id });
		expect(keysOf(parent.children)).toEqual([`${key}-2`]);

		const { ticket: started } = await mcp.ok('update_ticket', {
			ticket: `${key}-1`,
			state: 'doing',
			title: 'Ship it'
		});
		expect(started).toMatchObject({
			title: 'Ship it',
			state: { key: 'doing', label: 'Doing' },
			substate: { key: 'review', label: 'Review' }
		});

		await mcp.ok('create_ticket', { project: key, title: 'Third' });
		await mcp.ok('rank_ticket', { ticket: `${key}-3`, position: 'top' });
		const todo = await mcp.ok('list_tickets', { project: key, state: 'todo' });
		expect(keysOf(todo.tickets)).toEqual([`${key}-3`, `${key}-2`]);
		expect(todo).toMatchObject({ total: 2, offset: 0, nextOffset: null });

		const paged = await mcp.ok('list_tickets', { project: key, limit: 1 });
		expect(paged).toMatchObject({ total: 3, nextOffset: 1 });
		expect(keysOf(paged.tickets)).toEqual([`${key}-3`]);

		const { ticket: closed } = await mcp.ok('update_ticket', {
			ticket: `${key}-1`,
			state: 'closed'
		});
		expect(closed).toMatchObject({ state: { key: 'closed', label: 'Closed' }, closed: true });
		const done = await mcp.ok('list_tickets', { project: key, closed: true });
		expect(keysOf(done.tickets)).toEqual([`${key}-1`]);

		const unparented = await mcp.ok('set_parent', { ticket: `${key}-2`, parent: null });
		expect(unparented.ticket.parent).toBeNull();

		const deleted = await mcp.ok('delete_ticket', { ticket: `${key}-2` });
		expect(deleted).toEqual({ deleted: { id: child.data.ticket.id, key: `${key}-2` } });
		const gone = await mcp.call('get_ticket', { ticket: `${key}-2` });
		expect(gone).toMatchObject({ isError: true, text: `No Ticket has the key ${key}-2` });

		const again = await mcp.ok('create_ticket', { project: key, title: 'Numbers never reused' });
		expect(again.ticket.key).toBe(`${key}-4`);
	});

	test('a moved Ticket keeps its old keys as Aliases', async ({ mcp }) => {
		const from = await newProject(mcp, 'From');
		const to = await newProject(mcp, 'To');
		await mcp.ok('create_ticket', { project: from, title: 'Wanderer' });
		await mcp.ok('update_ticket', { ticket: `${from}-1`, state: 'closed' });

		const { ticket: moved } = await mcp.ok('move_ticket', {
			ticket: `${from.toLowerCase()}-1`,
			project: to
		});
		expect(moved).toMatchObject({
			key: `${to}-1`,
			project: to,
			state: { key: 'closed' },
			closed: true,
			aliases: [`${from}-1`]
		});

		const resolved = await mcp.ok('resolve', { key: `${from.toLowerCase()}-1` });
		expect(resolved).toMatchObject({ alias: true, ticket: { id: moved.id, key: `${to}-1` } });
		const current = await mcp.ok('resolve', { key: `${to}-1` });
		expect(current.alias).toBe(false);

		const renamed = uniqueProjectKey();
		const { project } = await mcp.ok('rename_project_key', { project: to, key: renamed });
		expect(project).toMatchObject({ key: renamed, aliases: [to] });
		for (const old of [`${from}-1`, `${to}-1`]) {
			const { ticket } = await mcp.ok('get_ticket', { ticket: old });
			expect(ticket.key, old).toBe(`${renamed}-1`);
		}
		const viaOldProjectKey = await mcp.ok('list_tickets', { project: to });
		expect(keysOf(viaOldProjectKey.tickets)).toEqual([`${renamed}-1`]);
	});

	test('a Quest counts its Closed Tickets and never adds Children', async ({ mcp }) => {
		const key = await newProject(mcp);
		for (const title of ['Epic', 'Part', 'Other']) {
			await mcp.ok('create_ticket', { project: key, title });
		}
		await mcp.ok('set_parent', { ticket: `${key}-2`, parent: `${key}-1` });

		const { quest } = await mcp.ok('create_quest', { name: 'Launch', description: 'Go live' });
		expect(quest).toMatchObject({ name: 'Launch', tickets: [], progress: { closed: 0, total: 0 } });

		const added = await mcp.ok('add_quest_tickets', {
			quest: quest.id,
			tickets: [`${key}-1`, `${key}-3`]
		});
		expect(keysOf(added.quest.tickets)).toEqual([`${key}-1`, `${key}-3`]);

		await mcp.ok('update_ticket', { ticket: `${key}-3`, state: 'closed' });
		const progressed = await mcp.ok('get_quest', { quest: quest.id });
		expect(progressed.quest.progress).toEqual({ closed: 1, total: 2 });
		expect(progressed.quest.tickets[1]).toMatchObject({ key: `${key}-3`, closed: true });

		const reordered = await mcp.ok('rank_quest_ticket', {
			quest: quest.id,
			ticket: `${key}-3`,
			before: `${key}-1`
		});
		expect(keysOf(reordered.quest.tickets)).toEqual([`${key}-3`, `${key}-1`]);
		const members = await mcp.ok('list_tickets', { quest: quest.id });
		expect(keysOf(members.tickets)).toEqual([`${key}-3`, `${key}-1`]);

		const { ticket } = await mcp.ok('get_ticket', { ticket: `${key}-1` });
		expect(ticket.quests).toEqual([
			{ id: quest.id, name: 'Launch', progress: { closed: 1, total: 2 } }
		]);

		const twice = await mcp.call('add_quest_tickets', { quest: quest.id, tickets: [`${key}-1`] });
		expect(twice.isError).toBe(true);

		const removed = await mcp.ok('remove_quest_tickets', {
			quest: quest.id,
			tickets: [`${key}-3`]
		});
		expect(removed.quest.progress).toEqual({ closed: 0, total: 1 });
	});

	test('refuses an Admin tool to an Agent user, and lets the Admin use it', async ({
		mcp,
		request
	}) => {
		const username = uniqueName('agent');
		const { user } = await mcp.ok('create_agent_user', { username, displayName: 'Bot' });
		expect(user).toMatchObject({ username, kind: 'agent', isAdmin: false });
		const { token } = await mcp.ok('create_api_token', { user: username, name: 'e2e' });

		const agent = await connectMcp(token);
		try {
			expect((await agent.ok('whoami')).user).toMatchObject({ username, kind: 'agent' });
			const refused = await agent.call('create_invite');
			expect(refused).toEqual({
				isError: true,
				text: 'Only an Admin can do that',
				data: { error: { code: 'forbidden', message: 'Only an Admin can do that' } }
			});
			expect((await agent.call('list_invites')).isError).toBe(true);
		} finally {
			await agent.close();
		}

		const invite = await mcp.ok('create_invite');
		expect(invite.path).toMatch(/^\/invite\/wli_/);
		expect((await request.get(invite.path)).status()).toBe(200);
	});

	test('answers 401 without a Bearer token', async ({ request, signedInPage: page }) => {
		const bare = await request.post('/mcp', {
			data: initialize,
			headers: { accept: 'application/json, text/event-stream' }
		});
		expect(bare.status()).toBe(401);
		expect(bare.headers()['www-authenticate']).toBe('Bearer');

		const cookie = await cookieHeader(page.context());
		const withCookie = await request.post('/mcp', {
			data: initialize,
			headers: { accept: 'application/json, text/event-stream', cookie }
		});
		expect(withCookie.status()).toBe(401);

		const client = new Client({ name: 'anonymous', version: '0' });
		await expect(client.connect(mcpTransport())).rejects.toThrow();
	});

	test('serves plain JSON-RPC over POST without a session', async ({ request, apiToken }) => {
		const response = await request.post('/mcp', {
			data: initialize,
			headers: {
				authorization: `Bearer ${apiToken.token}`,
				accept: 'application/json, text/event-stream'
			}
		});
		expect(response.status()).toBe(200);
		expect(response.headers()['mcp-session-id']).toBeUndefined();
		expect(await response.json()).toMatchObject({
			jsonrpc: '2.0',
			id: 1,
			result: { serverInfo: { name: 'workload' } }
		});
	});
});
