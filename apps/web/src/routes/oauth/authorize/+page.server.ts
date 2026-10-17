import { error, redirect, type Actions } from '@sveltejs/kit';
import {
	OAUTH_REDIRECT_ORIGINS,
	consentRedirect,
	readAuthorizeRequest
} from '#lib/server/auth/oauth-authorize.ts';
import { OAuthError, issueCode } from '#lib/server/auth/oauth.ts';
import { getDb } from '#lib/server/db/index.ts';
import type { PageServerLoad } from './$types';

const external = OAUTH_REDIRECT_ORIGINS;

function sessionUser(locals: App.Locals) {
	if (locals.credential?.kind !== 'session' || !locals.user) {
		error(403, 'Authorize clients from a signed-in browser');
	}
	return locals.user;
}

export const load: PageServerLoad = ({ locals, url }) => {
	const user = sessionUser(locals);
	const request = readAuthorizeRequest(getDb(), url.searchParams, url.origin);
	if (request.kind === 'invalid') error(400, request.message);
	if (request.kind === 'redirect') redirect(303, request.location, { external });
	return {
		clientName: request.client.name,
		redirectHost: new URL(request.redirectUri).host,
		user: { displayName: user.displayName, username: user.username }
	};
};

export const actions: Actions = {
	default: async ({ request, locals, url }) => {
		const user = sessionUser(locals);
		const db = getDb();
		const authorize = readAuthorizeRequest(db, url.searchParams, url.origin);
		if (authorize.kind === 'invalid') error(400, authorize.message);
		if (authorize.kind === 'redirect') redirect(303, authorize.location, { external });

		const { redirectUri, state } = authorize;
		const stateParam: Record<string, string> = state === null ? {} : { state };
		const form = await request.formData();
		if (form.get('decision') !== 'allow') {
			redirect(303, consentRedirect(redirectUri, { error: 'access_denied', ...stateParam }), {
				external
			});
		}

		let code: string;
		try {
			code = issueCode(db, {
				clientId: authorize.client.clientId,
				userId: user.id,
				redirectUri,
				codeChallenge: authorize.codeChallenge,
				codeChallengeMethod: 'S256'
			});
		} catch (e) {
			if (e instanceof OAuthError) error(400, e.message);
			throw e;
		}
		redirect(303, consentRedirect(redirectUri, { code, ...stateParam }), { external });
	}
};
