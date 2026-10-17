import { unauthorizedResponse } from '#lib/server/auth/access.ts';
import { resourceMetadataUrl } from '#lib/server/auth/oauth-metadata.ts';
import { getDb } from '#lib/server/db/index.ts';
import { readMessage, refuseForeignOrigin } from '#lib/server/mcp/http.ts';
import { handleMcpRequest } from '#lib/server/mcp/server.ts';
import type { RequestHandler } from './$types';

// Accept an API token only, never a session cookie: the MCP decision in docs/mvp.md.
export const POST: RequestHandler = async ({ request, locals, url }) => {
	const refused = refuseForeignOrigin(request, url.origin);
	if (refused) return refused;
	if (!locals.user || locals.credential?.kind !== 'api_token') {
		return unauthorizedResponse(resourceMetadataUrl(url.origin));
	}
	const body = await readMessage(request);
	if (body instanceof Response) return body;
	return handleMcpRequest(getDb(), locals.user, url.origin, request, body.message);
};
