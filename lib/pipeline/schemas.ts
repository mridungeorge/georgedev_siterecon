import { z } from "zod";

export const ModuleNameSchema = z.enum(["technical", "geo", "content", "social", "competitors", "performance"]);
export const SeveritySchema = z.enum(["critical", "high", "medium", "low"]);
export const EffortSchema = z.enum(["low", "medium", "high"]);

export const EvidenceSchema = z.object({
  url: z.string(),
  quote: z.string().optional(),
  note: z.string().optional(),
});

export const FindingSchema = z.object({
  id: z.string(),
  module: ModuleNameSchema,
  severity: SeveritySchema,
  title: z.string(),
  detail: z.string(),
  // The spec's core rule: a finding with no evidence is not a finding.
  evidence: z.array(EvidenceSchema).min(1),
  fix: z.string(),
  effort: EffortSchema,
});

export const CouldntCheckSchema = z.object({ what: z.string(), why: z.string() });

/** A marketing idea. It must point at a finding that really exists in the same report. */
export const IdeaSchema = z.object({
  title: z.string(),
  why: z.string(),
  findingId: z.string(),
  effort: EffortSchema,
});
export type Idea = z.infer<typeof IdeaSchema>;

export const PlatformSchema = z.enum(["facebook", "instagram", "x", "linkedin", "youtube", "tiktok", "pinterest", "github"]);
export type Platform = z.infer<typeof PlatformSchema>;

/** One social profile linked from the site, and what a public read of it showed. */
export const SocialProfileSchema = z.object({
  platform: PlatformSchema,
  url: z.string(),
  handle: z.string().nullable(),
  kind: z.enum(["profile", "homepage"]),
  status: z.enum(["linked", "found", "not_found", "login_wall", "unreadable"]),
  title: z.string().optional(),
  note: z.string().optional(),
  lastActivityAt: z.string().optional(),
});
export type SocialProfile = z.infer<typeof SocialProfileSchema>;

export const SocialSummarySchema = z.object({
  profiles: z.array(SocialProfileSchema),
  /** Key platforms (Facebook, Instagram, LinkedIn) the site does not link to. */
  missing: z.array(PlatformSchema),
  mentions: z.object({ hackerNews: z.number().int().min(0) }).nullable().default(null),
  readerUsed: z.boolean(),
});
export type SocialSummary = z.infer<typeof SocialSummarySchema>;

export const CompetitorRowSchema = z.object({
  domain: z.string(),
  url: z.string(),
  source: z.enum(["ai", "search"]),
  technical: z.number().nullable(),
  geo: z.number().nullable(),
  platforms: z.array(PlatformSchema),
  /** Ids of the SEO and AI-visibility checks this competitor passes. Reports stored before this existed have none. */
  passed: z.array(z.string()).default([]),
});
export type CompetitorRow = z.infer<typeof CompetitorRowSchema>;

export const CompetitorTableSchema = z.object({
  rows: z.array(CompetitorRowSchema),
  gaps: z.array(z.string()),
  note: z.string().optional(),
});
export type CompetitorTable = z.infer<typeof CompetitorTableSchema>;

export const ModuleResultSchema = z.object({
  module: ModuleNameSchema,
  status: z.enum(["ok", "partial", "failed"]),
  score: z.number().min(0).max(100).nullable(),
  findings: z.array(FindingSchema),
  passed: z.array(z.string()),
  couldntCheck: z.array(CouldntCheckSchema),
});

/** One page that was read: what it says about itself and how many findings point at it. */
export const PageRowSchema = z.object({
  url: z.string(),
  title: z.string(),
  description: z.string(),
  h1: z.number().int().min(0),
  words: z.number().int().min(0),
  issues: z.number().int().min(0),
});
export type PageRow = z.infer<typeof PageRowSchema>;

/** A short plain-language read on the whole report and a plan for fixing it, worked out from the findings alone. */
export const ReportSummarySchema = z.object({
  grade: z.enum(["A", "B", "C", "D", "F"]).nullable(),
  verdict: z.string(),
  strongest: z.object({ module: ModuleNameSchema, score: z.number() }).nullable(),
  weakest: z.object({ module: ModuleNameSchema, score: z.number() }).nullable(),
  counts: z.object({ critical: z.number().int(), high: z.number().int(), medium: z.number().int(), low: z.number().int() }),
  /** Ids of cheap fixes that matter. */
  quickWins: z.array(z.string()),
  /** Every finding id, grouped by how much work it takes to fix. */
  roadmap: z.object({ thisWeek: z.array(z.string()), thisMonth: z.array(z.string()), thisQuarter: z.array(z.string()) }),
});
export type ReportSummary = z.infer<typeof ReportSummarySchema>;

/** A file or snippet, built from the site's own data, that fixes one or more findings when pasted in. */
export const FixKitItemSchema = z.object({
  id: z.string(),
  title: z.string(),
  /** Where it goes: a file name such as robots.txt, or a place such as "the page head". */
  filename: z.string(),
  language: z.enum(["html", "json", "xml", "text"]),
  content: z.string(),
  /** What to check before using it. */
  note: z.string(),
  forFindings: z.array(z.string()),
});
export type FixKitItem = z.infer<typeof FixKitItemSchema>;

export const ReportSchema = z.object({
  id: z.string(),
  url: z.string(),
  domain: z.string(),
  createdAt: z.string(),
  overallScore: z.number().min(0).max(100).nullable(),
  modules: z.array(ModuleResultSchema),
  topFixes: z.array(FindingSchema),
  fixPrompt: z.string(),
  couldntCheck: z.array(CouldntCheckSchema),
  pagesScanned: z.array(z.string()),
  injectionFlags: z.number().int().min(0),
  // Reports stored before marketing ideas existed have none, so they still load.
  ideas: z.array(IdeaSchema).default([]),
  // Added later: reports stored before these existed still load, with them empty.
  social: SocialSummarySchema.nullable().default(null),
  competitors: CompetitorTableSchema.nullable().default(null),
  summary: ReportSummarySchema.nullable().default(null),
  fixKit: z.array(FixKitItemSchema).default([]),
  /** One row per page read, homepage first. Reports stored before this existed have none. */
  pageTable: z.array(PageRowSchema).default([]),
});

export type ModuleName = z.infer<typeof ModuleNameSchema>;
export type Severity = z.infer<typeof SeveritySchema>;
export type Effort = z.infer<typeof EffortSchema>;
export type Evidence = z.infer<typeof EvidenceSchema>;
export type Finding = z.infer<typeof FindingSchema>;
export type CouldntCheck = z.infer<typeof CouldntCheckSchema>;
export type ModuleResult = z.infer<typeof ModuleResultSchema>;
export type Report = z.infer<typeof ReportSchema>;

/** One weighted pass/fail from a deterministic check. A failed outcome carries its finding. */
export interface CheckOutcome {
  id: string;
  weight: number;
  passed: boolean;
  /** For a failed check on a measured value: the share of the weight still earned, from 0 to 1. */
  credit?: number;
  finding?: Finding;
}
