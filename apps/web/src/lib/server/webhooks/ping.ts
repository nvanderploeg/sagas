import { eq } from 'drizzle-orm';
import type { AuthUser } from '#lib/server/auth/users.ts';
import type { Db } from '#lib/server/db/client.ts';
import { webhooks } from '#lib/server/db/schema.ts';
import { DomainError } from '#lib/server/domain/errors.ts';
import { recordDelivery } from './deliveries.ts';
import type { WebhookRuntime } from './runtime.ts';
import type { SafeFetchResult } from './safe-fetch.ts';
import { signedHeaders, webhookMessageId } from './sign.ts';
import { signingSecrets, type WebhookEnv } from './store.ts';

export type PingAttempt = {
	ok: boolean;
	status: number | null;
	error: string | null;
	durationMs: number;
};

export async function testWebhook(
	db: Db,
	actor: AuthUser,
	id: number,
	env: WebhookEnv,
	fetch: WebhookRuntime['fetch']
): Promise<PingAttempt> {
	if (!env.key) throw new DomainError('invalid', 'webhooks need WEBHOOK_KEY');
	const row = db.select().from(webhooks).where(eq(webhooks.id, id)).get();
	if (!row || (row.ownerId !== actor.id && !actor.isAdmin)) {
		throw new DomainError('not_found', 'Webhook not found');
	}
	const timestamp = Math.floor(env.now / 1000);
	const kind = { kind: 'ping', webhookId: id, timestamp } as const;
	const body = JSON.stringify({ webhook: { id, name: row.name }, ping: true });
	let result: SafeFetchResult;
	try {
		const headers = signedHeaders(kind, body, signingSecrets(row, env), env.now);
		result = await fetch({ url: row.url, headers, body }, env.allowPrivate);
	} catch (error) {
		result = {
			ok: false,
			status: null,
			durationMs: 0,
			body: '',
			error: error instanceof Error ? error.message : String(error)
		};
	}
	const attempt: PingAttempt = {
		ok: result.ok,
		status: result.status,
		error: result.ok ? null : result.error,
		durationMs: Math.round(result.durationMs)
	};
	db.transaction((tx) => {
		if (!tx.select({ id: webhooks.id }).from(webhooks).where(eq(webhooks.id, id)).get()) return;
		recordDelivery(tx, {
			webhookId: id,
			attemptedAt: env.now,
			messageId: webhookMessageId(kind),
			kind: 'ping',
			firstSeq: null,
			lastSeq: null,
			status: attempt.status,
			error: attempt.error,
			durationMs: attempt.durationMs,
			responseBody: result.body === '' ? null : result.body
		});
	});
	return attempt;
}
