import { describe, it, expect } from "vitest";
import { buildAiReadiness, READINESS_COMPONENTS } from "@/lib/ai-readiness";
import { LABELS } from "@/lib/methodology";
import type { Finding, ModuleName, ModuleResult } from "@/lib/pipeline/schemas";

const finding = (module: ModuleName, id: string): Finding => ({
  id: `${module}:${id}`, module, severity: "high", effort: "low", title: id, detail: "d", fix: "f", evidence: [{ url: "https://example.com/", note: "n" }],
});
const mod = (module: ModuleName, passed: string[], failed: string[]): ModuleResult => ({
  module, status: "ok", score: 50, passed, findings: failed.map((id) => finding(module, id)), couldntCheck: [],
});

const ALL_GEO = ["ai-crawler-oai-searchbot", "ai-crawler-claude-searchbot", "ai-crawler-perplexitybot", "ai-crawler-googlebot", "content-in-html", "organisation-schema", "question-headings", "question-answers", "citable-passage", "llms-txt", "freshness-signals"];
const ALL_TECH = ["indexable", "structured-data", "json-ld-valid", "schema-complete", "canonical", "not-truncated"];

describe("buildAiReadiness", () => {
  it("scores 100 when every readiness check passed", () => {
    const r = buildAiReadiness([mod("geo", ALL_GEO, []), mod("technical", ALL_TECH, []), mod("content", ["readability", "about-page"], [])]);
    expect(r?.score).toBe(100);
    expect(r?.band).toBe("Strong");
    expect(r?.components.every((c) => c.score === 100)).toBe(true);
  });

  it("scores 0 and says the site is very weak when every readiness check failed", () => {
    const r = buildAiReadiness([mod("geo", [], ALL_GEO), mod("technical", [], ALL_TECH), mod("content", [], ["readability", "about-page"])]);
    expect(r?.score).toBe(0);
    expect(r?.band).toBe("Very weak");
  });

  it("returns null when none of the readiness checks ran", () => {
    expect(buildAiReadiness([{ module: "geo", status: "failed", score: null, findings: [], passed: [], couldntCheck: [] }])).toBeNull();
  });

  it("weights components by the published rubric, ignoring checks that did not run", () => {
    const r = buildAiReadiness([mod("geo", ["ai-crawler-oai-searchbot", "ai-crawler-googlebot"], [])]);
    expect(r?.score).toBe(100);
    expect(r?.components.find((c) => c.id === "answer-blocks")?.score).toBeNull();
  });

  it("names the weakest gaps in the verdict, in plain words, from the failed checks", () => {
    const r = buildAiReadiness([
      mod("geo", ALL_GEO.filter((i) => i !== "organisation-schema" && i !== "question-headings"), ["organisation-schema", "question-headings"]),
      mod("technical", ALL_TECH, []),
    ]);
    expect(r?.verdict).toMatch(/for AI-generated answers/);
    expect(r?.verdict).toMatch(/no Organization schema/i);
    expect(r?.verdict).toMatch(/question headings/i);
  });

  it("links every component to the check ids behind it", () => {
    const r = buildAiReadiness([mod("geo", ALL_GEO.slice(1), [ALL_GEO[0]!])]);
    const crawler = r!.components.find((c) => c.id === "crawler-access")!;
    expect(crawler.failed).toContain("geo:ai-crawler-oai-searchbot");
    expect(crawler.passed).toContain("geo:ai-crawler-googlebot");
  });

  it("is deterministic", () => {
    const m = [mod("geo", ALL_GEO.slice(2), ALL_GEO.slice(0, 2))];
    expect(buildAiReadiness(m)).toEqual(buildAiReadiness(m));
  });

  it("only refers to checks that have a published label, and its component weights add up to 100", () => {
    // LABELS covers every check the rubric can show, including ones that only exist on some pages.
    for (const c of READINESS_COMPONENTS) for (const m of c.members) expect(LABELS[m.id], `${m.module}:${m.id}`).toBeTruthy();
    expect(READINESS_COMPONENTS.reduce((sum, c) => sum + c.weight, 0)).toBe(100);
  });
});
