import { beforeEach, describe, expect, it } from 'vitest';
import { clearFailures, isThrottled, recordFailure, resetThrottle } from './throttle.ts';

describe('login throttle', () => {
	beforeEach(resetThrottle);

	it('blocks a key after repeated failures and frees it once the window passes', () => {
		const start = 1_000_000;
		for (let i = 0; i < 8; i++) recordFailure(['ip:1.2.3.4'], start + i);
		expect(isThrottled(['ip:1.2.3.4'], start + 10)).toBe(true);
		expect(isThrottled(['ip:1.2.3.4'], start + 16 * 60 * 1000)).toBe(false);
	});

	it('blocks when any one of the keys is over the limit', () => {
		for (let i = 0; i < 8; i++) recordFailure(['user:ada', `ip:${i}`]);
		expect(isThrottled(['user:ada', 'ip:new'])).toBe(true);
		expect(isThrottled(['user:bob', 'ip:new'])).toBe(false);
	});

	it('forgets a key after a successful sign-in', () => {
		for (let i = 0; i < 8; i++) recordFailure(['user:ada']);
		clearFailures(['user:ada']);
		expect(isThrottled(['user:ada'])).toBe(false);
	});
});
