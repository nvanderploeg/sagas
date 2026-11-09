import { error } from '@sveltejs/kit';
import { createApiToken, listApiTokens, revokeApiToken } from '#lib/server/auth/tokens.ts';
import {
	createAgentUser,
	deleteUser,
	listUsers,
	setBanned,
	setRealmLimit,
	setUserEmail,
	unlinkSignIn
} from '#lib/server/auth/users.ts';
import { assignRealmOwner } from '#lib/server/auth/realm-owners.ts';
import { IMPORT_CONFIRMATION } from '#lib/server/admin/guard.ts';
import { importMaxBytes } from '#lib/server/config.ts';
import { getDb } from '#lib/server/db/index.ts';
import { int, perform, signedIn, text } from '#lib/server/ui/form.ts';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	const actor = signedIn(locals);
	if (!actor.isAdmin) error(403, 'Only an Admin can manage Users');
	const db = getDb();
	const users = await listUsers(db);
	return {
		importConfirmation: IMPORT_CONFIRMATION,
		importMaxBytes,
		users,
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
	realmLimit: async ({ request, locals }) => {
		const actor = signedIn(locals);
		const form = await request.formData();
		return perform('realmLimit', async () => {
			await setRealmLimit(getDb(), actor, int(form, 'userId'), int(form, 'limit'));
		});
	},

	email: async ({ request, locals }) => {
		const actor = signedIn(locals);
		const form = await request.formData();
		return perform('email', async () => {
			await setUserEmail(getDb(), actor, int(form, 'userId'), text(form, 'email'));
		});
	},

	unlink: async ({ request, locals }) => {
		const actor = signedIn(locals);
		const form = await request.formData();
		return perform('unlink', async () => {
			await unlinkSignIn(getDb(), actor, int(form, 'userId'));
		});
	},

	ban: async ({ request, locals }) => {
		const actor = signedIn(locals);
		const form = await request.formData();
		return perform(`user:${text(form, 'userId')}`, async () => {
			await setBanned(getDb(), actor, {
				userId: int(form, 'userId'),
				banned: text(form, 'banned') === 'true',
				confirm: text(form, 'confirm')
			});
		});
	},

	delete: async ({ request, locals }) => {
		const actor = signedIn(locals);
		const form = await request.formData();
		return perform(`user:${text(form, 'userId')}`, async () => {
			await deleteUser(getDb(), actor, {
				userId: int(form, 'userId'),
				confirm: text(form, 'confirm')
			});
		});
	},

	owner: async ({ request, locals }) => {
		const actor = signedIn(locals);
		const form = await request.formData();
		return perform('owner', async () => {
			await assignRealmOwner(getDb(), actor, {
				realmKey: text(form, 'realmKey'),
				user: text(form, 'user')
			});
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
