// Timing budgets assume a developer machine with the database on the same host: twice as long
// there for the round trips, four times on shared CI runners.
export const budget = (ms: number): number => ms * (process.env.CI ? 4 : 2);
