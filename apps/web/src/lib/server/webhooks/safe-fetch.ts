import { promises as dns } from 'node:dns';
import http from 'node:http';
import net from 'node:net';
import tls from 'node:tls';

export type Resolve = (host: string) => Promise<string[]>;
export type Connect = (target: {
	address: string;
	port: number;
	secure: boolean;
	servername: string;
}) => net.Socket;
export type SafeFetchOptions = {
	allowPrivate: boolean;
	resolve?: Resolve;
	connect?: Connect;
	timeoutMs?: number;
	maxBodyBytes?: number;
	keepBytes?: number;
	signal?: AbortSignal;
};
export type SafeFetchInput = { url: string; headers: Record<string, string>; body: string };
export type SafeFetchResult =
	| { ok: true; status: number; durationMs: number; body: string }
	| { ok: false; status: number | null; durationMs: number; body: string; error: string };

const defaultResolve: Resolve = async (host) =>
	(await dns.lookup(host, { all: true })).map((a) => a.address);

const defaultConnect: Connect = ({ address, port, secure, servername }) =>
	secure
		? tls.connect({
				host: address,
				port,
				servername: net.isIP(servername) ? undefined : servername
			})
		: net.connect({ host: address, port });

export function checkTargetUrl(
	url: string,
	allowPrivate: boolean
): { ok: true; url: URL } | { ok: false; error: string } {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return { ok: false, error: 'url is not valid' };
	}
	if (parsed.protocol !== 'https:' && !(allowPrivate && parsed.protocol === 'http:')) {
		return { ok: false, error: 'url must use https' };
	}
	if (parsed.username || parsed.password) {
		return { ok: false, error: 'url must not contain a user or password' };
	}
	return { ok: true, url: parsed };
}

function parseIPv4(address: string): number[] | null {
	const parts = address.split('.');
	if (parts.length !== 4) return null;
	const octets = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : NaN));
	return octets.every((o) => o >= 0 && o <= 255) ? octets : null;
}

function parseIPv6(address: string): number[] | null {
	let text = address.split('%')[0].toLowerCase();
	const lastColon = text.lastIndexOf(':');
	const tail = text.slice(lastColon + 1);
	if (tail.includes('.')) {
		const v4 = parseIPv4(tail);
		if (!v4) return null;
		text = `${text.slice(0, lastColon + 1)}${((v4[0] << 8) | v4[1]).toString(16)}:${((v4[2] << 8) | v4[3]).toString(16)}`;
	}
	const halves = text.split('::');
	if (halves.length > 2) return null;
	const head = halves[0] ? halves[0].split(':') : [];
	const rest = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
	const fill = 8 - head.length - rest.length;
	if (halves.length === 2 ? fill < 1 : fill !== 0) return null;
	const groups = [...head, ...Array<string>(halves.length === 2 ? fill : 0).fill('0'), ...rest];
	const nums = groups.map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN));
	return nums.length === 8 && nums.every((n) => !Number.isNaN(n)) ? nums : null;
}

function isPublicIPv4([a, b, c]: number[]): boolean {
	if (a === 0 || a === 10 || a === 127) return false;
	if (a === 100 && b >= 64 && b <= 127) return false;
	if (a === 169 && b === 254) return false;
	if (a === 172 && b >= 16 && b <= 31) return false;
	if (a === 192 && b === 0 && c === 0) return false;
	if (a === 192 && b === 168) return false;
	if (a === 198 && (b === 18 || b === 19)) return false;
	if (a >= 224) return false;
	return true;
}

const ipv4Of = (hi: number, lo: number) => [hi >> 8, hi & 255, lo >> 8, lo & 255];
const zero = (groups: number[]) => groups.every((n) => n === 0);

// Unwrap or refuse every IPv6 form that carries an IPv4 address: one left public reaches private IPv4.
export function isPublicAddress(address: string): boolean {
	const family = net.isIP(address);
	if (family === 4) {
		const v4 = parseIPv4(address);
		return v4 !== null && isPublicIPv4(v4);
	}
	if (family !== 6) return false;
	const g = parseIPv6(address);
	if (!g) return false;
	if (zero(g.slice(0, 5)) && g[5] === 0xffff) return isPublicIPv4(ipv4Of(g[6], g[7]));
	if (zero(g.slice(0, 4)) && g[4] === 0xffff && g[5] === 0) return isPublicIPv4(ipv4Of(g[6], g[7]));
	if (zero(g.slice(0, 6))) return false;
	if (g[0] === 0x64 && g[1] === 0xff9b) {
		return zero(g.slice(2, 6)) && isPublicIPv4(ipv4Of(g[6], g[7]));
	}
	if (g[0] === 0x2002) return isPublicIPv4(ipv4Of(g[1], g[2]));
	if (g[0] === 0x2001 && g[1] === 0) return false;
	if (g[0] === 0x100 && zero(g.slice(1, 4))) return false;
	if ((g[0] & 0xfe00) === 0xfc00) return false;
	if ((g[0] & 0xffc0) === 0xfe80) return false;
	if ((g[0] & 0xffc0) === 0xfec0) return false;
	if ((g[0] & 0xff00) === 0xff00) return false;
	return true;
}

