import type { Gate } from '#lib/server/auth/access.ts';

const BASE = 'http://sagas.invalid';

// A path on this site to come back to after signing in. Anything that could leave the site, or
// lead back to signing in, is '/'.
export function returnPath(value: string | null | undefined): string {
	if (!value || !value.startsWith('/')) return '/';
	let url: URL;
	try {
		url = new URL(value, BASE);
	} catch {
		return '/';
	}
	if (url.origin !== BASE || url.pathname.startsWith('//')) return '/';
	if (url.pathname === '/login' || url.pathname === '/logout') return '/';
	return `${url.pathname}${url.search}${url.hash}`;
}

export function signInPath(here: string): string {
	return `/login?next=${encodeURIComponent(here)}`;
}

// Where a page gate decision sends `url`; `/` goes bare, any other page is returned to.
export function gateRedirect(decision: Exclude<Gate, 'pass' | 'unauthorized'>, url: URL): string {
	if (decision === 'setup') return '/setup';
	const here = `${url.pathname}${url.search}`;
	if (decision === 'login') return url.pathname === '/' ? '/login' : signInPath(here);
	return url.pathname === '/' ? '/password' : `/password?next=${encodeURIComponent(here)}`;
}
