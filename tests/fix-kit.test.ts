import { describe, it, expect } from "vitest";
import { buildFixKit } from "@/lib/fix-kit";
import type { Finding, ModuleName, ModuleResult, SocialSummary } from "@/lib/pipeline/schemas";
import { page, snap } from "./helpers/snap";

const finding = (module: ModuleName, id: string): Finding => ({
  id: `${module}:${id}`, module, severity: "medium", effort: "low", title: id, detail: "d", fix: "f", evidence: [{ url: "https://example.com/", note: "n" }],
});
const modulesWith = (...ids: string[]): ModuleResult[] => {
  const byModule = new Map<ModuleName, Finding[]>();
  for (const full of ids) {
    const [module, id] = full.split(":") as [ModuleName, string];
    byModule.set(module, [...(byModule.get(module) ?? []), finding(module, id)]);
  }
  return [...byModule].map(([module, findings]) => ({ module, status: "ok", score: 50, findings, passed: [], couldntCheck: [] }));
};

const HOME = `<html><head><title>Sunrise Bakery | Fresh sourdough</title>
<meta name="description" content="Sunrise Bakery bakes sourdough and pastries in Melbourne every morning.">
<meta property="og:image" content="https://example.com/og.png"></head>
<body><a href="tel:+61390000000">Call</a><a href="mailto:hello@example.com">Email</a></body></html>`;

const snapshot = (html = HOME) => {
  const s = snap(html);
  s.pages = [
    page("https://example.com/menu", "<html><head><title>Menu | Sunrise Bakery</title><meta name=\"description\" content=\"Everything we bake.\"></head><body></body></html>"),
    page("https://example.com/about", "<html><head><title>About us</title></head><body></body></html>"),
  ];
  return s;
};
const social: SocialSummary = {
  profiles: [
    { platform: "facebook", url: "https://www.facebook.com/sunrisebakery", handle: "sunrisebakery", kind: "profile", status: "linked" },
    { platform: "instagram", url: "https://www.instagram.com/", handle: null, kind: "homepage", status: "linked" },
  ],
  missing: [], mentions: null, readerUsed: false,
};
const item = (kit: ReturnType<typeof buildFixKit>, id: string) => kit.find((k) => k.id === id)!;

