import { describe, expect, it } from 'vitest';
import { DomainError } from './errors.ts';
import { formatLabourKey, normalizeRealmKey, parseLabourKey } from './keys.ts';

describe('normalizeRealmKey', () => {
	it('uppercases a key of 2 to 6 letters or digits that starts with a letter', () => {
		expect(normalizeRealmKey('am')).toBe('AM');
		expect(normalizeRealmKey('a1b2c3')).toBe('A1B2C3');
	});

	it.each(['A', 'ABCDEFG', '1AB', 'A-B', 'A_B', 'Ä1'])('rejects %s', (key) => {
		expect(() => normalizeRealmKey(key)).toThrow(DomainError);
	});
});

describe('parseLabourKey', () => {
	it('parses a key in any case', () => {
		expect(parseLabourKey('am-123')).toEqual({ realmKey: 'AM', number: 123 });
		expect(parseLabourKey('Am-7')).toEqual({ realmKey: 'AM', number: 7 });
	});

	it('returns null for anything that is not a canonical Labour key', () => {
		expect(parseLabourKey('AM-0')).toBeNull();
		expect(parseLabourKey('AM-007')).toBeNull();
		expect(parseLabourKey('AM123')).toBeNull();
		expect(parseLabourKey('A-1')).toBeNull();
		expect(parseLabourKey('AM-1x')).toBeNull();
	});

	it('formats the key it parses', () => {
		expect(formatLabourKey('AM', 12)).toBe('AM-12');
	});
});
