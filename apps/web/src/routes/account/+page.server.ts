import { createApiToken, listApiTokens, revokeApiToken } from '#lib/server/auth/tokens.ts';
import { findUser } from '#lib/server/auth/users.ts';
import { acceptOffer, declineOffer, listOffers } from '#lib/server/domain/memberships.ts';
import { getDb } from '#lib/server/db/index.ts';
import { int, perform, signedIn, text } from '#lib/server/ui/form.ts';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	const user = signedIn(locals);
	return {
		tokens: await listApiTokens(getDb(), user, user.id),
		offers: await Promise.all(
			(await listOffers(getDb(), user.id)).map(async (offer) => ({
				...offer,
				createdAt: offer.createdAt.toISOString(),
				invitedByName:
					offer.invitedBy === null
						? null
						: ((await findUser(getDb(), offer.invitedBy))?.displayName ?? null)
			}))
		)
	};
};

export const actions: Actions = {
	acceptOffer: async ({ request, locals }) => {
		const user = signedIn(locals);
		const form = await request.formData();
		return perform('offers', async () => {
			await acceptOffer(getDb(), user, int(form, 'realmId'));
		});
	},

	declineOffer: async ({ request, locals }) => {
		const user = signedIn(locals);
		const form = await request.formData();
		return perform('offers', async () => {
			await declineOffer(getDb(), user, int(form, 'realmId'));
		});
	},

	token: async ({ request, locals }) => {
		const user = signedIn(locals);
		const form = await request.formData();
		return perform('token', async () => {
			const { token } = await createApiToken(getDb(), user, user.id, text(form, 'name'));
			return { token };
		});
	},

	revoke: async ({ request, locals }) => {
		const user = signedIn(locals);
		const form = await request.formData();
		return perform('revoke', async () => {
			await revokeApiToken(getDb(), user, int(form, 'tokenId'));
		});
	}
};
