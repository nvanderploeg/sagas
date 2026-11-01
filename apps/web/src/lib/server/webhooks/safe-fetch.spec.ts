import { readFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import tls from 'node:tls';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkTargetUrl, isPublicAddress, safeFetch, type Connect } from './safe-fetch.ts';

describe('checkTargetUrl', () => {
	it('accepts https', () => {
		expect(checkTargetUrl('https://example.com/hook', false).ok).toBe(true);
	});
	it('refuses http unless private is allowed', () => {
		expect(checkTargetUrl('http://example.com/', false).ok).toBe(false);
		expect(checkTargetUrl('http://example.com/', true).ok).toBe(true);
	});
	it('refuses other schemes, junk and credentials', () => {
		expect(checkTargetUrl('ftp://example.com/', true).ok).toBe(false);
		expect(checkTargetUrl('not a url', true).ok).toBe(false);
		expect(checkTargetUrl('https://user@example.com/', false).ok).toBe(false);
		expect(checkTargetUrl('https://user:pw@example.com/', true).ok).toBe(false);
	});
});

describe('isPublicAddress', () => {
	it.each([
		'127.0.0.1',
		'127.255.255.254',
		'10.1.2.3',
		'172.16.0.1',
		'172.31.255.255',
		'192.168.1.1',
		'169.254.169.254',
		'100.64.0.1',
		'100.127.255.255',
		'224.0.0.1',
		'239.255.255.255',
		'0.0.0.0',
		'0.1.2.3',
		'255.255.255.255',
		'::1',
		'::',
		'fc00::1',
		'fd12:3456::1',
		'fe80::1',
		'febf::1',
		'ff02::1',
		'::ffff:127.0.0.1',
		'::ffff:10.0.0.1',
		'::ffff:192.168.0.1',
		'::ffff:169.254.169.254',
		'::ffff:100.64.0.1',
		'::ffff:7f00:1',
		'::ffff:a00:1',
		'::ffff:0.0.0.0',
		'::ffff:224.0.0.1',
		'192.0.0.192',
		'192.0.0.1',
		'198.18.0.1',
		'198.19.255.255',
		'64:ff9b::7f00:1',
		'64:ff9b::a9fe:a9fe',
		'64:ff9b::127.0.0.1',
		'64:ff9b::a00:1',
		'64:ff9b:1::808:808',
		'64:ff9b:0:0:1::808:808',
		'2002:7f00:1::',
		'2002:a9fe:a9fe::',
		'2002:c0a8:101::1',
		'::127.0.0.1',
		'::7f00:1',
		'::8.8.8.8',
		'::ffff:0:a9fe:a9fe',
		'::ffff:0:7f00:1',
		'::ffff:0:127.0.0.1',
		'fec0::1',
		'feff::1',
		'100::',
		'100::1',
		'100::ffff:ffff:ffff:ffff',
		'2001:0:4136:e378:8000:63bf:3fff:fdd2',
		'not an address'
	])('refuses %s', (address) => {
		expect(isPublicAddress(address)).toBe(false);
	});

	it.each([
		'93.184.216.34',
		'8.8.8.8',
		'172.15.0.1',
		'172.32.0.1',
		'100.63.255.255',
		'100.128.0.1',
		'2606:2800:220:1:248:1893:25c8:1946',
		'2001:4860:4860::8888',
		'::ffff:8.8.8.8',
		'::ffff:808:808',
		'192.0.1.1',
		'198.17.255.255',
		'198.20.0.1',
		'64:ff9b::808:808',
		'64:ff9b::8.8.8.8',
		'2002:808:808::1',
		'2001:4860:4860::8844',
		'100:0:0:1::1'
	])('accepts %s', (address) => {
		expect(isPublicAddress(address)).toBe(true);
	});
});

