import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
	ResourceListChangedNotificationSchema,
	ToolListChangedNotificationSchema
} from '@modelcontextprotocol/sdk/types.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cacheDirFor, createHelper, type Helper, type HelperOptions } from './server.ts';
import { ok, toolError } from './testing/stub.ts';
import {
	createWorldStub,
	defaultWorld,
	scale,
	sentimentKey,
	tags,
	type World
} from './testing/world.ts';

const INSTRUCTIONS = 'sagas is a labour tracker.';

let dir: string;
let world: World;
let stub: Awaited<ReturnType<typeof createWorldStub>>;
const opened: { helper: Helper; client: Client }[] = [];

type Opened = Awaited<ReturnType<typeof open>>;

async function open(overrides: Partial<HelperOptions> = {}, target = stub) {
	const warnings: string[] = [];
	const helper = await createHelper({
		url: target.url,
		token: 'secret',
		pollMs: 0,
		timeoutMs: 1000,
		configHome: dir,
		warn: (message) => warnings.push(message),
		...overrides
	});
	const client = new Client({ name: 'agent', version: '0' });
	const notes = { tools: 0, resources: 0 };
	client.setNotificationHandler(ToolListChangedNotificationSchema, () => void notes.tools++);
	client.setNotificationHandler(
		ResourceListChangedNotificationSchema,
		() => void notes.resources++
	);
	const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
	await helper.server.connect(serverSide);
	await client.connect(clientSide);
	await client.ping();
	opened.push({ helper, client });
	return { helper, client, notes, warnings };
}

// Round-trips so every notification sent before it has been delivered.
const flush = (session: Opened) => session.client.ping();

const text = (result: unknown) =>
	((result as { content: { text: string }[] }).content[0] ?? { text: '' }).text;

const surveyOf = async (session: Opened) =>
	(await session.client.listTools()).tools.find((t) => t.name === 'survey')!;

// Holds the next calls of a tool until released, answering as the world would.
function hold(name: string) {
	const answer = stub.handlers.get(name)!;
	let release!: () => void;
	let reach!: () => void;
	const released = new Promise<void>((resolve) => (release = resolve));
	const reached = new Promise<void>((resolve) => (reach = resolve));
	stub.handlers.set(name, async (args) => {
		reach();
		await released;
		return answer(args);
	});
	return { reached, release };
}

async function readJson(session: Opened, uri: string) {
	const { contents } = await session.client.readResource({ uri });
	return JSON.parse((contents[0] as { text: string }).text);
}

beforeEach(async () => {
	dir = mkdtempSync(join(tmpdir(), 'sagas-mcp-'));
	world = defaultWorld();
	stub = await createWorldStub(world);
});

afterEach(async () => {
	for (const { helper, client } of opened.splice(0)) {
		await client.close().catch(() => {});
		await helper.close();
	}
	await stub.stop();
	rmSync(dir, { recursive: true, force: true });
});

describe('tools', () => {
	it('passes every server tool through unchanged except survey', async () => {
		const session = await open();
		const { tools } = await session.client.listTools();
		expect(tools.map((t) => t.name)).toEqual(stub.tools.map((t) => t.name));
		for (const served of tools.filter((t) => t.name !== 'survey')) {
			expect(served).toEqual(stub.tools.find((t) => t.name === served.name));
		}
		const survey = tools.find((t) => t.name === 'survey')!;
		expect(survey.inputSchema).toEqual(stub.tools.find((t) => t.name === 'survey')!.inputSchema);
	});

	it('passes a call and its result through', async () => {
		const session = await open();
		stub.handlers.set('survey', (args) => ok({ echoed: args }));
		const result = await session.client.callTool({
			name: 'survey',
			arguments: { weights: { age: 1 } }
		});
		expect(result).toEqual(ok({ echoed: { weights: { age: 1 } } }));
		expect(stub.callsTo('survey')).toEqual([{ name: 'survey', args: { weights: { age: 1 } } }]);
	});

	it('passes an isError result through', async () => {
		const session = await open();
		stub.handlers.set('survey', () => toolError('invalid', 'weights: required'));
		const result = await session.client.callTool({ name: 'survey', arguments: {} });
		expect(result).toEqual(toolError('invalid', 'weights: required'));
	});

	it('passes an unknown tool error through', async () => {
		const session = await open();
		const result = await session.client.callTool({ name: 'nope', arguments: {} });
		expect(result.isError).toBe(true);
		expect(result.structuredContent).toEqual({
			error: { code: 'not_found', message: 'unknown tool nope' }
		});
	});

	it('answers a call with isError and the warning when the server is unreachable', async () => {
		const session = await open();
		await stub.stop();
		const result = await session.client.callTool({ name: 'survey', arguments: {} });
		expect(result.isError).toBe(true);
		expect(result.content).toHaveLength(1);
		expect(text(result)).toMatch(/^sagas unreachable: /);
	});

	it('answers a call with isError when the token is refused', async () => {
		const session = await open({ token: 'wrong' });
		const result = await session.client.callTool({ name: 'survey', arguments: {} });
		expect(result).toEqual({
			isError: true,
			content: [{ type: 'text', text: 'sagas refused the token' }]
		});
	});

	it('lists no tools, without failing, when nothing is cached and the server is down', async () => {
		await stub.stop();
		const session = await open();
		expect((await session.client.listTools()).tools).toEqual([]);
	});
});

