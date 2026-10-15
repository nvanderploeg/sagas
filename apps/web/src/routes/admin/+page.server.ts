import { error } from '@sveltejs/kit';
import { createInvite, listInvites } from '#lib/server/auth/invites.ts';
import { createApiToken, listApiTokens, revokeApiToken } from '#lib/server/auth/tokens.ts';
import { createAgentUser, listUsers } from '#lib/server/auth/users.ts';
import { getDb } from '#lib/server/db/index.ts';
import { int, perform, signedIn, text } from '#lib/server/ui/form.ts';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = ({ locals }) => {
	const actor = signedIn(locals);
	if (!actor.isAdmin) error(403, 'Only an Admin can manage Users and Invites');
	const db = getDb();
	const users = listUsers(db);
	return {
		users,
		invites: listInvites(db, actor),
		tokens: Object.fromEntries(
			users.filter((u) => u.kind === 'agent').map((u) => [u.id, listApiTokens(db, actor, u.id)])
		)
	};
};

export const actions: Actions = {
	invite: ({ locals, url }) => {
		const actor = signedIn(locals);
		return perform('invite', () => {
			const { token } = createInvite(getDb(), actor);
			return { link: `${url.origin}/invite/${token}` };
		});
	},

	agent: async ({ request, locals }) => {
		const actor = signedIn(locals);
		const form = await request.formData();
		return perform('agent', () => {
			createAgentUser(getDb(), actor, {
				username: text(form, 'username'),
				displayName: text(form, 'displayName')
			});
		});
	},

	token: async ({ request, locals }) => {
		const actor = signedIn(locals);
		const form = await request.formData();
		return perform(`token:${text(form, 'userId')}`, () => {
			const userId = int(form, 'userId');
			const { token } = createApiToken(getDb(), actor, userId, text(form, 'name'));
			return { token, userId };
		});
	},

	revoke: async ({ request, locals }) => {
		const actor = signedIn(locals);
		const form = await request.formData();
		return perform('revoke', () => {
			revokeApiToken(getDb(), actor, int(form, 'tokenId'));
		});
	}
};
