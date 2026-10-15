import { describe, expect, it } from 'vitest';
import { readMessage, refuseForeignOrigin } from './http.ts';

const ORIGIN = 'http://localhost:3290';

function post(body: BodyInit | null, headers: Record<string, string> = {}): Request {
	return new Request(`${ORIGIN}/mcp`, {
		method: 'POST',
		body,
		headers,
		duplex: 'half'
	} as RequestInit);
}

const ping = { jsonrpc: '2.0', id: 1, method: 'ping' };

describe('refuseForeignOrigin', () => {
	it('lets a request with no Origin, or this server Origin, through', () => {
		expect(refuseForeignOrigin(post(null), ORIGIN)).toBeNull();
		expect(refuseForeignOrigin(post(null, { origin: ORIGIN }), ORIGIN)).toBeNull();
	});

	it('refuses any other Origin with 403', async () => {
		const refused = refuseForeignOrigin(post(null, { origin: 'http://evil.example' }), ORIGIN);

		expect(refused?.status).toBe(403);
		expect(await refused?.json()).toMatchObject({
			jsonrpc: '2.0',
			id: null,
			error: { message: expect.stringContaining('http://evil.example') }
		});
	});
});

describe('readMessage', () => {
	it('returns one parsed JSON-RPC message', async () => {
		expect(await readMessage(post(JSON.stringify(ping)))).toEqual({ message: ping });
	});

	it('refuses a batch, so one request is one message', async () => {
		const refused = (await readMessage(post(JSON.stringify([ping, ping])))) as Response;

		expect(refused.status).toBe(400);
		expect(await refused.json()).toMatchObject({
			error: { code: -32600, message: expect.stringContaining('batches are not supported') }
		});
	});

	it('answers a body over the size limit with 413, never a parse error', async () => {
		const tooLarge = Object.assign(new Error('Payload Too Large'), { status: 413 });
		const body = new ReadableStream({ start: (controller) => controller.error(tooLarge) });

		const refused = (await readMessage(post(body))) as Response;

		expect(refused.status).toBe(413);
		expect(await refused.json()).toMatchObject({
			error: { code: -32600, message: expect.stringContaining('too large') }
		});
	});

	it('answers a body that is not JSON with a parse error', async () => {
		const refused = (await readMessage(post('{'))) as Response;

		expect(refused.status).toBe(400);
		expect(await refused.json()).toMatchObject({ error: { code: -32700 } });
	});
});