describe('digest', () => {
	it('adds what the cache holds to the survey description', async () => {
		const session = await open();
		expect((await surveyOf(session)).description).toBe('Rank the Labours.');
		await session.helper.poll();
		expect((await surveyOf(session)).description).toBe(
			[
				'Rank the Labours.',
				'',
				'Cached for this instance:',
				'AM: impact (scale 1–5), topic (tags: boss-hp, loot); loud: topic:boss-hp mood +0.7, impact mood -0.4',
				'WB: fun (scale 0–10)',
				'Skills: art, code'
			].join('\n')
		);
	});

	it('names only the three loudest keys', async () => {
		world.sentiment[1].keys = [
			sentimentKey('AM', 'a', 1, 0.1, 0.1),
			sentimentKey('AM', 'b', 1, 0.2, 0.4),
			sentimentKey('AM', 'c', 1, -0.3, 0.3),
			sentimentKey('AM', 'd', 1, 0.5, 0.2)
		];
		const session = await open();
		await session.helper.poll();
		const line = (await surveyOf(session))
			.description!.split('\n')
			.find((l) => l.startsWith('AM:'));
		expect(line).toMatch(/; loud: b mood \+0\.2, c mood -0\.3, d mood \+0\.5$/);
	});

	it('cuts a long digest to 1,500 characters ending in an ellipsis', async () => {
		world.attributes[1].attributes = Array.from({ length: 32 }, (_, i) =>
			tags(
				`attribute-${i}`,
				Array.from({ length: 10 }, (_, j) => `member-${j}`)
			)
		);
		const session = await open();
		await session.helper.poll();
		const description = (await surveyOf(session)).description!;
		const digest = description.slice(description.indexOf('Cached for this instance:'));
		expect(digest).toHaveLength(1500);
		expect(digest.endsWith('…')).toBe(true);
	});

	it('leaves the description alone while the cache is empty', async () => {
		await stub.stop();
		const session = await open();
		await session.helper.poll();
		expect(await session.client.listTools()).toEqual({ tools: [] });
	});
});

