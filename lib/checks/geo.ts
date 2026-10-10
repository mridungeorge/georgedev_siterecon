import * as cheerio from "cheerio";
import type { SiteSnapshot } from "@/lib/snapshot";
import type { CheckOutcome } from "@/lib/pipeline/schemas";
import { isAllowed } from "@/lib/robots";
import { clip, makeChecker } from "./helpers";

export type CrawlerRole = "search" | "google" | "training";
export interface CrawlerInfo { bot: string; role: CrawlerRole; governs: string }

/**
 * What each AI crawler actually controls. The distinction matters: GPTBot and ClaudeBot are the
 * *training* crawlers, so blocking them opts a site out of model training but does not remove it
 * from ChatGPT or Claude search. The search crawlers (OAI-SearchBot, Claude-SearchBot,
 * PerplexityBot) and Googlebot, which Google's AI Overviews follow, are what decide whether the site
 * can be cited. Only those are scored; training crawlers are reported as a choice.
 */
export const CRAWLERS: CrawlerInfo[] = [
  { bot: "OAI-SearchBot", role: "search", governs: "ChatGPT search: whether the site can be shown and cited in ChatGPT answers" },
  { bot: "Claude-SearchBot", role: "search", governs: "Claude search: whether the site can be shown and cited in Claude answers" },
  { bot: "PerplexityBot", role: "search", governs: "Perplexity: whether the site can be shown and cited in Perplexity answers" },
  { bot: "Googlebot", role: "google", governs: "Google Search and Google's AI Overviews, which follow Googlebot" },
  { bot: "GPTBot", role: "training", governs: "OpenAI model training only. It does not affect ChatGPT search" },
  { bot: "ClaudeBot", role: "training", governs: "Anthropic model training only. It does not affect Claude search" },
  { bot: "Google-Extended", role: "training", governs: "Gemini and Vertex AI training only. Google Search and AI Overviews ignore it" },
  { bot: "Applebot-Extended", role: "training", governs: "Apple Intelligence training only. Siri and Spotlight search follow Applebot" },
  { bot: "CCBot", role: "training", governs: "Common Crawl's open dataset, which many AI models are trained on" },
];

/** For each known AI crawler: what it controls, and whether this site's robots.txt lets it in. */
export function crawlerAccess(s: SiteSnapshot): (CrawlerInfo & { allowed: boolean })[] {
  const path = new URL(s.home.finalUrl).pathname;
  return CRAWLERS.map((c) => ({ ...c, allowed: isAllowed(s.robots, c.bot, path) }));
}

