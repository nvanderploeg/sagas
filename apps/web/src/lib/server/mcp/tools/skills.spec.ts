import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { seedHuman } from '#lib/server/auth/fixtures.ts';
import { createFirstAdmin, type AuthUser } from '#lib/server/auth/users.ts';
import type { Db } from '#lib/server/db/client.ts';
import { eventWindow } from '#lib/server/events/log.ts';
import { testDb } from '#lib/server/test/db.ts';
import { createMcpServer } from '../server.ts';

let db: Db;
let admin: AuthUser;
let bob: AuthUser;
const clients: Client[] = [];

beforeEach(async () => {
	db = testDb();
	admin = await createFirstAdmin(db, {
		username: 'root',
		displayName: 'Root',
		password: 'a long enough password'
	});
	bob = seedHuman(db, 'bob');
});

afterEach(async () => {
	vi.useRealTimers();
	await Promise.all(clients.splice(0).map((client) => client.close()));
	db.$client.close();
});

async function connect(actor: AuthUser = admin): Promise<Client> {
	const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
	await createMcpServer(db, actor, 'http://sagas.test').connect(serverSide);
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

const at = (day: number) => {
	vi.useFakeTimers({ toFake: ['Date'] });
	const now = new Date(Date.UTC(2030, 0, day));
	vi.setSystemTime(now);
	return now.toISOString();
};

const lastSeq = () => eventWindow(db).last;

const defineSkill = (client: Client, key: string, label = key, rubric?: string) =>
	ok(client, 'define_skill', rubric === undefined ? { key, label } : { key, label, rubric });

const setSkills = (client: Client, user: string | number, skills: Record<string, unknown>) =>
	call(client, 'set_skills', { user, skills });

const listSkills = async (client: Client) => (await ok(client, 'list_skills')).skills as any[];

async function seed(client: Client, labourCount = 1) {
	await ok(client, 'create_realm', { key: 'am', name: 'Atlas' });
	for (let i = 1; i <= labourCount; i++) {
		await ok(client, 'create_labour', { realm: 'AM', title: `Labour ${i}` });
	}
}

const appraise = (client: Client, ...labours: Record<string, unknown>[]) =>
	call(client, 'appraise', { labours });

const getAppraisal = (client: Client, labour: string | number) =>
	ok(client, 'get_appraisal', { labour });

describe('tool registration', () => {
	it('lists define_skill and set_skills as writes and list_skills as a read, each with a closed input schema', async () => {
		const { tools } = await (await connect()).listTools();

		for (const [name, readOnly] of [
			['define_skill', false],
			['list_skills', true],
			['set_skills', false]
		] as const) {
			const tool = tools.find((t) => t.name === name);
			expect(tool, name).toBeDefined();
			expect(tool!.description, name).toBeTruthy();
			expect(tool!.inputSchema.additionalProperties, name).toBe(false);
			expect(tool!.annotations?.readOnlyHint, name).toBe(readOnly);
		}
	});

	it('offers `needs` in the appraise input', async () => {
		const { tools } = await (await connect()).listTools();

		expect(JSON.stringify(tools.find((t) => t.name === 'appraise')!.inputSchema)).toContain(
			'needs'
		);
	});
});

describe('define_skill', () => {
	it('creates a Skill, answering with key, label and rubric', async () => {
		const result = await call(await connect(), 'define_skill', {
			key: 'vfx',
			label: 'Visual effects',
			rubric: '1 = tweaks, 5 = owns the pipeline'
		});

		expect(result.isError).toBeFalsy();
		expect(result.structuredContent).toEqual({
			skill: { key: 'vfx', label: 'Visual effects', rubric: '1 = tweaks, 5 = owns the pipeline' }
		});
	});

	it('answers with an empty rubric when none was given', async () => {
		expect((await defineSkill(await connect(), 'vfx', 'Visual effects')).skill).toEqual({
			key: 'vfx',
			label: 'Visual effects',
			rubric: ''
		});
	});

	it('puts a summary line and then the result as JSON in the text', async () => {
		const result = await call(await connect(), 'define_skill', { key: 'vfx', label: 'VFX' });

		const [summary, ...rest] = text(result).split('\n');
		expect(summary).toBeTruthy();
		expect(JSON.parse(rest.join('\n'))).toEqual(result.structuredContent);
	});

	it('normalizes the key to trimmed lowercase', async () => {
		expect((await defineSkill(await connect(), '  VFX ', 'Visual effects')).skill.key).toBe('vfx');
	});

	it('revises the given fields of an existing Skill and leaves the rest', async () => {
		const client = await connect();
		await defineSkill(client, 'vfx', 'VFX', 'the rubric');

		const label = await ok(client, 'define_skill', { key: 'vfx', label: 'Visual effects' });
		const rubric = await ok(client, 'define_skill', { key: 'VFX', rubric: 'new rubric' });

		expect(label.skill).toEqual({ key: 'vfx', label: 'Visual effects', rubric: 'the rubric' });
		expect(rubric.skill).toEqual({ key: 'vfx', label: 'Visual effects', rubric: 'new rubric' });
		expect(await listSkills(client)).toHaveLength(1);
	});

	it('is shared by every User: a Skill defined by one is revised by another', async () => {
		await defineSkill(await connect(admin), 'vfx', 'VFX');

		const revised = await ok(await connect(bob), 'define_skill', { key: 'vfx', label: 'Effects' });

		expect(revised.skill.label).toBe('Effects');
	});

	it('refuses a new Skill without a label as invalid', async () => {
		const client = await connect();

		expect((await fail(client, 'define_skill', { key: 'vfx' })).code).toBe('invalid');
		expect(await listSkills(client)).toEqual([]);
	});

	it('refuses a malformed key, an over-long label and an over-long rubric as invalid', async () => {
		const client = await connect();

		for (const args of [
			{ key: '1vfx', label: 'x' },
			{ key: 'vfx_fx', label: 'x' },
			{ key: 'a'.repeat(33), label: 'x' },
			{ key: 'vfx', label: 'x'.repeat(65) },
			{ key: 'vfx', label: 'x', rubric: 'r'.repeat(4001) },
			{ label: 'no key' }
		]) {
			expect((await fail(client, 'define_skill', args)).code, JSON.stringify(args)).toBe('invalid');
		}
		expect(await listSkills(client)).toEqual([]);
	});

	it('refuses an unknown argument, naming it', async () => {
		const client = await connect();

		const error = await fail(client, 'define_skill', { key: 'vfx', label: 'VFX', color: 'red' });

		expect(error.code).toBe('invalid');
		expect(error.message).toContain('color');
		expect(await listSkills(client)).toEqual([]);
	});
});

describe('list_skills', () => {
	it('answers with an empty list when no Skill is defined', async () => {
		const result = await call(await connect(), 'list_skills');

		expect(result.isError).toBeFalsy();
		expect(result.structuredContent).toEqual({ skills: [] });
	});

	it('lists each Skill by key with label, rubric and holders, and nothing else', async () => {
		const client = await connect();
		await defineSkill(client, 'vfx', 'Visual effects', 'effects rubric');
		await defineSkill(client, 'audio', 'Audio');
		await defineSkill(client, 'combat-design', 'Combat design', 'fights');
		await setSkills(client, 'me', { vfx: 3, audio: 2 });
		await setSkills(client, 'bob', { vfx: 5 });

		const result = await call(client, 'list_skills');

		expect(result.structuredContent).toEqual({
			skills: [
				{ key: 'audio', label: 'Audio', rubric: '', holders: 1 },
				{ key: 'combat-design', label: 'Combat design', rubric: 'fights', holders: 0 },
				{ key: 'vfx', label: 'Visual effects', rubric: 'effects rubric', holders: 2 }
			]
		});
	});

	it('stops counting a holder who cleared the Skill', async () => {
		const client = await connect();
		await defineSkill(client, 'vfx');
		await setSkills(client, 'me', { vfx: 3 });
		await setSkills(client, 'bob', { vfx: 3 });

		await setSkills(client, 'bob', { vfx: null });

		expect((await listSkills(client))[0].holders).toBe(1);
	});

	it('is readable by any User', async () => {
		await defineSkill(await connect(admin), 'vfx');

		expect((await listSkills(await connect(bob))).map((s) => s.key)).toEqual(['vfx']);
	});

	it('refuses an unknown argument as invalid', async () => {
		const error = await fail(await connect(), 'list_skills', { verbose: true });

		expect(error.code).toBe('invalid');
		expect(error.message).toContain('verbose');
	});
});

describe('set_skills', () => {
	beforeEach(async () => {
		const client = await connect();
		await defineSkill(client, 'vfx');
		await defineSkill(client, 'audio');
		await defineSkill(client, 'combat-design');
	});

	it('sets the calling User with "me", answering with the username and the whole set', async () => {
		const result = await setSkills(await connect(bob), 'me', { vfx: 4, audio: 2 });

		expect(result.isError).toBeFalsy();
		expect(result.structuredContent).toEqual({ user: 'bob', skills: { vfx: 4, audio: 2 } });
	});

	it('names the User by username or by id, and answers with the username either way', async () => {
		const client = await connect(admin);

		const byName = await ok(client, 'set_skills', { user: 'bob', skills: { vfx: 3 } });
		const byId = await ok(client, 'set_skills', { user: bob.id, skills: { audio: 1 } });

		expect(byName).toEqual({ user: 'bob', skills: { vfx: 3 } });
		expect(byId).toEqual({ user: 'bob', skills: { vfx: 3, audio: 1 } });
	});

	it('lets a User set another Users Skills, and answers with that User', async () => {
		const result = await ok(await connect(bob), 'set_skills', {
			user: 'root',
			skills: { 'combat-design': 5 }
		});

		expect(result).toEqual({ user: 'root', skills: { 'combat-design': 5 } });
	});

	it('keeps each User own set apart', async () => {
		const client = await connect();
		await setSkills(client, 'me', { vfx: 1 });

		const result = await ok(client, 'set_skills', { user: 'bob', skills: { audio: 2 } });

		expect(result.skills).toEqual({ audio: 2 });
	});

	it('merges, changes a level and clears with null, answering with the whole set each time', async () => {
		const client = await connect();
		await setSkills(client, 'me', { vfx: 2, audio: 3 });

		const merged = await ok(client, 'set_skills', { user: 'me', skills: { 'combat-design': 4 } });
		const changed = await ok(client, 'set_skills', { user: 'me', skills: { vfx: 5 } });
		const cleared = await ok(client, 'set_skills', { user: 'me', skills: { audio: null } });

		expect(merged.skills).toEqual({ vfx: 2, audio: 3, 'combat-design': 4 });
		expect(changed.skills).toEqual({ vfx: 5, audio: 3, 'combat-design': 4 });
		expect(cleared.skills).toEqual({ vfx: 5, 'combat-design': 4 });
	});

	it('puts a summary line and then the result as JSON in the text', async () => {
		const result = await setSkills(await connect(), 'me', { vfx: 1 });

		const [summary, ...rest] = text(result).split('\n');
		expect(summary).toBeTruthy();
		expect(JSON.parse(rest.join('\n'))).toEqual(result.structuredContent);
	});

	it('refuses an unknown Skill as invalid', async () => {
		const error = await fail(await connect(), 'set_skills', { user: 'me', skills: { nope: 3 } });

		expect(error.code).toBe('invalid');
	});

	it('refuses a level outside 1 to 5, a fraction and a non-number as invalid', async () => {
		const client = await connect();

		for (const level of [0, 6, -1, 2.5, '3', true, [3], { level: 3 }]) {
			const error = await fail(client, 'set_skills', { user: 'me', skills: { vfx: level } });
			expect(error.code, JSON.stringify(level)).toBe('invalid');
		}
		expect(await listSkills(client)).toMatchObject([
			{ holders: 0 },
			{ holders: 0 },
			{ holders: 0 }
		]);
	});

	it('refuses an unknown User as not_found', async () => {
		const client = await connect();

		expect((await fail(client, 'set_skills', { user: 'nobody', skills: { vfx: 3 } })).code).toBe(
			'not_found'
		);
		expect((await fail(client, 'set_skills', { user: 9999, skills: { vfx: 3 } })).code).toBe(
			'not_found'
		);
	});

	it('writes nothing when one entry is bad', async () => {
		const client = await connect();
		await setSkills(client, 'me', { audio: 4 });

		const error = await fail(client, 'set_skills', {
			user: 'me',
			skills: { vfx: 3, audio: null, 'combat-design': 9 }
		});

		expect(error.code).toBe('invalid');
		expect((await listSkills(client)).map((s) => [s.key, s.holders])).toEqual([
			['audio', 1],
			['combat-design', 0],
			['vfx', 0]
		]);
	});

	it('refuses a missing user and a missing skills as invalid', async () => {
		const client = await connect();

		expect((await fail(client, 'set_skills', { skills: { vfx: 3 } })).code).toBe('invalid');
		expect((await fail(client, 'set_skills', { user: 'me' })).code).toBe('invalid');
	});

	it('refuses an unknown argument, naming it', async () => {
		const error = await fail(await connect(), 'set_skills', {
			user: 'me',
			skills: { vfx: 3 },
			verbose: true
		});

		expect(error.code).toBe('invalid');
		expect(error.message).toContain('verbose');
	});
});

describe('needs on appraise and get_appraisal', () => {
	beforeEach(async () => {
		const client = await connect();
		await seed(client, 2);
		await defineSkill(client, 'vfx');
		await defineSkill(client, 'audio');
		await defineSkill(client, 'combat-design');
	});

	it('sets needs on an item, readable on get_appraisal as skill, level, setBy and setAt', async () => {
		const client = await connect(bob);
		const now = at(5);

		const result = await appraise(client, {
			labour: 'AM-1',
			needs: { vfx: 3, 'combat-design': 4 }
		});

		expect(result.isError).toBeFalsy();
		expect(result.structuredContent).toEqual({ appraised: [{ labour: 'AM-1', stamped: false }] });
		expect((await getAppraisal(client, 'AM-1')).needs).toEqual([
			{ skill: 'combat-design', level: 4, setBy: 'bob', setAt: now },
			{ skill: 'vfx', level: 3, setBy: 'bob', setAt: now }
		]);
	});

	it('reads as an empty list for a Labour that needs nothing', async () => {
		expect((await getAppraisal(await connect(), 'AM-1')).needs).toEqual([]);
	});

	it('orders needs by Skill key', async () => {
		const client = await connect();
		await appraise(client, { labour: 'AM-1', needs: { vfx: 1 } });
		await appraise(client, { labour: 'AM-1', needs: { audio: 2 } });

		expect((await getAppraisal(client, 'AM-1')).needs.map((n: any) => n.skill)).toEqual([
			'audio',
			'vfx'
		]);
	});

	it('merges and keeps who set what and when for the needs it did not touch', async () => {
		const first = at(2);
		await appraise(await connect(admin), { labour: 'AM-1', needs: { vfx: 3 } });
		const second = at(3);

		await appraise(await connect(bob), { labour: 'AM-1', needs: { audio: 2 } });

		expect((await getAppraisal(await connect(), 'AM-1')).needs).toEqual([
			{ skill: 'audio', level: 2, setBy: 'bob', setAt: second },
			{ skill: 'vfx', level: 3, setBy: 'root', setAt: first }
		]);
	});

	it('changes a level, rewriting setBy and setAt', async () => {
		at(2);
		await appraise(await connect(admin), { labour: 'AM-1', needs: { vfx: 3 } });
		const later = at(4);

		await appraise(await connect(bob), { labour: 'AM-1', needs: { vfx: 5 } });

		expect((await getAppraisal(await connect(), 'AM-1')).needs).toEqual([
			{ skill: 'vfx', level: 5, setBy: 'bob', setAt: later }
		]);
	});

	it('clears a need with null and leaves the others', async () => {
		const client = await connect();
		await appraise(client, { labour: 'AM-1', needs: { vfx: 3, audio: 2 } });

		await appraise(client, { labour: 'AM-1', needs: { audio: null } });

		expect((await getAppraisal(client, 'AM-1')).needs.map((n: any) => n.skill)).toEqual(['vfx']);
	});

	it('names the Labour by key in any case, by Alias or by id', async () => {
		const client = await connect();
		const { labour } = await ok(client, 'get_labour', { labour: 'AM-2' });

		await appraise(client, { labour: 'am-2', needs: { vfx: 1 } });
		await appraise(client, { labour: labour.id, needs: { audio: 2 } });

		expect((await getAppraisal(client, 'AM-2')).needs.map((n: any) => n.skill)).toEqual([
			'audio',
			'vfx'
		]);
		expect((await getAppraisal(client, 'AM-1')).needs).toEqual([]);
	});

	it('accepts an item that carries only needs, and an empty needs object', async () => {
		const client = await connect();

		const result = await appraise(
			client,
			{ labour: 'AM-1', needs: { vfx: 3 } },
			{ labour: 'AM-2', needs: {} }
		);

		expect(result.structuredContent).toEqual({
			appraised: [
				{ labour: 'AM-1', stamped: false },
				{ labour: 'AM-2', stamped: false }
			]
		});
	});

	it('does not change the content hash, so a stamp taken with the needs still lands', async () => {
		const client = await connect();
		const { contentHash } = await getAppraisal(client, 'AM-1');

		const result = await appraise(client, {
			labour: 'AM-1',
			needs: { vfx: 3 },
			stamp: contentHash
		});

		expect(result.structuredContent).toEqual({ appraised: [{ labour: 'AM-1', stamped: true }] });
		expect(await getAppraisal(client, 'AM-1')).toMatchObject({ contentHash, stale: false });
	});

	it('records no Event', async () => {
		const client = await connect();
		const before = lastSeq();

		await appraise(client, { labour: 'AM-1', needs: { vfx: 3 } });

		expect(lastSeq()).toBe(before);
	});

	it('refuses an unknown Skill, a null for an unknown Skill and a bad level as invalid', async () => {
		const client = await connect();

		for (const needs of [
			{ nope: 3 },
			{ nope: null },
			{ vfx: 0 },
			{ vfx: 6 },
			{ vfx: 2.5 },
			{ vfx: '3' }
		]) {
			const result = await appraise(client, { labour: 'AM-1', needs });
			expect(result.isError, JSON.stringify(needs)).toBe(true);
			expect(result.structuredContent, JSON.stringify(needs)).toMatchObject({
				error: { code: 'invalid' }
			});
		}
		expect((await getAppraisal(client, 'AM-1')).needs).toEqual([]);
	});

	it('refuses the whole batch when one item has a bad need', async () => {
		const client = await connect();

		const result = await appraise(
			client,
			{ labour: 'AM-1', brief: 'lands only if all lands', needs: { vfx: 3 } },
			{ labour: 'AM-2', needs: { nope: 1 } }
		);

		expect(result.structuredContent).toMatchObject({ error: { code: 'invalid' } });
		expect(await getAppraisal(client, 'AM-1')).toMatchObject({ brief: '', needs: [] });
	});

	it('refuses a Labour that would need more than 8 Skills as invalid', async () => {
		const client = await connect();
		const keys: string[] = [];
		for (let i = 1; i <= 9; i++) {
			keys.push(`extra-${i}`);
			await defineSkill(client, `extra-${i}`);
		}
		const only = (count: number) => Object.fromEntries(keys.slice(0, count).map((k) => [k, 2]));

		const nine = await appraise(client, { labour: 'AM-1', needs: only(9) });
		const eight = await appraise(client, { labour: 'AM-1', needs: only(8) });
		const ninth = await appraise(client, { labour: 'AM-1', needs: { vfx: 1 } });
		const swap = await appraise(client, {
			labour: 'AM-1',
			needs: { 'extra-1': null, vfx: 1 }
		});

		expect(nine.structuredContent).toMatchObject({ error: { code: 'invalid' } });
		expect(eight.isError).toBeFalsy();
		expect(ninth.structuredContent).toMatchObject({ error: { code: 'invalid' } });
		expect(swap.isError).toBeFalsy();
		expect((await getAppraisal(client, 'AM-1')).needs).toHaveLength(8);
	});

	it('refuses a needs that is not an object of levels, as invalid', async () => {
		const client = await connect();

		for (const needs of [[{ skill: 'vfx', level: 3 }], 'vfx', 3, { vfx: { level: 3 } }]) {
			const result = await appraise(client, { labour: 'AM-1', needs });
			expect(result.structuredContent, JSON.stringify(needs)).toMatchObject({
				error: { code: 'invalid' }
			});
		}
	});

	it('still refuses an unknown key on an item', async () => {
		const result = await appraise(await connect(), { labour: 'AM-1', mood: 'good' });

		expect(result.structuredContent).toMatchObject({
			error: { code: 'invalid', message: expect.stringContaining('mood') }
		});
	});

	it('shows the needs among the rest of get_appraisal', async () => {
		const client = await connect();
		const now = at(6);
		await appraise(client, { labour: 'AM-1', brief: 'a brief', needs: { audio: 5 } });

		expect(await getAppraisal(client, 'AM-1')).toMatchObject({
			labour: 'AM-1',
			brief: 'a brief',
			needs: [{ skill: 'audio', level: 5, setBy: 'root', setAt: now }]
		});
	});
});

describe('Skills end to end through survey', () => {
	it('scores the asking User on the Skills they hold and the Labours need', async () => {
		const client = await connect();
		await seed(client, 3);
		await defineSkill(client, 'vfx');
		await defineSkill(client, 'audio');
		await setSkills(client, 'me', { vfx: 4 });
		await setSkills(client, 'bob', { audio: 3 });
		await appraise(
			client,
			{ labour: 'AM-1', needs: { vfx: 4 } },
			{ labour: 'AM-2', needs: { audio: 4 } }
		);

		const mine = await ok(client, 'survey', { weights: { skill_fit: 1 }, temperature: 0 });
		const bobs = await ok(client, 'survey', {
			weights: { skill_fit: 1 },
			temperature: 0,
			for: 'bob'
		});

		expect(mine.ignored).toEqual([]);
		expect(mine.results.map((r: any) => [r.key, r.score])).toEqual([
			['AM-1', 1],
			['AM-3', 0.5],
			['AM-2', 0]
		]);
		expect(mine.coverage.missing).toEqual({ skill_fit: 1 });
		expect(bobs.results.map((r: any) => [r.key, r.score])).toEqual([
			['AM-2', 0.75],
			['AM-3', 0.5],
			['AM-1', 0]
		]);
	});
});
