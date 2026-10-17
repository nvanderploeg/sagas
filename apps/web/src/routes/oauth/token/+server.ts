import { handleTokenRequest } from '#lib/server/auth/oauth-token.ts';
import { getDb } from '#lib/server/db/index.ts';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = ({ request, url }) =>
	handleTokenRequest(getDb(), request, url.origin);
