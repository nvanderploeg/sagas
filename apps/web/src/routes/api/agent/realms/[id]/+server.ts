import { getDb } from '#lib/server/db/index.ts';
import { answerSession, idParam } from '#lib/server/ui/agent-route.ts';
import { readRealmLayer } from '#lib/server/ui/agent.ts';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = ({ locals, params }) =>
	answerSession(locals, () => readRealmLayer(getDb(), idParam(params.id)));
