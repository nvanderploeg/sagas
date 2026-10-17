export type Gate = 'pass' | 'setup' | 'login' | 'password' | 'unauthorized';

const PUBLIC_PAGES = new Set(['/setup', '/login', '/logout']);

export function isPublicPath(pathname: string): boolean {
	return PUBLIC_PAGES.has(pathname) || pathname.startsWith('/invite/');
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

const PASSWORD_CHANGE_PAGES = new Set(['/password', '/logout']);

export function gate(
	pathname: string,
	state: { setupDone: boolean; signedIn: boolean; mustChangePassword?: boolean }
): Gate {
	if (OAUTH_OPEN_PATHS.has(pathname)) return 'pass';
	if (state.signedIn && state.mustChangePassword) {
		if (PASSWORD_CHANGE_PAGES.has(pathname)) return 'pass';
		return isMachinePath(pathname) ? 'unauthorized' : 'password';
	}
	if (state.signedIn) return 'pass';
	if (isMachinePath(pathname)) return 'unauthorized';
	if (!state.setupDone) return pathname === '/setup' ? 'pass' : 'setup';
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