describe('safeFetch', () => {
	let server: http.Server;
	let port: number;
	let handler: http.RequestListener;
	let sockets: Set<net.Socket>;

	beforeEach(async () => {
		sockets = new Set();
		handler = (_req, res) => res.end('ok');
		server = http.createServer((req, res) => handler(req, res));
		server.on('connection', (s) => {
			sockets.add(s);
			s.on('close', () => sockets.delete(s));
		});
		await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
		port = (server.address() as AddressInfo).port;
	});

	afterEach(async () => {
		for (const s of sockets) s.destroy();
		await new Promise((r) => server.close(r));
	});

	// Records the vetted address, then reaches the local server instead.
	function connector() {
		const targets: Parameters<Connect>[0][] = [];
		const connect: Connect = (t) => {
			targets.push(t);
			return net.connect({ host: '127.0.0.1', port });
		};
		return { connect, targets };
	}

	const input = (url = 'https://hooks.example.com:8443/in?x=1') => ({
		url,
		headers: { 'content-type': 'application/json' },
		body: '{"a":1}'
	});

	it('posts to the vetted address and keeps the Host name', async () => {
		const seen: { method?: string; host?: string; url?: string; body: string } = { body: '' };
		handler = (req, res) => {
			seen.method = req.method;
			seen.host = req.headers.host;
			seen.url = req.url;
			req.on('data', (c) => (seen.body += c));
			req.on('end', () => res.end('hello'));
		};
		const { connect, targets } = connector();
		const resolve = vi.fn(async () => ['93.184.216.34']);
		const result = await safeFetch(input(), { allowPrivate: false, resolve, connect });
		expect(result).toMatchObject({ ok: true, status: 200, body: 'hello' });
		expect(resolve).toHaveBeenCalledTimes(1);
		expect(targets).toEqual([
			{ address: '93.184.216.34', port: 8443, secure: true, servername: 'hooks.example.com' }
		]);
		expect(seen).toEqual({
			method: 'POST',
			host: 'hooks.example.com:8443',
			url: '/in?x=1',
			body: '{"a":1}'
		});
	});

	it('keeps framing and hop-by-hop headers its own, whatever the caller passes', async () => {
		let seen: http.IncomingHttpHeaders = {};
		let body = '';
		handler = (req, res) => {
			seen = req.headers;
			req.on('data', (c) => (body += c));
			req.on('end', () => res.end('ok'));
		};
		const { connect } = connector();
		const result = await safeFetch(
			{
				url: 'https://hooks.example.com/in',
				headers: {
					Host: 'internal.example',
					'Content-Length': '1',
					'TRANSFER-ENCODING': 'chunked',
					Connection: 'keep-alive, x-smuggle',
					'Keep-Alive': 'timeout=600',
					Upgrade: 'websocket',
					TE: 'trailers',
					Trailer: 'x-late',
					Expect: '100-continue',
					'Proxy-Connection': 'keep-alive',
					'X-Signature': 'sig'
				},
				body: '{"a":1}'
			},
			{ allowPrivate: false, resolve: async () => ['93.184.216.34'], connect }
		);
		expect(result).toMatchObject({ ok: true, status: 200 });
		expect(body).toBe('{"a":1}');
		expect(seen.host).toBe('hooks.example.com');
		expect(seen['content-length']).toBe('7');
		expect(seen['x-signature']).toBe('sig');
		expect(seen.connection).toBe('close');
		for (const name of [
			'transfer-encoding',
			'keep-alive',
			'upgrade',
			'te',
			'trailer',
			'expect',
			'proxy-connection'
		]) {
			expect(seen[name]).toBeUndefined();
		}
	});

	it('measures duration with the injected clock', async () => {
		const ticks = [1000, 1250];
		const { connect } = connector();
		const result = await safeFetch(
			input(),
			{ allowPrivate: false, resolve: async () => ['93.184.216.34'], connect },
			() => ticks.shift() ?? 9999
		);
		expect(result.durationMs).toBe(250);
	});

	it.each([
		['loopback', '127.0.0.1'],
		['private', '10.0.0.5'],
		['link-local', '169.254.169.254'],
		['cgnat', '100.64.0.1'],
		['unique-local', 'fd00::1'],
		['mapped', '::ffff:127.0.0.1'],
		['nat64 metadata', '64:ff9b::a9fe:a9fe'],
		['6to4 loopback', '2002:7f00:1::'],
		['ipv4-compatible', '::127.0.0.1'],
		['unspecified', '0.0.0.0'],
		['multicast', 'ff02::1']
	])('refuses a name resolving to %s', async (_n, address) => {
		const { connect, targets } = connector();
		const result = await safeFetch(input(), {
			allowPrivate: false,
			resolve: async () => [address],
			connect
		});
		expect(result.ok).toBe(false);
		expect(targets).toEqual([]);
	});

	it('refuses a mix of public and private addresses', async () => {
		const { connect, targets } = connector();
		const result = await safeFetch(input(), {
			allowPrivate: false,
			resolve: async () => ['93.184.216.34', '10.0.0.1'],
			connect
		});
		expect(result).toMatchObject({ ok: false, status: null });
		expect(targets).toEqual([]);
	});

	it('checks literal-IP hosts without resolving', async () => {
		const { connect, targets } = connector();
		const resolve = vi.fn(async () => ['93.184.216.34']);
		for (const url of ['https://127.0.0.1/', 'https://[::1]/', 'https://[::ffff:10.0.0.1]/']) {
			const result = await safeFetch(input(url), { allowPrivate: false, resolve, connect });
			expect(result.ok).toBe(false);
		}
		expect(resolve).not.toHaveBeenCalled();
		expect(targets).toEqual([]);
	});

	it('allows a literal public IP and connects to it', async () => {
		const { connect, targets } = connector();
		const result = await safeFetch(input('https://93.184.216.34/'), {
			allowPrivate: false,
			connect
		});
		expect(result.ok).toBe(true);
		expect(targets[0].address).toBe('93.184.216.34');
	});

	it('refuses a rejected URL before resolving', async () => {
		const resolve = vi.fn(async () => ['93.184.216.34']);
		const result = await safeFetch(input('http://example.com/'), { allowPrivate: false, resolve });
		expect(result.ok).toBe(false);
		expect(resolve).not.toHaveBeenCalled();
	});

	it('reports a resolver failure', async () => {
		const result = await safeFetch(input(), {
			allowPrivate: false,
			resolve: async () => {
				throw new Error('ENOTFOUND');
			}
		});
		expect(result).toMatchObject({ ok: false, status: null });
	});

	it('connects to the vetted address once, never a second lookup (rebinding)', async () => {
		let calls = 0;
		const resolve = vi.fn(async () => (calls++ === 0 ? ['93.184.216.34'] : ['127.0.0.1']));
		const { connect, targets } = connector();
		const result = await safeFetch(input(), { allowPrivate: false, resolve, connect });
		expect(result.ok).toBe(true);
		expect(resolve).toHaveBeenCalledTimes(1);
		expect(targets.map((t) => t.address)).toEqual(['93.184.216.34']);
	});

	it('allowPrivate lifts the address and https rules', async () => {
		const result = await safeFetch(input(`http://127.0.0.1:${port}/`), {
			allowPrivate: true,
			connect: undefined
		});
		expect(result).toMatchObject({ ok: true, status: 200, body: 'ok' });
	});

	it.each([301, 302, 307, 308])('never follows a %i redirect', async (code) => {
		let hits = 0;
		handler = (req, res) => {
			hits++;
			res.writeHead(code, { location: `http://127.0.0.1:${port}/elsewhere` });
			res.end();
		};
		const result = await safeFetch(input(`http://127.0.0.1:${port}/`), { allowPrivate: true });
		expect(result).toMatchObject({ ok: false, status: code });
		expect(hits).toBe(1);
	});

	it('fails a non-2xx with its status and body', async () => {
		handler = (_req, res) => {
			res.writeHead(500);
			res.end('boom');
		};
		const result = await safeFetch(input(`http://127.0.0.1:${port}/`), { allowPrivate: true });
		expect(result).toMatchObject({ ok: false, status: 500, body: 'boom' });
	});

	it('times out when the receiver never answers', async () => {
		handler = () => {};
		const result = await safeFetch(input(`http://127.0.0.1:${port}/`), {
			allowPrivate: true,
			timeoutMs: 50
		});
		expect(result).toMatchObject({ ok: false, status: null, error: 'timed out' });
	});

	it('times out a response that stalls mid-body', async () => {
		handler = (_req, res) => {
			res.writeHead(200);
			res.write('partial');
		};
		const result = await safeFetch(input(`http://127.0.0.1:${port}/`), {
			allowPrivate: true,
			timeoutMs: 100
		});
		expect(result).toMatchObject({ ok: false, error: 'timed out' });
	});

	it('times out a stalled resolver', async () => {
		const result = await safeFetch(input(), {
			allowPrivate: false,
			resolve: () => new Promise(() => {}),
			timeoutMs: 50
		});
		expect(result).toMatchObject({ ok: false, error: 'timed out' });
	});

	it('honours the caller signal', async () => {
		handler = () => {};
		const ac = new AbortController();
		const p = safeFetch(input(`http://127.0.0.1:${port}/`), {
			allowPrivate: true,
			signal: ac.signal
		});
		setTimeout(() => ac.abort(), 30);
		expect(await p).toMatchObject({ ok: false, error: 'aborted' });
	});

	it('stops reading at maxBodyBytes and keeps only keepBytes', async () => {
		let written = 0;
		let closed = false;
		handler = (req, res) => {
			res.writeHead(200);
			req.socket.on('close', () => (closed = true));
			const chunk = 'x'.repeat(1024);
			const pump = () => {
				if (closed || res.destroyed) return;
				written += chunk.length;
				res.write(chunk);
				setTimeout(pump, 1);
			};
			pump();
		};
		const result = await safeFetch(input(`http://127.0.0.1:${port}/`), {
			allowPrivate: true,
			maxBodyBytes: 4096,
			keepBytes: 100,
			timeoutMs: 2000
		});
		expect(result.ok).toBe(true);
		expect(result.body).toBe('x'.repeat(100));
		await new Promise((r) => setTimeout(r, 50));
		expect(closed).toBe(true);
		expect(written).toBeLessThan(64 * 1024);
	});

	it('keeps the first 512 bytes by default, decoded as utf-8', async () => {
		handler = (_req, res) => res.end('é'.repeat(1000));
		const result = await safeFetch(input(`http://127.0.0.1:${port}/`), { allowPrivate: true });
		expect(result.body).toBe('é'.repeat(256));
	});
});

