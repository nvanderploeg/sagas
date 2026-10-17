import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { seedHuman } from '#lib/server/auth/fixtures.ts';
import type { AuthUser } from '#lib/server/auth/users.ts';
import type { Db } from '#lib/server/db/client.ts';
import { setValues } from '#lib/server/agent/attributes.ts';
import { testDb } from '#lib/server/test/db.ts';
import { seedLabour, seedRealm } from '#lib/server/test/fixtures.ts';
import { toolRegistry, type Registry } from '../tool.ts';
import { registerAttributeTools } from './attributes.ts';

let db: Db;
let registry: Registry;
let user: AuthUser;

beforeEach(() => {
	db = testDb();
	user = seedHuman(db, 'ada');
	registry = toolRegistry(db, user, 'http://sagas.test');
	registerAttributeTools(registry.tools);
});

afterEach(() => {
	db.$client.close();
});

async function call(name: string, args: Record<string, unknown>) {
	const result = await registry.call(name, args);
	return { error: result.isError === true, data: result.structuredContent as any };
}

describe('attribute tools', () => {
	it('defines, reads with since, tunes and deletes by Realm key', async () => {
		const realm = seedRealm(db, 'AM');
		const spec = { min: 1, max: 5 };
		const made = await call('define_attribute', {
			realm: 'am',
			key: 'size',
			kind: 'scale',
			label: 'Size',
			rubric: 'How big.',
			spec
		});
		expect(made.data.version).toBe(1);
		expect(made.data.attribute).toMatchObject({ key: 'size', spec, held: 0, counts: {} });
		expect(typeof made.data.attribute.revisedAt).toBe('string');

		const labour = seedLabour(db, { realmId: realm.id });
		setValues(db, user, labour.id, { size: 4 });

		expect((await call('get_attributes', { realm: 'AM', since: 2 })).data).toEqual({
			realm: 'AM',
			version: 2
		});
		const full = await call('get_attributes', { realm: 'AM', since: 1 });
		expect(full.data).toMatchObject({
			realm: 'AM',
			version: 2,
			notes: '',
			settings: { halfLifeDays: 14, loudness: 5 }
		});
		expect(full.data.attributes[0].counts).toEqual({ '4': 1 });

		const tuned = await call('tune_realm', { realm: 'AM', notes: 'Hi', half_life_days: 7 });
		expect(tuned.data).toEqual({
			realm: 'AM',
			version: 3,
			notes: 'Hi',
			settings: { halfLifeDays: 7, loudness: 5 }
		});

		const gone = await call('delete_attribute', { realm: 'AM', key: 'size' });
		expect(gone.data).toEqual({ version: 4, deleted: { key: 'size' } });
	});

	it('answers a domain error with its code and refuses unknown arguments', async () => {
		seedRealm(db, 'AM');
		const reserved = await call('define_attribute', {
			realm: 'AM',
			key: 'rank',
			kind: 'text',
			label: 'l',
			rubric: 'r'
		});
		expect(reserved.error).toBe(true);
		expect(reserved.data.error.code).toBe('invalid');
		const extra = await call('define_attribute', {
			realm: 'AM',
			key: 'x',
			kind: 'scale',
			spec: { min: 1, max: 2, bogus: 1 }
		});
		expect(extra.data.error.code).toBe('invalid');
		expect((await call('tune_realm', { realm: 'ZZ' })).data.error.code).toBe('not_found');
	});
});
