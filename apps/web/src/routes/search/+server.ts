import { json } from '@sveltejs/kit';
import { getDb } from '#lib/server/db/index.ts';
import { searchLabours, toJson } from '#lib/server/ui/reads.ts';
import { signedIn } from '#lib/server/ui/form.ts';
import type { RequestHandler } from './$types';

// The UI's Labour lookup, by key or title, behind the session like every page.
export const GET: RequestHandler = ({ url, locals }) =>
	json(toJson(searchLabours(getDb(), signedIn(locals), url.searchParams.get('q') ?? '')));
