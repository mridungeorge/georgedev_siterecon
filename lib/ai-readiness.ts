import type { ModuleName, ModuleResult } from "@/lib/pipeline/schemas";

// The AI Readiness Score is a lens over checks that already ran. It adds no checks of its own, so it
// cannot disagree with the module scores, and no model touches it. The components and weights below
// are published on /methodology.

export type ReadinessComponentId = "crawler-access" | "structured-data" | "answer-blocks" | "entity-clarity" | "render-parity" | "freshness";

interface Member { module: ModuleName; id: string; weight: number; gap: string }
interface ComponentDef { id: ReadinessComponentId; label: string; weight: number; members: Member[] }

/** `gap` is the phrase used in the verdict when this check failed. */
export const READINESS_COMPONENTS: ComponentDef[] = [
  {
    id: "crawler-access", label: "Crawler access", weight: 25,
    members: [
      { module: "geo", id: "ai-crawler-oai-searchbot", weight: 10, gap: "ChatGPT search is blocked in robots.txt" },
      { module: "geo", id: "ai-crawler-claude-searchbot", weight: 10, gap: "Claude search is blocked in robots.txt" },
      { module: "geo", id: "ai-crawler-perplexitybot", weight: 10, gap: "Perplexity is blocked in robots.txt" },
      { module: "geo", id: "ai-crawler-googlebot", weight: 6, gap: "Googlebot (and so AI Overviews) is blocked in robots.txt" },
      { module: "technical", id: "indexable", weight: 10, gap: "the page is set to noindex" },
    ],
  },
  {
    id: "structured-data", label: "Structured data quality", weight: 20,
    members: [
      { module: "technical", id: "structured-data", weight: 10, gap: "there is no structured data" },
      { module: "technical", id: "json-ld-valid", weight: 8, gap: "the JSON-LD is broken" },
      { module: "technical", id: "schema-complete", weight: 8, gap: "the schema is missing required properties" },
      { module: "citation", id: "schema-fit", weight: 8, gap: "FAQ, article or product content has no matching structured data" },
      { module: "crawl", id: "render-schema", weight: 6, gap: "the structured data is only added by JavaScript" },
    ],
  },
  {
    id: "answer-blocks", label: "Concise answer blocks", weight: 20,
    members: [
      { module: "geo", id: "question-headings", weight: 10, gap: "there are no question headings" },
      { module: "geo", id: "question-answers", weight: 3, gap: "question headings have no answer directly beneath" },
      { module: "geo", id: "citable-passage", weight: 14, gap: "no paragraph is substantial enough to quote" },
      { module: "content", id: "readability", weight: 5, gap: "the copy is hard to read" },
      { module: "citation", id: "answer-passage", weight: 14, gap: "no passage is the right length to be lifted whole" },
      { module: "citation", id: "structure", weight: 5, gap: "long unbroken text is hard to quote" },
    ],
  },
  {
    id: "entity-clarity", label: "Entity clarity", weight: 15,
    members: [
      { module: "geo", id: "organisation-schema", weight: 12, gap: "there is no Organization schema naming who runs the site" },
      { module: "technical", id: "canonical", weight: 4, gap: "there is no canonical URL" },
      { module: "content", id: "about-page", weight: 4, gap: "there is no About page" },
      { module: "citation", id: "entity-early", weight: 10, gap: "the opening text never names the business" },
      { module: "citation", id: "definition", weight: 8, gap: "no opening sentence says what the business does" },
    ],
  },
  {
    id: "render-parity", label: "Content visible without JavaScript", weight: 12,
    members: [
      { module: "geo", id: "content-in-html", weight: 20, gap: "the content only appears after JavaScript runs" },
      { module: "technical", id: "not-truncated", weight: 4, gap: "the HTML response is cut short" },
      { module: "crawl", id: "render-links", weight: 8, gap: "navigation links only appear after JavaScript runs" },
      { module: "crawl", id: "render-headings", weight: 8, gap: "the main heading only appears after JavaScript runs" },
      { module: "crawl", id: "render-hydration", weight: 8, gap: "the page logs hydration errors, so bots and visitors may see different pages" },
    ],
  },
  {
    id: "freshness", label: "Freshness signals", weight: 8,
    members: [
      { module: "geo", id: "freshness-signals", weight: 4, gap: "nothing says when the page was updated" },
      { module: "geo", id: "llms-txt", weight: 2, gap: "there is no llms.txt" },
    ],
  },
];

export interface ReadinessComponent {
  id: ReadinessComponentId;
  label: string;
  weight: number;
  /** Null when none of this component's checks ran. */
  score: number | null;
  passed: string[];
  failed: string[];
}

export interface AiReadiness {
  score: number;
  band: "Strong" | "Moderate" | "Weak" | "Very weak";
  verdict: string;
  components: ReadinessComponent[];
}

const BANDS: { min: number; band: AiReadiness["band"] }[] = [
  { min: 80, band: "Strong" },
  { min: 60, band: "Moderate" },
  { min: 40, band: "Weak" },
  { min: 0, band: "Very weak" },
];

export function buildAiReadiness(modules: ModuleResult[]): AiReadiness | null {
  const byModule = new Map(modules.map((m) => [m.module, m]));
  const failedGaps: { gap: string; lost: number }[] = [];

  const components: ReadinessComponent[] = READINESS_COMPONENTS.map((def) => {
    let earned = 0;
    let total = 0;
    const passed: string[] = [];
    const failed: string[] = [];
    for (const m of def.members) {
      const result = byModule.get(m.module);
      if (!result) continue;
      const key = `${m.module}:${m.id}`;
      if (result.passed.includes(m.id)) {
        total += m.weight;
        earned += m.weight;
        passed.push(key);
      } else if (result.findings.some((f) => f.id === key)) {
        total += m.weight;
        failed.push(key);
        failedGaps.push({ gap: m.gap, lost: m.weight * def.weight });
      }
    }
    return { id: def.id, label: def.label, weight: def.weight, score: total === 0 ? null : Math.round((earned / total) * 100), passed, failed };
  });

  const scored = components.filter((c) => c.score !== null);
  if (scored.length === 0) return null;
  const weight = scored.reduce((s, c) => s + c.weight, 0);
  const score = Math.round(scored.reduce((s, c) => s + (c.score as number) * c.weight, 0) / weight);
  const band = BANDS.find((b) => score >= b.min)!.band;

  // The verdict names the failed checks that cost the most, in a fixed order, so the same findings always give the same words.
  const top = failedGaps.sort((a, b) => b.lost - a.lost || a.gap.localeCompare(b.gap)).slice(0, 3).map((g) => g.gap);
  const lead = `${band} for AI-generated answers (${score}/100).`;
  const verdict = top.length === 0 ? `${lead} Every readiness check that ran passed.` : `${lead} Main gaps: ${top.join("; ")}.`;
  return { score, band, verdict, components };
}
