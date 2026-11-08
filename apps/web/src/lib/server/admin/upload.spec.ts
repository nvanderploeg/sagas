import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { gate } from '#lib/server/auth/access.ts';
import { testDb } from '#lib/server/test/db.ts';
import { UploadError, createUploads } from './upload.ts';

const options = { maxBytes: 1000, maxExpandedBytes: 4000 };
const chunk = (id: string, offset: number, text: string, final = false) => ({
	id,
	offset,
	body: Readable.from([Buffer.from(text)]),
	final
});
const id = () => Math.random().toString(16).slice(2, 18).padEnd(16, '0');
const spool = (name: string) => join(tmpdir(), `sagas-upload-${name}.zip`);

describe('uploads', () => {
	it('gives a second concurrent upload a 409 and lets the first finish', async () => {
		const [A, B] = [id(), id()];
		const uploads = createUploads(await testDb(), options);
		await uploads.append(chunk(A, 0, 'abc'));

		await expect(uploads.append(chunk(B, 0, 'xyz'))).rejects.toMatchObject({ status: 409 });
		await expect(uploads.append(chunk(A, 3, 'def'))).resolves.toBeNull();
		expect(readFileSync(spool(A), 'utf8')).toBe('abcdef');
	});

	it('refuses a chunk that races a first chunk of another upload, without orphaning files', async () => {
		const [A, B] = [id(), id()];
		const uploads = createUploads(await testDb(), options);

		const results = await Promise.allSettled([
			uploads.append(chunk(A, 0, 'abc')),
			uploads.append(chunk(B, 0, 'xyz'))
		]);

		expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected']);
		expect(existsSync(spool(A))).toBe(true);
		expect(readdirSync(tmpdir()).filter((n) => n.includes(B))).toEqual([]);
	});

	it('refuses a duplicate of a chunk in flight and appends it once', async () => {
		const A = id();
		const uploads = createUploads(await testDb(), options);
		await uploads.append(chunk(A, 0, 'abc'));

		const results = await Promise.allSettled([
			uploads.append(chunk(A, 3, 'def')),
			uploads.append(chunk(A, 3, 'def'))
		]);

		expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected']);
		expect(readFileSync(spool(A), 'utf8')).toBe('abcdef');
		await expect(uploads.append(chunk(A, 6, 'g'))).resolves.toBeNull();
	});

	it('lets a new upload replace one abandoned for ten minutes', async () => {
		const [A, B] = [id(), id()];
		let now = 0;
		const uploads = createUploads(await testDb(), options, () => now);
		await uploads.append(chunk(A, 0, 'abc'));
		now = 11 * 60 * 1000;

		await expect(uploads.append(chunk(B, 0, 'xyz'))).resolves.toBeNull();
		expect(existsSync(spool(A))).toBe(false);
	});

	it('refuses out-of-order chunks, bad ids, and more than the cap', async () => {
		const [A, B] = [id(), id()];
		const uploads = createUploads(await testDb(), options);
		await expect(uploads.append(chunk('nope', 0, 'x'))).rejects.toMatchObject({ status: 400 });
		await expect(uploads.append(chunk(A, 5, 'x'))).rejects.toMatchObject({ status: 409 });
		await uploads.append(chunk(A, 0, 'abc'));
		await expect(uploads.append(chunk(A, 0, 'abc'))).rejects.toBeInstanceOf(UploadError);

		const big = createUploads(await testDb(), options);
		await expect(big.append(chunk(B, 0, 'z'.repeat(1001)))).rejects.toMatchObject({ status: 413 });
		expect(readdirSync(tmpdir()).filter((n) => n.includes(B))).toEqual([]);
	});
});

describe('gate with encoded paths', () => {
	const signedOut = { setupDone: true, signedIn: false };

	it('never passes an encoded spelling of a protected path', () => {
		for (const path of [
			'/%61dmin/export',
			'/admin%2Fexport',
			'/admin/%69mport',
			'/%6Cogin/../admin'
		]) {
			expect(gate(path, signedOut), path).toBe('login');
		}
	});
});
