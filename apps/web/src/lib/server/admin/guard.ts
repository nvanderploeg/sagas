import { error } from '@sveltejs/kit';
import type { AuthUser } from '#lib/server/auth/users.ts';

export const IMPORT_CONFIRMATION = 'REPLACE ALL DATA';

export function requireAdminSession(locals: App.Locals): AuthUser {
	if (!locals.user) error(401, 'Sign in first');
	if (!locals.user.isAdmin) error(403, 'Only an Admin can manage the instance');
	if (locals.credential?.kind !== 'session') error(403, 'Sign in with the browser to do that');
	return locals.user;
}

export function requireSameOrigin(request: Request, origin: string): void {
	if (request.headers.get('origin') !== origin) error(403, 'Cross-site request refused');
}
