import { DomainError } from './errors.ts';

const REALM_KEY = /^[A-Z][A-Z0-9]{1,5}$/;
const LABOUR_KEY = /^([A-Z][A-Z0-9]{1,5})-([1-9][0-9]*)$/;

export function normalizeRealmKey(input: string): string {
	const key = input.trim().toUpperCase();
	if (!REALM_KEY.test(key)) {
		throw new DomainError(
			'invalid',
			'Realm key must be 2 to 6 letters or digits, starting with a letter'
		);
	}
	return key;
}

export function parseLabourKey(input: string): { realmKey: string; number: number } | null {
	const match = LABOUR_KEY.exec(input.trim().toUpperCase());
	if (!match) return null;
	return { realmKey: match[1], number: Number(match[2]) };
}

export function formatLabourKey(realmKey: string, number: number): string {
	return `${realmKey}-${number}`;
}
