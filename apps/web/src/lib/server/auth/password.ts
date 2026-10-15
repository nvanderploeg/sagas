import { randomBytes } from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';
import { DomainError } from '#lib/server/domain/errors.ts';

const MIN_LENGTH = 12;
const MAX_LENGTH = 256;

export function checkPassword(password: string): string {
	if (password.length < MIN_LENGTH || password.length > MAX_LENGTH) {
		throw new DomainError('invalid', `Password must be ${MIN_LENGTH} to ${MAX_LENGTH} characters`);
	}
	return password;
}

export async function hashPassword(password: string): Promise<string> {
	return hash(checkPassword(password));
}

export async function verifyPassword(stored: string, password: string): Promise<boolean> {
	try {
		return await verify(stored, password);
	} catch {
		return false;
	}
}

let decoy: Promise<string> | undefined;

// Runs the same argon2 work for an unknown user as for a wrong password.
export async function spendPasswordTime(password: string): Promise<void> {
	decoy ??= hash(randomBytes(32).toString('hex'));
	await verify(await decoy, password);
}
