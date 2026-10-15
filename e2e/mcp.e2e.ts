import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { origin } from './support/env.ts';
import { cookieHeader, uniqueName } from './support/http.ts';
import { openStream, type Frame } from './support/stream.ts';
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

// The Events recorded after `since`, as the Stream replays them.
async function eventsAfter(token: string, since: number) {
	const stream = await openStream({ authorization: `Bearer ${token}` }, `?since=${since}`);
	try {
		const frames = await stream.until((f) => f.some((frame) => frame.event === 'ready'));
		return frames
			.filter((f: Frame) => f.event !== undefined && f.event !== 'ready')
			.map((f) => JSON.parse(f.data!) as { type: string; actor: { id: number } });
	} finally {
		await stream.close();
	}
}

const rpcHeaders = (token: string, extra: Record<string, string> = {}) => ({
	authorization: `Bearer ${token}`,
	accept: 'application/json, text/event-stream',
	'content-type': 'application/json',
	'mcp-protocol-version': '2025-06-18',
	...extra
});

const ping = (id: number) => ({ jsonrpc: '2.0', id, method: 'ping' });

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

	test('acts as the token User, who is the actor of the Events its writes record', async ({
		mcp,
		admin,
		apiToken,
		seed
	}) => {
		const { user } = await mcp.ok('whoami');
		expect(user).toEqual({
			id: admin.id,
			username: admin.username,
			displayName: admin.displayName,
			kind: 'human',
			isAdmin: true
		});

		const username = uniqueName('agent');
		await mcp.ok('create_agent_user', { username, displayName: 'Bot' });
		const { token } = await mcp.ok('create_api_token', { user: username, name: 'e2e' });
		const agent = await connectMcp(token);
		try {
			const { user: bot } = await agent.ok('whoami');
			const before = seed.lastSeq();
			await agent.ok('create_project', { name: 'By the bot', key: uniqueProjectKey() });

			const events = await eventsAfter(apiToken.token, before);
			expect(events.map((e) => [e.type, e.actor])).toEqual([
				['project.created', { id: bot.id, kind: 'agent', username, displayName: 'Bot' }]
			]);
		} finally {
			await agent.close();
		}
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
		expect(child.text.split('\n')[0]).toBe(`${key}-2 [todo: To do] Write the docs`);
		expect(JSON.parse(child.text.split('\n').slice(1).join('\n'))).toEqual(child.data);

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

		const resolved = await mcp.ok('resolve', { ticket: `${from.toLowerCase()}-1` });
		expect(resolved).toMatchObject({ alias: true, ticket: { id: moved.id, key: `${to}-1` } });
		const current = await mcp.ok('resolve', { ticket: `${to}-1` });
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

		const twice = await mcp.ok('add_quest_tickets', { quest: quest.id, tickets: [`${key}-1`] });
		expect(twice).toMatchObject({ added: [], skipped: [`${key}-1`] });
		expect(keysOf(twice.quest.tickets)).toEqual([`${key}-3`, `${key}-1`]);

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

	test('adds 100 Tickets to a Quest with exactly one Event', async ({ mcp, apiToken, seed }) => {
		const key = await newProject(mcp);
		const tickets: string[] = [];
		for (let i = 1; i <= 100; i++) {
			await mcp.ok('create_ticket', { project: key, title: `Bulk ${i}` });
			tickets.push(`${key}-${i}`);
		}
		const { quest } = await mcp.ok('create_quest', { name: 'Bulk' });

		const before = seed.lastSeq();
		const added = await mcp.ok('add_quest_tickets', { quest: quest.id, tickets });

		expect(added.quest.progress).toEqual({ closed: 0, total: 100 });
		const events = await eventsAfter(apiToken.token, before);
		expect(events.map((e) => e.type)).toEqual(['quest.tickets_added']);

		const tooMany = await mcp.call('add_quest_tickets', {
			quest: quest.id,
			tickets: [...tickets, `${key}-101`]
		});
		expect(tooMany.data).toMatchObject({ error: { code: 'invalid' } });
	});

	test('rejects an unknown argument and an unknown tool in the error contract', async ({ mcp }) => {
		const unknownArg = await mcp.call('list_projects', { verbose: true });
		expect(unknownArg).toMatchObject({
			isError: true,
			data: {
				error: {
					code: 'invalid',
					message:
						'Invalid arguments for list_projects: unknown argument "verbose"; list_projects takes no arguments'
				}
			}
		});

		const unknownTool = await mcp.call('make_coffee');
		expect(unknownTool.data).toEqual({
			error: { code: 'not_found', message: 'No tool is named "make_coffee"' }
		});
	});

	test('refuses a JSON-RPC batch', async ({ request, apiToken }) => {
		const response = await request.post('/mcp', {
			data: [ping(1), ping(2)],
			headers: rpcHeaders(apiToken.token)
		});

		expect(response.status()).toBe(400);
		expect(await response.json()).toMatchObject({
			jsonrpc: '2.0',
			id: null,
			error: { code: -32600, message: expect.stringContaining('batches are not supported') }
		});
	});

	test('answers a body over BODY_SIZE_LIMIT with 413, sized or chunked', async ({ apiToken }) => {
		const big = JSON.stringify({ ...ping(1), params: { pad: 'x'.repeat(600 * 1024) } });
		const chunks = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode(big));
				controller.close();
			}
		});
		const sized = await fetch(`${origin}/mcp`, {
			method: 'POST',
			headers: rpcHeaders(apiToken.token),
			body: big
		});
		const chunked = await fetch(`${origin}/mcp`, {
			method: 'POST',
			headers: rpcHeaders(apiToken.token),
			body: chunks,
			duplex: 'half'
		} as RequestInit);

		for (const response of [sized, chunked]) {
			expect(response.status).toBe(413);
			expect(await response.json()).toEqual({
				jsonrpc: '2.0',
				id: null,
				error: { code: -32600, message: 'Request body too large: it exceeds BODY_SIZE_LIMIT' }
			});
		}
	});

	test('refuses a foreign Origin and accepts its own', async ({ request, apiToken }) => {
		const foreign = await request.post('/mcp', {
			data: ping(1),
			headers: rpcHeaders(apiToken.token, { origin: 'http://evil.example' })
		});
		expect(foreign.status()).toBe(403);

		const own = await request.post('/mcp', {
			data: ping(1),
			headers: rpcHeaders(apiToken.token, { origin })
		});
		expect(own.status()).toBe(200);
		expect(await own.json()).toEqual({ jsonrpc: '2.0', id: 1, result: {} });
	});

	test('answers GET with 405', async ({ request, apiToken }) => {
		const response = await request.get('/mcp', {
			headers: { authorization: `Bearer ${apiToken.token}`, accept: 'text/event-stream' }
		});

		expect(response.status()).toBe(405);
		expect(response.headers()['allow']).toBe('POST');
	});

	test('answers DELETE with 405, or 403 from the CSRF check without a matching Origin', async ({
		request,
		apiToken
	}) => {
		const authorization = `Bearer ${apiToken.token}`;

		const bare = await request.delete('/mcp', { headers: { authorization } });
		expect(bare.status()).toBe(403);

		const foreign = await request.delete('/mcp', {
			headers: { authorization, origin: 'http://evil.example' }
		});
		expect(foreign.status()).toBe(403);

		const own = await request.delete('/mcp', { headers: { authorization, origin } });
		expect(own.status()).toBe(405);
		expect(own.headers()['allow']).toBe('POST');
	});

	test('does not advertise tools.listChanged', async ({ mcp }) => {
		expect(mcp.client.getServerCapabilities()?.tools).toEqual({});
	});
});