/** Parseable dates that say when the page was written or last changed, from any of the usual places. */
function freshnessDates(s: SiteSnapshot, $: cheerio.CheerioAPI): string[] {
  const valid = (v: unknown): v is string => typeof v === "string" && !Number.isNaN(Date.parse(v)) && Date.parse(v) > Date.parse("1990-01-01");
  const found: string[] = [];
  const header = s.home.headers["last-modified"];
  if (valid(header)) found.push(header);
  $("time[datetime]").each((_, el) => {
    const v = $(el).attr("datetime");
    if (valid(v)) found.push(v);
  });
  $('meta[property="article:published_time"], meta[property="article:modified_time"], meta[property="og:updated_time"], meta[itemprop="dateModified"], meta[itemprop="datePublished"]').each((_, el) => {
    const v = $(el).attr("content");
    if (valid(v)) found.push(v);
  });
  const walk = (node: unknown, depth: number): void => {
    if (depth > 8 || node === null || typeof node !== "object") return;
    if (Array.isArray(node)) return node.forEach((item) => walk(item, depth + 1));
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if ((key === "dateModified" || key === "datePublished") && valid(value)) found.push(value);
      else walk(value, depth + 1);
    }
  };
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      walk(JSON.parse($(el).text()), 0);
    } catch {
      // invalid JSON-LD is ignored
    }
  });
  return found;
}

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

  // Only crawlers that decide whether the site can be cited are scored. Training crawlers are not:
  // blocking them is a legitimate choice, and it does not remove the site from AI search.
  for (const c of CRAWLERS.filter((x) => x.role !== "training")) {
    check(`ai-crawler-${c.bot.toLowerCase()}`, c.role === "google" ? 6 : 10, isAllowed(s.robots, c.bot, path), {
      severity: c.role === "google" ? "critical" : "high", effort: "low",
      title: `robots.txt blocks ${c.bot}`,
      detail: `${c.bot} is not allowed to read this page. It controls ${c.governs}, so the site cannot be cited there.`,
      fix: `Remove the Disallow rule for ${c.bot} in robots.txt, unless keeping the site out of that product is deliberate.`,
      evidence: [{ url: robotsUrl, note: `${c.bot} is disallowed for ${path}` }],
    });
  }

  // Most AI crawlers do not run JavaScript. What matters is the text in the HTML itself.
  $("script, style, noscript, template, svg").remove();
  const bodyText = $("body").text().replace(/\s+/g, " ").trim();
  const wordCount = words(bodyText);
  // When the optional browser render ran, a gap between what a browser sees and what is in the
  // raw HTML is direct proof that AI crawlers are missing content.
  const browserWords = s.rendered?.words ?? 0;
  const jsOnly = browserWords >= 150 && wordCount < 150;
  check("content-in-html", 20, wordCount >= 150, {
    severity: "critical", effort: "high",
    title: jsOnly
      ? `Only ${wordCount} words are in the HTML, but a browser shows ${browserWords}`
      : `Only ${wordCount} words of content are in the HTML of the page`,
    detail: jsOnly
      ? "A real browser shows far more text than the HTML contains, so the content is added by JavaScript. Most AI crawlers do not run JavaScript and see an almost empty page."
      : "Most AI crawlers do not run JavaScript. If the content only appears after scripts run, they see an almost empty page.",
    fix: "Render the main content on the server (SSR or static generation) so it is present in the initial HTML.",
    evidence: [{
      url,
      note: jsOnly
        ? `${wordCount} words in the raw HTML against ${browserWords} words in a real browser`
        : `${wordCount} words of visible text in the raw HTML`,
      ...(bodyText ? { quote: clip(bodyText) } : {}),
    }],
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

  // Only when the page has question headings: a question with no answer under it gives an AI nothing to quote.
  if (questionHeadings.length > 0) {
    const unanswered = questionHeadings.toArray().filter((el) => {
      const next = fresh(el).next();
      const tag = String(next.prop("tagName") ?? "").toLowerCase();
      if (tag === "p") {
        const n = words(next.text().replace(/\s+/g, " ").trim());
        return n < 20 || n > 200;
      }
      if (tag === "ul" || tag === "ol") return next.children("li").length < 2;
      return true;
    });
    check("question-answers", 3, unanswered.length === 0, {
      severity: "medium", effort: "low",
      title: `${unanswered.length} question heading${unanswered.length === 1 ? " has" : "s have"} no answer directly beneath ${unanswered.length === 1 ? "it" : "them"}`,
      detail: "AI answer engines lift the passage that sits right under a question. When the next thing after the question is another heading, a very short line or a long wall of text, there is nothing clean to quote.",
      fix: "Put a direct answer of two to four sentences (about 20 to 100 words) immediately under each question heading, then add detail after it.",
      evidence: unanswered.slice(0, 4).map((el) => ({ url, note: "no answer directly beneath this question", quote: clip(fresh(el).text()) })),
    });
  }

  const paragraphs = fresh("p").map((_, el) => fresh(el).text().replace(/\s+/g, " ").trim()).get();
  const citable = paragraphs.find((p) => words(p) >= 40 && words(p) <= 200);
  check("citable-passage", 14, Boolean(citable), {
    severity: "medium", effort: "medium",
    title: "No paragraph is substantial enough to be quoted",
    detail: "AI systems quote self-contained passages of roughly 40 to 200 words. Short fragments and slogans do not get cited.",
    fix: "Add at least one paragraph that explains what the business does, for whom and why, in plain complete sentences.",
    evidence: [{ url, note: `${paragraphs.length} paragraphs found, none between 40 and 200 words` }],
  });

  check("llms-txt", 4, s.llmsTxt !== null, {
    severity: "low", effort: "low",
    title: "The site has no llms.txt file",
    detail: "llms.txt is an emerging convention that gives AI agents a short guide to the site. Google Search ignores it, so this is a small bonus, not a requirement.",
    fix: "Add a /llms.txt with a one-paragraph summary of the business and links to its most important pages.",
    evidence: [{ url: `${s.origin}/llms.txt`, note: "not found" }],
  });

  const dates = freshnessDates(s, fresh);
  check("freshness-signals", 4, dates.length > 0, {
    severity: "low", effort: "low",
    title: "Nothing on the page says when it was written or last updated",
    detail: "AI answer engines and Google favour content that shows it is current. A machine-readable date (a Last-Modified header, a <time datetime> element, or datePublished/dateModified in the schema) is how they tell.",
    fix: "Add dateModified (and datePublished) to the page's JSON-LD, or wrap the \"last updated\" date in <time datetime=\"2026-01-31\">.",
    evidence: [{ url, note: "no Last-Modified header, <time datetime>, article date meta tag or schema date found" }],
  });

  return outcomes;
}
