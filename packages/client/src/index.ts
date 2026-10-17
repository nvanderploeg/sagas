import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
	StreamableHTTPClientTransport,
	StreamableHTTPError
} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
	CallToolResultSchema,
	ErrorCode,
	ListToolsResultSchema,
	McpError,
	type CallToolResult,
	type Tool
} from '@modelcontextprotocol/sdk/types.js';

export { listCache, readCache, removeCache, writeCache } from './cache.ts';
export type { CacheEntry, Warn } from './cache.ts';
export type { CallToolResult, Tool };

export type Result<T> = { ok: true; value: T } | { ok: false; warning: string };

export type SagasClient = {
	instructions(): Promise<Result<string | undefined>>;
	listTools(): Promise<Result<Tool[]>>;
	callTool(name: string, args: Record<string, unknown>): Promise<Result<CallToolResult>>;
	close(): Promise<void>;
};

export type ClientOptions = { url: string; token: string; timeoutMs?: number };

export const REFUSED_WARNING = 'sagas refused the token';
export const CLOSED_WARNING = 'sagas client is closed';

const CONNECT_MS = 10_000;

const oneLine = (text: string) => text.split('\n')[0].trim().slice(0, 200);

const errorCode = (error: unknown): unknown => {
	const cause = error instanceof Error ? error.cause : undefined;
	return cause && typeof cause === 'object' && 'code' in cause ? cause.code : undefined;
};

// Retry only the connect handshake on these: a request may have reached the server.
const staleSocket = (error: unknown) =>
	errorCode(error) === 'UND_ERR_SOCKET' || errorCode(error) === 'ECONNRESET';

function warningFor(error: unknown): string {
	if (error instanceof McpError) {
		if (error.code === ErrorCode.RequestTimeout) {
			const data = error.data as { timeout?: unknown } | undefined;
			return `sagas unreachable: timed out after ${String(data?.timeout)} ms`;
		}
		if (error.code === ErrorCode.ConnectionClosed) return 'sagas unreachable: connection closed';
		return `sagas failed: ${oneLine(error.message)}`;
	}
	if (error instanceof StreamableHTTPError) {
		const status = error.code;
		if (status === 401 || status === 403) return REFUSED_WARNING;
		if (typeof status === 'number' && status >= 500) return `sagas unreachable: HTTP ${status}`;
		if (typeof status === 'number' && status >= 100) return `sagas failed: HTTP ${status}`;
		return `sagas failed: ${oneLine(error.message.replace(/^Streamable HTTP error: /, ''))}`;
	}
	if (error instanceof SyntaxError || (error instanceof Error && error.name === 'ZodError')) {
		return 'sagas failed: unreadable answer';
	}
	const code = errorCode(error);
	const cause = error instanceof Error ? error.cause : undefined;
	const reason = cause instanceof Error ? cause.message : '';
	const message = error instanceof Error ? error.message : String(error);
	return `sagas unreachable: ${oneLine(code ? String(code) : reason || message)}`;
}

// A retired session takes no new requests and closes once `busy` is 0.
type Session = { client: Promise<Client>; busy: number; retired: boolean };

export function createClient(options: ClientOptions): SagasClient {
	const timeoutMs = options.timeoutMs ?? 10_000;
	const connectMs = Math.min(timeoutMs, CONNECT_MS);
	const sessions = new Set<Session>();
	let current: Session | undefined;
	let closed = false;

	async function connectOnce(): Promise<Client> {
		const url = new URL(`${options.url.replace(/\/+$/, '')}/mcp`);
		const headers: Record<string, string> = options.token
			? { authorization: `Bearer ${options.token}` }
			: {};
		const transport = new StreamableHTTPClientTransport(url, { requestInit: { headers } });
		transport.onerror = () => {};
		const client = new Client({ name: 'sagas-client', version: '0.1.0' });
		client.onerror = () => {};
		try {
			await client.connect(transport, { timeout: connectMs });
			return client;
		} catch (error) {
			await client.close().catch(() => {});
			throw error;
		}
	}

	// Repeat only the handshake, never a request: a request's socket can drop after the server ran it.
	async function connect(): Promise<Client> {
		try {
			return await connectOnce();
		} catch (error) {
			if (closed || !staleSocket(error)) throw error;
			return connectOnce();
		}
	}

	function session(): Session {
		if (current) return current;
		const opened: Session = { client: connect(), busy: 0, retired: false };
		opened.client.catch(() => {});
		sessions.add(opened);
		current = opened;
		return opened;
	}

	async function shut(ended: Session): Promise<void> {
		sessions.delete(ended);
		await (await ended.client.catch(() => undefined))?.close().catch(() => {});
	}

	async function guard<T>(run: (client: Client) => Promise<T>): Promise<Result<T>> {
		if (closed) return { ok: false, warning: CLOSED_WARNING };
		const used = session();
		used.busy++;
		try {
			return { ok: true, value: await run(await used.client) };
		} catch (error) {
			used.retired = true;
			if (current === used) current = undefined;
			return { ok: false, warning: closed ? CLOSED_WARNING : warningFor(error) };
		} finally {
			used.busy--;
			if (used.retired && used.busy === 0 && sessions.has(used)) void shut(used);
		}
	}

	return {
		instructions: () => guard(async (client) => client.getInstructions()),
		listTools: () =>
			guard(async (client) => {
				const tools: Tool[] = [];
				let cursor: string | undefined;
				do {
					const page = await client.request(
						{ method: 'tools/list', params: cursor ? { cursor } : {} },
						ListToolsResultSchema,
						{ timeout: timeoutMs }
					);
					tools.push(...page.tools);
					cursor = page.nextCursor;
				} while (cursor);
				return tools;
			}),
		callTool: (name, args) =>
			guard((client) =>
				client.request(
					{ method: 'tools/call', params: { name, arguments: args } },
					CallToolResultSchema,
					{ timeout: timeoutMs }
				)
			),
		async close() {
			closed = true;
			current = undefined;
			await Promise.all([...sessions].map(shut));
		}
	};
}
