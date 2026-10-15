import { describe, expect, it } from 'vitest';
import { DomainError } from './errors.ts';
import { formatTicketKey, normalizeProjectKey, parseTicketKey } from './keys.ts';

describe('normalizeProjectKey', () => {
	it('uppercases a key of 2 to 6 letters or digits that starts with a letter', () => {
		expect(normalizeProjectKey('am')).toBe('AM');
		expect(normalizeProjectKey('a1b2c3')).toBe('A1B2C3');
	});

	it.each(['A', 'ABCDEFG', '1AB', 'A-B', 'A_B', 'Ä1'])('rejects %s', (key) => {
		expect(() => normalizeProjectKey(key)).toThrow(DomainError);
	});
});

describe('parseTicketKey', () => {
	it('parses a key in any case', () => {
		expect(parseTicketKey('am-123')).toEqual({ projectKey: 'AM', number: 123 });
		expect(parseTicketKey('Am-7')).toEqual({ projectKey: 'AM', number: 7 });
	});

	it('returns null for anything that is not a canonical Ticket key', () => {
		expect(parseTicketKey('AM-0')).toBeNull();
		expect(parseTicketKey('AM-007')).toBeNull();
		expect(parseTicketKey('AM123')).toBeNull();
		expect(parseTicketKey('A-1')).toBeNull();
		expect(parseTicketKey('AM-1x')).toBeNull();
	});

	it('formats the key it parses', () => {
		expect(formatTicketKey('AM', 12)).toBe('AM-12');
	});
});
