import { describe, expect, it } from 'vitest';
import { returnPath, signInPath } from './return-path.ts';

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
