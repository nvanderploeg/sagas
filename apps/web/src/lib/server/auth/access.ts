export type Gate = 'pass' | 'setup' | 'login' | 'unauthorized';

const PUBLIC_PAGES = new Set(['/setup', '/login', '/logout']);

export function isPublicPath(pathname: string): boolean {
	return PUBLIC_PAGES.has(pathname) || pathname.startsWith('/invite/');
}

export function gate(pathname: string, state: { setupDone: boolean; signedIn: boolean }): Gate {
	if (state.signedIn) return 'pass';
	if (pathname.startsWith('/api/')) return 'unauthorized';
	if (!state.setupDone) return pathname === '/setup' ? 'pass' : 'setup';
	return isPublicPath(pathname) ? 'pass' : 'login';
}