describe('resources', () => {
	it('serves one resource per Realm and the Skills', async () => {
		const session = await open();
		expect((await session.client.listResources()).resources).toEqual([]);
		await session.helper.poll();
		const { resources } = await session.client.listResources();
		expect(resources.map((r) => r.uri)).toEqual([
			'sagas://realm/AM',
			'sagas://realm/WB',
			'sagas://skills'
		]);
		expect(resources.every((r) => r.mimeType === 'application/json')).toBe(true);

		const am = await readJson(session, 'sagas://realm/AM');
		expect(am).toEqual({
			realm: { id: 1, key: 'AM', name: 'Armory' },
			version: 1,
			notes: 'Armory notes',
			settings: { halfLifeDays: 14, loudness: 5 },
			attributes: world.attributes[1].attributes,
			attributesFetchedAt: expect.any(String),
			sentiment: world.sentiment[1],
			sentimentAsOf: expect.any(String)
		});
		const skills = await readJson(session, 'sagas://skills');
		expect(skills).toEqual({ skills: world.skills, fetchedAt: expect.any(String) });
	});

	it('rejects an unknown resource', async () => {
		const session = await open();
		await expect(session.client.readResource({ uri: 'sagas://realm/NOPE' })).rejects.toThrow(
			/Unknown resource/
		);
	});

	it('drops the resource and file of a Realm no longer listed', async () => {
		const session = await open();
		await session.helper.poll();
		expect(readdirSync(join(session.helper.cacheDir, 'realms')).sort()).toEqual([
			'1.json',
			'2.json'
		]);

		world.realms = world.realms.filter((r) => r.key !== 'WB');
		await session.helper.poll();
		const { resources } = await session.client.listResources();
		expect(resources.map((r) => r.uri)).toEqual(['sagas://realm/AM', 'sagas://skills']);
		expect(readdirSync(join(session.helper.cacheDir, 'realms'))).toEqual(['1.json']);
		expect((await surveyOf(session)).description).not.toContain('WB:');
	});

	it('serves a renamed Realm under its new key', async () => {
		const session = await open();
		await session.helper.poll();
		world.realms[0].key = 'ARM';
		await session.helper.poll();
		const { resources } = await session.client.listResources();
		expect(resources.map((r) => r.uri)).toContain('sagas://realm/ARM');
		expect(resources.map((r) => r.uri)).not.toContain('sagas://realm/AM');
		expect((await readJson(session, 'sagas://realm/ARM')).realm.key).toBe('ARM');
	});
});

describe('polling', () => {
	it('asks for attributes with the cached version and keeps the cache on a version-only answer', async () => {
		const session = await open();
		await session.helper.poll();
		const first = stub.callsTo('get_attributes').map((c) => c.args);
		expect(first).toEqual([{ realm: 1 }, { realm: 2 }]);

		await session.helper.poll();
		const second = stub
			.callsTo('get_attributes')
			.slice(2)
			.map((c) => c.args);
		expect(second).toEqual([
			{ realm: 1, since: 1 },
			{ realm: 2, since: 4 }
		]);
		const am = await readJson(session, 'sagas://realm/AM');
		expect(am.attributes).toEqual(world.attributes[1].attributes);
		expect(am.sentiment).toEqual(world.sentiment[1]);
	});

	it('takes a full answer when the version moves', async () => {
		const session = await open();
		await session.helper.poll();
		world.attributes[1] = {
			version: 2,
			notes: 'new notes',
			attributes: [scale('impact'), scale('fun')]
		};
		await session.helper.poll();
		const am = await readJson(session, 'sagas://realm/AM');
		expect(am.version).toBe(2);
		expect(am.notes).toBe('new notes');
		expect(am.attributes).toHaveLength(2);
	});

	it('refreshes Sentiment on its own timer without polling Realms again', async () => {
		const session = await open({ sentimentMs: 30 });
		await session.helper.poll();
		const realms = stub.callsTo('list_realms').length;
		world.sentiment[1] = {
			...world.sentiment[1],
			keys: [sentimentKey('AM', 'impact', 9, -0.9, 0.6)]
		};
		await vi.waitFor(async () => {
			expect((await readJson(session, 'sagas://realm/AM')).sentiment.keys[0].volume).toBe(9);
		});
		expect(stub.callsTo('list_realms')).toHaveLength(realms);
	});

	it('polls Realms, Attributes and Skills on its own timer', async () => {
		const session = await open({ pollMs: 30, sentimentMs: 0 });
		await vi.waitFor(() => {
			expect(stub.callsTo('list_realms').length).toBeGreaterThanOrEqual(3);
			expect(stub.callsTo('list_skills').length).toBeGreaterThanOrEqual(3);
		});
		await session.helper.close();
		await new Promise((resolve) => setTimeout(resolve, 100));
		const count = stub.calls.length;
		await new Promise((resolve) => setTimeout(resolve, 150));
		expect(stub.calls.length).toBe(count);
	});

	it('never fetches Sentiment when its timer is off', async () => {
		const session = await open({ sentimentMs: 0 });
		await session.helper.poll();
		expect(stub.callsTo('get_sentiment')).toEqual([]);
		expect((await readJson(session, 'sagas://realm/AM')).sentiment).toBeNull();
	});

	it('does not poll at all when polling is off', async () => {
		await open({ pollMs: 0, sentimentMs: 0 });
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(stub.calls).toEqual([]);
	});

	it('fetches Sentiment for a Realm that appears between Sentiment polls', async () => {
		const session = await open();
		await session.helper.poll();
		world.realms.push({ id: 3, key: 'NW', name: 'New', aliases: [] });
		world.attributes[3] = { version: 1, notes: '', attributes: [scale('fun')] };
		world.sentiment[3] = {
			asOf: '2026-01-01T00:00:00.000Z',
			keys: [sentimentKey('NW', 'fun', 3, 0.5, 0.4)],
			unfiled: []
		};
		await session.helper.poll();
		expect((await readJson(session, 'sagas://realm/NW')).sentiment.keys).toHaveLength(1);
	});

	it('runs one poll at a time', async () => {
		const session = await open();
		stub.delayMs = 20;
		await Promise.all([session.helper.poll(), session.helper.poll()]);
		const names = stub.calls.map((c) => c.name);
		const firstSkills = names.indexOf('list_skills');
		expect(names.slice(0, firstSkills + 1).filter((n) => n === 'list_realms')).toHaveLength(1);
	});
});

