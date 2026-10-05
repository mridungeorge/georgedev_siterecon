export const STEPS = ["fetch", "technical", "geo", "synthesis"] as const;
export type StepName = (typeof STEPS)[number];
