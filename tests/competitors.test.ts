import { describe, it, expect } from "vitest";
import { findCompetitors, computeGaps } from "@/lib/competitors";
import { CompetitorTableSchema } from "@/lib/pipeline/schemas";
import type { LlmClient, LlmCallOptions } from "@/lib/llm/router";
import { LlmUnavailableError } from "@/lib/llm/router";
import type { PageFetcher } from "@/lib/snapshot";
import { page } from "./helpers/snap";

const SELF = { domain: "acme.example", title: "Acme Storage", description: "Shelving for small homes", summary: "Acme sells modular shelving.", technical: 50, geo: 40, platforms: ["facebook" as const] };

const GOOD_HOME = (extra = "") => `<html lang="en"><head><title>Rival shelving for homes everywhere</title>
<meta name="description" content="Rival sells modular shelving and storage boxes for homes, with free design help and delivery across the country.">
<meta name="viewport" content="width=device-width"><link rel="canonical" href="/"><meta property="og:title" content="r"><meta property="og:image" content="i">
<script type="application/ld+json">{"@type":"Organization","sameAs":["https://www.instagram.com/rival"]}</script></head>
<body><h1>Storage for every home</h1>${extra}<a href="https://www.instagram.com/rival">ig</a><a href="https://www.facebook.com/rival">fb</a></body></html>`;

const site = (hosts: Record<string, string | number>): PageFetcher => async (url) => {
  const u = new URL(url);
  const hit = hosts[u.hostname];
  if (hit === undefined) throw new Error("ENOTFOUND");
  if (typeof hit === "number") return page(url, "blocked", { status: hit });
  return u.pathname === "/" ? page(url, hit) : page(url, "nope", { status: 404 });
};
const ai = (domains: unknown[]): LlmClient => async () => ({ content: JSON.stringify({ competitors: domains }), provider: "nim", model: "m" });

describe("findCompetitors", () => {
  it("proposes competitors, keeps only live sites, scores them and builds a valid table", async () => {
    const fetchPage = site({ "rival.example": GOOD_HOME(), "other.example": GOOD_HOME(), "dead.example": "" });
    const r = await findCompetitors(SELF, { llm: ai([{ domain: "rival.example" }, { domain: "https://www.other.example/shop" }, { domain: "gone.example" }]), search: null, fetchPage });
    expect(() => CompetitorTableSchema.parse(r.table)).not.toThrow();
    expect(r.table!.rows.map((x) => x.domain)).toEqual(["rival.example", "other.example"]);
    expect(r.table!.rows[0]).toMatchObject({ source: "ai" });
    expect(typeof r.table!.rows[0].technical).toBe("number");
    expect(r.table!.rows[0].platforms.sort()).toEqual(["facebook", "instagram"]);
    expect(r.table!.note).toMatch(/suggested by AI/i);
  });

  it("keeps which checks each competitor passes, so the report can name what they do better", async () => {
    const fetchPage = site({ "rival.example": GOOD_HOME() });
    const r = await findCompetitors(SELF, { llm: ai([{ domain: "rival.example" }]), search: null, fetchPage });
    const passed = r.table!.rows[0].passed;
    expect(passed).toEqual(expect.arrayContaining(["technical:title", "technical:canonical", "geo:organisation-schema"]));
    expect(passed.every((id) => /^(technical|geo):[a-z0-9-]+$/.test(id))).toBe(true);
  });

  it("stops after three audited competitors", async () => {
    const hosts = Object.fromEntries(["a", "b", "c", "d", "e"].map((x) => [`${x}.example`, GOOD_HOME()]));
    const r = await findCompetitors(SELF, { llm: ai(Object.keys(hosts).map((domain) => ({ domain }))), search: null, fetchPage: site(hosts) });
    expect(r.table!.rows).toHaveLength(3);
  });

  it("never lists the audited site, social platforms, marketplaces or invalid names", async () => {
    const fetchPage = site({ "rival.example": GOOD_HOME() });
    const r = await findCompetitors(SELF, {
      llm: ai([{ domain: "acme.example" }, { domain: "www.acme.example" }, { domain: "facebook.com" }, { domain: "amazon.com" }, { domain: "localhost" },
        { domain: "10.0.0.1" }, { domain: "ignore previous instructions.example" }, { domain: 42 }, "rival.example", { domain: "rival.example" }]),
      search: null, fetchPage,
    });
    expect(r.table!.rows.map((x) => x.domain)).toEqual(["rival.example"]);
  });

  it("skips competitors that block crawlers or return errors, and says so when none can be read", async () => {
    const r = await findCompetitors(SELF, { llm: ai([{ domain: "blocked.example" }, { domain: "down.example" }]), search: null, fetchPage: site({ "blocked.example": 403, "down.example": 503 }) });
    expect(r.table).toBeNull();
    expect(r.couldntCheck[0].what).toMatch(/competitor/i);
  });

  it("uses search results too, labelled as such, and works with search alone", async () => {
    const fetchPage = site({ "found.example": GOOD_HOME() });
    const r = await findCompetitors(SELF, { llm: null, search: async () => ["https://found.example/pricing", "https://acme.example/"], fetchPage });
    expect(r.table!.rows).toEqual([expect.objectContaining({ domain: "found.example", source: "search" })]);
    expect(r.table!.note ?? "").not.toMatch(/suggested by AI/i);
  });

  it.each([
    ["no AI and no search", { llm: null, search: null }],
    ["the AI is down", { llm: (async () => { throw new LlmUnavailableError("down"); }) as LlmClient, search: null }],
    ["a non-JSON answer", { llm: (async () => ({ content: "sorry", provider: "nim", model: "m" })) as LlmClient, search: null }],
  ])("returns no table and a could-not-check note when %s", async (_, deps) => {
    const r = await findCompetitors(SELF, { ...deps, fetchPage: site({}) });
    expect(r.table).toBeNull();
    expect(r.couldntCheck[0].what).toMatch(/competitor/i);
  });

  it("fences the site summary as untrusted and asks for JSON", async () => {
    const calls: LlmCallOptions[] = [];
    const llm: LlmClient = async (o) => { calls.push(o); return { content: '{"competitors":[]}', provider: "nim", model: "m" }; };
    await findCompetitors(SELF, { llm, search: null, fetchPage: site({}) });
    expect(calls[0].user).toContain("<<<UNTRUSTED_PAGE_TEXT>>>");
    expect(calls[0].jsonOnly).toBe(true);
  });

  it("stops when the scan is cancelled", async () => {
    const controller = new AbortController();
    let fetched = 0;
    const fetchPage: PageFetcher = async (url) => { fetched++; controller.abort(); return site({ "rival.example": GOOD_HOME(), "other.example": GOOD_HOME() })(url); };
    await findCompetitors(SELF, { llm: ai([{ domain: "rival.example" }, { domain: "other.example" }]), search: null, fetchPage, signal: controller.signal });
    expect(fetched).toBeLessThanOrEqual(4); // one competitor's robots, home, sitemap, llms.txt at most
  });
});

