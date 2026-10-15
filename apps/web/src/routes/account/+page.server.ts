import { createApiToken, listApiTokens, revokeApiToken } from '#lib/server/auth/tokens.ts';
import { getDb } from '#lib/server/db/index.ts';
import { int, perform, signedIn, text } from '#lib/server/ui/form.ts';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = ({ locals }) => {
	const user = signedIn(locals);
	return { tokens: listApiTokens(getDb(), user, user.id) };
};

export const actions: Actions = {
	token: async ({ request, locals }) => {
		const user = signedIn(locals);
		const form = await request.formData();
		return perform('token', () => {
			const { token } = createApiToken(getDb(), user, user.id, text(form, 'name'));
			return { token };
		});
	},

	revoke: async ({ request, locals }) => {
		const user = signedIn(locals);
		const form = await request.formData();
		return perform('revoke', () => {
			revokeApiToken(getDb(), user, int(form, 'tokenId'));
		});
	}
};