describe('safeFetch default connector', () => {
	// Self-signed for DNS:hook.test only, valid to 2126.
	const key = readFileSync(new URL('./fixtures/hook-test.key.pem', import.meta.url));
	const cert = readFileSync(new URL('./fixtures/hook-test.cert.pem', import.meta.url));
	let server: https.Server;
	let port: number;
	let realConnect: typeof tls.connect;

	beforeAll(async () => {
		server = https.createServer({ key, cert }, (_req, res) => res.end('secure'));
		await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
		port = (server.address() as AddressInfo).port;
		realConnect = tls.connect;
	});

	afterAll(async () => {
		server.closeAllConnections();
		await new Promise((r) => server.close(r));
	});

	afterEach(() => vi.restoreAllMocks());

	// Adds only the trust anchor; host, servername and verification stay the connector's own.
	function trustFixture() {
		const spy = vi
			.spyOn(tls, 'connect')
			.mockImplementation(((options: tls.ConnectionOptions) =>
				realConnect({ ...options, ca: cert })) as typeof tls.connect);
		return spy;
	}

	const fetchAt = (url: string) =>
		safeFetch(
			{ url, headers: {}, body: '' },
			{ allowPrivate: true, resolve: async () => ['127.0.0.1'], timeoutMs: 2000 }
		);

	it('connects over TLS to the vetted address and verifies the certificate for the URL host', async () => {
		const spy = trustFixture();
		const result = await fetchAt(`https://hook.test:${port}/`);
		expect(result).toMatchObject({ ok: true, status: 200, body: 'secure' });
		expect(spy).toHaveBeenCalledWith(
			expect.objectContaining({ host: '127.0.0.1', port, servername: 'hook.test' })
		);
	});

	it('fails when the certificate does not name the URL host', async () => {
		trustFixture();
		const result = await fetchAt(`https://other.test:${port}/`);
		expect(result).toMatchObject({
			ok: false,
			status: null,
			error: expect.stringMatching(/altnames|does not match/i)
		});
	});

	it('fails for a literal-IP URL the certificate does not name', async () => {
		trustFixture();
		const result = await fetchAt(`https://127.0.0.1:${port}/`);
		expect(result).toMatchObject({
			ok: false,
			status: null,
			error: expect.stringMatching(/altnames|not in the cert/i)
		});
	});

	it('fails when the certificate is not trusted', async () => {
		const result = await fetchAt(`https://hook.test:${port}/`);
		expect(result).toMatchObject({
			ok: false,
			status: null,
			error: expect.stringMatching(/self[- ]signed/i)
		});
	});
});
