import {
	createServer,
	type IncomingHttpHeaders,
	type IncomingMessage,
	type Server as HttpServer,
	type ServerResponse
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import {
	CallToolRequestSchema,
	ListToolsRequestSchema,
	type CallToolResult,
	type Tool
} from '@modelcontextprotocol/sdk/types.js';

export type StubCall = { name: string; args: Record<string, unknown> };
export type StubHandler = (
	args: Record<string, unknown>
) => CallToolResult | Promise<CallToolResult>;

export const tool = (name: string, description = `${name} tool`): Tool => ({
	name,
	description,
	inputSchema: { type: 'object', properties: { realm: { type: ['string', 'integer'] } } }
});

export const ok = (structuredContent: Record<string, unknown>): CallToolResult => ({
	content: [{ type: 'text', text: `ok\n${JSON.stringify(structuredContent)}` }],
	structuredContent
});

export const toolError = (code: string, message: string): CallToolResult => ({
	isError: true,
	content: [{ type: 'text', text: message }],
	structuredContent: { error: { code, message } }
});

// A stand-in for the sagas `/mcp`: stateless Streamable HTTP, JSON responses, POST only, Bearer token.
export function createStub(token = 'secret') {
	const stub = {
		token,
		url: '',
		tools: [] as Tool[],
		handlers: new Map<string, StubHandler>(),
		calls: [] as StubCall[],
		listCount: 0,
		headers: [] as IncomingHttpHeaders[],
		delayMs: 0,
		forceStatus: 0,
		instructions: undefined as string | undefined,
		// The next request for each tool (by name) or method runs on the server, then loses its socket.
		drop: new Set<string>(),
		start: (sameAddress?: boolean) => start(sameAddress),
		stop,
		callsTo: (name: string) => stub.calls.filter((call) => call.name === name)
	};
	let http: HttpServer | undefined;
	let port = 0;

	function mcpServer(): Server {
		const server = new Server(
			{ name: 'sagas-stub', version: '0' },
			{ capabilities: { tools: {} }, instructions: stub.instructions }
		);
		server.setRequestHandler(ListToolsRequestSchema, () => {
			stub.listCount++;
			return { tools: stub.tools };
		});
		server.setRequestHandler(CallToolRequestSchema, (request) => {
			const args = (request.params.arguments ?? {}) as Record<string, unknown>;
			stub.calls.push({ name: request.params.name, args });
			const handler = stub.handlers.get(request.params.name);
			return handler
				? handler(args)
				: toolError('not_found', `unknown tool ${request.params.name}`);
		});
		return server;
	}

	async function serve(req: IncomingMessage, res: ServerResponse): Promise<void> {
		stub.headers.push(req.headers);
		if (stub.delayMs) await new Promise((resolve) => setTimeout(resolve, stub.delayMs));
		if (stub.forceStatus) {
			res.writeHead(stub.forceStatus).end('boom');
			return;
		}
		if (req.headers.authorization !== `Bearer ${stub.token}`) {
			res.writeHead(401, { 'content-type': 'application/json' }).end('{"error":"unauthorized"}');
			return;
		}
		if (req.headers.origin) {
			res.writeHead(403).end();
			return;
		}
		if (req.method !== 'POST') {
			res.writeHead(405, { allow: 'POST' }).end();
			return;
		}
		const chunks: Buffer[] = [];
		for await (const chunk of req) chunks.push(chunk as Buffer);
		const body = Buffer.concat(chunks);
		const parsed = JSON.parse(body.toString('utf8')) as {
			method?: string;
			params?: { name?: string };
		};
		const target = parsed.method === 'tools/call' ? String(parsed.params?.name) : parsed.method;
		const dropped = target !== undefined && stub.drop.delete(target);
		const request = new Request(`${stub.url}/mcp`, {
			method: 'POST',
			headers: req.headers as Record<string, string>,
			body
		});
		const server = mcpServer();
		const transport = new WebStandardStreamableHTTPServerTransport({
			sessionIdGenerator: undefined,
			enableJsonResponse: true
		});
		await server.connect(transport);
		try {
			const response = await transport.handleRequest(request, { parsedBody: parsed });
			if (dropped) {
				req.socket.destroy();
				return;
			}
			res.writeHead(response.status, Object.fromEntries(response.headers));
			res.end(Buffer.from(await response.arrayBuffer()));
		} finally {
			await server.close();
		}
	}

	async function start(sameAddress = false): Promise<void> {
		if (!sameAddress) port = 0;
		http = createServer((req, res) => {
			serve(req, res).catch(() => {
				if (!res.headersSent) res.writeHead(500);
				res.end();
			});
		});
		await new Promise<void>((resolve) => http!.listen(port, '127.0.0.1', resolve));
		port = (http.address() as AddressInfo).port;
		stub.url = `http://127.0.0.1:${port}`;
	}

	async function stop(): Promise<void> {
		const closing = http;
		http = undefined;
		if (!closing) return;
		closing.closeAllConnections();
		await new Promise((resolve) => closing.close(resolve));
	}

	return stub;
}
