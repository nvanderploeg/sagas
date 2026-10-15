import type { APIRequestContext, APIResponse, BrowserContext } from '@playwright/test';
import { origin } from './env.ts';

// Mimics a browser form post: SvelteKit rejects a foreign Origin and answers a non-HTML Accept
// with JSON instead of a redirect.
export function postForm(
	request: APIRequestContext,
	path: string,
	form: Record<string, string>,
	headers: Record<string, string> = {}
): Promise<APIResponse> {
	return request.post(path, {
		form,
		headers: { origin, accept: 'text/html', ...headers },
		maxRedirects: 0
	});
}

export function getNoFollow(
	request: APIRequestContext,
	path: string,
	headers: Record<string, string> = {}
): Promise<APIResponse> {
	return request.get(path, { headers, maxRedirects: 0 });
}

export async function cookieHeader(context: BrowserContext): Promise<string> {
	const cookies = await context.cookies();
	return cookies.map((c) => `${c.name}=${c.value}`).join('; ');
}

export function setCookies(response: APIResponse): string[] {
	return response
		.headersArray()
		.filter((h) => h.name.toLowerCase() === 'set-cookie')
		.map((h) => h.value);
}

let counter = 0;

// Matches the username rule: a letter first, then letters, digits, - or _.
export function uniqueName(prefix = 'user'): string {
	counter += 1;
	return `${prefix}${Date.now().toString(36)}${counter}`.slice(0, 32);
}
