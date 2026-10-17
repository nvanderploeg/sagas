import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createClient } from './index.ts';
import { createStub, ok, tool, toolError } from './testing/stub.ts';

const stub = createStub('secret');
const clients: ReturnType<typeof createClient>[] = [];

function connect(options: { token?: string; timeoutMs?: number; url?: string } = {}) {
	const client = createClient({
		url: options.url ?? stub.url,
		token: options.token ?? 'secret',
		timeoutMs: options.timeoutMs
	});
	clients.push(client);
	return client;
}

beforeEach(async () => {
	stub.tools = [tool('list_realms'), tool('survey', 'Pick the next Labour.')];
	stub.handlers.clear();
	stub.calls.length = 0;
	stub.headers.length = 0;
	stub.delayMs = 0;
	stub.forceStatus = 0;
	stub.instructions = undefined;
	stub.drop.clear();
	await stub.start();
});

afterEach(async () => {
	await Promise.all(clients.splice(0).map((client) => client.close()));
	await stub.stop();
});

describe('listTools', () => {
	it('returns the server tools unchanged', async () => {
		stub.tools = [
			{
				name: 'survey',
				description: 'Pick.',
				inputSchema: {
					type: 'object',
					properties: { weights: { type: 'object', additionalProperties: { type: 'number' } } },
					required: ['weights'],
					additionalProperties: false
				},
				annotations: { readOnlyHint: true }
			}
		];
		const result = await connect().listTools();
		expect(result).toEqual({ ok: true, value: stub.tools });
	});

	it('sends the token as a Bearer header and no Origin', async () => {
		await connect().listTools();
		expect(stub.headers.length).toBeGreaterThan(0);
		for (const headers of stub.headers) {
			expect(headers.authorization).toBe('Bearer secret');
			expect(headers.origin).toBeUndefined();
		}
	});

	it('keeps working when the server answers GET with 405', async () => {
		const client = connect();
		expect((await client.listTools()).ok).toBe(true);
		expect((await client.listTools()).ok).toBe(true);
	});
});

describe('instructions', () => {
	it('returns what the server sent when it connected', async () => {
		stub.instructions = 'sagas is a labour tracker.';
		expect(await connect().instructions()).toEqual({
			ok: true,
			value: 'sagas is a labour tracker.'
		});
	});

	it('is undefined when the server sends none', async () => {
		expect(await connect().instructions()).toEqual({ ok: true, value: undefined });
	});
});

describe('callTool', () => {
	it('returns the server result unchanged', async () => {
		stub.handlers.set('list_realms', () => ok({ realms: [] }));
		const result = await connect().callTool('list_realms', {});
		expect(result).toEqual({ ok: true, value: ok({ realms: [] }) });
	});

	it('passes arguments to the tool', async () => {
		stub.handlers.set('survey', () => ok({}));
		await connect().callTool('survey', { weights: { age: 1 } });
		expect(stub.callsTo('survey')).toEqual([{ name: 'survey', args: { weights: { age: 1 } } }]);
	});

	it('passes an isError result through as a value', async () => {
		stub.handlers.set('survey', () => toolError('invalid', 'weights: required'));
		const result = await connect().callTool('survey', {});
		expect(result).toEqual({ ok: true, value: toolError('invalid', 'weights: required') });
	});

	it('returns an unknown tool as the server answers it', async () => {
		const result = await connect().callTool('nope', {});
		expect(result.ok && result.value.isError).toBe(true);
	});
});

