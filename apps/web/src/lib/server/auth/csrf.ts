import { text } from '@sveltejs/kit';

// Add a path only if it authenticates its caller without cookies.
const CSRF_EXEMPT_PATHS = new Set(['/oauth/token', '/oauth/register']);
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
// Kit's is_form_content_type list.
const FORM_CONTENT_TYPES = new Set([
	'application/x-www-form-urlencoded',
	'multipart/form-data',
	'text/plain',
	'application/x-sveltekit-formdata'
]);

function isFormContentType(header: string): boolean {
	return FORM_CONTENT_TYPES.has(header.split(';', 1)[0].trim().toLowerCase());
}

// Keep identical to Kit's is_csrf_forbidden apart from the exempt paths.
export function crossSiteFormRefusal(
	request: Request,
	selfOrigin: string,
	pathname: string
): Response | null {
	if (CSRF_EXEMPT_PATHS.has(pathname)) return null;
	const contentType = request.headers.get('content-type');
	const formLike = !contentType || isFormContentType(contentType);
	if (!formLike || !MUTATING_METHODS.has(request.method)) return null;
	if (request.headers.get('origin') === selfOrigin) return null;

	const message = `Cross-site ${request.method} form submissions are forbidden`;
	const init = { status: 403 };
	if (request.headers.get('accept') === 'application/json') {
		return Response.json({ message }, init);
	}
	return text(message, init);
}
