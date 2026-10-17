import type { OAuthError, OAuthErrorCode } from './oauth.ts';

export const NO_STORE = { 'cache-control': 'no-store', pragma: 'no-cache' } as const;

export function oauthJson(body: unknown, status = 200, headers: Record<string, string> = {}) {
	return Response.json(body, { status, headers: { ...NO_STORE, ...headers } });
}

// RFC 6749 §5.2 / RFC 7591 §3.2.2 error body.
export function oauthErrorResponse(
	error: OAuthError | { error: OAuthErrorCode; message: string },
	status = 400,
	headers: Record<string, string> = {}
): Response {
	return oauthJson({ error: error.error, error_description: error.message }, status, headers);
}
