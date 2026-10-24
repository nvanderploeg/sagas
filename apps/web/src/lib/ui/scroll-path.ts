// Slug and Path rules from docs/scrolls.md, shared by the server and the browser.

export const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
export const SLUG_MAX = 64;
export const DEPTH_MAX = 10;

// Every run of characters a slug cannot hold becomes one `-`; empty when nothing is left.
function slugPart(text: string): string {
	return text
		.normalize('NFKD')
		.replace(/[̀-ͯ]/g, '')
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.slice(0, SLUG_MAX)
		.replace(/^-+|-+$/g, '');
}

export function slugify(title: string): string {
	return slugPart(title) || 'page';
}

// A Path as written in a link or URL, made canonical; null when it names nothing.
export function normalizePath(raw: string): string | null {
	const segments = raw.split('/').map(slugPart).filter(Boolean);
	if (segments.length === 0 || segments.length > DEPTH_MAX) return null;
	return segments.join('/');
}

export function parentPath(path: string): string | null {
	const at = path.lastIndexOf('/');
	return at < 0 ? null : path.slice(0, at);
}

export function lastSegment(path: string): string {
	return path.slice(path.lastIndexOf('/') + 1);
}
