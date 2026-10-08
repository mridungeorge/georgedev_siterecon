import type { SiteSnapshot } from "@/lib/snapshot";
import type { CheckOutcome, ModuleName } from "@/lib/pipeline/schemas";
import { MODULE_WEIGHTS } from "@/lib/scoring";
import { runTechnicalChecks } from "@/lib/checks/technical";
import { runGeoChecks } from "@/lib/checks/geo";
import { RUBRIC, runContentChecks } from "@/lib/checks/content";
import { runPerformanceChecks } from "@/lib/checks/performance";
import { runSocialChecks } from "@/lib/checks/social";

// The /methodology page lists exactly what is scored. The list is not typed out by hand: it is
// produced by running the real checks on a blank page, so a new or re-weighted check shows up here
// by itself. The one thing written by hand is a plain-words label per check, and a test fails if a
// check has none.

export interface RubricCheck { id: string; weight: number; label: string; ai?: boolean }
export interface ModuleRubric {
  module: Exclude<ModuleName, "competitors">;
  label: string;
  weightInOverall: number;
  source: string;
  checks: RubricCheck[];
}

const LABELS: Record<string, string> = {
  // SEO
  "status-ok": "The homepage returns HTTP 200", https: "The site is served over HTTPS",
  indexable: "The page is not blocked from search (no noindex)", title: "Has a title tag",
  "title-length": "The title is 15 to 60 characters", "meta-description": "Has a meta description",
  "meta-description-length": "The description is 70 to 160 characters", "single-h1": "Has exactly one H1 heading",
  canonical: "Has a canonical link", "html-lang": "Declares its language", viewport: "Has a mobile viewport tag",
  "image-alt": "Images have alt text", "robots-txt": "Has a robots.txt file", sitemap: "Has an XML sitemap",
  "structured-data": "Has structured data (JSON-LD)", "open-graph": "Has social preview tags",
  hsts: "Sends an HSTS header", "not-truncated": "The HTML is under 2 MB", "mobile-layout": "Fits a phone screen (only when a browser render ran)",
  "json-ld-valid": "Every structured data block is valid JSON", "schema-complete": "Structured data has its required properties and no template text",
  "canonical-valid": "The canonical link points at the page itself", "heading-order": "Heading levels step down one at a time",
  "security-headers": "Sends nosniff, frame protection and a referrer policy", "image-dimensions": "Images have width and height so the layout does not jump",
  "internal-links": "The homepage links to at least two other pages", "broken-links": "No followed internal link leads to an error page",
  "sitemap-quality": "The sitemap lists each page once, on the right host (only when a sitemap exists)",
  "robots-sitemap": "robots.txt points to the sitemap (only when robots.txt exists)",
  "pages-titles": "Inner pages each have their own title (only when inner pages were read)",
  "pages-descriptions": "Inner pages each have their own meta description (only when inner pages were read)",
  "pages-h1": "Inner pages have exactly one H1 (only when inner pages were read)",
  "pages-content": "Inner pages have at least 100 words (only when inner pages were read)",
  // AI visibility
  "ai-crawler-oai-searchbot": "OAI-SearchBot (ChatGPT search) is allowed in robots.txt", "ai-crawler-claude-searchbot": "Claude-SearchBot (Claude search) is allowed in robots.txt",
  "ai-crawler-perplexitybot": "PerplexityBot (Perplexity) is allowed in robots.txt", "ai-crawler-googlebot": "Googlebot (Google Search and AI Overviews) is allowed in robots.txt",
  "freshness-signals": "A machine-readable date shows when the page was last updated",
  "content-in-html": "The content is in the HTML, not only added by JavaScript", "organisation-schema": "Organisation schema identifies the business",
  "question-headings": "Questions are answered under question headings", "citable-passage": "Has a 40 to 200 word paragraph that can be quoted",
  "llms-txt": "Has an llms.txt file (a small bonus)",
  // Content and conversion
  "cta-present": "Has a clear call to action", "headline-clear": "The headline is 3 to 20 words", "contact-info": "Has a way to contact the business",
  "trust-signals": "Shows social proof (reviews, ratings, guarantees)", navigation: "Has a menu with three or more links",
  "value-prop": "AI review: the value is clear", audience: "AI review: it says who it is for",
  "cta-clarity": "AI review: the next step is clear", differentiation: "AI review: something concrete sets it apart",
  // Speed
  "perf-score": "Mobile performance score of 90 or more", lcp: "The main content appears within 2.5 seconds", cls: "The layout does not jump (shift under 0.1)",
  tbt: "The page is not frozen by scripts (under 200 ms)", fcp: "Something appears within 1.8 seconds",
  // Social
  "has-profiles": "Links two or more social profiles", "profile-links-valid": "No placeholder links to a platform's front page",
  "key-platforms": "Links Facebook, Instagram or LinkedIn", "schema-sameas": "Lists the profiles in the Organization sameAs field",
  "profiles-reachable": "Every linked profile exists", "profile-activity": "A linked profile posted in the last six months",
};

