import { json } from '@sveltejs/kit';
import { streamHeartbeatMs } from '#lib/server/config.ts';
import { getDb } from '#lib/server/db/index.ts';
import {
	openEventStream,
	parseSince,
	SinceError,
	STREAM_HEADERS
} from '#lib/server/events/stream.ts';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = ({ request, url }) => {
	let since: number | undefined;
	try {
		since = parseSince(request, url);
	} catch (error) {
		if (error instanceof SinceError) return json({ error: error.message }, { status: 400 });
		throw error;
	}
	const stream = openEventStream(getDb(), { since, heartbeatMs: streamHeartbeatMs });
	return new Response(stream, { headers: STREAM_HEADERS });
};
