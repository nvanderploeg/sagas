import { getDb } from '#lib/server/db/index.ts';
import { handleRegistration } from '#lib/server/auth/oauth-register.ts';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = ({ request, getClientAddress }) =>
	handleRegistration(getDb(), request, getClientAddress());
