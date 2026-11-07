import { redirect } from '@sveltejs/kit';
import type { Handle, ServerInit } from '@sveltejs/kit/hooks';
import { building, dev } from '$app/env';
import { crossSiteFormRefusal } from '#lib/server/auth/csrf.ts';
import { gate, isMcpPath, unauthorizedResponse } from '#lib/server/auth/access.ts';
import { resourceMetadataUrl } from '#lib/server/auth/oauth-metadata.ts';
import { scheduleOAuthPruning } from '#lib/server/auth/oauth.ts';
import { authFromRequest, SESSION_COOKIE } from '#lib/server/auth/request.ts';
import { gateRedirect } from '#lib/ui/return-path.ts';
import {
	embeddingModelDir,
	embeddingThreads,
	eventRetentionMs,
	surveyRetentionMs,
	webhookAllowPrivate,
	webhookConcurrency,
	webhookDisableAfterMs,
	webhookKey,
	webhookMax,
	webhookMaxPerUser
} from '#lib/server/config.ts';
import { rebuildDerived } from '#lib/server/agent/derived.ts';
import { scheduleRecurrences } from '#lib/server/domain/recurrences.ts';
import { scheduleAgentPruning } from '#lib/server/agent/prune.ts';
import { loadEmbedder, setEmbedder } from '#lib/server/agent/vectors/embedder.ts';
import {
	createEmbeddingQueue,
	enqueueStale,
	setEmbeddingQueue
} from '#lib/server/agent/vectors/index.ts';
import type { Db } from '#lib/server/db/client.ts';
import { getDb, migrateDatabase } from '#lib/server/db/index.ts';
import { schedulePruning } from '#lib/server/events/log.ts';
import { assertDisableBeforeRetention, createDispatcher } from '#lib/server/webhooks/dispatcher.ts';
import { setDispatcher } from '#lib/server/webhooks/registry.ts';
import { safeFetch } from '#lib/server/webhooks/safe-fetch.ts';
import { pauseKeyChanged } from '#lib/server/webhooks/store.ts';

export const init: ServerInit = async () => {
	if (building) return;
	await migrateDatabase();
	const db = getDb();
	await rebuildDerived(db);
	await schedulePruning(db, eventRetentionMs);
	await scheduleAgentPruning(db, surveyRetentionMs);
	await scheduleOAuthPruning(db);
	await scheduleRecurrences(db);
	if (webhookKey) await startWebhooks(db, webhookKey);
	void startEmbeddings(db);
};

async function startWebhooks(db: Db, key: Buffer): Promise<void> {
	assertDisableBeforeRetention(webhookDisableAfterMs, eventRetentionMs);
	await pauseKeyChanged(db, {
		key,
		maxPerUser: webhookMaxPerUser,
		max: webhookMax,
		allowPrivate: webhookAllowPrivate,
		now: Date.now()
	});
	const dispatcher = createDispatcher(db, {
		env: { key, allowPrivate: webhookAllowPrivate },
		concurrency: webhookConcurrency,
		disableAfterMs: webhookDisableAfterMs,
		now: Date.now,
		random: Math.random,
		fetch: (input, allowPrivate) => safeFetch(input, { allowPrivate })
	});
	setDispatcher(dispatcher);
	dispatcher.start();
}

async function startEmbeddings(db: Db): Promise<void> {
	try {
		const embedder = await loadEmbedder(embeddingModelDir, { threads: embeddingThreads });
		if (embedder === null) return;
		setEmbedder(embedder);
		const queue = createEmbeddingQueue(db, embedder);
		setEmbeddingQueue(queue);
		await enqueueStale(db, queue).catch((error: unknown) => {
			console.error('sagas embeddings could not queue stale Labours', error);
		});
	} catch (error) {
		console.error('sagas embeddings failed to start', error);
	}
}

export const handle: Handle = async ({ event, resolve }) => {
	// Match Kit's built-in rule, which never runs in dev.
	const refusal = dev
		? null
		: crossSiteFormRefusal(event.request, event.url.origin, event.url.pathname);
	if (refusal) return refusal;

	const db = getDb();
	const auth = await authFromRequest(db, event.request, event.cookies.get(SESSION_COOKIE));
	event.locals.user = auth?.user ?? null;
	event.locals.credential = auth?.credential ?? null;

	const decision = gate(event.url.pathname, { signedIn: auth !== null });
	if (decision === 'login') {
		redirect(303, gateRedirect(event.url));
	}
	if (decision === 'unauthorized') {
		return unauthorizedResponse(
			isMcpPath(event.url.pathname) ? resourceMetadataUrl(event.url.origin) : undefined
		);
	}
	const response = await resolve(event);
	response.headers.set('x-content-type-options', 'nosniff');
	response.headers.set('referrer-policy', 'same-origin');
	response.headers.set('permissions-policy', 'camera=(), microphone=(), geolocation=()');
	if (event.url.protocol === 'https:') {
		response.headers.set('strict-transport-security', 'max-age=31536000');
	}
	return response;
};
