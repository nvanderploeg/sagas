import { eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { realms, users } from '../../db/schema.ts';
import { DomainError } from '../../domain/errors.ts';
import { listDeliveries } from '../../webhooks/deliveries.ts';
import { testWebhook } from '../../webhooks/ping.ts';
import { webhookRuntime } from '../../webhooks/runtime.ts';
import {
	createWebhook,
	deleteWebhook,
	getWebhook,
	listWebhooks,
	rotateWebhookSecret,
	updateWebhook,
	type WebhookInfo
} from '../../webhooks/store.ts';
import { count } from '../present.ts';
import * as refs from '../refs.ts';
import { reply } from '../result.ts';
import { realmRef, userRef, type Tools } from '../tool.ts';

const webhookId = z
	.number({ error: 'expected a Webhook id as a JSON number' })
	.int()
	.positive()
	.describe('Webhook id');

const eventTypes = z
	.array(z.string())
	.nullable()
	.describe('Event types to send, from the table in docs/events.md; null sends every type');

const realmsField = z
	.array(realmRef)
	.nullable()
	.describe('Realms to send Events for; null sends every Event, whatever Realms it touches');

export function registerWebhookTools({ db, actor, define }: Tools): void {
	const runtime = () => webhookRuntime();

	// Call env() first in every tool, before any lookup.
	const env = () => {
		const current = runtime().env();
		if (!current.key) throw new DomainError('invalid', 'webhooks need WEBHOOK_KEY');
		return current;
	};

	const view = (info: WebhookInfo) => {
		const stored = info.realmIds;
		const keys = new Map(
			stored === null || stored.length === 0
				? []
				: db
						.select({ id: realms.id, key: realms.key })
						.from(realms)
						.where(inArray(realms.id, stored))
						.all()
						.map((r) => [r.id, r.key])
		);
		const owner = db
			.select({ username: users.username })
			.from(users)
			.where(eq(users.id, info.ownerId))
			.get()?.username;
		return {
			id: info.id,
			owner: owner ?? null,
			name: info.name,
			url: info.url,
			eventTypes: info.eventTypes,
			realms: stored === null ? null : stored.flatMap((id) => keys.get(id) ?? []),
			realmIds: stored,
			status: info.status,
			statusReason: info.statusReason,
			cursor: info.cursor,
			createdAt: info.createdAt.toISOString(),
			updatedAt: info.updatedAt.toISOString(),
			failingSince: info.failingSince?.toISOString() ?? null,
			nextAttemptAt: info.nextAttemptAt?.toISOString() ?? null
		};
	};

	const realmIds = (given: (string | number)[] | null | undefined) =>
		given === undefined || given === null
			? given
			: given.map((ref) => refs.realmId(db, ref, actor));

	define(
		'create_webhook',
		{
			kind: 'write',
			description:
				'Create a Webhook you own: sagas POSTs the Events you could see on your Stream to its url. The secret that signs Deliveries is returned only now.',
			input: {
				name: z.string().describe('1 to 100 characters'),
				url: z.string().describe('https URL that receives Deliveries'),
				eventTypes: eventTypes.optional(),
				realms: realmsField.optional()
			}
		},
		(args) => {
			const current = env();
			const { webhook, secret } = createWebhook(
				db,
				actor,
				{
					name: args.name,
					url: args.url,
					eventTypes: args.eventTypes,
					realmIds: realmIds(args.realms)
				},
				current
			);
			return reply(
				{ webhook: view(webhook), secret },
				`Webhook ${webhook.id} created; its secret is shown only now`
			);
		}
	);

	define(
		'list_webhooks',
		{
			kind: 'read',
			description:
				"List a User's Webhooks, without secrets. You can see your own; an Admin can see anyone's.",
			input: { user: userRef.optional().describe('Username, "me" or id; defaults to you') }
		},
		(args) => {
			const current = env();
			const owner = args.user === undefined ? actor.id : refs.userId(db, args.user, actor);
			const webhooks = listWebhooks(db, actor, owner, current).map(view);
			return reply({ webhooks }, count(webhooks.length, 'Webhook'));
		}
	);

	define(
		'update_webhook',
		{
			kind: 'write',
			description:
				'Change a Webhook you own (an Admin can change anyone\'s). status "active" resumes a paused or disabled Webhook and retries at once. Changing eventTypes or realms applies from its cursor onward.',
			input: {
				webhook: webhookId,
				name: z.string().optional().describe('1 to 100 characters'),
				url: z.string().optional().describe('https URL that receives Deliveries'),
				eventTypes: eventTypes.optional(),
				realms: realmsField.optional(),
				status: z.enum(['active', 'paused']).optional()
			}
		},
		(args) => {
			const current = env();
			getWebhook(db, actor, args.webhook, current);
			const webhook = updateWebhook(
				db,
				actor,
				args.webhook,
				{
					name: args.name,
					url: args.url,
					eventTypes: args.eventTypes,
					realmIds: realmIds(args.realms),
					status: args.status
				},
				current
			);
			return reply({ webhook: view(webhook) }, `Updated Webhook ${webhook.id}`);
		}
	);

	define(
		'rotate_webhook_secret',
		{
			kind: 'write',
			description:
				'Make a new secret for a Webhook. The old one keeps signing alongside it for 24 hours. The new secret is returned only now.',
			input: { webhook: webhookId }
		},
		(args) => {
			const { secret } = rotateWebhookSecret(db, actor, args.webhook, env());
			return reply(
				{ secret },
				`Webhook ${args.webhook} secret rotated; the new secret is shown only now`
			);
		}
	);

	define(
		'test_webhook',
		{
			kind: 'write',
			description:
				"Send a signed ping to a Webhook's url and report the attempt. Works in any status, moves no cursor, and is kept in the delivery log.",
			input: { webhook: webhookId }
		},
		async (args) => {
			const current = env();
			const attempt = await testWebhook(db, actor, args.webhook, current, runtime().fetch);
			const outcome = attempt.ok ? `ok (${attempt.status})` : `failed: ${attempt.error}`;
			return reply({ attempt }, `Ping to Webhook ${args.webhook} ${outcome}`);
		}
	);

	define(
		'delete_webhook',
		{
			kind: 'destroy',
			description: 'Delete a Webhook and its delivery log.',
			input: { webhook: webhookId }
		},
		(args) => {
			deleteWebhook(db, actor, args.webhook, env());
			return reply({ deleted: args.webhook }, `Deleted Webhook ${args.webhook}`);
		}
	);

	define(
		'list_webhook_deliveries',
		{
			kind: 'read',
			description:
				"List a Webhook's delivery attempts, newest first. Pass the returned nextBefore as before for the next page.",
			input: {
				webhook: webhookId,
				before: z
					.number({ error: 'expected a delivery id as a JSON number' })
					.int()
					.positive()
					.optional()
					.describe('Return attempts older than this delivery id'),
				limit: z.number().int().min(1).max(200).optional().describe('Page size, 1 to 200')
			}
		},
		(args) => {
			getWebhook(db, actor, args.webhook, env());
			const page = listDeliveries(db, args.webhook, { before: args.before, limit: args.limit });
			const deliveries = page.deliveries.map((d) => ({
				id: d.id,
				attemptedAt: d.attemptedAt.toISOString(),
				messageId: d.messageId,
				kind: d.kind,
				firstSeq: d.firstSeq,
				lastSeq: d.lastSeq,
				status: d.status,
				error: d.error,
				durationMs: d.durationMs,
				responseBody: d.responseBody
			}));
			return reply(
				{ deliveries, nextBefore: page.nextBefore },
				count(deliveries.length, 'delivery', 'deliveries')
			);
		}
	);
}
