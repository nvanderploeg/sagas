import { getDb } from '#lib/server/db/index.ts';
import { handleRest } from '#lib/server/rest/api.ts';
import type { RequestHandler } from './$types';

const handle: RequestHandler = ({ request, url, params, locals }) =>
	handleRest(
		getDb(),
		locals.user && locals.credential ? { user: locals.user, credential: locals.credential } : null,
		{
			method: request.method,
			origin: url.origin,
			segments: params.path.split('/').filter((part) => part !== ''),
			query: url.searchParams,
			body: () => request.json()
		}
	);

export const GET = handle;
export const PATCH = handle;
export const POST = handle;
