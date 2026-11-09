import { describe, expect, it } from 'vitest';
import type { AuthUser } from '#lib/server/auth/users.ts';
import { requireAdminSession, requireSameOrigin } from './guard.ts';

const user = (isAdmin: boolean): AuthUser => ({
	id: 1,
	kind: 'human',
	isAdmin,
	username: 'ada',
	displayName: 'Ada',
	email: null,
	realmLimit: 1,
	banned: false
});
const session = { kind: 'session', hash: 'h' } as const;
const token = { kind: 'api_token', hash: 'h' } as const;

const status = (run: () => unknown): number => {
	try {
		run();
	} catch (e) {
		return (e as { status: number }).status;
	}
	return 0;
};

describe('requireAdminSession', () => {
	it('lets an Admin with a browser session through', () => {
		expect(requireAdminSession({ user: user(true), credential: session }).id).toBe(1);
	});

	it('refuses nobody, a plain User, and an Admin acting through an API token', () => {
		expect(status(() => requireAdminSession({ user: null, credential: null }))).toBe(401);
		expect(status(() => requireAdminSession({ user: user(false), credential: session }))).toBe(403);
		expect(status(() => requireAdminSession({ user: user(true), credential: token }))).toBe(403);
	});
});

describe('requireSameOrigin', () => {
	const request = (origin?: string) =>
		new Request('https://s.example/admin/import', {
			method: 'POST',
			headers: origin ? { origin } : {}
		});

	it('passes only the server own origin', () => {
		expect(status(() => requireSameOrigin(request('https://s.example'), 'https://s.example'))).toBe(
			0
		);
		expect(
			status(() => requireSameOrigin(request('https://evil.example'), 'https://s.example'))
		).toBe(403);
		expect(status(() => requireSameOrigin(request(), 'https://s.example'))).toBe(403);
	});
});