const SOURCES: Record<ModuleRubric["module"], string> = {
  technical: "A plain fetch of the homepage and up to ten inner pages, robots.txt, the sitemap and the response headers. No AI.",
  geo: "The same fetch, read for AI search crawler rules (ChatGPT search, Claude search, Perplexity, Google), the text in the HTML, structured data and dates. Blocking an AI training crawler such as GPTBot is shown as a choice, never as a problem. No AI.",
  content: "Fixed checks on the page text (80 points), plus a small AI review (20 points). The AI's answers only count when they quote a specific passage that is really on the page.",
  performance: "Google PageSpeed Insights, one mobile lab run. Needs a free API key. Each vital earns full marks when good, half in Google's needs-improvement band and none when poor; the overall speed score earns its share in proportion.",
  social: "Social links found on the homepage, then each public profile page read without logging in. Pages that need a login are reported as unchecked. When a public page states its audience in the description it shows to anyone (for example Facebook's \"621,509 followers\"), that count is shown. Instagram business and creator accounts are read through Meta's official API when the server owner has connected one, which adds their follower count and latest post.",
};

const LABEL: Record<ModuleRubric["module"], string> = {
  technical: "SEO", geo: "AI visibility", content: "Content and conversion", performance: "Speed", social: "Social media",
};

const blank = (body = "<html><head></head><body></body></html>"): SiteSnapshot => ({
  origin: "https://example.com", domain: "example.com",
  home: { url: "https://example.com/", finalUrl: "https://example.com/", status: 200, headers: {}, contentType: "text/html", body, truncated: false },
  pages: [], robotsTxt: null, robots: null, sitemapUrl: null, sitemapXml: null, llmsTxt: null, fetchedAt: new Date(0).toISOString(),
});

const PERFECT_PSI = {
  lighthouseResult: {
    categories: { performance: { score: 1 } },
    audits: {
      "largest-contentful-paint": { numericValue: 1000 }, "cumulative-layout-shift": { numericValue: 0 },
      "total-blocking-time": { numericValue: 0 }, "first-contentful-paint": { numericValue: 500 },
    },
  },
};

const toChecks = (outcomes: CheckOutcome[]): RubricCheck[] =>
  outcomes.map((o) => ({ id: o.id, weight: o.weight, label: LABELS[o.id] ?? "" }));

export async function rubricTable(): Promise<ModuleRubric[]> {
  const content = await runContentChecks(blank(), null);
  const performance = await runPerformanceChecks("https://example.com/", {
    apiKey: "docs", quotaOk: () => true, fetchJson: async () => PERFECT_PSI,
  });
  const social = await runSocialChecks(
    blank('<html><body><a href="https://www.facebook.com/example">f</a></body></html>'),
    async () => ({ status: "found", lastActivityAt: "2026-09-01T00:00:00Z" }),
    undefined,
    Date.parse("2026-10-01T00:00:00Z"),
  );

  const modules: [ModuleRubric["module"], RubricCheck[]][] = [
    ["technical", toChecks(runTechnicalChecks(blank()))],
    ["geo", toChecks(runGeoChecks(blank()))],
    ["content", [...toChecks(content.outcomes), ...RUBRIC.map((r) => ({ id: r.id, weight: 5, label: LABELS[r.id] ?? "", ai: true }))]],
    ["performance", toChecks(performance.outcomes)],
    ["social", toChecks(social.outcomes)],
  ];
  return modules.map(([module, checks]) => ({
    module, label: LABEL[module], weightInOverall: MODULE_WEIGHTS[module], source: SOURCES[module], checks,
  }));
}
