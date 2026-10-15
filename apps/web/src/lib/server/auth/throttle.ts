const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES = 8;
const MAX_KEYS = 10_000;

const failures = new Map<string, number[]>();

function recent(key: string, now: number): number[] {
	const times = (failures.get(key) ?? []).filter((t) => now - t < WINDOW_MS);
	if (times.length === 0) failures.delete(key);
	else failures.set(key, times);
	return times;
}

export function isThrottled(keys: string[], now = Date.now()): boolean {
	return keys.some((key) => recent(key, now).length >= MAX_FAILURES);
}

export function recordFailure(keys: string[], now = Date.now()): void {
	for (const key of keys) {
		failures.set(key, [...recent(key, now), now]);
	}
	if (failures.size > MAX_KEYS) failures.delete(failures.keys().next().value!);
}

export function clearFailures(keys: string[]): void {
	for (const key of keys) failures.delete(key);
}

export function resetThrottle(): void {
	failures.clear();
}