describe("buildFixKit", () => {
  it("builds only the always-offered CI workflow when no finding needs a file", () => {
    expect(buildFixKit(snapshot(), modulesWith("content:cta-present", "technical:single-h1"), social).map((k) => k.id)).toEqual(["ci-audit"]);
  });

  it("builds a canonical tag with the page's own address", () => {
    const kit = buildFixKit(snapshot(), modulesWith("technical:canonical"), null);
    expect(item(kit, "canonical").content).toBe('<link rel="canonical" href="https://example.com/">');
    expect(item(kit, "canonical").language).toBe("html");
    expect(item(kit, "canonical").forFindings).toEqual(["technical:canonical"]);
  });

  it("builds a robots.txt that welcomes the AI search crawlers and points at the sitemap", () => {
    const kit = buildFixKit(snapshot(), modulesWith("geo:ai-crawler-oai-searchbot"), null);
    const robots = item(kit, "robots-txt");
    expect(robots.filename).toBe("robots.txt");
    for (const bot of ["OAI-SearchBot", "Claude-SearchBot", "PerplexityBot", "Googlebot"]) expect(robots.content).toContain(`User-agent: ${bot}\nAllow: /`);
    expect(robots.content).toContain("Sitemap: https://example.com/sitemap.xml");
    expect(robots.note).toMatch(/training/i);
    expect(robots.content).not.toMatch(/Disallow: \/\s*$/m);
  });
  it.each(["technical:robots-txt", "technical:robots-sitemap", "geo:ai-crawler-perplexitybot"])("builds a robots.txt for %s", (id) => {
    expect(item(buildFixKit(snapshot(), modulesWith(id), null), "robots-txt")).toBeDefined();
  });

  it("builds a sitemap from the pages that were read, each once, on this site only", () => {
    const s = snapshot();
    s.pages.push(page("https://example.com/menu", "<html></html>"), page("https://elsewhere.test/x", "<html></html>"));
    const sitemap = item(buildFixKit(s, modulesWith("technical:sitemap"), null), "sitemap-xml");
    expect(sitemap.language).toBe("xml");
    expect(sitemap.content.match(/<loc>/g)).toHaveLength(3);
    expect(sitemap.content).toContain("<loc>https://example.com/</loc>");
    expect(sitemap.content).toContain("<loc>https://example.com/menu</loc>");
    expect(sitemap.content).not.toContain("elsewhere");
    expect(sitemap.content.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
  });
  it("escapes characters that are special in XML", () => {
    const s = snapshot();
    s.pages = [page("https://example.com/a?x=1&y=<2>", "<html></html>")];
    const sitemap = item(buildFixKit(s, modulesWith("technical:sitemap-quality"), null), "sitemap-xml");
    expect(sitemap.content).toContain("x=1&amp;y=%3C2%3E");
    expect(sitemap.content).not.toMatch(/<loc>[^<]*[<>][^<]*<\/loc>/);
  });

  describe("organisation schema", () => {
    const org = (html = HOME, soc: SocialSummary | null = social) => {
      const kit = buildFixKit(snapshot(html), modulesWith("geo:organisation-schema"), soc);
      return { item: item(kit, "organisation-schema"), data: JSON.parse(item(kit, "organisation-schema").content.replace(/\\u003c/g, "<")) };
    };
    it("fills in only what the site itself says", () => {
      const { item: it1, data } = org();
      expect(it1.language).toBe("json");
      expect(data).toMatchObject({
        "@context": "https://schema.org", "@type": "Organization", name: "Sunrise Bakery", url: "https://example.com/",
        description: "Sunrise Bakery bakes sourdough and pastries in Melbourne every morning.",
        logo: "https://example.com/og.png", telephone: "+61390000000", email: "hello@example.com",
        sameAs: ["https://www.facebook.com/sunrisebakery"],
      });
    });
    it("leaves out anything the page does not provide, instead of inventing it", () => {
      const { data } = org("<html><head><title>Plain</title></head><body></body></html>", null);
      expect(Object.keys(data).sort()).toEqual(["@context", "@type", "name", "url"]);
    });
    it("prefers og:site_name for the name", () => {
      expect(org(HOME.replace("<head>", '<head><meta property="og:site_name" content="Sunrise Bakery Pty Ltd">')).data.name).toBe("Sunrise Bakery Pty Ltd");
    });
    it.each(["technical:structured-data", "technical:schema-complete"])("is offered for %s too", (id) => {
      expect(buildFixKit(snapshot(), modulesWith(id), null).map((k) => k.id)).toContain("organisation-schema");
    });
    it("never lets page text close the script tag it will be pasted into", () => {
      const hostile = "<html><head><title>Evil </script><script>alert(1)</script> Co</title></head><body></body></html>";
      const raw = org(hostile).item.content;
      expect(raw).not.toContain("</script>");
      expect(raw).not.toContain("<script");
    });
  });

  describe("llms.txt", () => {
    const llms = (s = snapshot()) => item(buildFixKit(s, modulesWith("geo:llms-txt"), null), "llms-txt");
    it("summarises the site and lists its pages", () => {
      const f = llms();
      expect(f.filename).toBe("llms.txt");
      expect(f.content.startsWith("# Sunrise Bakery\n> Sunrise Bakery bakes sourdough and pastries in Melbourne every morning.\n")).toBe(true);
      expect(f.content).toContain("- [Menu | Sunrise Bakery](https://example.com/menu): Everything we bake.");
      expect(f.content).toContain("- [About us](https://example.com/about)");
    });
    it("keeps page text on one line and out of the link syntax", () => {
      const s = snapshot();
      s.pages = [page("https://example.com/x", '<html><head><title>Bad]\n(https://evil.test)\n# Heading</title><meta name="description" content="line one\nline two"></head></html>')];
      const lines = llms(s).content.split("\n");
      expect(lines.filter((l) => l.startsWith("- ["))).toHaveLength(1);
      expect(lines.filter((l) => l.startsWith("#")).map((l) => l.slice(0, 2))).toEqual(["# ", "##"]);
      expect(llms(s).content).not.toContain("](https://evil.test)");
    });
  });

  it("builds Open Graph tags from the page's own title and description, escaped", () => {
    const html = HOME.replace("Fresh sourdough", 'Fresh "sourdough" & <more>');
    const og = item(buildFixKit(snapshot(html), modulesWith("technical:open-graph"), null), "open-graph");
    expect(og.language).toBe("html");
    expect(og.content).toContain('<meta property="og:title" content="Sunrise Bakery | Fresh &quot;sourdough&quot; &amp; &lt;more&gt;">');
    expect(og.content).toContain('<meta property="og:url" content="https://example.com/">');
    expect(og.content).not.toMatch(/content="[^"]*[<>][^"]*"/);
  });

  it("builds security headers for the common servers", () => {
    const headers = item(buildFixKit(snapshot(), modulesWith("technical:security-headers"), null), "security-headers");
    expect(headers.content).toMatch(/X-Content-Type-Options.*nosniff/);
    expect(headers.content).toMatch(/Referrer-Policy/);
    expect(headers.content).toMatch(/nginx/i);
    expect(headers.content).toMatch(/Caddy/i);
  });

  describe("schema gaps", () => {
    const words = (n: number) => Array.from({ length: n }, () => "word").join(" ");
    const faq = `<html><head><title>Help | Acme</title></head><body><h1>Help</h1>${[1, 2, 3].map((i) => `<h2>Question ${i} about delivery?</h2><p>${words(30)}</p>`).join("")}</body></html>`;

    it("builds FAQPage JSON-LD from the questions on the page when the citation finding fired", () => {
      const kit = buildFixKit(snapshot(faq), modulesWith("citation:schema-fit"), null);
      const item = kit.find((k) => k.id.startsWith("schema-faqpage"))!;
      expect(item.language).toBe("json");
      expect(JSON.parse(item.content)["@type"]).toBe("FAQPage");
      expect(item.forFindings).toEqual(["citation:schema-fit"]);
    });

    it("builds nothing when the finding did not fire", () => {
      expect(buildFixKit(snapshot(faq), [], null).some((k) => k.id.startsWith("schema-"))).toBe(false);
    });
  });

  describe("schema that competitors publish", () => {
    const rival = (domain: string, types: string[]) => ({
      domain, url: `https://${domain}/`, source: "ai" as const, technical: 70, geo: 70, platforms: [], title: "", headline: "", description: "",
      passed: [], schemaTypes: types, words: 300, topics: [], entities: [], sitemapUrls: 0,
    });
    const table = (rows: ReturnType<typeof rival>[]) => ({ rows, gaps: [], note: "" });

    it("gives a fill-in FAQPage when most competitors have one and the page has no questions to build it from", () => {
      const kit = buildFixKit(snapshot(), [], null, table([rival("a.example", ["FAQPage"]), rival("b.example", ["FAQPage"])]));
      const item = kit.find((k) => k.id === "competitor-schema-faqpage")!;
      const json = JSON.parse(item.content);
      expect(json["@type"]).toBe("FAQPage");
      expect(JSON.stringify(json)).toContain("REPLACE");
      expect(item.note).toMatch(/a\.example, b\.example/);
      expect(item.forFindings).toEqual([]);
    });

    it("does not add a fill-in when the page already has that type", () => {
      const s = snapshot('<html><head><script type="application/ld+json">{"@type":"FAQPage","mainEntity":[]}</script></head><body></body></html>');
      const kit = buildFixKit(s, [], null, table([rival("a.example", ["FAQPage"])]));
      expect(kit.some((k) => k.id === "competitor-schema-faqpage")).toBe(false);
    });

    it("does not add one when only a minority of competitors have the type", () => {
      const kit = buildFixKit(snapshot(), [], null, table([rival("a.example", ["Product"]), rival("b.example", []), rival("c.example", [])]));
      expect(kit.some((k) => k.id.startsWith("competitor-schema-"))).toBe(false);
    });

    it("builds LocalBusiness from what the homepage states and marks the address to fill in", () => {
      const kit = buildFixKit(snapshot(), [], null, table([rival("a.example", ["LocalBusiness"])]));
      const json = JSON.parse(kit.find((k) => k.id === "competitor-schema-localbusiness")!.content);
      expect(json["@type"]).toBe("LocalBusiness");
      expect(json.telephone).toContain("+61");
      expect(json.email).toBe("hello@example.com");
      expect(JSON.stringify(json.address)).toContain("REPLACE");
    });

    it("leaves a built-from-the-page schema alone and does not duplicate it", () => {
      const faq = `<html><head><title>Help</title></head><body><h1>Help</h1>${[1, 2, 3].map((i) => `<h2>Question ${i} about delivery?</h2><p>${"word ".repeat(30)}</p>`).join("")}</body></html>`;
      const kit = buildFixKit(snapshot(faq), modulesWith("citation:schema-fit"), null, table([rival("a.example", ["FAQPage"])]));
      expect(kit.filter((k) => /faqpage/i.test(k.id))).toHaveLength(1);
    });
  });

  describe("meta tags, HSTS and CI", () => {
    it("builds a title, description and viewport block from the page itself, escaped", () => {
      const html = '<html><head><title>Tom &amp; "Jerry" | Cafe</title><meta name="description" content="Fresh <b>bread</b> daily."></head><body></body></html>';
      const kit = buildFixKit(snapshot(html), modulesWith("technical:meta-description", "technical:viewport"), null);
      const c = item(kit, "meta-tags").content;
      expect(c).toContain('<meta name="viewport" content="width=device-width, initial-scale=1">');
      expect(c).toContain('<meta name="description" content="Fresh &lt;b&gt;bread&lt;/b&gt; daily.">');
      expect(c).not.toContain("<b>");
    });

    it("adds a Strict-Transport-Security header to the headers item when HSTS is missing", () => {
      const kit = buildFixKit(snapshot(), modulesWith("technical:hsts"), null);
      expect(item(kit, "security-headers").content).toContain("Strict-Transport-Security");
      expect(item(kit, "security-headers").forFindings).toEqual(["technical:hsts"]);
    });

    it("always offers a CI audit workflow pointing at the audited site", () => {
      const kit = buildFixKit(snapshot(), [], null);
      const ci = item(kit, "ci-audit");
      expect(ci.filename).toBe(".github/workflows/siterecon.yml");
      expect(ci.content).toContain("schedule:");
      expect(ci.content).toContain("https://example.com/");
      expect(ci.forFindings).toEqual([]);
    });
  });

  it("only refers to findings that exist, and gives every item a title and a note", () => {
    const ids = ["technical:canonical", "technical:sitemap", "geo:llms-txt", "technical:open-graph", "technical:security-headers", "geo:organisation-schema", "technical:robots-txt"];
    const modules = modulesWith(...ids);
    const have = new Set(modules.flatMap((m) => m.findings.map((f) => f.id)));
    const kit = buildFixKit(snapshot(), modules, social);
    expect(kit).toHaveLength(8);
    for (const k of kit.filter((x) => x.id !== "ci-audit")) {
      expect(k.forFindings.length).toBeGreaterThan(0);
      for (const f of k.forFindings) expect(have.has(f)).toBe(true);
      expect(k.title.length).toBeGreaterThan(5);
      expect(k.note.length).toBeGreaterThan(10);
      expect(k.content.length).toBeGreaterThan(10);
    }
  });
  it("is deterministic", () => {
    const m = modulesWith("technical:sitemap", "geo:llms-txt");
    expect(buildFixKit(snapshot(), m, social)).toEqual(buildFixKit(snapshot(), m, social));
  });
});
