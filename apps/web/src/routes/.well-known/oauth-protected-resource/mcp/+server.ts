import { metadataResponse, protectedResourceMetadata } from '#lib/server/auth/oauth-metadata.ts';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = ({ url }) =>
	metadataResponse(protectedResourceMetadata(url.origin));