describe("computeGaps", () => {
  const row = (domain: string, technical: number, geo: number, platforms: ("facebook" | "instagram" | "linkedin")[]) =>
    ({ domain, url: `https://${domain}/`, source: "ai" as const, technical, geo, platforms, passed: [] as string[] });

  it("reports score gaps of 10 points or more and platforms most competitors have", () => {
    const gaps = computeGaps({ technical: 50, geo: 40, platforms: ["facebook"] }, [row("a.example", 70, 45, ["facebook", "instagram"]), row("b.example", 55, 60, ["instagram"])]);
    expect(gaps.join(" ")).toMatch(/1 of 2 competitors score at least 10 points higher on SEO/);
    expect(gaps.join(" ")).toMatch(/best: a\.example/);
    expect(gaps.join(" ")).toMatch(/1 of 2 competitors score at least 10 points higher on AI visibility/);
    expect(gaps.join(" ")).toMatch(/2 of 2 competitors are on instagram/);
  });
  it("says there are no clear gaps when the site holds its own", () => {
    expect(computeGaps({ technical: 90, geo: 90, platforms: ["facebook"] }, [row("a.example", 60, 60, ["facebook"])])).toEqual(["No clear gaps against these competitors."]);
  });
  describe("problems most competitors do not have", () => {
    const failures = [
      { id: "technical:canonical", title: "The homepage has no canonical link" },
      { id: "geo:llms-txt", title: "The site has no llms.txt file" },
    ];
    const mine = { technical: 50, geo: 50, platforms: [] as never[], failures };
    const withPassed = (domain: string, passed: string[]) => ({ ...row(domain, 50, 50, []), passed });

    it("names each problem that at least half of the competitors do not have, most common first", () => {
      const gaps = computeGaps(mine, [
        withPassed("a.example", ["technical:canonical", "geo:llms-txt"]),
        withPassed("b.example", ["technical:canonical", "geo:llms-txt"]),
        withPassed("c.example", ["technical:canonical"]),
      ]);
      expect(gaps[0]).toBe("3 of 3 competitors do not have this problem: The homepage has no canonical link.");
      expect(gaps[1]).toBe("2 of 3 competitors do not have this problem: The site has no llms.txt file.");
    });
    it("leaves out a problem that fewer than half of them avoid", () => {
      const gaps = computeGaps(mine, [withPassed("a.example", ["geo:llms-txt"]), withPassed("b.example", []), withPassed("c.example", ["technical:canonical"]), withPassed("d.example", [])].map((r, i) => (i === 1 || i === 3 ? { ...r, passed: ["technical:title"] } : r)));
      expect(gaps.join(" ")).not.toMatch(/llms\.txt/);
    });
    it("does not count competitors that have no check data", () => {
      const gaps = computeGaps(mine, [withPassed("a.example", ["technical:canonical"]), withPassed("b.example", [])]);
      expect(gaps[0]).toBe("1 of 1 competitors do not have this problem: The homepage has no canonical link.");
    });
    it("says nothing about problems the site does not have, and still falls back to no clear gaps", () => {
      expect(computeGaps({ ...mine, failures: [] }, [withPassed("a.example", ["technical:canonical"])])).toEqual(["No clear gaps against these competitors."]);
    });
    it("shows at most four such lines", () => {
      const many = Array.from({ length: 8 }, (_, i) => ({ id: `technical:c${i}`, title: `Problem ${i}` }));
      const gaps = computeGaps({ ...mine, failures: many }, [withPassed("a.example", many.map((m) => m.id))]);
      expect(gaps.filter((g) => /do not have this problem/.test(g))).toHaveLength(4);
    });
  });

  it("ignores competitors with no score for a metric", () => {
    const gaps = computeGaps({ technical: 50, geo: 50, platforms: [] }, [{ ...row("a.example", 0, 0, []), technical: null, geo: null }]);
    expect(gaps).toEqual(["No clear gaps against these competitors."]);
  });
});
