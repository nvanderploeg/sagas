import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defineAttribute, setValues } from '#lib/server/agent/attributes.ts';
import { seedHuman } from '#lib/server/auth/fixtures.ts';
import type { AuthUser } from '#lib/server/auth/users.ts';
import type { Db } from '#lib/server/db/client.ts';
import { deleteLabour } from '#lib/server/domain/labours.ts';
import { testDb } from '#lib/server/test/db.ts';
import { seedLabour, seedRealm } from '#lib/server/test/fixtures.ts';
import { toolRegistry, type Registry } from '../tool.ts';
import { registerSentimentTools } from './sentiment.ts';
import { registerSurveyTools } from './survey.ts';

let db: Db;
let registry: Registry;
let user: AuthUser;

beforeEach(() => {
	db = testDb();
	user = seedHuman(db, 'ada');
	registry = toolRegistry(db, user, 'http://sagas.test');
	registerSentimentTools(registry.tools);
	registerSurveyTools(registry.tools);
});

afterEach(() => {
	db.$client.close();
});

async function call(name: string, args: Record<string, unknown>) {
	const result = await registry.call(name, args);
	return { error: result.isError === true, data: result.structuredContent as any };
}

function setup() {
	const realm = seedRealm(db, 'AM');
	defineAttribute(db, user, realm.id, {
		key: 'impact',
		kind: 'scale',
		label: 'Impact',
		rubric: 'x',
		spec: { min: 0, max: 4 }
	});
	return realm;
}

describe('sentiment tools', () => {
	it('closes every input object', async () => {
		setup();
		for (const tool of registry.list()) {
			expect(tool.inputSchema.additionalProperties, tool.name).toBe(false);
		}
		const extra = await call('pulse', {
			realm: 'AM',
			pulses: [{ key: 'impact', amount: 1, mood: 0, extra: 1 }]
		});
		expect(extra.data.error.code).toBe('invalid');
		const nested = await call('pulse', {
			realm: 'AM',
			pulses: [{ key: 'impact', amount: 1, mood: 0, evidence: [{ href: 'x', labour: 1 }] }]
		});
		expect(nested.error).toBe(true);
	});

	it('posts, reads, files and deletes, naming users, Realms and Labours', async () => {
		const realm = setup();
		const cited = seedLabour(db, { realmId: realm.id });
		const posted = await call('pulse', {
			realm: 'am',
			pulses: [
				{
					key: 'Impact',
					amount: 3,
					mood: -0.5,
					note: 'crashes',
					evidence: [{ labour: cited.key.toLowerCase() }, { href: 'https://x.test' }],
					half_life_days: null,
					ref: 'm1'
				},
				{ key: 'boss-hp', amount: 1, mood: 1 },
				{ key: 'impact', amount: 1, mood: 0, ref: 'm1' }
			]
		});
		expect(posted.error).toBe(false);
		expect(posted.data.pulses).toEqual([
			{ index: 0, status: 'filed', id: expect.any(Number) },
			{ index: 1, status: 'unfiled', id: expect.any(Number) },
			{ index: 2, status: 'skipped', id: posted.data.pulses[0].id }
		]);

		const read = await call('get_sentiment', { realm: realm.id });
		expect(read.data.keys).toEqual([
			{
				realm: 'AM',
				key: 'impact',
				volume: 3,
				mood: -0.5,
				v: 3 / 8,
				pulses: [
					{
						id: posted.data.pulses[0].id,
						note: 'crashes',
						evidence: [{ labour: cited.key }, { href: 'https://x.test', label: null }],
						author: 'ada',
						createdAt: expect.stringMatching(/Z$/),
						weight: 3
					}
				]
			}
		]);
		expect(read.data.unfiled).toMatchObject([{ rawKey: 'boss-hp', count: 1 }]);
		expect(read.data.asOf).toMatch(/Z$/);

		deleteLabour(db, user, cited.id);
		const after = await call('get_sentiment', { realm: 'AM', limit: 1 });
		expect(after.data.keys[0].pulses[0].evidence).toEqual([
			{ href: 'https://x.test', label: null }
		]);

		expect(
			(await call('file_pulses', { realm: 'AM', raw_key: 'boss-hp', key: 'impact' })).data
		).toEqual({
			filed: 1
		});
		expect(
			(await call('file_pulses', { realm: 'AM', raw_key: 'x', key: 'nope' })).data.error.code
		).toBe('invalid');
		const id = posted.data.pulses[0].id;
		expect((await call('delete_pulse', { pulse: id })).data).toEqual({ deleted: { id } });
		expect((await call('delete_pulse', { pulse: id })).data.error.code).toBe('not_found');
	});

	it('shows the notes behind a Survey as Realm keys, usernames and ISO times', async () => {
		const realm = setup();
		const labour = seedLabour(db, { realmId: realm.id });
		setValues(db, user, labour.id, { impact: 4 });
		await call('pulse', {
			realm: 'AM',
			pulses: [
				{ key: 'impact', amount: 2, mood: 1, note: 'loved', evidence: [{ labour: labour.id }] }
			]
		});

		const result = await call('survey', { weights: { delight: 1 } });

		expect(result.data.sentiment).toEqual([
			{
				realm: 'AM',
				key: 'impact',
				volume: expect.closeTo(2, 5),
				mood: 1,
				pulses: [
					{
						id: expect.any(Number),
						note: 'loved',
						evidence: [{ labour: labour.key }],
						author: 'ada',
						createdAt: expect.stringMatching(/Z$/)
					}
				]
			}
		]);
		expect(result.data.results[0].score).toBeGreaterThan(0);
	});
});
