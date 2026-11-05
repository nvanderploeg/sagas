import { describe, expect, it } from 'vitest';
import { DomainError } from './errors.ts';
import { nextOccurrence, occurrence, parseDate, requireTimezone } from './schedule.ts';

const monthly = (startsOn: string, timezone = 'UTC') =>
	({ unit: 'month', every: 1, startsOn, timezone }) as const;
const iso = (date: Date) => date.toISOString();

describe('occurrence', () => {
	it('steps by days and weeks', () => {
		expect(
			iso(occurrence({ unit: 'day', every: 3, startsOn: '2026-01-30', timezone: 'UTC' }, 1))
		).toBe('2026-02-02T00:00:00.000Z');
		expect(
			iso(occurrence({ unit: 'week', every: 2, startsOn: '2026-01-01', timezone: 'UTC' }, 2))
		).toBe('2026-01-29T00:00:00.000Z');
	});

	it('clamps a month day to the last day, then returns to it', () => {
		const cadence = monthly('2026-01-31');
		expect(iso(occurrence(cadence, 1))).toBe('2026-02-28T00:00:00.000Z');
		expect(iso(occurrence(cadence, 2))).toBe('2026-03-31T00:00:00.000Z');
		expect(iso(occurrence(cadence, 13))).toBe('2027-02-28T00:00:00.000Z');
	});

	it('clamps a leap day in non-leap years', () => {
		const cadence = { unit: 'year', every: 1, startsOn: '2028-02-29', timezone: 'UTC' } as const;
		expect(iso(occurrence(cadence, 1))).toBe('2029-02-28T00:00:00.000Z');
		expect(iso(occurrence(cadence, 4))).toBe('2032-02-29T00:00:00.000Z');
	});

	it('starts at local midnight in the zone', () => {
		expect(iso(occurrence(monthly('2026-01-15', 'America/Edmonton'), 0))).toBe(
			'2026-01-15T07:00:00.000Z'
		);
		expect(iso(occurrence(monthly('2026-01-15', 'America/Edmonton'), 6))).toBe(
			'2026-07-15T06:00:00.000Z'
		);
	});
});

describe('nextOccurrence', () => {
	it('is strictly after the given instant', () => {
		const cadence = monthly('2026-01-01');
		expect(iso(nextOccurrence(cadence, new Date('2026-03-01T00:00:00Z')))).toBe(
			'2026-04-01T00:00:00.000Z'
		);
		expect(iso(nextOccurrence(cadence, new Date('2026-03-14T12:00:00Z')))).toBe(
			'2026-04-01T00:00:00.000Z'
		);
	});

	it('is the first occurrence when the start is in the future', () => {
		expect(iso(nextOccurrence(monthly('2027-01-01'), new Date('2026-03-14T12:00:00Z')))).toBe(
			'2027-01-01T00:00:00.000Z'
		);
	});
});

describe('validation', () => {
	it('rejects impossible dates and unknown zones', () => {
		expect(() => parseDate('2026-02-30')).toThrow(DomainError);
		expect(() => parseDate('tomorrow')).toThrow(DomainError);
		expect(() => requireTimezone('Mars/Olympus')).toThrow(DomainError);
	});
});
