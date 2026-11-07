export type Gate = 'pass' | 'login' | 'unauthorized';

const PUBLIC_PAGES = new Set(['/login', '/login/session', '/logout']);

export function isPublicPath(pathname: string): boolean {
	return PUBLIC_PAGES.has(pathname);
}

export function isMcpPath(pathname: string): boolean {
	return pathname === '/mcp' || pathname.startsWith('/mcp/');
}

// Machine clients get a 401 they can act on, never a redirect to a sign-in page.
export function isMachinePath(pathname: string): boolean {
	return isMcpPath(pathname) || pathname.startsWith('/api/');
}

// Add a path here only if it authenticates its caller itself, or needs no caller at all.
const OAUTH_OPEN_PATHS = new Set([
	'/.well-known/oauth-protected-resource',
	'/.well-known/oauth-protected-resource/mcp',
	'/.well-known/oauth-authorization-server',
	'/oauth/register',
	'/oauth/token'
]);

export function gate(pathname: string, state: { signedIn: boolean }): Gate {
	if (OAUTH_OPEN_PATHS.has(pathname)) return 'pass';
	if (state.signedIn) return 'pass';
	if (isMachinePath(pathname)) return 'unauthorized';
	return isPublicPath(pathname) ? 'pass' : 'login';
}

export function unauthorizedResponse(resourceMetadata?: string): Response {
	const challenge =
		resourceMetadata === undefined ? 'Bearer' : `Bearer resource_metadata="${resourceMetadata}"`;
	return Response.json(
		{ error: 'unauthorized' },
		{ status: 401, headers: { 'www-authenticate': challenge } }
	);
}
