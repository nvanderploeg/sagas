import { createApiToken, listApiTokens, revokeApiToken } from '#lib/server/auth/tokens.ts';
import { findUser } from '#lib/server/auth/users.ts';
import { acceptOffer, declineOffer, listOffers } from '#lib/server/domain/memberships.ts';
import { getDb } from '#lib/server/db/index.ts';
import { int, perform, signedIn, text } from '#lib/server/ui/form.ts';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = ({ locals }) => {
	const user = signedIn(locals);
	return {
		tokens: listApiTokens(getDb(), user, user.id),
		offers: listOffers(getDb(), user.id).map((offer) => ({
			...offer,
			createdAt: offer.createdAt.toISOString(),
			invitedByName:
				offer.invitedBy === null ? null : (findUser(getDb(), offer.invitedBy)?.displayName ?? null)
		}))
	};
};

export const actions: Actions = {
	acceptOffer: async ({ request, locals }) => {
		const user = signedIn(locals);
		const form = await request.formData();
		return perform('offers', () => {
			acceptOffer(getDb(), user, int(form, 'realmId'));
		});
	},

	declineOffer: async ({ request, locals }) => {
		const user = signedIn(locals);
		const form = await request.formData();
		return perform('offers', () => {
			declineOffer(getDb(), user, int(form, 'realmId'));
		});
	},

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
