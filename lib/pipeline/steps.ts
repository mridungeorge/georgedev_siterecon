export const STEPS = ["fetch", "technical", "geo", "content", "performance", "synthesis"] as const;
export type StepName = (typeof STEPS)[number];
