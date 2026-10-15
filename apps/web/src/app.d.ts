import type { Credential } from '#lib/server/auth/credentials.ts';
import type { AuthUser } from '#lib/server/auth/users.ts';

declare global {
	namespace App {
		interface Locals {
			user: AuthUser | null;
			credential: Credential | null;
		}
	}
}

export {};
