import { createHash, randomBytes } from 'node:crypto';

export const API_TOKEN_PREFIX = 'wlt_';
export const INVITE_PREFIX = 'wli_';
export const SESSION_PREFIX = 'wls_';
export const OAUTH_CLIENT_PREFIX = 'wlc_';
export const OAUTH_CLIENT_SECRET_PREFIX = 'wlk_';
export const OAUTH_CODE_PREFIX = 'wla_';
export const OAUTH_REFRESH_PREFIX = 'wlr_';

export function generateSecret(prefix: string): string {
	return `${prefix}${randomBytes(32).toString('base64url')}`;
}

export function hashSecret(secret: string): string {
	return createHash('sha256').update(secret).digest('hex');
}
