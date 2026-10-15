export const databasePath = process.env.DATABASE_PATH || '/data/sagas.db';

const DAY_MS = 24 * 60 * 60 * 1000;

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

export const streamHeartbeatMs = positiveNumber(
	'STREAM_HEARTBEAT_MS',
	process.env.STREAM_HEARTBEAT_MS,
	25_000
);
