import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listCache, readCache, removeCache, writeCache } from './index.ts';

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'sagas-cache-'));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe('writeCache', () => {
	it('round-trips data in the versioned envelope', () => {
		const now = new Date('2026-01-02T03:04:05.000Z');
		writeCache(dir, 'skills.json', { skills: [1, 2] }, { now });
		expect(readCache(dir, 'skills.json')).toEqual({
			format: 1,
			fetchedAt: '2026-01-02T03:04:05.000Z',
			data: { skills: [1, 2] }
		});
	});

	it('creates the directory 0700 and the file 0600', () => {
		const nested = join(dir, 'a', 'b');
		writeCache(nested, 'realms/1.json', {});
		expect(statSync(nested).mode & 0o777).toBe(0o700);
		expect(statSync(join(nested, 'realms')).mode & 0o777).toBe(0o700);
		expect(statSync(join(nested, 'realms', '1.json')).mode & 0o777).toBe(0o600);
	});

	it('leaves no temp file behind and replaces in place', () => {
		writeCache(dir, 'a.json', { n: 1 });
		writeCache(dir, 'a.json', { n: 2 });
		expect(readdirSync(dir)).toEqual(['a.json']);
		expect(readCache<{ n: number }>(dir, 'a.json')?.data).toEqual({ n: 2 });
	});

	it('keeps the old file whole when the write fails', () => {
		writeCache(dir, 'a.json', { n: 1 });
		const before = readFileSync(join(dir, 'a.json'), 'utf8');
		const warnings: string[] = [];
		writeCache(dir, 'a.json', { n: 1n }, { warn: (message) => warnings.push(message) });
		expect(readFileSync(join(dir, 'a.json'), 'utf8')).toBe(before);
		expect(readdirSync(dir)).toEqual(['a.json']);
		expect(warnings).toHaveLength(1);
	});

	it('warns instead of throwing when the directory cannot be made', () => {
		writeFileSync(join(dir, 'blocked'), 'file');
		const warnings: string[] = [];
		expect(() =>
			writeCache(join(dir, 'blocked'), 'a.json', {}, { warn: (message) => warnings.push(message) })
		).not.toThrow();
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain('a.json');
	});
});

describe('readCache', () => {
	it('ignores a missing file', () => {
		expect(readCache(dir, 'nope.json')).toBeUndefined();
	});

	it.each([
		['truncated JSON', '{"format":1,"fetch'],
		['not an object', '[1,2]'],
		['another format', '{"format":2,"fetchedAt":"x","data":{}}'],
		['no fetchedAt', '{"format":1,"data":{}}'],
		['no data', '{"format":1,"fetchedAt":"x"}'],
		['empty', '']
	])('ignores a corrupt file: %s', (_, text) => {
		writeFileSync(join(dir, 'bad.json'), text);
		expect(readCache(dir, 'bad.json')).toBeUndefined();
	});

	it('ignores a directory where a file should be', () => {
		mkdirSync(join(dir, 'dir.json'));
		expect(readCache(dir, 'dir.json')).toBeUndefined();
	});
});

describe('removeCache and listCache', () => {
	it('removes a file and tolerates a missing one', () => {
		writeCache(dir, 'realms/1.json', {});
		removeCache(dir, 'realms/1.json');
		removeCache(dir, 'realms/1.json');
		expect(listCache(dir, 'realms')).toEqual([]);
	});

	it('lists files and skips temp files', () => {
		writeCache(dir, 'realms/1.json', {});
		writeFileSync(join(dir, 'realms', '.tmp-1-abc'), 'x');
		expect(listCache(dir, 'realms')).toEqual(['1.json']);
		expect(listCache(dir, 'missing')).toEqual([]);
	});
});