describe('an older server', () => {
	it('works without get_sentiment and list_skills, and says nothing', async () => {
		await stub.stop();
		stub = await createWorldStub(world, ['get_sentiment', 'list_skills']);
		const session = await open();
		await session.helper.poll();
		const { resources } = await session.client.listResources();
		expect(resources.map((r) => r.uri)).toEqual(['sagas://realm/AM', 'sagas://realm/WB']);
		expect((await readJson(session, 'sagas://realm/AM')).sentiment).toBeNull();
		expect((await surveyOf(session)).description).not.toContain('Skills:');
		expect(session.warnings).toEqual([]);
		expect(stub.callsTo('get_sentiment')).toEqual([]);
		expect(stub.callsTo('list_skills')).toEqual([]);
	});

	it('warns once when a listed tool fails', async () => {
		stub.handlers.set('get_sentiment', () => toolError('internal', 'boom'));
		stub.handlers.set('list_skills', () => toolError('internal', 'boom'));
		const session = await open();
		await session.helper.poll();
		await session.helper.poll();
		expect(session.warnings.sort()).toEqual(['get_sentiment: boom', 'list_skills: boom']);
		expect((await session.client.listResources()).resources).toHaveLength(2);
	});

	it('skips a Realm the server no longer knows and carries on', async () => {
		stub.handlers.set('list_realms', () =>
			ok({
				realms: [{ id: 99, key: 'GONE', name: 'Gone', aliases: [] }, ...world.realms]
			})
		);
		const session = await open();
		await session.helper.poll();
		const { resources } = await session.client.listResources();
		expect(resources.map((r) => r.uri)).toEqual([
			'sagas://realm/AM',
			'sagas://realm/WB',
			'sagas://skills'
		]);
	});

	it('ignores an answer it cannot read', async () => {
		stub.handlers.set('list_skills', () => ok({ skills: 'many' }));
		const session = await open();
		await session.helper.poll();
		expect(session.warnings).toEqual(['list_skills: unexpected answer']);
	});
});

