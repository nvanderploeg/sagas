import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { seedHuman } from '#lib/server/auth/fixtures.ts';
import type { AuthUser } from '#lib/server/auth/users.ts';
import type { Db } from '#lib/server/db/client.ts';
import { surveys } from '#lib/server/db/schema.ts';
import { seedLabour, seedRealm } from '#lib/server/test/fixtures.ts';
import { testDb } from '#lib/server/test/db.ts';
import { toolRegistry, type Registry } from '../tool.ts';
import { registerSurveyTools } from './survey.ts';

let db: Db;
let registry: Registry;
let user: AuthUser;

beforeEach(() => {
	db = testDb();
	user = seedHuman(db, 'ada');
	registry = toolRegistry(db, user);
	registerSurveyTools(registry.tools);
});

afterEach(() => {
	db.$client.close();
});

async function call(args: Record<string, unknown>) {
	const result = await registry.call('survey', args);
	return {
		error: result.isError === true,
		data: result.structuredContent as any,
		text: (result.content[0] as { text: string }).text
	};
}

describe('survey tool', () => {
	it('is a write with a closed input schema', () => {
		const tool = registry.list().find((t) => t.name === 'survey')!;
		expect(tool.annotations?.readOnlyHint).toBe(false);
		expect(tool.inputSchema.additionalProperties).toBe(false);
	});

	it('resolves refs, scores, and answers with keys and usernames', async () => {
		const am = seedRealm(db, 'AM');
		const bm = seedRealm(db, 'BM');
		const first = seedLabour(db, { realmId: am.id, title: 'First', assigneeId: user.id });
		seedLabour(db, { realmId: bm.id, title: 'Second' });

		const result = await call({
			realm: ['am', bm.id],
			for: 'me',
			weights: { age: 1, bogus: 1 },
			filter: { assignee: ['ADA'], labels: [], unblocked: true },
			temperature: 0,
			show: ['nope']
		});
		expect(result.error, result.text).toBe(false);
		expect(result.text.split('\n')[0]).toBe(`Survey ${result.data.survey}: 1 of 1 Labour`);
		expect(result.data).toMatchObject({
			sentiment: [],
			ignored: ['bogus', 'nope'],
			coverage: { candidates: 1, unappraised: 1, stale: 0, unembedded: 1, missing: {} }
		});
		expect(result.data.results).toEqual([
			{
				key: 'AM-1',
				path: '/l/AM-1',
				title: first.title,
				realm: 'AM',
				state: 'todo',
				assignee: 'ada',
				brief: '',
				score: expect.any(Number),
				contributions: expect.any(Object),
				values: {}
			}
		]);
		const stored = db.select().from(surveys).where(eq(surveys.id, result.data.survey)).get()!;
		expect(stored.actorId).toBe(user.id);
		expect(stored.forId).toBe(user.id);
	});

	it('maps include_closed and null assignee, and refuses unknown arguments', async () => {
		const am = seedRealm(db, 'AM');
		seedLabour(db, { realmId: am.id });
		const ok = await call({
			weights: { age: 1 },
			filter: { include_closed: { within_days: 5 }, assignee: [null], quest: 99 }
		});
		expect(ok.data.error.code).toBe('not_found');
		const fine = await call({
			weights: { age: 1 },
			filter: { include_closed: { within_days: 5 }, assignee: [null] }
		});
		expect(fine.error, fine.text).toBe(false);
		expect(fine.data.results).toHaveLength(1);

		for (const args of [
			{ weights: { age: 1 }, extra: 1 },
			{ weights: { age: 1 }, filter: { nope: 1 } },
			{ weights: { age: 1 }, filter: { include_closed: { within_days: 1, x: 1 } } },
			{ weights: { age: 'x' } }
		]) {
			const refused = await call(args);
			expect(refused.error).toBe(true);
			expect(refused.data.error.code).toBe('invalid');
		}
	});

	it('refuses lists past their caps as invalid before resolving any ref', async () => {
		seedLabour(db, { realmId: seedRealm(db, 'AM').id });
		const many = (size: number, item: (i: number) => unknown) =>
			Array.from({ length: size }, (_, i) => item(i));
		for (const args of [
			{ realm: many(65, (i) => `R${i}`) },
			{ filter: { assignee: many(65, (i) => `u${i}`) } },
			{ filter: { has: many(33, (i) => `topic:m${i}`) } },
			{ filter: { labels: many(21, (i) => `l${i}`) } }
		]) {
			const refused = await call({ weights: { age: 1 }, ...args });
			expect(refused.error, JSON.stringify(args).slice(0, 40)).toBe(true);
			expect(refused.data.error.code).toBe('invalid');
		}
		const atCaps = await call({
			weights: { age: 1 },
			filter: {
				assignee: many(64, () => null),
				has: many(32, (i) => `topic:m${i}`),
				labels: many(20, (i) => `l${i}`)
			}
		});
		expect(atCaps.error, atCaps.text).toBe(false);
	});
});
