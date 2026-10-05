export const STEPS = ["fetch", "render", "technical", "geo", "content", "performance", "social", "competitors", "synthesis"] as const;
export type StepName = (typeof STEPS)[number];
