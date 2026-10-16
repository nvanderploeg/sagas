import { getDb } from '#lib/server/db/index.ts';
import { answerSession } from '#lib/server/ui/agent-route.ts';
import { readUserLayer } from '#lib/server/ui/agent.ts';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = ({ locals }) =>
	answerSession(locals, () => readUserLayer(getDb(), locals.user!.id));
