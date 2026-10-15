import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { DomainError } from '../domain/errors.ts';

export type Reply = { data: Record<string, unknown>; text: string };

export function reply(data: Record<string, unknown>, text: string): Reply {
	return { data, text };
}

export function toResult(value: Reply): CallToolResult {
	return {
		content: [{ type: 'text', text: value.text }],
		structuredContent: value.data
	};
}

// Only a DomainError's message reaches the caller: any other error may carry internals.
export function toErrorResult(error: unknown): CallToolResult {
	if (error instanceof DomainError) {
		return {
			isError: true,
			content: [{ type: 'text', text: error.message }],
			structuredContent: { error: { code: error.code, message: error.message } }
		};
	}
	return {
		isError: true,
		content: [{ type: 'text', text: 'Internal error' }],
		structuredContent: { error: { code: 'internal', message: 'Internal error' } }
	};
}

export async function run(
	name: string,
	body: () => Reply | Promise<Reply>
): Promise<CallToolResult> {
	try {
		return toResult(await body());
	} catch (error) {
		if (!(error instanceof DomainError)) console.error(`MCP tool ${name} failed`, error);
		return toErrorResult(error);
	}
}
