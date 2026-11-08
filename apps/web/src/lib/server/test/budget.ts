// State every timing budget in local-machine milliseconds; the multiplier absorbs slower runners.
export const budget = (ms: number): number => ms * (process.env.CI ? 8 : 4);
