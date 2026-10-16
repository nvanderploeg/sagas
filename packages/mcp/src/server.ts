import { homedir } from 'node:os';
import { join } from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
	CallToolRequestSchema,
	ErrorCode,
	ListResourceTemplatesRequestSchema,
	ListResourcesRequestSchema,
	ListToolsRequestSchema,
	McpError,
	ReadResourceRequestSchema,
	type CallToolResult
} from '@modelcontextprotocol/sdk/types.js';
import { createClient, type Warn } from '@sagas/client';
import { createPoller, loadState, type Kind } from './poller.ts';
import { resourcesOf, servedTools, type State } from './view.ts';

export type HelperOptions = {
	url: string;
	token: string;
	pollMs?: number;
	sentimentMs?: number;
	timeoutMs?: number;
	callTimeoutMs?: number;
	startupMs?: number;
	configHome?: string;
	warn?: Warn;
};

export type Helper = {
	server: Server;
	cacheDir: string;
	poll(): Promise<void>;
	close(): Promise<void>;
};

export const DEFAULT_POLL_MS = 60_000;
export const DEFAULT_SENTIMENT_MS = 300_000;
export const DEFAULT_CALL_TIMEOUT_MS = 120_000;
const STARTUP_MS = 2_000;
const CLOSING_GRACE_MS = 1_000;

export function cacheDirFor(url: string, configHome?: string): string {
	const home = configHome ?? (process.env.XDG_CONFIG_HOME || join(homedir(), '.config'));
	const { host, pathname } = new URL(url);
	const path = pathname.replace(/\/+$/, '');
	return join(home, 'sagas', 'cache', `${host}${path}`.replaceAll(':', '_').replaceAll('/', '_'));
}

const failure = (text: string): CallToolResult => ({
	isError: true,
	content: [{ type: 'text', text }]
});

function loadSafely(dir: string): State {
	try {
		return loadState(dir);
	} catch {
		return { realms: new Map(), skills: undefined, tools: undefined, server: undefined };
	}
}

function sleep(ms: number): Promise<undefined> {
	return new Promise((resolve) => setTimeout(() => resolve(undefined), ms).unref());
}

export async function createHelper(options: HelperOptions): Promise<Helper> {
	const warn: Warn = options.warn ?? ((message) => process.stderr.write(`sagas-mcp: ${message}\n`));
	const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
	const sentimentMs = options.sentimentMs ?? DEFAULT_SENTIMENT_MS;
	const { url, token } = options;
	// Separate sessions: a poll that fails must never take an agent's call down with it.
	const polling = createClient({ url, token, timeoutMs: options.timeoutMs });
	const calls = createClient({
		url,
		token,
		timeoutMs: options.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS
	});
	const cacheDir = cacheDirFor(url, options.configHome);
	const state = loadSafely(cacheDir);

	let initialized = false;
	const announce = (send: () => Promise<void>) => {
		if (initialized) send().catch(() => {});
	};
	const poller = createPoller(state, {
		client: polling,
		dir: cacheDir,
		warn,
		sentiment: sentimentMs > 0,
		onChange: ({ tools, resources }) => {
			if (tools) announce(() => server.sendToolListChanged());
			if (resources) announce(() => server.sendResourceListChanged());
		}
	});

	const fetched = calls.instructions().then((result) => {
		if (result.ok) poller.rememberInstructions(result.value);
		return result;
	});
	const live = await Promise.race([fetched, sleep(options.startupMs ?? STARTUP_MS)]);
	const instructions = live?.ok ? live.value : state.server?.data.instructions;

	const server = new Server(
		{ name: 'sagas-mcp', version: '0.1.0' },
		{
			capabilities: { tools: { listChanged: true }, resources: { listChanged: true } },
			...(instructions === undefined ? {} : { instructions })
		}
	);
	server.oninitialized = () => {
		initialized = true;
	};

	const answering = new Set<Promise<unknown>>();
	const track = <T>(work: Promise<T>): Promise<T> => {
		answering.add(work);
		void work.finally(() => answering.delete(work)).catch(() => {});
		return work;
	};

	server.setRequestHandler(ListToolsRequestSchema, () =>
		track(
			(async () => {
				if (!state.tools) await poller.refreshTools();
				else if (pollMs <= 0) poller.enqueue('tools');
				poller.markToolsSeen();
				return { tools: servedTools(state) };
			})()
		)
	);

	server.setRequestHandler(CallToolRequestSchema, (request) =>
		track(
			calls
				.callTool(request.params.name, request.params.arguments ?? {})
				.then((result) => (result.ok ? result.value : failure(result.warning)))
		)
	);

	server.setRequestHandler(ListResourcesRequestSchema, () => ({
		resources: resourcesOf(state).map(({ uri, name, description, mimeType }) => ({
			uri,
			name,
			description,
			mimeType
		}))
	}));

	server.setRequestHandler(ListResourceTemplatesRequestSchema, () => ({ resourceTemplates: [] }));

	server.setRequestHandler(ReadResourceRequestSchema, (request) => {
		const resource = resourcesOf(state).find(({ uri }) => uri === request.params.uri);
		if (!resource) {
			throw new McpError(ErrorCode.InvalidParams, `Unknown resource: ${request.params.uri}`);
		}
		return { contents: [{ uri: resource.uri, mimeType: resource.mimeType, text: resource.text }] };
	});

	const timers: ReturnType<typeof setInterval>[] = [];
	const every = (ms: number, kind: Kind) => {
		const timer = setInterval(() => poller.enqueue(kind), ms);
		timer.unref();
		timers.push(timer);
	};
	if (pollMs > 0) {
		every(pollMs, 'core');
		void poller.poll();
	}
	if (sentimentMs > 0) every(sentimentMs, 'sentiment');

	return {
		server,
		cacheDir,
		poll: () => poller.poll(),
		async close() {
			timers.forEach(clearInterval);
			poller.stop();
			await Promise.race([Promise.allSettled([...answering]), sleep(CLOSING_GRACE_MS)]);
			await Promise.all([polling.close(), calls.close()]);
			await fetched;
			await poller.idle();
			await server.close().catch(() => {});
		}
	};
}
