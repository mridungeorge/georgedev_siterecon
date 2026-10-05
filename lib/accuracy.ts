import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

// The /accuracy page and /api/accuracy show the results of `npm run eval` and `npm run
// eval:adversarial`, committed as JSON. If a file is missing or unreadable the page says so,
// it never invents a number.

const EvalSchema = z.object({
  fixtures: z.number().int(),
  expectedFindings: z.number().int(),
  foundExpected: z.number().int(),
  recall: z.number(),
  falsePositives: z.number().int(),
  evidenceValid: z.boolean(),
  deterministic: z.boolean(),
  failures: z.array(z.string()),
  ranOn: z.string(),
  recallFloor: z.number(),
});

const AdversarialSchema = z.object({
  total: z.number().int(),
  passed: z.number().int(),
  failed: z.array(z.string()),
  cases: z.array(z.object({ name: z.string(), passed: z.boolean(), detail: z.string() })),
  ranOn: z.string(),
});

export type EvalScorecard = z.infer<typeof EvalSchema>;
export type AdversarialScorecard = z.infer<typeof AdversarialSchema>;

function read<T>(file: string, schema: z.ZodType<T>): T | null {
  try {
    const parsed = schema.safeParse(JSON.parse(readFileSync(file, "utf-8")));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function readScorecards(root: string = process.cwd()): { eval: EvalScorecard | null; adversarial: AdversarialScorecard | null } {
  return {
    eval: read(join(root, "eval", "scorecard.json"), EvalSchema),
    adversarial: read(join(root, "eval", "adversarial-scorecard.json"), AdversarialSchema),
  };
}