describe('the cache', () => {
	it('survives a restart with the server down', async () => {
		const first = await open();
		await first.helper.poll();
		const served = (await first.client.listTools()).tools;
		const am = await readJson(first, 'sagas://realm/AM');
		await first.client.close();
		await first.helper.close();
		await stub.stop();

		const second = await open();
		expect((await second.client.listTools()).tools).toEqual(served);
		expect((await second.client.listResources()).resources.map((r) => r.uri)).toEqual([
			'sagas://realm/AM',
			'sagas://realm/WB',
			'sagas://skills'
		]);
		expect(await readJson(second, 'sagas://realm/AM')).toEqual(am);
		await expect(second.helper.poll()).resolves.toBeUndefined();
		expect((await second.client.listTools()).tools).toEqual(served);
		expect(await readJson(second, 'sagas://realm/AM')).toEqual(am);
	});

	it('keeps the cache through a failed poll and warns once per outage', async () => {
		const session = await open();
		await session.helper.poll();
		await stub.stop();
		await session.helper.poll();
		await session.helper.poll();
		expect(session.warnings).toHaveLength(1);
		expect(session.warnings[0]).toMatch(/^sagas unreachable/);
		expect((await session.client.listResources()).resources).toHaveLength(3);

		await stub.start(true);
		await session.helper.poll();
		await stub.stop();
		await session.helper.poll();
		expect(session.warnings).toHaveLength(2);
	});

	it('warns that the token was refused, once', async () => {
		const session = await open({ token: 'wrong' });
		await session.helper.poll();
		await session.helper.poll();
		expect(session.warnings).toEqual(['sagas refused the token']);
	});

	it('lives under the config home, per host, and keeps files private', async () => {
		const session = await open();
		await session.helper.poll();
		const host = new URL(stub.url).host.replace(':', '_');
		expect(session.helper.cacheDir).toBe(join(dir, 'sagas', 'cache', host));
		expect(readdirSync(session.helper.cacheDir).sort()).toEqual([
			'realms',
			'server.json',
			'skills.json',
			'tools.json'
		]);
		expect(statSync(session.helper.cacheDir).mode & 0o777).toBe(0o700);
		expect(statSync(join(session.helper.cacheDir, 'skills.json')).mode & 0o777).toBe(0o600);
	});

	it('leaves no temp file behind and writes whole files', async () => {
		const session = await open();
		await session.helper.poll();
		await session.helper.poll();
		for (const sub of ['.', 'realms']) {
			const names = readdirSync(join(session.helper.cacheDir, sub));
			expect(names.filter((n) => n.startsWith('.tmp-'))).toEqual([]);
		}
		const file = JSON.parse(
			readFileSync(join(session.helper.cacheDir, 'realms', '1.json'), 'utf8')
		);
		expect(file).toMatchObject({ format: 1, data: { realm: { key: 'AM' } } });
	});

	it('ignores corrupt cache files', async () => {
		const first = await open();
		await first.helper.poll();
		const root = first.helper.cacheDir;
		await first.client.close();
		await first.helper.close();
		await stub.stop();

		writeFileSync(join(root, 'realms', '1.json'), '{"format":1,"fetchedAt":"x","da');
		writeFileSync(join(root, 'skills.json'), 'not json');
		writeFileSync(join(root, 'tools.json'), '{"format":1,"fetchedAt":"x","data":[1]}');

		const second = await open();
		expect((await second.client.listResources()).resources.map((r) => r.uri)).toEqual([
			'sagas://realm/WB'
		]);
		expect((await second.client.listTools()).tools).toEqual([]);
	});

	it('repairs a corrupt file on the next poll', async () => {
		const first = await open();
		await first.helper.poll();
		const root = first.helper.cacheDir;
		await first.client.close();
		await first.helper.close();
		writeFileSync(join(root, 'realms', '1.json'), 'garbage');

		const second = await open();
		await second.helper.poll();
		expect((await second.client.listResources()).resources.map((r) => r.uri)).toContain(
			'sagas://realm/AM'
		);
		expect(JSON.parse(readFileSync(join(root, 'realms', '1.json'), 'utf8')).format).toBe(1);
	});
});

