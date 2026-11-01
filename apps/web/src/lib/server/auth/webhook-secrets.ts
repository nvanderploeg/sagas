import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

const NONCE_BYTES = 12;
const TAG_BYTES = 16;

export class WrongKeyError extends Error {
	constructor() {
		super('webhook secret was sealed under another key');
		this.name = 'WrongKeyError';
	}
}

export class TamperedError extends Error {
	constructor() {
		super('webhook secret is malformed or was tampered with');
		this.name = 'TamperedError';
	}
}

export function keyFingerprint(key: Buffer): string {
	return createHash('sha256').update(key).digest('hex').slice(0, 16);
}

export function generateWebhookSecret(): string {
	return `whsec_${randomBytes(32).toString('base64')}`;
}

export function seal(plain: string, key: Buffer): string {
	const nonce = randomBytes(NONCE_BYTES);
	const cipher = createCipheriv('aes-256-gcm', key, nonce);
	const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final(), cipher.getAuthTag()]);
	return `${keyFingerprint(key)}.${nonce.toString('base64url')}.${body.toString('base64url')}`;
}

function split(sealed: string): [string, string, string] {
	const parts = sealed.split('.');
	if (parts.length !== 3 || !/^[0-9a-f]{16}$/.test(parts[0])) throw new TamperedError();
	return [parts[0], parts[1], parts[2]];
}

export function sealedFingerprint(sealed: string): string {
	return split(sealed)[0];
}

export function open(sealed: string, key: Buffer): string {
	const [fingerprint, nonceText, bodyText] = split(sealed);
	if (fingerprint !== keyFingerprint(key)) throw new WrongKeyError();
	const nonce = Buffer.from(nonceText, 'base64url');
	const body = Buffer.from(bodyText, 'base64url');
	if (nonce.length !== NONCE_BYTES || body.length < TAG_BYTES) throw new TamperedError();
	try {
		const decipher = createDecipheriv('aes-256-gcm', key, nonce);
		decipher.setAuthTag(body.subarray(body.length - TAG_BYTES));
		return Buffer.concat([
			decipher.update(body.subarray(0, body.length - TAG_BYTES)),
			decipher.final()
		]).toString('utf8');
	} catch {
		throw new TamperedError();
	}
}
