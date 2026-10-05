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

export const ModuleResultSchema = z.object({
  module: ModuleNameSchema,
  status: z.enum(["ok", "partial", "failed"]),
  score: z.number().min(0).max(100).nullable(),
  findings: z.array(FindingSchema),
  passed: z.array(z.string()),
  couldntCheck: z.array(CouldntCheckSchema),
});

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
  finding?: Finding;
}
