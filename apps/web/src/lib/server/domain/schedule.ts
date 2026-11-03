import { DomainError } from './errors.ts';

export type Unit = 'day' | 'week' | 'month' | 'year';

export type Cadence = {
	unit: Unit;
	every: number;
	// A local calendar date, YYYY-MM-DD.
	startsOn: string;
	// An IANA zone name.
	timezone: string;
};

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MAX_ITERATIONS = 100_000;

export function requireTimezone(zone: string): string {
	try {
		new Intl.DateTimeFormat('en-US', { timeZone: zone });
	} catch {
		throw new DomainError('invalid', `Timezone "${zone}" is not an IANA zone name`);
	}
	return zone;
}

export function parseDate(value: string): { year: number; month: number; day: number } {
	const match = DATE.exec(value);
	if (match) {
		const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
		const date = new Date(Date.UTC(year, month - 1, day));
		if (date.getUTCMonth() === month - 1 && date.getUTCDate() === day) {
			return { year, month, day };
		}
	}
	throw new DomainError('invalid', `Start date "${value}" must be a calendar date, YYYY-MM-DD`);
}

function offsetAt(ms: number, zone: string): number {
	const parts = new Intl.DateTimeFormat('en-US', {
		timeZone: zone,
		hourCycle: 'h23',
		year: 'numeric',
		month: 'numeric',
		day: 'numeric',
		hour: 'numeric',
		minute: 'numeric',
		second: 'numeric'
	}).formatToParts(new Date(ms));
	const get = (type: string) => Number(parts.find((part) => part.type === type)!.value);
	const local = Date.UTC(
		get('year'),
		get('month') - 1,
		get('day'),
		get('hour'),
		get('minute'),
		get('second')
	);
	return local - Math.floor(ms / 1000) * 1000;
}

// Midnight starting a local date. A midnight skipped by a clock change lands on the first instant
// after the gap.
function midnight(year: number, month: number, day: number, zone: string): number {
	const wall = Date.UTC(year, month - 1, day);
	const first = wall - offsetAt(wall, zone);
	return wall - offsetAt(first, zone);
}

// The date `steps` cadences after the start, measured from the start itself so a 31st stays the
// 31st in the months that have one and clamps to the last day in the rest.
function dateAfter(cadence: Cadence, steps: number) {
	const start = parseDate(cadence.startsOn);
	const by = steps * cadence.every;
	if (cadence.unit === 'day' || cadence.unit === 'week') {
		const days = cadence.unit === 'week' ? by * 7 : by;
		const date = new Date(Date.UTC(start.year, start.month - 1, start.day + days));
		return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
	}
	const months = cadence.unit === 'year' ? by * 12 : by;
	const index = start.year * 12 + (start.month - 1) + months;
	const year = Math.floor(index / 12);
	const month = (index % 12) + 1;
	const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
	return { year, month, day: Math.min(start.day, last) };
}

export function occurrence(cadence: Cadence, steps: number): Date {
	const { year, month, day } = dateAfter(cadence, steps);
	return new Date(midnight(year, month, day, cadence.timezone));
}

// The first occurrence strictly after `after`.
export function nextOccurrence(cadence: Cadence, after: Date): Date {
	for (let steps = 0; steps < MAX_ITERATIONS; steps++) {
		const at = occurrence(cadence, steps);
		if (at.getTime() > after.getTime()) return at;
	}
	throw new DomainError('invalid', 'The schedule has no occurrence in range');
}
