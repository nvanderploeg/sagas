import { Readable } from 'node:stream';
import { exportBundle } from '#lib/server/admin/export.ts';
import { requireAdminSession, requireSameOrigin } from '#lib/server/admin/guard.ts';
import { getDb } from '#lib/server/db/index.ts';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = ({ locals, request, url }) => {
	requireAdminSession(locals);
	requireSameOrigin(request, url.origin);
	const { stream, filename } = exportBundle(getDb());
	return new Response(Readable.toWeb(stream) as ReadableStream, {
		headers: {
			'content-type': 'application/zip',
			'content-disposition': `attachment; filename="${filename}"`,
			'cache-control': 'no-store'
		}
	});
};