const reservedHeaders = new Set([
	'host',
	'content-length',
	'transfer-encoding',
	'connection',
	'keep-alive',
	'proxy-connection',
	'te',
	'trailer',
	'upgrade',
	'expect'
]);

const callerHeaders = (headers: Record<string, string>) =>
	Object.fromEntries(
		Object.entries(headers).filter(([name]) => !reservedHeaders.has(name.toLowerCase()))
	);

export async function safeFetch(
	input: SafeFetchInput,
	options: SafeFetchOptions,
	now: () => number = Date.now
): Promise<SafeFetchResult> {
	const start = now();
	const fail = (error: string, status: number | null = null, body = ''): SafeFetchResult => ({
		ok: false,
		status,
		durationMs: now() - start,
		body,
		error
	});
	const timeoutMs = options.timeoutMs ?? 10_000;
	const maxBodyBytes = options.maxBodyBytes ?? 64 * 1024;
	const keepBytes = options.keepBytes ?? 512;

	const checked = checkTargetUrl(input.url, options.allowPrivate);
	if (!checked.ok) return fail(checked.error);
	const url = checked.url;
	const host = url.hostname.replace(/^\[|\]$/g, '');
	const secure = url.protocol === 'https:';
	const port = url.port ? Number(url.port) : secure ? 443 : 80;

	const controller = new AbortController();
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		controller.abort();
	}, timeoutMs);
	const onAbort = () => controller.abort();
	options.signal?.addEventListener('abort', onAbort);
	if (options.signal?.aborted) controller.abort();

	const abortError = () => (timedOut ? 'timed out' : 'aborted');
	const aborted = new Promise<never>((_, reject) => {
		const rejectNow = () => reject(new Error(abortError()));
		if (controller.signal.aborted) rejectNow();
		else controller.signal.addEventListener('abort', rejectNow, { once: true });
	});
	aborted.catch(() => {});

	try {
		let addresses: string[];
		if (net.isIP(host)) addresses = [host];
		else {
			try {
				addresses = await Promise.race([(options.resolve ?? defaultResolve)(host), aborted]);
			} catch (e) {
				if (controller.signal.aborted) return fail(abortError());
				return fail(`could not resolve host: ${(e as Error).message}`);
			}
		}
		if (addresses.length === 0) return fail('host resolved to no addresses');
		if (!options.allowPrivate && !addresses.every(isPublicAddress)) {
			return fail('host resolves to a non-public address');
		}
		const address = addresses[0];
		const connect = options.connect ?? defaultConnect;

		return await new Promise<SafeFetchResult>((resolve, reject) => {
			const agent = new (class extends http.Agent {
				createConnection() {
					return connect({ address, port, secure, servername: host });
				}
			})();
			const req = http.request(
				{
					method: 'POST',
					host: address,
					port,
					path: url.pathname + url.search,
					agent,
					headers: {
						...callerHeaders(input.headers),
						host: url.host,
						'content-length': Buffer.byteLength(input.body)
					},
					signal: controller.signal
				},
				(res) => {
					const status = res.statusCode ?? 0;
					const kept: Buffer[] = [];
					let keptLen = 0;
					let total = 0;
					let done = false;
					const finish = () => {
						if (done) return;
						done = true;
						const body = Buffer.concat(kept).subarray(0, keepBytes).toString('utf8');
						const durationMs = now() - start;
						if (status >= 200 && status < 300) resolve({ ok: true, status, durationMs, body });
						else resolve({ ok: false, status, durationMs, body, error: `http ${status}` });
					};
					res.on('data', (chunk: Buffer) => {
						if (done) return;
						total += chunk.length;
						if (keptLen < keepBytes) {
							kept.push(chunk);
							keptLen += chunk.length;
						}
						if (total >= maxBodyBytes) {
							finish();
							res.destroy();
						}
					});
					res.on('end', finish);
					res.on('error', (e) => {
						if (!done) reject(e);
					});
					res.on('close', () => {
						if (!done) reject(new Error('connection closed before the response ended'));
					});
				}
			);
			req.on('error', reject);
			req.end(input.body);
		});
	} catch (e) {
		if (controller.signal.aborted) return fail(abortError());
		return fail((e as Error).message || 'network error');
	} finally {
		clearTimeout(timer);
		options.signal?.removeEventListener('abort', onAbort);
	}
}
