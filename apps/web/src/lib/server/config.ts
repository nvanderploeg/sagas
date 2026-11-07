import { resolve } from 'node:path';

export function databaseUrl(): string {
	const url = process.env.DATABASE_URL;
	if (!url) throw new Error('DATABASE_URL is not set');
	return url;
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

function positiveNumber(name: string, raw: string | undefined, fallback: number): number {
	if (raw === undefined || raw.trim() === '') return fallback;
	const value = Number(raw);
	if (!Number.isFinite(value) || value <= 0) {
		throw new Error(`${name} must be a positive number, got "${raw}"`);
	}
	return value;
}

export const eventRetentionMs =
	positiveNumber('EVENT_RETENTION_DAYS', process.env.EVENT_RETENTION_DAYS, 7) * DAY_MS;

export const surveyRetentionMs =
	positiveNumber('SURVEY_RETENTION_DAYS', process.env.SURVEY_RETENTION_DAYS, 30) * DAY_MS;

export const streamHeartbeatMs = positiveNumber(
	'STREAM_HEARTBEAT_MS',
	process.env.STREAM_HEARTBEAT_MS,
	25_000
);

// Domain of the shared session cookie, such as `.nanzero.com`; unset gives a host-only cookie.
export const authCookieDomain = process.env.AUTH_COOKIE_DOMAIN?.trim() || undefined;

export const firebaseProjectId = process.env.FIREBASE_PROJECT_ID?.trim() || 'runestone-d3a35';

// Public web config the sign-in page hands to the Firebase client SDK.
export const firebaseWebConfig = {
	apiKey: process.env.FIREBASE_WEB_API_KEY?.trim() ?? '',
	authDomain: process.env.FIREBASE_AUTH_DOMAIN?.trim() || `${firebaseProjectId}.firebaseapp.com`,
	projectId: firebaseProjectId,
	appId: process.env.FIREBASE_APP_ID?.trim() || undefined
};

export function parseAdminEmails(raw: string | undefined): Set<string> {
	return new Set(
		(raw ?? '')
			.split(',')
			.map((email) => email.trim().toLowerCase())
			.filter((email) => email !== '')
	);
}

// A signed-in User with one of these verified emails is an Admin.
export const adminEmails = parseAdminEmails(process.env.ADMIN_EMAILS);

export const embeddingModelDir = resolve(process.env.EMBEDDING_MODEL_DIR ?? 'models');

function positiveInteger(name: string, raw: string | undefined, fallback: number): number {
	if (raw === undefined || raw.trim() === '') return fallback;
	const value = Number(raw);
	if (!Number.isInteger(value) || value <= 0) {
		throw new Error(`${name} must be a positive integer, got "${raw}"`);
	}
	return value;
}

export const embeddingThreads = positiveInteger(
	'EMBEDDING_THREADS',
	process.env.EMBEDDING_THREADS,
	2
);

export function parseWebhookKey(raw: string | undefined): Buffer | undefined {
	if (raw === undefined || raw.trim() === '') return undefined;
	const text = raw.trim();
	const key = Buffer.from(text, 'base64');
	if (!/^[A-Za-z0-9+/]+={0,2}$/.test(text) || key.length !== 32) {
		throw new Error('WEBHOOK_KEY must be 32 bytes in base64');
	}
	return key;
}

export const webhookKey = parseWebhookKey(process.env.WEBHOOK_KEY);

export const webhookMaxPerUser = positiveInteger(
	'WEBHOOK_MAX_PER_USER',
	process.env.WEBHOOK_MAX_PER_USER,
	10
);

export const webhookMax = positiveInteger('WEBHOOK_MAX', process.env.WEBHOOK_MAX, 50);

export const webhookAllowPrivate = process.env.WEBHOOK_ALLOW_PRIVATE === 'true';

export const webhookConcurrency = positiveInteger(
	'WEBHOOK_CONCURRENCY',
	process.env.WEBHOOK_CONCURRENCY,
	4
);

export const webhookDisableAfterMs =
	positiveNumber('WEBHOOK_DISABLE_AFTER_HOURS', process.env.WEBHOOK_DISABLE_AFTER_HOURS, 72) *
	HOUR_MS;

const MIB = 1024 ** 2;

// Caps the upload; the unpacked bundle may be four times this.
export const importMaxBytes = positiveInteger(
	'SAGAS_IMPORT_MAX_BYTES',
	process.env.SAGAS_IMPORT_MAX_BYTES,
	200 * MIB
);
