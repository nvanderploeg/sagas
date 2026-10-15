import type { AuthUser } from '#lib/server/auth/users.ts';

declare global {
	namespace App {
		interface Locals {
			user: AuthUser | null;
		}
	}
}

export {};
