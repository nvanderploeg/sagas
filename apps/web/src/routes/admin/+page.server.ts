import { error } from '@sveltejs/kit';
import { createInvite, listInvites } from '#lib/server/auth/invites.ts';
import { createApiToken, listApiTokens, revokeApiToken } from '#lib/server/auth/tokens.ts';
import { createAgentUser, listUsers } from '#lib/server/auth/users.ts';
import { IMPORT_CONFIRMATION } from '#lib/server/admin/guard.ts';
import { importMaxBytes } from '#lib/server/config.ts';
import { getDb } from '#lib/server/db/index.ts';
import { int, perform, signedIn, text } from '#lib/server/ui/form.ts';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	const actor = signedIn(locals);
	if (!actor.isAdmin) error(403, 'Only an Admin can manage Users and Invites');
	const db = getDb();
	const users = await listUsers(db);
	return {
		importConfirmation: IMPORT_CONFIRMATION,
		importMaxBytes,
		users,
		invites: await listInvites(db, actor),
		tokens: Object.fromEntries(
			await Promise.all(
				users
					.filter((u) => u.kind === 'agent')
					.map(async (u) => [u.id, await listApiTokens(db, actor, u.id)])
			)
		)
	};
};

export const actions: Actions = {
	invite: ({ locals, url }) => {
		const actor = signedIn(locals);
		return perform('invite', async () => {
			const { token } = await createInvite(getDb(), actor);
			return { link: `${url.origin}/invite/${token}` };
		});
	},

	agent: async ({ request, locals }) => {
		const actor = signedIn(locals);
		const form = await request.formData();
		return perform('agent', async () => {
			await createAgentUser(getDb(), actor, {
				username: text(form, 'username'),
				displayName: text(form, 'displayName')
			});
		});
	},

	token: async ({ request, locals }) => {
		const actor = signedIn(locals);
		const form = await request.formData();
		return perform(`token:${text(form, 'userId')}`, async () => {
			const userId = int(form, 'userId');
			const { token } = await createApiToken(getDb(), actor, userId, text(form, 'name'));
			return { token, userId };
		});
	},

	revoke: async ({ request, locals }) => {
		const actor = signedIn(locals);
		const form = await request.formData();
		return perform('revoke', async () => {
			await revokeApiToken(getDb(), actor, int(form, 'tokenId'));
		});
	}
};