describe('notifications', () => {
	it('announces new resources and a changed digest', async () => {
		const session = await open();
		await session.helper.poll();
		await flush(session);
		expect(session.notes).toEqual({ tools: 1, resources: 1 });
	});

	it('announces a change to a Realm', async () => {
		const session = await open();
		await session.helper.poll();
		await flush(session);

		world.attributes[1] = { version: 2, notes: 'edited', attributes: [scale('impact')] };
		await session.helper.poll();
		await flush(session);
		expect(session.notes).toEqual({ tools: 2, resources: 2 });
	});

	it('announces a change that leaves the digest alone as a resource change only', async () => {
		const session = await open();
		await session.helper.poll();
		await flush(session);

		world.attributes[1] = { ...world.attributes[1], version: 2, notes: 'edited' };
		await session.helper.poll();
		await flush(session);
		expect(session.notes).toEqual({ tools: 1, resources: 2 });
	});

	it('stays quiet when only asOf, weights and drift below 0.1 change', async () => {
		const session = await open();
		await session.helper.poll();
		await flush(session);

		world.sentiment[1] = {
			asOf: '2026-02-02T00:00:00.000Z',
			keys: [
				sentimentKey('AM', 'impact', 2.04, -0.42, 0.3),
				sentimentKey('AM', 'topic:boss-hp', 3.96, 0.68, 0.43)
			],
			unfiled: []
		};
		await session.helper.poll();
		await flush(session);
		expect(session.notes).toEqual({ tools: 1, resources: 1 });
		expect((await readJson(session, 'sagas://realm/AM')).sentiment.asOf).toBe(
			'2026-02-02T00:00:00.000Z'
		);
	});

	it('announces Sentiment that moves by 0.1 or more', async () => {
		const session = await open();
		await session.helper.poll();
		await flush(session);

		world.sentiment[1].keys = [
			sentimentKey('AM', 'impact', 2.4, -0.4, 0.29),
			sentimentKey('AM', 'topic:boss-hp', 4, 0.7, 0.44)
		];
		await session.helper.poll();
		await flush(session);
		expect(session.notes).toEqual({ tools: 1, resources: 2 });
	});

	it('announces a new loudest key in the digest', async () => {
		const session = await open();
		await session.helper.poll();
		await flush(session);

		world.sentiment[1].keys = [
			sentimentKey('AM', 'impact', 20, -0.4, 0.8),
			sentimentKey('AM', 'topic:boss-hp', 4, 0.7, 0.44)
		];
		await session.helper.poll();
		await flush(session);
		expect(session.notes).toEqual({ tools: 2, resources: 2 });
	});

	it('announces a Realm that goes away', async () => {
		const session = await open();
		await session.helper.poll();
		await flush(session);

		world.realms = world.realms.slice(0, 1);
		await session.helper.poll();
		await flush(session);
		expect(session.notes).toEqual({ tools: 2, resources: 2 });
	});

	it('announces nothing while an unchanged server is polled', async () => {
		const session = await open();
		await session.helper.poll();
		await flush(session);
		await session.helper.poll();
		await session.helper.poll();
		await flush(session);
		expect(session.notes).toEqual({ tools: 1, resources: 1 });
	});

	it('announces a change to the server tools', async () => {
		const session = await open();
		await session.helper.poll();
		await flush(session);
		stub.tools = [...stub.tools, { ...stub.tools[0], name: 'brand_new' }];
		await session.helper.poll();
		await flush(session);
		expect(session.notes).toEqual({ tools: 2, resources: 1 });
		expect((await session.client.listTools()).tools.map((t) => t.name)).toContain('brand_new');
	});

	it('does not announce a tool list the client already listed', async () => {
		const session = await open();
		await session.helper.poll();
		await flush(session);
		const gate = hold('list_realms');
		stub.tools = [...stub.tools, { ...stub.tools[0], name: 'brand_new' }];
		const polled = session.helper.poll();
		await gate.reached;
		expect((await session.client.listTools()).tools.map((t) => t.name)).toContain('brand_new');
		gate.release();
		await polled;
		await flush(session);
		expect(session.notes.tools).toBe(1);
	});

	it('polls and notifies into the void while no client is connected', async () => {
		const helper = await createHelper({
			url: stub.url,
			token: 'secret',
			pollMs: 0,
			configHome: dir,
			warn: () => {}
		});
		opened.push({ helper, client: new Client({ name: 'unused', version: '0' }) });
		await expect(helper.poll()).resolves.toBeUndefined();
	});
});

describe('calls that may have reached the server', () => {
	it('reports a call whose socket drops after the server ran it, once, without repeating it', async () => {
		let runs = 0;
		stub.handlers.set('create_thing', () => ok({ id: ++runs }));
		const session = await open();
		await session.client.listTools();
		stub.drop.add('create_thing');

		const result = await session.client.callTool({ name: 'create_thing', arguments: {} });
		expect(result.isError).toBe(true);
		expect(text(result)).toMatch(/^sagas unreachable: /);
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(runs).toBe(1);
	});

	it('leaves an agent call alone while a poll times out', async () => {
		const session = await open({ timeoutMs: 300, callTimeoutMs: 5000 });
		const poll = hold('list_realms');
		let finish!: () => void;
		const finished = new Promise<void>((resolve) => (finish = resolve));
		stub.handlers.set('survey', async () => {
			await finished;
			return ok({ done: true });
		});

		const polled = session.helper.poll();
		await poll.reached;
		const call = session.client.callTool({ name: 'survey', arguments: {} });
		await polled;
		expect(session.warnings).toEqual(['sagas unreachable: timed out after 300 ms']);
		finish();
		expect(await call).toEqual(ok({ done: true }));
	});

	it('bounds an agent call by its own timeout, not the poll timeout', async () => {
		const session = await open({ timeoutMs: 100, callTimeoutMs: 5000 });
		stub.handlers.set('survey', async () => {
			await new Promise((resolve) => setTimeout(resolve, 300));
			return ok({ done: true });
		});
		expect(await session.client.callTool({ name: 'survey', arguments: {} })).toEqual(
			ok({ done: true })
		);
	});
});

