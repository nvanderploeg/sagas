import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { origin } from './support/env.ts';
import { cookieHeader, uniqueName } from './support/http.ts';
import { openStream, type Frame } from './support/stream.ts';
import {
	connectMcp,
	expect,
	mcpTransport,
	test,
	uniqueRealmKey,
	type Mcp
} from './fixtures/mcp.ts';

const TOOLS = [
	'resolve',
	'list_labours',
	'get_labour',
	'create_labour',
	'update_labour',
	'move_labour',
	'rank_labour',
	'set_parent',
	'delete_labour',
	'add_comment',
	'update_comment',
	'delete_comment',
	'list_comments',
	'list_realms',
	'get_realm',
	'create_realm',
	'update_realm',
	'rename_realm_key',
	'delete_realm',
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
	'add_quest_labours',
	'remove_quest_labours',
	'list_members',
	'offer_membership',
	'withdraw_offer',
	'set_member_role',
	'remove_member',
	'list_offers',
	'accept_offer',
	'decline_offer',
	'rank_quest_labour',
	'whoami',
	'list_users',
	'create_invite',
	'list_invites',
	'create_agent_user',
	'list_api_tokens',
	'create_api_token',
	'revoke_api_token',
	'get_attributes',
	'define_attribute',
	'delete_attribute',
	'tune_realm',
	'appraise',
	'link_labours',
	'get_appraisal',
	'list_unappraised',
	'survey',
	'pulse',
	'get_sentiment',
	'file_pulses',
	'delete_pulse',
	'report_outcomes',
	'define_skill',
	'list_skills',
	'set_skills'
];

const keysOf = (labours: { key: string }[]) => labours.map((t) => t.key);

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

