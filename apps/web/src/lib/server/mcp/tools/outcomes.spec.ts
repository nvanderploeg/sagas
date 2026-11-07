import { seedAdmin } from '#lib/server/auth/fixtures.ts';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { asc } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defineAttribute, setValues } from '#lib/server/agent/attributes.ts';
import { reportOutcomes, type Verdict } from '#lib/server/agent/outcomes.ts';
import { seedHuman } from '#lib/server/auth/fixtures.ts';
import { type AuthUser } from '#lib/server/auth/users.ts';
import type { Db } from '#lib/server/db/client.ts';
import { outcomes, pulses } from '#lib/server/db/schema.ts';
import { renameRealmKey } from '#lib/server/domain/realms.ts';
import type { Actor } from '#lib/server/domain/write.ts';
import { testDb } from '#lib/server/test/db.ts';
import { seedActor, seedLabour, seedRealm } from '#lib/server/test/fixtures.ts';
import { createMcpServer } from '../server.ts';

let db: Db;
let admin: AuthUser;
let actor: Actor;
const clients: Client[] = [];

beforeEach(async () => {
	db = await testDb();
	admin = await seedAdmin(db, 'root', 'Root');
	actor = await seedActor(db);
});

afterEach(async () => {
	await Promise.all(clients.splice(0).map((client) => client.close()));
});

async function connect(user: AuthUser = admin): Promise<Client> {
	const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
	await createMcpServer(db, user, 'http://sagas.test').connect(serverSide);
	const client = new Client({ name: 'spec', version: '0' });
	await client.connect(clientSide);
	clients.push(client);
	return client;
}

const text = (result: CallToolResult) =>
	result.content.map((part) => (part.type === 'text' ? part.text : '')).join('');

async function call(client: Client, name: string, args: Record<string, unknown>) {
	return (await client.callTool({ name, arguments: args })) as CallToolResult;
}

async function ok(client: Client, name: string, args: Record<string, unknown>) {
	const result = await call(client, name, args);
	expect(result.isError, `${name}: ${text(result)}`).toBeFalsy();
	return result.structuredContent as any;
}

async function fail(client: Client, name: string, args: Record<string, unknown>) {
	const result = await call(client, name, args);
	expect(result.isError, `${name} should fail`).toBe(true);
	return (result.structuredContent as any).error as { code: string; message: string };
}

const storedOutcomes = async () => await db.select().from(outcomes);
const allPulses = async () => await db.select().from(pulses).orderBy(asc(pulses.id));
const NEUTRAL = { evidence: 1 };

// AM-1 holds impact 3 of 0-4 (x 0.75), effort 2 of 1-5 (x 0.25), area audio and ui; AM-2 holds impact 4.
async function world() {
	const am = await seedRealm(db, 'AM');
	await defineAttribute(db, actor, am.id, {
		key: 'impact',
		kind: 'scale',
		label: 'Impact',
		rubric: 'rubric',
		spec: { min: 0, max: 4 }
	});
	await defineAttribute(db, actor, am.id, {
		key: 'effort',
		kind: 'scale',
		label: 'Effort',
		rubric: 'rubric',
		spec: { min: 1, max: 5 }
	});
	await defineAttribute(db, actor, am.id, {
		key: 'area',
		kind: 'tags',
		label: 'Area',
		rubric: 'rubric',
		spec: {
			members: [
				{ key: 'ui', label: 'ui' },
				{ key: 'audio', label: 'audio' }
			]
		}
	});
	const rich = await seedLabour(db, { realmId: am.id, title: 'Rich' });
	const high = await seedLabour(db, { realmId: am.id, title: 'High' });
	await setValues(db, actor, rich.id, { impact: 3, effort: 2, area: ['audio', 'ui'] });
	await setValues(db, actor, high.id, { impact: 4 });
	return { am, rich, high, bob: await seedHuman(db, 'bob'), carol: await seedHuman(db, 'carol') };
}

async function surveyFor(client: Client, user: string, extra: Record<string, unknown> = {}) {
	const result = await ok(client, 'survey', {
		weights: NEUTRAL,
		temperature: 0,
		for: user,
		...extra
	});
	return result.survey as number;
}

