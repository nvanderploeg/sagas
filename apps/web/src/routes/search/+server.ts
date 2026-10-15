import { json } from '@sveltejs/kit';
import { getDb } from '#lib/server/db/index.ts';
import { searchTickets, toJson } from '#lib/server/ui/reads.ts';
import type { RequestHandler } from './$types';

// The UI's Ticket lookup, by key or title, behind the session like every page.
export const GET: RequestHandler = ({ url }) =>
	json(toJson(searchTickets(getDb(), url.searchParams.get('q') ?? '')));
