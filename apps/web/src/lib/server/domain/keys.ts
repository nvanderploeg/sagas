import { DomainError } from './errors.ts';

const PROJECT_KEY = /^[A-Z][A-Z0-9]{1,5}$/;
const TICKET_KEY = /^([A-Z][A-Z0-9]{1,5})-([1-9][0-9]*)$/;

export function normalizeProjectKey(input: string): string {
	const key = input.trim().toUpperCase();
	if (!PROJECT_KEY.test(key)) {
		throw new DomainError(
			'invalid',
			'Project key must be 2 to 6 letters or digits, starting with a letter'
		);
	}
	return key;
}

export function parseTicketKey(input: string): { projectKey: string; number: number } | null {
	const match = TICKET_KEY.exec(input.trim().toUpperCase());
	if (!match) return null;
	return { projectKey: match[1], number: Number(match[2]) };
}

export function formatTicketKey(projectKey: string, number: number): string {
	return `${projectKey}-${number}`;
}
