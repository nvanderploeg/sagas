import { redirect, type RequestHandler } from '@sveltejs/kit';
import { endSession } from '#lib/server/auth/request.ts';

export const POST: RequestHandler = async ({ cookies, url }) => {
	await endSession(cookies, url);
	redirect(303, '/login');
};
