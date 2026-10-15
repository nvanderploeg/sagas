export type Gate = 'pass' | 'setup' | 'login' | 'unauthorized';

const PUBLIC_PAGES = new Set(['/setup', '/login', '/logout']);

export function isPublicPath(pathname: string): boolean {
	return PUBLIC_PAGES.has(pathname) || pathname.startsWith('/invite/');
}

// Machine clients get a 401 they can act on, never a redirect to a sign-in page.
export function isMachinePath(pathname: string): boolean {
	return pathname === '/mcp' || pathname.startsWith('/mcp/') || pathname.startsWith('/api/');
}

export function gate(pathname: string, state: { setupDone: boolean; signedIn: boolean }): Gate {
	if (state.signedIn) return 'pass';
	if (isMachinePath(pathname)) return 'unauthorized';
	if (!state.setupDone) return pathname === '/setup' ? 'pass' : 'setup';
	return isPublicPath(pathname) ? 'pass' : 'login';
}

export function unauthorizedResponse(): Response {
	return Response.json(
		{ error: 'unauthorized' },
		{ status: 401, headers: { 'www-authenticate': 'Bearer' } }
	);
}
