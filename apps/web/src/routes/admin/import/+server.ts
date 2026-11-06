import { error, json } from '@sveltejs/kit';
import {
	IMPORT_CONFIRMATION,
	requireAdminSession,
	requireSameOrigin
} from '#lib/server/admin/guard.ts';
import { BusyError } from '#lib/server/admin/import.ts';
import { dataLayout } from '#lib/server/admin/layout.ts';
import { BundleError } from '#lib/server/admin/manifest.ts';
import { UploadError, createUploads } from '#lib/server/admin/upload.ts';
import { importMaxBytes } from '#lib/server/config.ts';
import type { RequestHandler } from './$types';

const uploads = createUploads(dataLayout, {
	maxBytes: importMaxBytes,
	maxExpandedBytes: importMaxBytes * 4
});

export const POST: RequestHandler = async ({ request, locals, url }) => {
	requireAdminSession(locals);
	requireSameOrigin(request, url.origin);
	if (request.headers.get('x-sagas-confirm') !== IMPORT_CONFIRMATION) {
		error(400, `Type ${IMPORT_CONFIRMATION} to confirm`);
	}
	if (!request.body) error(400, 'Send a chunk of the bundle as the request body');
	const offset = Number(url.searchParams.get('offset'));
	if (!Number.isSafeInteger(offset) || offset < 0) error(400, 'Bad offset');

	try {
		const pending = await uploads.append({
			id: url.searchParams.get('id') ?? '',
			offset,
			body: request.body,
			final: url.searchParams.get('final') === '1'
		});
		return json({ pending });
	} catch (e) {
		if (e instanceof UploadError) error(e.status, e.message);
		if (e instanceof BusyError) error(409, e.message);
		if (e instanceof BundleError) error(422, e.message);
		throw e;
	}
};
