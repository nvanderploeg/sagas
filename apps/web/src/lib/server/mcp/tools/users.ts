import { z } from 'zod';
import { createApiToken, listApiTokens, revokeApiToken } from '../../auth/tokens.ts';
import { createAgentUser, listUsers, setRealmLimit, unlinkSignIn } from '../../auth/users.ts';
import { count, userSummary } from '../present.ts';
import * as refs from '../refs.ts';
import { reply } from '../result.ts';
import { userRef, type Tools } from '../tool.ts';

const iso = (date: Date | null) => (date === null ? null : date.toISOString());

export function registerUserTools({ db, actor, define }: Tools): void {
	const userLine = (u: ReturnType<typeof userSummary>) =>
		`${u.username} (${u.displayName}, ${u.kind}${u.isAdmin ? ', Admin' : ''})`;

	define(
		'whoami',
		{
			kind: 'read',
			description: 'The User this API token acts as. Every tool acts as this User.',
			input: {}
		},
		() => {
			const user = userSummary(actor);
			return reply({ user }, userLine(user));
		}
	);

	define(
		'list_users',
		{
			kind: 'read',
			description:
				'List every User, human or agent. Owners and Assignees are Users, named by username.',
			input: {}
		},
		async () => {
			const users = (await listUsers(db)).map(userSummary);
			return reply(
				{ users },
				`${count(users.length, 'User')}: ${users.map((u) => u.username).join(', ')}`
			);
		}
	);

	define(
		'set_realm_limit',
		{
			kind: 'write',
			description:
				'Admin only. Set how many Realms a User may create. Every User starts at 1; 0 stops them creating any.',
			input: {
				user: userRef.describe('Username, "me" or id'),
				limit: z.number().int().min(0).describe('Realms the User may create')
			}
		},
		async (args) => {
			const userId = await refs.userId(db, args.user, actor);
			const user = userSummary(await setRealmLimit(db, actor, userId, args.limit));
			return reply(
				{ user, realmLimit: args.limit },
				`${user.username} may create ${args.limit} Realms`
			);
		}
	);

	define(
		'unlink_sign_in',
		{
			kind: 'write',
			description:
				'Admin only. Clear the Firebase sign-in a User is linked to, keeping their email, so the next verified sign-in with that email links again. Use after a Firebase account was recreated.',
			input: { user: userRef.describe('Username, "me" or id') }
		},
		async (args) => {
			const userId = await refs.userId(db, args.user, actor);
			const user = userSummary(await unlinkSignIn(db, actor, userId));
			return reply({ user }, `${user.username} is no longer linked to a sign-in`);
		}
	);

	define(
		'create_agent_user',
		{
			kind: 'write',
			description:
				'Admin only. Create an Agent user: a User of kind agent with no password, which signs in only with API tokens and can own and be assigned Labours. Follow with create_api_token for it.',
			input: {
				username: z
					.string()
					.describe('2 to 32 characters: a letter first, then letters, digits, - or _'),
				displayName: z.string().describe('1 to 100 characters')
			}
		},
		async (args) => {
			const user = userSummary(await createAgentUser(db, actor, args));
			return reply({ user }, `Created ${userLine(user)}`);
		}
	);

	define(
		'list_api_tokens',
		{
			kind: 'read',
			description:
				"List a User's API tokens, without their secrets. You can manage your own tokens; an Admin can also manage an Agent user's.",
			input: { user: userRef.optional().describe('Username, "me" or id; defaults to you') }
		},
		async (args) => {
			const userId = args.user === undefined ? actor.id : await refs.userId(db, args.user, actor);
			const listed = await listApiTokens(db, actor, userId);
			const now = new Date();
			const live = listed.filter(
				(t) => t.revokedAt === null && (t.expiresAt === null || t.expiresAt > now)
			).length;
			const tokens = listed.map((t) => ({
				id: t.id,
				name: t.name,
				createdAt: t.createdAt.toISOString(),
				lastUsedAt: iso(t.lastUsedAt),
				revokedAt: iso(t.revokedAt),
				expiresAt: iso(t.expiresAt),
				oauth: t.oauth
			}));
			return reply({ tokens }, `${count(tokens.length, 'API token')}, ${live} live`);
		}
	);

	define(
		'create_api_token',
		{
			kind: 'write',
			description:
				"Create an API token that acts as a User. The secret is returned only now; the server keeps only its hash. You can create your own tokens; an Admin can also create an Agent user's.",
			input: {
				user: userRef.optional().describe('Username, "me" or id; defaults to you'),
				name: z.string().describe('What the token is for, 1 to 100 characters')
			}
		},
		async (args) => {
			const userId = args.user === undefined ? actor.id : await refs.userId(db, args.user, actor);
			const { id, token } = await createApiToken(db, actor, userId, args.name);
			return reply({ id, token }, `API token ${id} created; its secret is shown only now`);
		}
	);

	define(
		'revoke_api_token',
		{
			kind: 'destroy',
			description:
				'Revoke an API token by id. Its open event streams close at once, and every later request with it gets 401. Revoking the token this call uses lets the call finish; the next request is the first one refused.',
			input: {
				token: z
					.number({ error: 'expected an API token id as a JSON number' })
					.int()
					.positive()
					.describe('API token id')
			}
		},
		async (args) => {
			await revokeApiToken(db, actor, args.token);
			return reply({ revoked: args.token }, `Revoked API token ${args.token}`);
		}
	);
}
