import { json } from '@sveltejs/kit';
import { requireAdminSession } from '#lib/server/admin/guard.ts';
import { adminStats } from '#lib/server/admin/stats.ts';
import { getDb } from '#lib/server/db/index.ts';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ locals }) => {
	requireAdminSession(locals);
	return json(await adminStats(getDb()), { headers: { 'cache-control': 'no-store' } });
};
