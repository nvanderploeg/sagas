import { createHmac } from 'node:crypto';

export type DeliveryKind =
	| { kind: 'events'; webhookId: number; firstSeq: number; lastSeq: number }
	| { kind: 'reset'; webhookId: number; seq: number }
	| { kind: 'ping'; webhookId: number; timestamp: number };

export function webhookMessageId(kind: DeliveryKind): string {
	switch (kind.kind) {
		case 'events':
			return `${kind.webhookId}:${kind.firstSeq}-${kind.lastSeq}`;
		case 'reset':
			return `${kind.webhookId}:reset-${kind.seq}`;
		case 'ping':
			return `${kind.webhookId}:ping-${kind.timestamp}`;
	}
}

const PREFIX = 'whsec_';

function sign(secret: string, content: string): string {
	if (!secret.startsWith(PREFIX)) throw new Error('webhook secret must start with whsec_');
	const key = Buffer.from(secret.slice(PREFIX.length), 'base64');
	if (key.length !== 32) throw new Error('webhook secret must carry 32 bytes');
	return `v1,${createHmac('sha256', key).update(content).digest('base64')}`;
}

export function signedHeaders(
	kind: DeliveryKind,
	body: string,
	secrets: string[],
	now: number
): Record<string, string> {
	const id = webhookMessageId(kind);
	const timestamp = String(Math.floor(now / 1000));
	const content = `${id}.${timestamp}.${body}`;
	return {
		'content-type': 'application/json',
		'user-agent': 'sagas-webhooks',
		'webhook-id': id,
		'webhook-timestamp': timestamp,
		'webhook-signature': secrets.map((s) => sign(s, content)).join(' ')
	};
}