describe('the report_outcomes tool', () => {
	it('is a write tool with a closed schema, 1 to 50 closed items and the three verdicts', async () => {
		const { tools } = await (await connect()).listTools();

		const tool = tools.find((t) => t.name === 'report_outcomes')!;

		expect(tool.description).toBeTruthy();
		expect(tool.annotations?.readOnlyHint).toBe(false);
		expect(tool.annotations?.destructiveHint).toBe(false);
		expect(tool.inputSchema.additionalProperties).toBe(false);
		expect([...(tool.inputSchema.required ?? [])].sort()).toEqual(['outcomes', 'survey']);
		expect(Object.keys(tool.inputSchema.properties!).sort()).toEqual(['outcomes', 'survey']);
		const list = (tool.inputSchema.properties as any).outcomes;
		expect(list.minItems).toBe(1);
		expect(list.maxItems).toBe(50);
		expect(list.items.additionalProperties).toBe(false);
		expect([...list.items.required].sort()).toEqual(['labour', 'verdict']);
		expect([...list.items.properties.verdict.enum].sort()).toEqual(['done', 'picked', 'skipped']);
	});

	it('records Outcomes for a Survey from the tool, answering with current Labour keys', async () => {
		const { rich, high, bob, carol } = await world();
		const survey = await surveyFor(await connect(), 'bob');

		const answered = await ok(await connect(carol), 'report_outcomes', {
			survey,
			outcomes: [
				{ labour: 'am-1', verdict: 'picked' },
				{ labour: high.id, verdict: 'skipped' }
			]
		});

		expect(answered).toEqual({
			outcomes: [
				{ labour: 'AM-1', verdict: 'picked', recorded: true },
				{ labour: 'AM-2', verdict: 'skipped', recorded: true }
			]
		});
		expect(
			(await storedOutcomes()).map((o) => [o.surveyId, o.labourId, o.verdict, o.authorId]).sort()
		).toEqual(
			[
				[survey, rich.id, 'picked', carol.id],
				[survey, high.id, 'skipped', carol.id]
			].sort()
		);
		const posted = await allPulses();
		expect(posted).toHaveLength(5);
		expect(posted.every((p) => p.userId === bob.id && p.realmId === null)).toBe(true);
		expect(posted.every((p) => p.authorId === carol.id)).toBe(true);
		const skipped = posted.find((p) => p.note === `skipped AM-2 in Survey ${survey}`)!;
		expect(skipped).toMatchObject({ rawKey: 'impact', amount: 0.5, mood: -1, halfLifeDays: 30 });
	});

	it('answers recorded false for a repeat and stores nothing more', async () => {
		const { bob } = await world();
		const client = await connect(bob);
		const survey = await surveyFor(client, 'me');
		await ok(client, 'report_outcomes', {
			survey,
			outcomes: [{ labour: 'AM-1', verdict: 'picked' }]
		});
		const pulsesBefore = await allPulses();

		const again = await ok(client, 'report_outcomes', {
			survey,
			outcomes: [
				{ labour: 'AM-1', verdict: 'picked' },
				{ labour: 'AM-1', verdict: 'done' }
			]
		});

		expect(again.outcomes.map((o: { recorded: boolean }) => o.recorded)).toEqual([false, true]);
		expect(await storedOutcomes()).toHaveLength(2);
		expect((await allPulses()).slice(0, pulsesBefore.length)).toEqual(pulsesBefore);
		expect(await allPulses()).toHaveLength(pulsesBefore.length * 2);
	});

	it('resolves a former Labour key and answers with the current one', async () => {
		const { am, carol } = await world();
		const survey = await surveyFor(await connect(), 'bob');
		await renameRealmKey(db, actor, am.id, 'ZZ');

		const answered = await ok(await connect(carol), 'report_outcomes', {
			survey,
			outcomes: [{ labour: 'AM-1', verdict: 'done' }]
		});

		expect(answered.outcomes).toEqual([{ labour: 'ZZ-1', verdict: 'done', recorded: true }]);
		expect((await allPulses())[0].note).toBe(`done ZZ-1 in Survey ${survey}`);
	});

	it('answers not_found for an unknown Survey', async () => {
		await world();

		const error = await fail(await connect(), 'report_outcomes', {
			survey: 9999,
			outcomes: [{ labour: 'AM-1', verdict: 'picked' }]
		});

		expect(error.code).toBe('not_found');
	});

	it('answers invalid for a Labour the Survey did not return, recording nothing from the call', async () => {
		await world();
		const client = await connect();
		const survey = await surveyFor(client, 'bob', { limit: 1 });

		const error = await fail(client, 'report_outcomes', {
			survey,
			outcomes: [
				{ labour: 'AM-1', verdict: 'picked' },
				{ labour: 'AM-2', verdict: 'picked' }
			]
		});

		expect(error.code).toBe('invalid');
		expect(await storedOutcomes()).toEqual([]);
		expect(await allPulses()).toEqual([]);
	});

	it('answers invalid for a verdict that is not picked, skipped or done', async () => {
		await world();
		const client = await connect();
		const survey = await surveyFor(client, 'bob');

		const error = await fail(client, 'report_outcomes', {
			survey,
			outcomes: [{ labour: 'AM-1', verdict: 'liked' }]
		});

		expect(error.code).toBe('invalid');
		expect(await storedOutcomes()).toEqual([]);
	});

	it('answers invalid for no outcomes and for 51', async () => {
		await world();
		const client = await connect();
		const survey = await surveyFor(client, 'bob');
		const item = { labour: 'AM-1', verdict: 'picked' };

		expect((await fail(client, 'report_outcomes', { survey, outcomes: [] })).code).toBe('invalid');
		expect(
			(await fail(client, 'report_outcomes', { survey, outcomes: Array(51).fill(item) })).code
		).toBe('invalid');
		expect(await storedOutcomes()).toEqual([]);
	});

	it('refuses an unknown argument at the top and inside an item', async () => {
		await world();
		const client = await connect();
		const survey = await surveyFor(client, 'bob');
		const item = { labour: 'AM-1', verdict: 'picked' };

		const top = await fail(client, 'report_outcomes', { survey, outcomes: [item], verbose: true });
		const nested = await fail(client, 'report_outcomes', {
			survey,
			outcomes: [{ ...item, note: 'liked it' }]
		});

		expect(top.code).toBe('invalid');
		expect(top.message).toContain('verbose');
		expect(nested.code).toBe('invalid');
		expect(nested.message).toContain('note');
		expect(await storedOutcomes()).toEqual([]);
	});

	it('refuses a digit string where a Labour is named', async () => {
		const { rich } = await world();
		const client = await connect();
		const survey = await surveyFor(client, 'bob');

		const error = await fail(client, 'report_outcomes', {
			survey,
			outcomes: [{ labour: String(rich.id), verdict: 'picked' }]
		});

		expect(error.code).toBe('invalid');
	});
});

