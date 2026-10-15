import { and, eq, gt, isNull } from 'drizzle-orm';
import type { Handle } from '#lib/server/db/client.ts';
import { apiTokens, sessions } from '#lib/server/db/schema.ts';
import { hashSecret } from './secrets.ts';

// What a request signed in with, named by the secret's stored hash.
export type Credential = { kind: 'api_token' | 'session'; hash: string };

export const apiTokenCredential = (token: string): Credential => ({
	kind: 'api_token',
	hash: hashSecret(token)
});

export const sessionCredential = (token: string): Credential => ({
	kind: 'session',
	hash: hashSecret(token)
});

export function credentialValid(db: Handle, credential: Credential, now = new Date()): boolean {
	if (credential.kind === 'api_token') {
		return (
			db
				.select({ id: apiTokens.id })
				.from(apiTokens)
				.where(and(eq(apiTokens.tokenHash, credential.hash), isNull(apiTokens.revokedAt)))
				.get() !== undefined
		);
	}
	return (
		db
			.select({ id: sessions.id })
			.from(sessions)
			.where(and(eq(sessions.id, credential.hash), gt(sessions.expiresAt, now)))
			.get() !== undefined
	);
}

type Listener = (credential: Credential) => void;

const listeners = new Set<Listener>();

export function onRevoked(listener: Listener): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

// Announce after the commit that ends the credential.
export function announceRevoked(credential: Credential): void {
	for (const listener of [...listeners]) listener(credential);
}

export function credentialGuard(db: Handle, credential: Credential) {
	return {
		valid: () => credentialValid(db, credential),
		watch: (revoked: () => void) =>
			onRevoked((ended) => {
				if (ended.kind === credential.kind && ended.hash === credential.hash) revoked();
			})
	};
}