describe('failures', () => {
	it('refuses a wrong token with one line', async () => {
		const client = connect({ token: 'wrong' });
		expect(await client.listTools()).toEqual({ ok: false, warning: 'sagas refused the token' });
		expect(await client.callTool('survey', {})).toEqual({
			ok: false,
			warning: 'sagas refused the token'
		});
	});

	it('refuses an empty token', async () => {
		const result = await connect({ token: '' }).listTools();
		expect(result).toEqual({ ok: false, warning: 'sagas refused the token' });
	});

	it('reports a refused connection as unreachable', async () => {
		const closed = createServer().listen(0, '127.0.0.1');
		await new Promise((resolve) => closed.once('listening', resolve));
		const url = `http://127.0.0.1:${(closed.address() as AddressInfo).port}`;
		await new Promise((resolve) => closed.close(resolve));

		const client = connect({ url });
		const listed = await client.listTools();
		const called = await client.callTool('survey', {});
		for (const result of [listed, called]) {
			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.warning).toMatch(/^sagas unreachable: /);
				expect(result.warning).not.toContain('\n');
			}
		}
	});

	it('reports a server error as unreachable', async () => {
		stub.forceStatus = 503;
		const result = await connect().listTools();
		expect(result).toEqual({ ok: false, warning: 'sagas unreachable: HTTP 503' });
	});

	it('gives up on a slow server after timeoutMs', async () => {
		stub.delayMs = 1000;
		const started = Date.now();
		const result = await connect({ timeoutMs: 150 }).callTool('survey', {});
		expect(Date.now() - started).toBeLessThan(900);
		expect(result).toEqual({ ok: false, warning: 'sagas unreachable: timed out after 150 ms' });
	});

	it('reports a bad url as a warning, not a throw', async () => {
		const result = await connect({ url: 'not a url' }).listTools();
		expect(result.ok).toBe(false);
	});

	it('says HTTP 500 for a 500', async () => {
		stub.forceStatus = 500;
		const result = await connect().listTools();
		expect(result).toEqual({ ok: false, warning: 'sagas unreachable: HTTP 500' });
	});

	it('names an answer it cannot read without a made-up status', async () => {
		for (const [type, body] of [
			['text/html', '<html>'],
			['application/json', '{nope'],
			['application/json', '{"a":1}']
		]) {
			const garbage = createServer((_, res) =>
				res.writeHead(200, { 'content-type': type }).end(body)
			);
			garbage.listen(0, '127.0.0.1');
			await new Promise((resolve) => garbage.once('listening', resolve));
			const url = `http://127.0.0.1:${(garbage.address() as AddressInfo).port}`;
			const result = await connect({ url }).listTools();
			garbage.closeAllConnections();
			await new Promise((resolve) => garbage.close(resolve));
			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.warning).toMatch(/^sagas failed: /);
				expect(result.warning).not.toContain('HTTP -1');
			}
		}
	});

	it('answers a closed client with a warning', async () => {
		const client = connect();
		await client.close();
		expect(await client.listTools()).toEqual({ ok: false, warning: 'sagas client is closed' });
	});

	it('reconnects after the server returns', async () => {
		const client = connect();
		expect((await client.listTools()).ok).toBe(true);
		await stub.stop();
		expect((await client.listTools()).ok).toBe(false);
		await stub.start(true);
		expect((await client.listTools()).ok).toBe(true);
	});
});

describe('requests that may have reached the server', () => {
	it('reports a call whose socket drops after the server ran it, and never repeats it', async () => {
		let runs = 0;
		stub.handlers.set('create_thing', () => {
			runs++;
			return ok({ id: runs });
		});
		const client = connect();
		expect((await client.listTools()).ok).toBe(true);
		stub.drop.add('create_thing');

		const result = await client.callTool('create_thing', {});
		expect(result.ok).toBe(false);
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(runs).toBe(1);

		expect(await client.callTool('create_thing', {})).toEqual({ ok: true, value: ok({ id: 2 }) });
		expect(runs).toBe(2);
	});

	it('repeats a handshake whose socket drops', async () => {
		stub.drop.add('initialize');
		const result = await connect().callTool('survey', {});
		expect(result.ok).toBe(true);
		expect(stub.callsTo('survey')).toHaveLength(1);
	});

	it('leaves a request in flight alone when another on the same client fails', async () => {
		let release!: () => void;
		const released = new Promise<void>((resolve) => (release = resolve));
		stub.handlers.set('stuck', () => new Promise(() => {}));
		stub.handlers.set('slow', async () => {
			await released;
			return ok({ done: true });
		});
		const client = connect({ timeoutMs: 400 });
		expect((await client.listTools()).ok).toBe(true);

		const stuck = client.callTool('stuck', {});
		await new Promise((resolve) => setTimeout(resolve, 200));
		const slow = client.callTool('slow', {});
		expect(await stuck).toEqual({
			ok: false,
			warning: 'sagas unreachable: timed out after 400 ms'
		});
		release();
		expect(await slow).toEqual({ ok: true, value: ok({ done: true }) });
		expect((await client.callTool('survey', {})).ok).toBe(true);
	});
});
