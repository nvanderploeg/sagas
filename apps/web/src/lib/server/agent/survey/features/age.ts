import { daysSince } from './decay.ts';
import type { Feature } from './types.ts';

export const age: Feature = {
	name: 'age',
	load({ candidates, now }) {
		return new Map(
			candidates.map(({ id, createdAt }) => {
				const d = daysSince(now, createdAt);
				return [id, d / (d + 30)];
			})
		);
	}
};
