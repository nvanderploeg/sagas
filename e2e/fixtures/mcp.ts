/* eslint-disable @typescript-eslint/no-explicit-any */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { origin } from '../support/env.ts';
import { expect, test as base } from './index.ts';

export type ToolReply = {
	isError: boolean;
	text: string;
	data: any;
};

export type Mcp = {
	client: Client;
	call: (name: string, args?: Record<string, unknown>) => Promise<ToolReply>;
	ok: (name: string, args?: Record<string, unknown>) => Promise<any>;
	close: () => Promise<void>;
};

export const mcpUrl = new URL('/mcp', origin);

export function mcpTransport(headers: Record<string, string> = {}) {
	return new StreamableHTTPClientTransport(mcpUrl, { requestInit: { headers } });
}

export async function connectMcp(token: string): Promise<Mcp> {
	const client = new Client({ name: 'sagas-e2e', version: '0' });
	await client.connect(mcpTransport({ authorization: `Bearer ${token}` }));

	const call = async (name: string, args: Record<string, unknown> = {}): Promise<ToolReply> => {
		const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
		const text = result.content.map((part) => (part.type === 'text' ? part.text : '')).join('');
		return { isError: result.isError === true, text, data: result.structuredContent };
	};

	return {
		client,
		call,
		async ok(name, args) {
			const reply = await call(name, args);
			expect(reply.isError, `${name}: ${reply.text}`).toBe(false);
			return reply.data;
		},
		close: () => client.close()
	};
}

export function uniqueRealmKey(): string {
	const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
	let key = 'M';
	for (let i = 0; i < 5; i++) key += alphabet[Math.floor(Math.random() * alphabet.length)];
	return key;
}

// `mcp` is a client acting as the first Admin.
export const test = base.extend<{ mcp: Mcp }>({
	mcp: async ({ apiToken }, use) => {
		const mcp = await connectMcp(apiToken.token);
		await use(mcp);
		await mcp.close();
	}
});

export { expect };