describe('instructions', () => {
	it('answers initialize with the server instructions', async () => {
		stub.instructions = INSTRUCTIONS;
		const session = await open();
		expect(session.client.getInstructions()).toBe(INSTRUCTIONS);
	});

	it('answers initialize with the cached instructions while the server is down', async () => {
		stub.instructions = INSTRUCTIONS;
		const first = await open();
		await first.client.close();
		await first.helper.close();
		await stub.stop();

		const second = await open();
		expect(second.client.getInstructions()).toBe(INSTRUCTIONS);
	});

	it('waits for a slow server only so long, then answers from the cache', async () => {
		stub.instructions = INSTRUCTIONS;
		const first = await open();
		await first.client.close();
		await first.helper.close();

		stub.delayMs = 3000;
		const started = Date.now();
		const second = await open({ startupMs: 100 });
		expect(Date.now() - started).toBeLessThan(1000);
		expect(second.client.getInstructions()).toBe(INSTRUCTIONS);
	});

	it('answers initialize without instructions when none are known', async () => {
		await stub.stop();
		const session = await open();
		expect(session.client.getInstructions()).toBeUndefined();
	});
});

describe('listing tools', () => {
	it('answers from the cache without waiting on the server', async () => {
		const first = await open();
		await first.client.listTools();
		await first.client.close();
		await first.helper.close();

		stub.delayMs = 3000;
		const second = await open({ startupMs: 0 });
		const started = Date.now();
		const { tools } = await second.client.listTools();
		expect(Date.now() - started).toBeLessThan(1000);
		expect(tools.map((t) => t.name)).toEqual(stub.tools.map((t) => t.name));
	});

	it('refreshes a cached list in the background while polling is off', async () => {
		const session = await open();
		await session.client.listTools();
		stub.tools = [...stub.tools, { ...stub.tools[0], name: 'brand_new' }];
		await session.client.listTools();
		await vi.waitFor(() => expect(session.notes.tools).toBe(1));
		expect((await session.client.listTools()).tools.map((t) => t.name)).toContain('brand_new');
	});

	it('hides no resource change a poll in flight has made', async () => {
		const session = await open();
		await session.helper.poll();
		await flush(session);

		world.attributes[1] = { ...world.attributes[1], version: 2, notes: 'edited' };
		const gate = hold('list_skills');
		const polled = session.helper.poll();
		await gate.reached;
		await session.client.listTools();
		gate.release();
		await polled;
		await flush(session);
		expect(session.notes.resources).toBe(2);
	});
});

describe('timers', () => {
	it('runs both kinds of poll when their intervals are equal', async () => {
		await open({ pollMs: 40, sentimentMs: 40 });
		await vi.waitFor(() => {
			expect(stub.callsTo('list_realms').length).toBeGreaterThanOrEqual(3);
			expect(stub.callsTo('get_sentiment').length).toBeGreaterThanOrEqual(6);
		});
	});

	it('lets an agent call in flight finish when closed', async () => {
		const session = await open();
		stub.handlers.set('survey', async () => {
			await new Promise((resolve) => setTimeout(resolve, 200));
			return ok({ done: true });
		});
		await session.client.listTools();
		const call = session.client.callTool({ name: 'survey', arguments: {} });
		await vi.waitFor(() => expect(stub.callsTo('survey')).toHaveLength(1));
		const closed = session.helper.close();
		expect(await call).toEqual(ok({ done: true }));
		await closed;
	});

	it('says nothing when closed in the middle of a poll', async () => {
		const session = await open();
		const gate = hold('list_realms');
		const polled = session.helper.poll();
		await gate.reached;
		await session.helper.close();
		await polled;
		expect(session.warnings).toEqual([]);
	});
});

