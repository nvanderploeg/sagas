import { describe, expect, it } from 'vitest';
import { protocolSource } from './protocol.js';

const request = (headers = {}) => ({ headers: { ...headers } });

describe('protocolSource', () => {
	it('treats a request without the forwarded header as plain http', () => {
		const source = protocolSource('X-Forwarded-Proto');
		const req = request({ host: '192.168.1.20:3290' });

		source.apply(req);

		expect(source.header).toBe('x-forwarded-proto');
		expect(req.headers['x-forwarded-proto']).toBe('http');
	});

	it('keeps the protocol a reverse proxy forwards', () => {
		const source = protocolSource('x-forwarded-proto');
		const req = request({ 'x-forwarded-proto': 'https' });

		source.apply(req);

		expect(req.headers['x-forwarded-proto']).toBe('https');
	});

	it('ignores client-sent protocol headers when no forwarded header is configured', () => {
		for (const configured of [undefined, '', '  ']) {
			const source = protocolSource(configured);
			const req = request({ 'x-forwarded-proto': 'https', [source.header]: 'https' });

			source.apply(req);

			expect(source.header).not.toBe('x-forwarded-proto');
			expect(req.headers[source.header]).toBe('http');
		}
	});
});