describe('get_sentiment for a user', () => {
	// carol reports picked then done on AM-1 for bob, just now.
	async function learnedWithSurvey() {
		const fixture = await world();
		const survey = await surveyFor(await connect(), 'bob');
		for (const verdict of ['picked', 'done'] as Verdict[]) {
			await reportOutcomes(
				db,
				fixture.carol,
				survey,
				[{ labourId: fixture.rich.id, verdict }],
				new Date()
			);
		}
		return { ...fixture, survey };
	}

	it('is a read tool whose input is closed, with realm, user and limit', async () => {
		const { tools } = await (await connect()).listTools();

		const tool = tools.find((t) => t.name === 'get_sentiment')!;

		expect(tool.annotations?.readOnlyHint).toBe(true);
		expect(tool.inputSchema.additionalProperties).toBe(false);
		expect(Object.keys(tool.inputSchema.properties!).sort()).toEqual(['limit', 'realm', 'user']);
		expect(tool.inputSchema.required ?? []).toEqual([]);
	});

	it('answers the Affinity of "me", a username or an id, the same each way', async () => {
		const { bob } = await learnedWithSurvey();

		const asMe = await ok(await connect(bob), 'get_sentiment', { user: 'me' });
		const byName = await ok(await connect(), 'get_sentiment', { user: 'bob' });
		const byId = await ok(await connect(), 'get_sentiment', { user: bob.id });

		// Decay moves between the three calls on the real clock, so numbers compare within 1e-6.
		const close = (actual: any[], expected: any[]) => {
			expect(actual.map(({ realm, key }) => [realm, key])).toEqual(
				expected.map(({ realm, key }) => [realm, key])
			);
			actual.forEach((key, i) => {
				for (const field of ['volume', 'mood', 'v'])
					expect(key[field]).toBeCloseTo(expected[i][field], 6);
				expect(key.pulses.map(({ id, note }: any) => [id, note])).toEqual(
					expected[i].pulses.map(({ id, note }: any) => [id, note])
				);
			});
		};
		close(byName.keys, asMe.keys);
		close(byId.keys, asMe.keys);
		expect(asMe.keys.length).toBeGreaterThan(0);
	});

	it('shows keys by Realm key, ordered by volume, with usernames, ISO dates and Labour keys', async () => {
		const { survey } = await learnedWithSurvey();

		const view = await ok(await connect(), 'get_sentiment', { user: 'bob' });

		expect(view.unfiled).toEqual([]);
		expect(new Date(view.asOf).toISOString()).toBe(view.asOf);
		expect(view.keys.map((k: { realm: string; key: string }) => [k.realm, k.key])).toEqual([
			['AM', 'area:audio'],
			['AM', 'area:ui'],
			['AM', 'impact'],
			['AM', 'effort']
		]);
		// picked 1 + done 2, both just now.
		const [audio, , impact, effort] = view.keys;
		expect(audio.volume).toBeCloseTo(3, 4);
		expect(audio.mood).toBeCloseTo(1, 4);
		expect(audio.v).toBeCloseTo(3 / 8, 4);
		expect(impact.volume).toBeCloseTo(2.25, 4);
		expect(effort.volume).toBeCloseTo(0.75, 4);
		expect(audio.pulses).toHaveLength(2);
		expect(audio.pulses[0]).toEqual({
			id: expect.any(Number),
			note: `done AM-1 in Survey ${survey}`,
			evidence: [{ labour: 'AM-1' }],
			author: 'carol',
			createdAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T.*Z$/),
			weight: expect.closeTo(2, 4)
		});
		expect(audio.pulses[1].note).toBe(`picked AM-1 in Survey ${survey}`);
	});

	it('lists at most `limit` Pulses for each key', async () => {
		await learnedWithSurvey();

		const view = await ok(await connect(), 'get_sentiment', { user: 'bob', limit: 1 });

		expect(view.keys.every((k: { pulses: unknown[] }) => k.pulses.length === 1)).toBe(true);
	});

	it('answers empty keys and unfiled for a User with no Pulses', async () => {
		await world();

		const view = await ok(await connect(), 'get_sentiment', { user: 'carol' });

		expect(view.keys).toEqual([]);
		expect(view.unfiled).toEqual([]);
	});

	it('answers not_found for an unknown User', async () => {
		await world();
		const client = await connect();

		expect((await fail(client, 'get_sentiment', { user: 'nobody' })).code).toBe('not_found');
		expect((await fail(client, 'get_sentiment', { user: 9999 })).code).toBe('not_found');
	});

	it('refuses a digit string where a User is named', async () => {
		const { bob } = await world();

		const error = await fail(await connect(), 'get_sentiment', { user: String(bob.id) });

		expect(error.code).toBe('invalid');
	});

	it('refuses giving both realm and user', async () => {
		await world();

		const error = await fail(await connect(), 'get_sentiment', { realm: 'AM', user: 'bob' });

		expect(error.code).toBe('invalid');
	});

	it('refuses giving neither realm nor user, with or without a limit', async () => {
		await world();
		const client = await connect();

		expect((await fail(client, 'get_sentiment', {})).code).toBe('invalid');
		expect((await fail(client, 'get_sentiment', { limit: 2 })).code).toBe('invalid');
	});

	it('refuses an unknown argument', async () => {
		await world();

		const error = await fail(await connect(), 'get_sentiment', { user: 'bob', verbose: true });

		expect(error.code).toBe('invalid');
		expect(error.message).toContain('verbose');
	});

	it('leaves the Realm form free of Affinity Pulses', async () => {
		await learnedWithSurvey();

		const view = await ok(await connect(), 'get_sentiment', { realm: 'AM' });

		expect(view.keys).toEqual([]);
		expect(view.unfiled).toEqual([]);
	});

	it('gives the reporter no Affinity of their own', async () => {
		await learnedWithSurvey();

		const view = await ok(await connect(), 'get_sentiment', { user: 'carol' });

		expect(view.keys).toEqual([]);
	});
});
