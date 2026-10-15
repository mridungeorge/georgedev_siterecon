export const STEPS = ["fetch", "render", "technical", "geo", "crawl", "citation", "content", "marketing", "performance", "social", "competitors", "synthesis"] as const;
export type StepName = (typeof STEPS)[number];
