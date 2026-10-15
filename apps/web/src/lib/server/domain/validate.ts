import { DomainError } from './errors.ts';

export const STATE_KEY = /^[a-z][a-z0-9-]{0,31}$/;
export const COLOR = /^#[0-9a-fA-F]{6}$/;
export const ICON = /^[a-z][a-z0-9-]{0,39}$/;

export function requireText(value: string, field: string, max: number): string {
	const trimmed = value.trim();
	if (trimmed.length === 0 || trimmed.length > max) {
		throw new DomainError('invalid', `${field} must be 1 to ${max} characters`);
	}
	return trimmed;
}

export function requireMatch(value: string, pattern: RegExp, message: string): string {
	if (!pattern.test(value)) throw new DomainError('invalid', message);
	return value;
}
