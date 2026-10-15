import { unauthorizedResponse } from '#lib/server/auth/access.ts';
import { getDb } from '#lib/server/db/index.ts';
import { handleMcpRequest } from '#lib/server/mcp/server.ts';
import type { RequestHandler } from './$types';

// Accept an API token only, never a session cookie: the MCP decision in docs/mvp.md.
export const POST: RequestHandler = ({ request, locals }) => {
	if (!locals.user || locals.credential?.kind !== 'api_token') return unauthorizedResponse();
	return handleMcpRequest(getDb(), locals.user, request);
};
