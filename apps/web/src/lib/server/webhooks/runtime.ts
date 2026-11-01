import {
	webhookAllowPrivate,
	webhookKey,
	webhookMax,
	webhookMaxPerUser
} from '#lib/server/config.ts';
import { safeFetch, type SafeFetchInput, type SafeFetchResult } from './safe-fetch.ts';
import type { WebhookEnv } from './store.ts';

export type WebhookRuntime = {
	// Fresh on every call: `now` is the current time in ms.
	env(): WebhookEnv;
	fetch(input: SafeFetchInput, allowPrivate: boolean): Promise<SafeFetchResult>;
};

const defaultRuntime: WebhookRuntime = {
	env: () => ({
		key: webhookKey,
		maxPerUser: webhookMaxPerUser,
		max: webhookMax,
		allowPrivate: webhookAllowPrivate,
		now: Date.now()
	}),
	fetch: (input, allowPrivate) => safeFetch(input, { allowPrivate })
};

let current: WebhookRuntime | null = null;

export function webhookRuntime(): WebhookRuntime {
	return current ?? defaultRuntime;
}

export function setWebhookRuntime(runtime: WebhookRuntime | null): void {
	current = runtime;
}
