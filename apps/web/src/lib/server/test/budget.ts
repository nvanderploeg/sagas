// The plan's timing budgets are for a developer machine; shared CI runners get four times as long.
export const budget = (ms: number): number => (process.env.CI ? ms * 4 : ms);
