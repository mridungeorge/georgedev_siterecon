import { z } from "zod";
import { TelemetrySchema } from "@/lib/telemetry";

export const ModuleNameSchema = z.enum(["technical", "geo", "content", "marketing", "social", "competitors", "performance", "citation", "crawl"]);
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
  /** How the competitor presents itself, cut short. Reports stored before this existed have none. */
  title: z.string().default(""),
  headline: z.string().default(""),
  description: z.string().default(""),
  /** Ids of the SEO and AI-visibility checks this competitor passes. Reports stored before this existed have none. */
  passed: z.array(z.string()).default([]),
  /** schema.org types on the competitor's homepage. Reports stored before this existed have none. */
  schemaTypes: z.array(z.string()).default([]),
  /** Words of visible text on the homepage. */
  words: z.number().int().min(0).default(0),
  /** The most repeated meaningful words in its title and headings. */
  topics: z.array(z.string()).default([]),
  /** Named places, brands and people on the homepage, lower case. */
  entities: z.array(z.string()).default([]),
  /** Pages its sitemap lists. 0 when it has none. */
  sitemapUrls: z.number().int().min(0).default(0),
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
  /** The text of the first H1. Reports stored before this existed have none. */
  headline: z.string().default(""),
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

const ReadinessComponentSchema = z.object({
  id: z.enum(["crawler-access", "structured-data", "answer-blocks", "entity-clarity", "render-parity", "freshness"]),
  label: z.string(),
  weight: z.number(),
  score: z.number().min(0).max(100).nullable(),
  passed: z.array(z.string()),
  failed: z.array(z.string()),
});

/** The AI Readiness Score: a lens over the checks that ran, with the check ids behind each component. */
export const AiReadinessSchema = z.object({
  score: z.number().min(0).max(100),
  band: z.enum(["Strong", "Moderate", "Weak", "Very weak"]),
  verdict: z.string(),
  components: z.array(ReadinessComponentSchema),
});

/** Detail behind the crawl, citation and speed modules: shown in the report, never part of a score. */
export const InsightsSchema = z.object({
  vitals: z.object({
    source: z.enum(["pagespeed", "browser"]).default("pagespeed"),
    lcp: z.object({ ms: z.number(), element: z.string().nullable(), resource: z.string().nullable() }),
    cls: z.object({ value: z.number(), shifts: z.array(z.object({ selector: z.string(), score: z.number() })) }),
    inp: z.object({ ms: z.number(), rating: z.enum(["good", "needs improvement", "poor"]), source: z.enum(["field", "lab"]).default("field") }).nullable(),
    blockers: z.array(z.object({ url: z.string(), wastedMs: z.number() })),
    heavyScripts: z.array(z.object({ url: z.string(), ms: z.number() })),
  }).nullable().default(null),
  crawl: z.object({
    statusClasses: z.object({ ok: z.number(), redirected: z.number(), clientError: z.number(), serverError: z.number(), unreachable: z.number().default(0) }),
    sitemapUrls: z.number().nullable(),
    coverage: z.object({
      sitemapUrls: z.number(),
      fetched: z.number(),
      complete: z.boolean(),
      childSitemaps: z.object({ listed: z.number(), read: z.number() }).nullable().default(null),
    }).nullable().default(null),
    orphanCheck: z.enum(["ran", "incomplete", "no-sitemap"]).default("no-sitemap"),
    renderDiff: z.array(z.object({ label: z.string(), raw: z.number(), rendered: z.number() })),
  }).nullable().default(null),
  citation: z.object({
    pages: z.array(z.object({
      url: z.string(),
      score: z.number().nullable(),
      criteria: z.record(z.string(), z.enum(["pass", "partial", "fail", "n/a"])),
    })),
    extractable: z.object({
      entity: z.string().nullable(),
      definition: z.string().nullable(),
      facts: z.array(z.string()),
      questions: z.array(z.object({ q: z.string(), a: z.string() })),
    }),
    /** Outside signals of authority, when any were read. */
    authority: z.object({
      domainRank: z.number().nullable(),
      wikidata: z.boolean().nullable(),
      hackerNews: z.number().nullable(),
    }).nullable().default(null),
    /** What a model could lift, each answer backed by a quote from the page. Empty without an AI service. */
    aiExtraction: z.array(z.object({ id: z.string(), label: z.string(), kind: z.enum(["fact", "keyword"]).default("fact"), extractable: z.boolean(), quote: z.string() })).default([]),
  }).nullable().default(null),
  schemaGaps: z.array(z.object({
    url: z.string(),
    type: z.enum(["FAQPage", "Article", "Product"]),
    reason: z.string(),
    snippet: z.record(z.string(), z.unknown()),
    note: z.string(),
  })).default([]),
});
export type Insights = z.infer<typeof InsightsSchema>;

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
  /** Reports stored before these existed have neither. */
  aiReadiness: AiReadinessSchema.nullable().default(null),
  telemetry: TelemetrySchema.nullable().default(null),
  insights: InsightsSchema.nullable().default(null),
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
  /** For a passed AI answer: the passage of the page the model quoted. */
  quote?: string;
  finding?: Finding;
}
