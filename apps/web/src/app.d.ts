import type { Credential } from '#lib/server/auth/credentials.ts';
import type { AuthUser } from '#lib/server/auth/users.ts';

declare global {
	const __APP_VERSION__: string;
	const __GIT_HASH__: string;

	namespace App {
		interface Locals {
			user: AuthUser | null;
			credential: Credential | null;
		}
	}
}

export {};
