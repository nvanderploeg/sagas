import { and, eq, gt, isNull, or } from 'drizzle-orm';
import { sessionVerifier } from './firebase.ts';
import type { Handle } from '#lib/server/db/client.ts';
import { apiTokens } from '#lib/server/db/schema.ts';
import { hashSecret } from './secrets.ts';

// What a request signed in with, named by the secret's stored hash.
// A session also carries the cookie itself, which only the Firebase verifier can check.
export type Credential = { kind: 'api_token' | 'session'; hash: string; token?: string };

export const apiTokenCredential = (token: string): Credential => ({
	kind: 'api_token',
	hash: hashSecret(token)
});

export const sessionCredential = (token: string): Credential => ({
	kind: 'session',
	hash: hashSecret(token),
	token
});

export async function credentialValid(
	db: Handle,
	credential: Credential,
	now = new Date()
): Promise<boolean> {
	if (credential.kind === 'api_token') {
		return (
			(
				await db
					.select({ id: apiTokens.id })
					.from(apiTokens)
					.where(
						and(
							eq(apiTokens.tokenHash, credential.hash),
							isNull(apiTokens.revokedAt),
							or(isNull(apiTokens.expiresAt), gt(apiTokens.expiresAt, now))
						)
					)
					.limit(1)
			)[0] !== undefined
		);
	}
	return (
		credential.token !== undefined && (await sessionVerifier.verify(credential.token)) !== null
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
	for (const listener of [...listeners]) {
		try {
			listener(credential);
		} catch (error) {
			console.error('sagas revocation listener failed', error);
		}
	}
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