async function newRealm(mcp: Mcp, name = 'MCP'): Promise<string> {
	const key = uniqueRealmKey();
	await mcp.ok('create_realm', { name, key: key.toLowerCase() });
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
		expect(mcp.client.getServerVersion()?.name).toBe('sagas');
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
			await agent.ok('create_realm', { name: 'By the bot', key: uniqueRealmKey() });

			const events = await eventsAfter(token, before);
			expect(events.map((e) => [e.type, e.actor])).toEqual([
				[
					'realm.created',
					{
						id: bot.id,
						kind: 'agent',
						username,
						displayName: 'Bot',
						via: { tokenId: expect.any(Number), name: 'e2e' }
					}
				]
			]);
		} finally {
			await agent.close();
		}
	});

	test('runs a Labour through its lifecycle', async ({ mcp, admin }) => {
		const key = await newRealm(mcp);
		await mcp.ok('create_state', {
			realm: key,
			key: 'doing',
			label: 'Doing',
			color: '#2563eb',
			icon: 'play'
		});
		await mcp.ok('create_substate', {
			realm: key,
			state: 'doing',
			key: 'review',
			label: 'Review',
			color: '#7c3aed',
			icon: 'eye'
		});

		const { labour: first } = await mcp.ok('create_labour', {
			realm: key.toLowerCase(),
			title: 'Ship the MCP server',
			description: 'Over **Streamable HTTP**',
			assignee: admin.username
		});
		expect(first).toMatchObject({
			key: `${key}-1`,
			title: 'Ship the MCP server',
			realm: key,
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

		const child = await mcp.call('create_labour', {
			realm: key,
			title: 'Write the docs',
			parent: first.key.toLowerCase()
		});
		expect(child.isError).toBe(false);
		expect(child.data.labour).toMatchObject({ key: `${key}-2`, parent: `${key}-1` });
		expect(child.text.split('\n')[0]).toBe(`${key}-2 [todo: To do] Write the docs`);
		expect(JSON.parse(child.text.split('\n').slice(1).join('\n'))).toEqual(child.data);

		const { labour: parent } = await mcp.ok('get_labour', { labour: first.id });
		expect(keysOf(parent.children)).toEqual([`${key}-2`]);

		const { labour: started } = await mcp.ok('update_labour', {
			labour: `${key}-1`,
			state: 'doing',
			title: 'Ship it'
		});
		expect(started).toMatchObject({
			title: 'Ship it',
			state: { key: 'doing', label: 'Doing' },
			substate: { key: 'review', label: 'Review' }
		});

		await mcp.ok('create_labour', { realm: key, title: 'Third' });
		await mcp.ok('rank_labour', { labour: `${key}-3`, position: 'top' });
		const todo = await mcp.ok('list_labours', { realm: key, state: 'todo' });
		expect(keysOf(todo.labours)).toEqual([`${key}-3`, `${key}-2`]);
		expect(todo).toMatchObject({ total: 2, offset: 0, nextOffset: null });

		const paged = await mcp.ok('list_labours', { realm: key, limit: 1 });
		expect(paged).toMatchObject({ total: 3, nextOffset: 1 });
		expect(keysOf(paged.labours)).toEqual([`${key}-3`]);

		const { labour: closed } = await mcp.ok('update_labour', {
			labour: `${key}-1`,
			state: 'closed'
		});
		expect(closed).toMatchObject({ state: { key: 'closed', label: 'Closed' }, closed: true });
		const done = await mcp.ok('list_labours', { realm: key, closed: true });
		expect(keysOf(done.labours)).toEqual([`${key}-1`]);

		const unparented = await mcp.ok('set_parent', { labour: `${key}-2`, parent: null });
		expect(unparented.labour.parent).toBeNull();

		const deleted = await mcp.ok('delete_labour', { labour: `${key}-2` });
		expect(deleted).toEqual({ deleted: { id: child.data.labour.id, key: `${key}-2` } });
		const gone = await mcp.call('get_labour', { labour: `${key}-2` });
		expect(gone).toMatchObject({ isError: true, text: `No Labour has the key ${key}-2` });

		const again = await mcp.ok('create_labour', { realm: key, title: 'Numbers never reused' });
		expect(again.labour.key).toBe(`${key}-4`);
	});

	test('a moved Labour keeps its old keys as Aliases', async ({ mcp }) => {
		const from = await newRealm(mcp, 'From');
		const to = await newRealm(mcp, 'To');
		await mcp.ok('create_labour', { realm: from, title: 'Wanderer' });
		await mcp.ok('update_labour', { labour: `${from}-1`, state: 'closed' });

		const { labour: moved } = await mcp.ok('move_labour', {
			labour: `${from.toLowerCase()}-1`,
			realm: to
		});
		expect(moved).toMatchObject({
			key: `${to}-1`,
			realm: to,
			state: { key: 'closed' },
			closed: true,
			aliases: [`${from}-1`]
		});

		const resolved = await mcp.ok('resolve', { labour: `${from.toLowerCase()}-1` });
		expect(resolved).toMatchObject({ alias: true, labour: { id: moved.id, key: `${to}-1` } });
		const current = await mcp.ok('resolve', { labour: `${to}-1` });
		expect(current.alias).toBe(false);

		const renamed = uniqueRealmKey();
		const { realm } = await mcp.ok('rename_realm_key', { realm: to, key: renamed });
		expect(realm).toMatchObject({ key: renamed, aliases: [to] });
		for (const old of [`${from}-1`, `${to}-1`]) {
			const { labour } = await mcp.ok('get_labour', { labour: old });
			expect(labour.key, old).toBe(`${renamed}-1`);
		}
		const viaOldRealmKey = await mcp.ok('list_labours', { realm: to });
		expect(keysOf(viaOldRealmKey.labours)).toEqual([`${renamed}-1`]);
	});

	test('a Quest counts its Closed Labours and never adds Children', async ({ mcp }) => {
		const key = await newRealm(mcp);
		for (const title of ['Epic', 'Part', 'Other']) {
			await mcp.ok('create_labour', { realm: key, title });
		}
		await mcp.ok('set_parent', { labour: `${key}-2`, parent: `${key}-1` });

		const { quest } = await mcp.ok('create_quest', {
			realm: key,
			name: 'Launch',
			description: 'Go live'
		});
		expect(quest).toMatchObject({ name: 'Launch', labours: [], progress: { closed: 0, total: 0 } });

		const added = await mcp.ok('add_quest_labours', {
			quest: quest.id,
			labours: [`${key}-1`, `${key}-3`]
		});
		expect(keysOf(added.quest.labours)).toEqual([`${key}-1`, `${key}-3`]);

		await mcp.ok('update_labour', { labour: `${key}-3`, state: 'closed' });
		const progressed = await mcp.ok('get_quest', { quest: quest.id });
		expect(progressed.quest.progress).toEqual({ closed: 1, total: 2 });
		expect(progressed.quest.labours[1]).toMatchObject({ key: `${key}-3`, closed: true });

		const reordered = await mcp.ok('rank_quest_labour', {
			quest: quest.id,
			labour: `${key}-3`,
			before: `${key}-1`
		});
		expect(keysOf(reordered.quest.labours)).toEqual([`${key}-3`, `${key}-1`]);
		const members = await mcp.ok('list_labours', { quest: quest.id });
		expect(keysOf(members.labours)).toEqual([`${key}-3`, `${key}-1`]);

		const { labour } = await mcp.ok('get_labour', { labour: `${key}-1` });
		expect(labour.quests).toEqual([
			{ id: quest.id, name: 'Launch', progress: { closed: 1, total: 2 } }
		]);

		const twice = await mcp.ok('add_quest_labours', { quest: quest.id, labours: [`${key}-1`] });
		expect(twice).toMatchObject({ added: [], skipped: [`${key}-1`] });
		expect(keysOf(twice.quest.labours)).toEqual([`${key}-3`, `${key}-1`]);

		const removed = await mcp.ok('remove_quest_labours', {
			quest: quest.id,
			labours: [`${key}-3`]
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
		expect(bare.headers()['www-authenticate']).toBe(
			`Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"`
		);

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
			result: { serverInfo: { name: 'sagas' } }
		});
	});

	test('adds 100 Labours to a Quest with exactly one Event', async ({ mcp, apiToken, seed }) => {
		const key = await newRealm(mcp);
		const labours: string[] = [];
		for (let i = 1; i <= 100; i++) {
			await mcp.ok('create_labour', { realm: key, title: `Bulk ${i}` });
			labours.push(`${key}-${i}`);
		}
		const { quest } = await mcp.ok('create_quest', { realm: key, name: 'Bulk' });

		const before = seed.lastSeq();
		const added = await mcp.ok('add_quest_labours', { quest: quest.id, labours });

		expect(added.quest.progress).toEqual({ closed: 0, total: 100 });
		const events = await eventsAfter(apiToken.token, before);
		expect(events.map((e) => e.type)).toEqual(['quest.labours_added']);

		const tooMany = await mcp.call('add_quest_labours', {
			quest: quest.id,
			labours: [...labours, `${key}-101`]
		});
		expect(tooMany.data).toMatchObject({ error: { code: 'invalid' } });
	});

	test('rejects an unknown argument and an unknown tool in the error contract', async ({ mcp }) => {
		const unknownArg = await mcp.call('list_realms', { verbose: true });
		expect(unknownArg).toMatchObject({
			isError: true,
			data: {
				error: {
					code: 'invalid',
					message:
						'Invalid arguments for list_realms: unknown argument "verbose"; list_realms takes no arguments'
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
