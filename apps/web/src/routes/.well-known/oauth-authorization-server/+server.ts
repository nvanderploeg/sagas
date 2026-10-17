import { authorizationServerMetadata, metadataResponse } from '#lib/server/auth/oauth-metadata.ts';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = ({ url }) =>
	metadataResponse(authorizationServerMetadata(url.origin));
