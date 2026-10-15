import { describe, expect, it } from 'vitest';
import { DomainError } from '#lib/server/domain/errors.ts';
import { hashPassword, verifyPassword } from './password.ts';

describe('password hashing', () => {
	it('stores an argon2 hash that verifies only the original password', async () => {
		const stored = await hashPassword('correct horse battery');

		expect(stored).toMatch(/^\$argon2id\$/);
		expect(stored).not.toContain('correct horse');
		expect(await verifyPassword(stored, 'correct horse battery')).toBe(true);
		expect(await verifyPassword(stored, 'correct horse batter')).toBe(false);
	});

	it('treats a malformed stored hash as a mismatch', async () => {
		expect(await verifyPassword('not-a-hash', 'correct horse battery')).toBe(false);
	});

	it('rejects a password shorter than 12 characters or longer than 256', async () => {
		await expect(hashPassword('short')).rejects.toBeInstanceOf(DomainError);
		await expect(hashPassword('x'.repeat(257))).rejects.toBeInstanceOf(DomainError);
	});
});
