const BASE = 'http://workload.invalid';

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
	if (url.origin !== BASE || url.pathname === '/login' || url.pathname === '/logout') return '/';
	return `${url.pathname}${url.search}${url.hash}`;
}

export function signInPath(here: string): string {
	return `/login?next=${encodeURIComponent(here)}`;
}
