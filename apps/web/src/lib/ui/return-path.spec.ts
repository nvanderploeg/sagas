import { describe, expect, it } from 'vitest';
import { gateRedirect, returnPath, signInPath } from './return-path.ts';

describe('returnPath', () => {
	it('keeps a path on this site, with its query and fragment', () => {
		expect(returnPath('/r/AM?filter=1#top')).toBe('/r/AM?filter=1#top');
		expect(
			returnPath(new URL(`http://x${signInPath('/l/AM-1?x=1')}`).searchParams.get('next'))
		).toBe('/l/AM-1?x=1');
	});

	it('never leads off the site', () => {
		for (const value of [
			'//evil.example/x',
			'/.//evil.example',
			'/a/..//evil.example',
			'/\\evil.example',
			'/\t/evil.example',
			'https://evil.example/',
			'javascript:alert(1)',
			'evil.example'
		]) {
			expect(returnPath(value), value).toBe('/');
		}
	});

	it('never leads back to signing in, and is home when missing', () => {
		expect(returnPath('/login?next=/x')).toBe('/');
		expect(returnPath('/logout')).toBe('/');
		expect(returnPath(null)).toBe('/');
		expect(returnPath('')).toBe('/');
	});
});

describe('gateRedirect', () => {
	const at = (path: string) => new URL(path, 'https://sagas.example');

	it('sends home to a bare /login or /password', () => {
		expect(gateRedirect('login', at('/'))).toBe('/login');
		expect(gateRedirect('login', at('/?x=1'))).toBe('/login');
		expect(gateRedirect('password', at('/'))).toBe('/password');
	});

	it('carries any other page and its query through sign-in', () => {
		const path =
			'/oauth/authorize?client_id=wlc_x&redirect_uri=https%3A%2F%2Fclaude.ai%2Fcb&state=a%26b';
		const login = gateRedirect('login', at(path));
		expect(login.startsWith('/login?next=')).toBe(true);
		expect(returnPath(new URL(login, 'https://x').searchParams.get('next'))).toBe(path);
	});

	it('carries any other page and its query through a forced password change', () => {
		const path = '/oauth/authorize?state=a%26b';
		const target = gateRedirect('password', at(path));
		expect(target).toBe(`/password?next=${encodeURIComponent(path)}`);
		expect(returnPath(new URL(target, 'https://x').searchParams.get('next'))).toBe(path);
	});

	it('leaves setup alone', () => {
		expect(gateRedirect('setup', at('/l/AM-1'))).toBe('/setup');
	});
});
