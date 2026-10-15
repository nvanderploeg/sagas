import { json } from '@sveltejs/kit';
import { unauthorizedResponse } from '#lib/server/auth/access.ts';
import { credentialGuard } from '#lib/server/auth/credentials.ts';
import { streamHeartbeatMs } from '#lib/server/config.ts';
import { getDb } from '#lib/server/db/index.ts';
import {
	openEventStream,
	parseSince,
	SinceError,
	STREAM_HEADERS
} from '#lib/server/events/stream.ts';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = ({ request, url, locals }) => {
	if (!locals.credential) return unauthorizedResponse();
	let since: number | undefined;
	try {
		since = parseSince(request, url);
	} catch (error) {
		if (error instanceof SinceError) return json({ error: error.message }, { status: 400 });
		throw error;
	}
	const db = getDb();
	const stream = openEventStream(db, {
		since,
		heartbeatMs: streamHeartbeatMs,
		guard: credentialGuard(db, locals.credential)
	});
	return new Response(stream, { headers: STREAM_HEADERS });
};
