import type { Cookies } from '@sveltejs/kit';
import { describe, expect, it } from 'vitest';
import { clearSessionCookie, SESSION_COOKIE, setSessionCookie } from './request.ts';

function recordingCookies() {
	const calls: { name: string; options: { secure?: boolean } }[] = [];
	const cookies = {
		set: (name: string, _value: string, options: { secure?: boolean }) =>
			calls.push({ name, options }),
		delete: (name: string, options: { secure?: boolean }) => calls.push({ name, options })
	} as unknown as Cookies;
	return { cookies, calls };
}

describe('session cookie', () => {
	const expires = new Date('2026-01-01T00:00:00Z');

	it.each([
		['http://localhost:3290/login', false],
		['http://192.168.1.20:3290/login', false],
		['https://workload.example.com/login', true]
	])('is Secure exactly when the request protocol is https (%s)', (href, secure) => {
		const { cookies, calls } = recordingCookies();

		setSessionCookie(cookies, new URL(href), 'wls_token', expires);
		clearSessionCookie(cookies, new URL(href));

		expect(calls).toHaveLength(2);
		for (const call of calls) {
			expect(call.name).toBe(SESSION_COOKIE);
			expect(call.options.secure).toBe(secure);
		}
	});
});
