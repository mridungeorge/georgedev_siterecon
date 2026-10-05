import * as cheerio from "cheerio";
import type { SiteSnapshot } from "@/lib/snapshot";
import type { CheckOutcome } from "@/lib/pipeline/schemas";
import { isAllowed } from "@/lib/robots";
import { clip, makeChecker } from "./helpers";

/** The crawlers that feed ChatGPT, Claude, Perplexity and Google's AI features. */
export const AI_CRAWLERS = ["GPTBot", "ClaudeBot", "PerplexityBot", "Google-Extended"] as const;

const ORGANISATION_TYPES = new Set([
  "Organization", "Corporation", "LocalBusiness", "Store", "OnlineStore", "OnlineBusiness",
  "ProfessionalService", "Restaurant", "NGO", "EducationalOrganization", "MedicalOrganization",
]);

/** Every @type used in the page's valid JSON-LD, including nested and @graph items. */
function jsonLdTypes($: cheerio.CheerioAPI): Set<string> {
  const types = new Set<string>();
  const walk = (node: unknown, depth: number): void => {
    if (depth > 8 || node === null || typeof node !== "object") return;
    if (Array.isArray(node)) return node.forEach((item) => walk(item, depth + 1));
    const record = node as Record<string, unknown>;
    const type = record["@type"];
    for (const t of Array.isArray(type) ? type : [type]) if (typeof t === "string") types.add(t);
    for (const value of Object.values(record)) walk(value, depth + 1);
  };
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      walk(JSON.parse($(el).text()), 0);
    } catch {
      // invalid JSON-LD is ignored
    }
  });
  return types;
}

const words = (text: string) => text.split(/\s+/).filter(Boolean).length;

export function runGeoChecks(s: SiteSnapshot): CheckOutcome[] {
  const { outcomes, check } = makeChecker("geo");
  const $ = cheerio.load(s.home.body);
  const url = s.home.finalUrl;
  const path = new URL(url).pathname;
  const robotsUrl = `${s.origin}/robots.txt`;

  for (const bot of AI_CRAWLERS) {
    check(`ai-crawler-${bot.toLowerCase()}`, 10, isAllowed(s.robots, bot, path), {
      severity: "high", effort: "low",
      title: `robots.txt blocks ${bot}`,
      detail: `${bot} is not allowed to read this page, so the AI products that rely on it cannot cite or recommend the site.`,
      fix: `Remove the Disallow rule for ${bot} in robots.txt, unless blocking AI crawlers is a deliberate choice.`,
      evidence: [{ url: robotsUrl, note: `${bot} is disallowed for ${path}` }],
    });
  }

  // Most AI crawlers do not run JavaScript. What matters is the text in the HTML itself.
  $("script, style, noscript, template, svg").remove();
  const bodyText = $("body").text().replace(/\s+/g, " ").trim();
  const wordCount = words(bodyText);
  check("content-in-html", 20, wordCount >= 150, {
    severity: "critical", effort: "high",
    title: `Only ${wordCount} words of content are in the HTML of the page`,
    detail: "Most AI crawlers do not run JavaScript. If the content only appears after scripts run, they see an almost empty page.",
    fix: "Render the main content on the server (SSR or static generation) so it is present in the initial HTML.",
    evidence: [{ url, note: `${wordCount} words of visible text in the raw HTML`, ...(bodyText ? { quote: clip(bodyText) } : {}) }],
  });

  const fresh = cheerio.load(s.home.body);
  const types = jsonLdTypes(fresh);
  check("organisation-schema", 12, [...types].some((t) => ORGANISATION_TYPES.has(t)), {
    severity: "medium", effort: "medium",
    title: "No organisation schema tells AI systems who runs this site",
    detail: "Organization or LocalBusiness markup gives AI systems a reliable source for the brand name, logo, location and profiles.",
    fix: "Add Organization (or LocalBusiness) JSON-LD with name, url, logo, sameAs links and contact details.",
    evidence: [{ url, note: types.size ? `schema types found: ${[...types].join(", ")}` : "no JSON-LD types found" }],
  });

  const questionHeadings = fresh("h2, h3").filter((_, el) => fresh(el).text().trim().endsWith("?"));
  check("question-headings", 10, questionHeadings.length > 0 || types.has("FAQPage") || types.has("QAPage"), {
    severity: "medium", effort: "medium",
    title: "The page does not answer questions in a form AI systems can lift",
    detail: "AI answers are built from passages that directly answer a question. Question headings with a short answer underneath are the easiest to cite.",
    fix: "Add an FAQ or question-style H2 and H3 headings, each followed by a direct two-to-three sentence answer.",
    evidence: [{ url, note: "no question headings and no FAQPage schema" }],
  });

  const paragraphs = fresh("p").map((_, el) => fresh(el).text().replace(/\s+/g, " ").trim()).get();
  const citable = paragraphs.find((p) => words(p) >= 40 && words(p) <= 200);
  check("citable-passage", 12, Boolean(citable), {
    severity: "medium", effort: "medium",
    title: "No paragraph is substantial enough to be quoted",
    detail: "AI systems quote self-contained passages of roughly 40 to 200 words. Short fragments and slogans do not get cited.",
    fix: "Add at least one paragraph that explains what the business does, for whom and why, in plain complete sentences.",
    evidence: [{ url, note: `${paragraphs.length} paragraphs found, none between 40 and 200 words` }],
  });

  check("llms-txt", 6, s.llmsTxt !== null, {
    severity: "low", effort: "low",
    title: "The site has no llms.txt file",
    detail: "llms.txt is an emerging convention that gives AI agents a short guide to the site. Google Search ignores it, so this is a small bonus, not a requirement.",
    fix: "Add a /llms.txt with a one-paragraph summary of the business and links to its most important pages.",
    evidence: [{ url: `${s.origin}/llms.txt`, note: "not found" }],
  });

  return outcomes;
}
