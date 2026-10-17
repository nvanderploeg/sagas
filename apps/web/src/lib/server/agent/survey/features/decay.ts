import { DAY_MS } from '../candidates.ts';

export function daysSince(now: Date, at: number): number {
	return Math.max(0, (now.getTime() - at) / DAY_MS);
}

export function recentShares(now: Date, rows: { id: number; at: number }[]): Map<number, number> {
	const sums = new Map<number, number>();
	for (const { id, at } of rows) sums.set(id, (sums.get(id) ?? 0) + 2 ** (-daysSince(now, at) / 7));
	return new Map([...sums].map(([id, sum]) => [id, 1 - 2 ** -sum]));
}

export function saturating(n: number): number {
	return n / (n + 2);
}