describe('a cache it cannot fully trust', () => {
	async function cacheThenStop() {
		const first = await open();
		await first.helper.poll();
		await first.client.close();
		await first.helper.close();
		await stub.stop();
		return first.helper.cacheDir;
	}

	const edit = (path: string, change: (data: Record<string, unknown>) => void) => {
		const file = JSON.parse(readFileSync(path, 'utf8'));
		change(file.data);
		writeFileSync(path, JSON.stringify(file));
	};

	it('starts, and skips a Realm whose Sentiment holds a null Pulse', async () => {
		const root = await cacheThenStop();
		edit(join(root, 'realms', '1.json'), (data) => {
			(data.sentiment as { keys: { pulses: unknown[] }[] }).keys[0].pulses = [null];
		});

		const session = await open();
		expect((await session.client.listResources()).resources.map((r) => r.uri)).toEqual([
			'sagas://realm/WB',
			'sagas://skills'
		]);
		expect((await surveyOf(session)).description).not.toContain('AM:');
	});

	it('lists the other tools when a cached tool has no inputSchema', async () => {
		const root = await cacheThenStop();
		const tools = JSON.parse(readFileSync(join(root, 'tools.json'), 'utf8'));
		edit(join(root, 'tools.json'), (data) => {
			const list = data as unknown as { name: string; inputSchema?: unknown }[];
			delete list.find((t) => t.name === 'whoami')!.inputSchema;
		});

		const session = await open();
		const listed = (await session.client.listTools()).tools.map((t) => t.name);
		expect(listed).toEqual(
			(tools.data as { name: string }[]).map((t) => t.name).filter((n) => n !== 'whoami')
		);
	});

	it('ignores a Realm file whose fields have the wrong types', async () => {
		const root = await cacheThenStop();
		edit(join(root, 'realms', '2.json'), (data) => {
			data.attributesFetchedAt = 5;
		});
		edit(join(root, 'skills.json'), (data) => {
			data.skills = [{ key: 7 }];
		});

		const session = await open();
		expect((await session.client.listResources()).resources.map((r) => r.uri)).toEqual([
			'sagas://realm/AM'
		]);
	});
});

describe('cache files', () => {
	it('names the directory by host, port and path', () => {
		expect(cacheDirFor('http://localhost:3290', dir)).toBe(
			join(dir, 'sagas', 'cache', 'localhost_3290')
		);
		expect(cacheDirFor('https://example.com/team/sagas/', dir)).toBe(
			join(dir, 'sagas', 'cache', 'example.com_team_sagas')
		);
	});

	it('leaves a file alone when its content has not changed', async () => {
		const session = await open({ sentimentMs: 0 });
		await session.helper.poll();
		const root = session.helper.cacheDir;
		const files = ['tools.json', 'skills.json', 'server.json', 'realms/1.json', 'realms/2.json'];
		const before = files.map((file) => statSync(join(root, file)).ino);
		await session.helper.poll();
		expect(files.map((file) => statSync(join(root, file)).ino)).toEqual(before);
	});

	it('keeps when the Attributes and the Sentiment were fetched apart', async () => {
		const session = await open();
		await session.helper.poll();
		const first = await readJson(session, 'sagas://realm/AM');
		expect(first.attributesFetchedAt).toEqual(expect.any(String));
		expect(first.sentimentAsOf).toEqual(expect.any(String));

		await new Promise((resolve) => setTimeout(resolve, 5));
		await session.helper.poll();
		const second = await readJson(session, 'sagas://realm/AM');
		expect(second.attributesFetchedAt).toBe(first.attributesFetchedAt);
		expect(second.sentimentAsOf > first.sentimentAsOf).toBe(true);

		await new Promise((resolve) => setTimeout(resolve, 5));
		world.attributes[1] = { ...world.attributes[1], version: 2 };
		await session.helper.poll();
		const third = await readJson(session, 'sagas://realm/AM');
		expect(third.attributesFetchedAt > first.attributesFetchedAt).toBe(true);

		const file = JSON.parse(
			readFileSync(join(session.helper.cacheDir, 'realms', '1.json'), 'utf8')
		);
		expect(file.data.attributesFetchedAt).toBe(third.attributesFetchedAt);
		expect(file.data.sentimentAsOf).toBe(third.sentimentAsOf);
	});
});

describe('the digest sign', () => {
	it('never prints -0.0', async () => {
		world.sentiment[1].keys = [sentimentKey('AM', 'impact', 2, -0.04, 0.5)];
		const session = await open();
		await session.helper.poll();
		expect((await surveyOf(session)).description).toContain('loud: impact mood +0.0');
	});
});
