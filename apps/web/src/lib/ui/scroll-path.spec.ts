import { describe, expect, it } from 'vitest';
import { normalizePath, parentPath, slugify, SLUG } from './scroll-path.ts';

describe('slugify', () => {
	it('lowercases, drops accents and joins words with hyphens', () => {
		expect(slugify('  Café Release — Process!  ')).toBe('cafe-release-process');
	});

	it('falls back to "page" when nothing is left', () => {
		expect(slugify('!!!')).toBe('page');
	});

	it('always makes a valid slug, even from a long title', () => {
		const slug = slugify(`${'a'.repeat(63)} b`);
		expect(slug).toMatch(SLUG);
		expect(slug.length).toBeLessThanOrEqual(64);
	});
});

describe('normalizePath', () => {
	it('slugifies each segment and drops empty ones', () => {
		expect(normalizePath('/Ops//Release Process/')).toBe('ops/release-process');
	});

	it('names nothing when empty or deeper than ten', () => {
		expect(normalizePath(' / ')).toBeNull();
		expect(normalizePath(Array(11).fill('a').join('/'))).toBeNull();
	});

	it('gives the parent Path', () => {
		expect(parentPath('a/b/c')).toBe('a/b');
		expect(parentPath('a')).toBeNull();
	});
});
