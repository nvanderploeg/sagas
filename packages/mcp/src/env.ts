import {
	DEFAULT_CALL_TIMEOUT_MS,
	DEFAULT_POLL_MS,
	DEFAULT_SENTIMENT_MS,
	type HelperOptions
} from './server.ts';

export const MIN_INTERVAL_MS = 5_000;
export const MAX_INTERVAL_MS = 86_400_000;

type Env = Record<string, string | undefined>;

function interval(env: Env, name: string, fallback: number, warn: (message: string) => void) {
	const raw = env[name]?.trim();
	if (!raw) return fallback;
	const ms = Number(raw);
	if (!Number.isFinite(ms)) {
		warn(`${name} is not a number (${raw}); using ${fallback}`);
		return fallback;
	}
	if (ms === 0) return 0;
	const clamped = Math.round(Math.min(MAX_INTERVAL_MS, Math.max(MIN_INTERVAL_MS, ms)));
	if (clamped !== ms) warn(`${name} ${raw} is out of range; using ${clamped}`);
	return clamped;
}

// setTimeout fires at once for any delay above 2^31 − 1 ms.
const TIMEOUT_MAX = 2_147_483_647;

function timeout(env: Env, name: string, fallback: number, warn: (message: string) => void) {
	const raw = env[name]?.trim();
	if (!raw) return fallback;
	const ms = Number(raw);
	if (Number.isFinite(ms) && ms > 0 && ms <= TIMEOUT_MAX) return ms;
	warn(`${name} is not a number from 1 to ${TIMEOUT_MAX} (${raw}); using ${fallback}`);
	return fallback;
}

export function optionsFromEnv(
	env: Env,
	warn: (message: string) => void
): HelperOptions | { error: string } {
	const url = env.SAGAS_URL?.trim();
	if (!url) return { error: 'SAGAS_URL is not set' };
	try {
		new URL(url);
	} catch {
		return { error: `SAGAS_URL is not a URL: ${url}` };
	}
	return {
		url,
		token: env.SAGAS_TOKEN?.trim() ?? '',
		pollMs: interval(env, 'SAGAS_POLL_MS', DEFAULT_POLL_MS, warn),
		sentimentMs: interval(env, 'SAGAS_SENTIMENT_MS', DEFAULT_SENTIMENT_MS, warn),
		callTimeoutMs: timeout(env, 'SAGAS_CALL_TIMEOUT_MS', DEFAULT_CALL_TIMEOUT_MS, warn)
	};
}
