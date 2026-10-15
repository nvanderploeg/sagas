import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '#lib/server/db/client.ts';
import { testDb } from '#lib/server/test/db.ts';
import { DomainError } from '#lib/server/domain/errors.ts';
import { createAgentUser, createFirstAdmin, hasUsers, authenticate } from './users.ts';
import { seedHuman } from './fixtures.ts';

let db: Db;

beforeEach(() => {
	db = testDb();
});

afterEach(() => {
	db.$client.close();
});

const setup = (username = 'root') => ({
	username,
	displayName: 'Root',
	password: 'a long enough password'
});

function expectCode(action: () => unknown, code: DomainError['code']) {
	let thrown: unknown;
	try {
		action();
	} catch (error) {
		thrown = error;
	}
	expect(thrown).toBeInstanceOf(DomainError);
	expect((thrown as DomainError).code).toBe(code);
}

describe('first-run setup', () => {
	it('creates the first User as an Admin', async () => {
		expect(hasUsers(db)).toBe(false);

		const admin = await createFirstAdmin(db, setup());

		expect(admin).toMatchObject({ kind: 'human', isAdmin: true, username: 'root' });
		expect(hasUsers(db)).toBe(true);
	});

	it('locks after the first User exists', async () => {
		await createFirstAdmin(db, setup());

		await expect(createFirstAdmin(db, setup('second'))).rejects.toMatchObject({ code: 'conflict' });
		expect(await authenticate(db, 'second', 'x')).toBeNull();
	});

	it('lets only one of two concurrent setups win', async () => {
		const results = await Promise.allSettled([
			createFirstAdmin(db, setup('first')),
			createFirstAdmin(db, setup('second'))
		]);

		expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
		expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
	});

	it('stores the username in lowercase and rejects a malformed one', async () => {
		const admin = await createFirstAdmin(db, setup('  Root  '));
		expect(admin.username).toBe('root');
	});

	it('rejects a weak password without creating the Admin', async () => {
		await expect(
			createFirstAdmin(db, { username: 'root', displayName: 'Root', password: 'short' })
		).rejects.toMatchObject({ code: 'invalid' });
		expect(hasUsers(db)).toBe(false);
	});
});

describe('Agent users', () => {
	it('creates an Agent user without a password, and an Admin only', async () => {
		const admin = await createFirstAdmin(db, setup());
		const grace = seedHuman(db, 'grace');

		const bot = createAgentUser(db, admin, { username: 'bot', displayName: 'Bot' });

		expect(bot).toMatchObject({ kind: 'agent', isAdmin: false });
		expectCode(
			() => createAgentUser(db, grace, { username: 'other', displayName: 'Other' }),
			'forbidden'
		);
	});

	it('cannot sign in with a password', async () => {
		const admin = await createFirstAdmin(db, setup());
		createAgentUser(db, admin, { username: 'bot', displayName: 'Bot' });

		expect(await authenticate(db, 'bot', 'a long enough password')).toBeNull();
	});

	it('rejects a username already taken', async () => {
		const admin = await createFirstAdmin(db, setup());

		expectCode(
			() => createAgentUser(db, admin, { username: 'ROOT', displayName: 'Dup' }),
			'conflict'
		);
	});
});

describe('password sign-in', () => {
	it('accepts the right password for a human, in any username case', async () => {
		await createFirstAdmin(db, setup());

		expect((await authenticate(db, 'ROOT', 'a long enough password'))?.username).toBe('root');
	});

	it('rejects a wrong password and an unknown user', async () => {
		await createFirstAdmin(db, setup());

		expect(await authenticate(db, 'root', 'wrong password here')).toBeNull();
		expect(await authenticate(db, 'nobody', 'a long enough password')).toBeNull();
		expect(await authenticate(db, '!!', 'a long enough password')).toBeNull();
	});
});
