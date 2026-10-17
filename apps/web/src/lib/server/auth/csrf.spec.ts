import { describe, expect, it } from 'vitest';
import { crossSiteFormRefusal } from './csrf.ts';

const SELF = 'https://sagas.example';
const FORM = 'application/x-www-form-urlencoded';

function req(method: string, headers: Record<string, string> = {}, path = '/anything'): Request {
	return new Request(`${SELF}${path}`, { method, headers });
}

const refusal = (request: Request, path = '/anything') => crossSiteFormRefusal(request, SELF, path);

describe('crossSiteFormRefusal', () => {
	it('passes a same-origin form POST', () => {
		expect(refusal(req('POST', { 'content-type': FORM, origin: SELF }))).toBeNull();
	});

	it('refuses a form POST with no Origin', async () => {
		const response = refusal(req('POST', { 'content-type': FORM }))!;
		expect(response.status).toBe(403);
		expect(await response.text()).toBe('Cross-site POST form submissions are forbidden');
	});

	it('refuses a foreign Origin', () => {
		expect(
			refusal(req('POST', { 'content-type': FORM, origin: 'https://evil.example' }))?.status
		).toBe(403);
	});

	it('refuses every mutating method and passes safe ones', () => {
		for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
			expect(refusal(req(method, { 'content-type': FORM }))?.status).toBe(403);
		}
		expect(refusal(req('GET'))).toBeNull();
		expect(refusal(req('HEAD'))).toBeNull();
	});

	it('refuses a request with no content type', async () => {
		const response = refusal(req('DELETE'))!;
		expect(response.status).toBe(403);
		expect(await response.text()).toBe('Cross-site DELETE form submissions are forbidden');
	});

	it('refuses multipart and text/plain, with parameters and any case', () => {
		for (const type of [
			'multipart/form-data; boundary=x',
			'text/plain',
			'Application/X-WWW-Form-Urlencoded; charset=utf-8'
		]) {
			expect(refusal(req('POST', { 'content-type': type }))?.status).toBe(403);
		}
	});

	it("refuses Kit's own form encoding and an empty content type", () => {
		for (const type of ['application/x-sveltekit-formdata', '']) {
			expect(refusal(req('POST', { 'content-type': type }))?.status).toBe(403);
		}
	});

	it('passes a JSON content type without Origin', () => {
		expect(refusal(req('POST', { 'content-type': 'application/json' }))).toBeNull();
	});

	it('answers JSON when accept is exactly application/json', async () => {
		const response = refusal(req('POST', { 'content-type': FORM, accept: 'application/json' }))!;
		expect(response.status).toBe(403);
		expect(await response.json()).toEqual({
			message: 'Cross-site POST form submissions are forbidden'
		});
	});

	it('exempts the token and register endpoints', () => {
		for (const path of ['/oauth/token', '/oauth/register']) {
			expect(refusal(req('POST', { 'content-type': FORM }, path), path)).toBeNull();
			expect(refusal(req('POST', {}, path), path)).toBeNull();
		}
	});

	it('still refuses /oauth/authorize without Origin', () => {
		const path = '/oauth/authorize';
		expect(refusal(req('POST', { 'content-type': FORM }, path), path)?.status).toBe(403);
	});
});
