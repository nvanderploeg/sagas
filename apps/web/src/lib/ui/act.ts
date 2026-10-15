import { deserialize } from '$app/forms';
import { goto } from '$app/navigation';

export class ActionError extends Error {}

export type Fields = Record<string, string | number | boolean | null | undefined>;

export type Done = { seq: number; scope: string } & Record<string, unknown>;

// Calls a form action of the current page from script, as `use:enhance` would.
export async function act(name: string, fields: Fields, path = location.pathname): Promise<Done> {
	const body = new FormData();
	for (const [key, value] of Object.entries(fields)) {
		if (value === undefined) continue;
		body.set(key, value === null ? '' : String(value));
	}
	let response: Response;
	try {
		response = await fetch(`${path}?/${name}`, {
			method: 'POST',
			body,
			headers: { accept: 'application/json', 'x-sveltekit-action': 'true' }
		});
	} catch {
		throw new ActionError('Could not reach the server. Check the connection and try again.');
	}
	const result = deserialize(await response.text());
	switch (result.type) {
		case 'success':
			return result.data as Done;
		case 'failure':
			throw new ActionError(String(result.data?.error ?? 'That did not work.'));
		case 'redirect':
			// eslint-disable-next-line svelte/no-navigation-without-resolve -- the server resolved it
			await goto(result.location);
			throw new ActionError('Redirected');
		default:
			throw new ActionError(result.error?.message ?? 'Something went wrong on the server.');
	}
}
