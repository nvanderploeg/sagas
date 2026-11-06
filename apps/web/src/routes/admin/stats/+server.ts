import { json } from '@sveltejs/kit';
import { requireAdminSession } from '#lib/server/admin/guard.ts';
import { dataLayout } from '#lib/server/admin/layout.ts';
import { adminStats } from '#lib/server/admin/stats.ts';
import { getDb } from '#lib/server/db/index.ts';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ locals }) => {
	requireAdminSession(locals);
	return json(await adminStats(getDb(), dataLayout), { headers: { 'cache-control': 'no-store' } });
};
