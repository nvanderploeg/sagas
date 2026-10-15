import { z } from 'zod';
import { createInvite, listInvites } from '../../auth/invites.ts';
import { createApiToken, listApiTokens, revokeApiToken } from '../../auth/tokens.ts';
import { createAgentUser, findUser, listUsers } from '../../auth/users.ts';
import { userSummary } from '../present.ts';
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
		() => {
			const users = listUsers(db).map(userSummary);
			return reply({ users }, users.map(userLine).join('\n'));
		}
	);

	define(
		'create_invite',
		{
			kind: 'write',
			description:
				"Admin only. Create a single-use Invite. Returns the path of its accept page, where a person sets a username and password; prefix it with this server's origin to share it. The link is shown only now.",
			input: {}
		},
		() => {
			const invite = createInvite(db, actor);
			const path = `/invite/${invite.token}`;
			return reply({ id: invite.id, path }, `Invite ${invite.id}: ${path}`);
		}
	);

	define(
		'list_invites',
		{
			kind: 'read',
			description: 'Admin only. List every Invite, and who used it.',
			input: {}
		},
		() => {
			const name = (id: number | null) =>
				id === null ? null : (findUser(db, id)?.username ?? null);
			const invites = listInvites(db, actor).map((invite) => ({
				id: invite.id,
				createdBy: name(invite.createdByUserId),
				createdAt: invite.createdAt.toISOString(),
				usedBy: name(invite.usedByUserId),
				usedAt: iso(invite.usedAt)
			}));
			const text = invites
				.map((i) => `#${i.id} by ${i.createdBy}: ${i.usedBy ? `used by ${i.usedBy}` : 'open'}`)
				.join('\n');
			return reply({ invites }, text || 'No Invites.');
		}
	);

	define(
		'create_agent_user',
		{
			kind: 'write',
			description:
				'Admin only. Create an Agent user: a User of kind agent with no password, which signs in only with API tokens and can own and be assigned Tickets. Follow with create_api_token for it.',
			input: {
				username: z
					.string()
					.describe('2 to 32 characters: a letter first, then letters, digits, - or _'),
				displayName: z.string().describe('1 to 100 characters')
			}
		},
		(args) => {
			const user = userSummary(createAgentUser(db, actor, args));
			return reply({ user }, `Created ${userLine(user)}`);
		}
	);

	define(
		'list_api_tokens',
		{
			kind: 'read',
			description:
				"List a User's API tokens, without their secrets. You can manage your own tokens; an Admin can also manage an Agent user's.",
			input: { user: userRef.optional().describe('Defaults to you') }
		},
		(args) => {
			const userId = args.user === undefined ? actor.id : refs.userId(db, args.user);
			const tokens = listApiTokens(db, actor, userId).map((t) => ({
				id: t.id,
				name: t.name,
				createdAt: t.createdAt.toISOString(),
				lastUsedAt: iso(t.lastUsedAt),
				revokedAt: iso(t.revokedAt)
			}));
			const text = tokens
				.map((t) => `#${t.id} ${t.name}${t.revokedAt ? ' (revoked)' : ''}`)
				.join('\n');
			return reply({ tokens }, text || 'No API tokens.');
		}
	);

	define(
		'create_api_token',
		{
			kind: 'write',
			description:
				"Create an API token that acts as a User. The secret is returned only now; the server keeps only its hash. You can create your own tokens; an Admin can also create an Agent user's.",
			input: {
				user: userRef.optional().describe('Defaults to you'),
				name: z.string().describe('What the token is for, 1 to 100 characters')
			}
		},
		(args) => {
			const userId = args.user === undefined ? actor.id : refs.userId(db, args.user);
			const { id, token } = createApiToken(db, actor, userId, args.name);
			return reply({ id, token }, `API token #${id}: ${token}`);
		}
	);

	define(
		'revoke_api_token',
		{
			kind: 'destroy',
			description:
				'Revoke an API token by id. Requests with it fail at once and its open event streams close. Revoking the token you are using ends this connection.',
			input: { token: z.number().int().positive().describe('API token id') }
		},
		(args) => {
			revokeApiToken(db, actor, args.token);
			return reply({ revoked: args.token }, `Revoked API token #${args.token}`);
		}
	);
}
