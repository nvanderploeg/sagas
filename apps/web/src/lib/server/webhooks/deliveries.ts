import { and, desc, eq, lt } from 'drizzle-orm';
import type { Handle } from '#lib/server/db/client.ts';
import { webhookDeliveries } from '#lib/server/db/schema.ts';

export type DeliveryInput = {
	webhookId: number;
	attemptedAt: number;
	messageId: string;
	kind: 'events' | 'reset' | 'ping';
	firstSeq: number | null;
	lastSeq: number | null;
	status: number | null;
	error: string | null;
	durationMs: number;
	responseBody: string | null;
};

export type DeliveryInfo = Omit<DeliveryInput, 'attemptedAt'> & { id: number; attemptedAt: Date };

const BODY_MAX_BYTES = 512;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

function truncateUtf8(text: string, maxBytes: number): string {
	const bytes = Buffer.from(text, 'utf8');
	if (bytes.length <= maxBytes) return text;
	let end = maxBytes;
	while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
	return bytes.subarray(0, end).toString('utf8');
}

export function recordDelivery(db: Handle, input: DeliveryInput): void {
	db.insert(webhookDeliveries)
		.values({
			...input,
			attemptedAt: new Date(input.attemptedAt),
			responseBody:
				input.responseBody === null ? null : truncateUtf8(input.responseBody, BODY_MAX_BYTES)
		})
		.run();
}

export function listDeliveries(
	db: Handle,
	webhookId: number,
	page: { before?: number; limit?: number } = {}
): { deliveries: DeliveryInfo[]; nextBefore: number | null } {
	const limit = Math.min(Math.max(Math.floor(page.limit ?? DEFAULT_LIMIT), 1), MAX_LIMIT);
	const rows = db
		.select()
		.from(webhookDeliveries)
		.where(
			and(
				eq(webhookDeliveries.webhookId, webhookId),
				page.before === undefined ? undefined : lt(webhookDeliveries.id, page.before)
			)
		)
		.orderBy(desc(webhookDeliveries.id))
		.limit(limit + 1)
		.all();
	const more = rows.length > limit;
	const deliveries = more ? rows.slice(0, limit) : rows;
	return { deliveries, nextBefore: more ? deliveries[deliveries.length - 1]!.id : null };
}

export function pruneDeliveries(db: Handle, retentionMs: number, now = Date.now()): number {
	return db
		.delete(webhookDeliveries)
		.where(lt(webhookDeliveries.attemptedAt, new Date(now - retentionMs)))
		.run().changes;
}
