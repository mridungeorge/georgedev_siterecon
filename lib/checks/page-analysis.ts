import * as cheerio from "cheerio";
import type { SiteSnapshot } from "@/lib/snapshot";
import { registrableDomain } from "@/lib/url-guard";
import { nodesOfType, readJsonLd } from "./jsonld";

// What one page looks like to a system that wants to quote it. Everything here is read from the HTML
// with no AI. Text comes from the audited site, so callers cut it short before showing it.

export interface PageAnalysis {
  url: string;
  title: string;
  h1: string;
  /** Words of visible text. */
  words: number;
  /** Visible paragraph text, outside navigation, footers and sidebars. */
  paragraphs: string[];
  headings: { level: number; text: string }[];
  /** Every @type found in the page's valid JSON-LD. */
  schemaTypes: string[];
  /** Other sites the page links to, as registrable domains, without social networks. */
  externalDomains: string[];
  hasByline: boolean;
  hasDate: boolean;
  /** The `<html>` of the page, kept for checks that need the DOM again. */
  html: string;
}

const SOCIAL = new Set([
  "facebook.com", "instagram.com", "twitter.com", "x.com", "linkedin.com", "youtube.com", "tiktok.com", "pinterest.com", "github.com", "wa.me", "t.me",
]);

export const wordCount = (text: string): number => text.split(/\s+/).filter(Boolean).length;
const clean = (text: string) => text.replace(/\s+/g, " ").trim();

// The same page is analysed by several modules in one scan. The analysis is a pure function of its
// input, so the last few results are kept to avoid parsing the same HTML again and again.
const MEMO = new Map<string, PageAnalysis>();
const MEMO_MAX = 24;

export function analysePage(url: string, html: string): PageAnalysis {
  const key = `${url}
${html}`;
  const hit = MEMO.get(key);
  if (hit) return hit;
  const result = analyse(url, html);
  if (MEMO.size >= MEMO_MAX) MEMO.delete(MEMO.keys().next().value as string);
  MEMO.set(key, result);
  return result;
}

function analyse(url: string, html: string): PageAnalysis {
  const $ = cheerio.load(html);
  const title = clean($("head > title").first().text());
  const h1 = clean($("h1").first().text());

  const schemaTypes = new Set<string>();
  const blocks = readJsonLd($);
  const walk = (node: unknown, depth: number): void => {
    if (depth > 10 || node === null || typeof node !== "object") return;
    if (Array.isArray(node)) return node.forEach((n) => walk(n, depth + 1));
    const record = node as Record<string, unknown>;
    const type = record["@type"];
    for (const t of Array.isArray(type) ? type : [type]) if (typeof t === "string") schemaTypes.add(t);
    for (const value of Object.values(record)) walk(value, depth + 1);
  };
  for (const b of blocks) if (b.data !== null) walk(b.data, 0);

  const hasByline =
    Boolean(clean($('meta[name="author" i]').attr("content") ?? "")) ||
    $('[rel="author"], [itemprop="author"], .byline, .author').length > 0 ||
    nodesOfType(blocks, new Set(["Article", "NewsArticle", "BlogPosting"])).some((n) => n.author !== undefined);
  const hasDate =
    $("time[datetime]").length > 0 ||
    $('meta[property="article:published_time"], meta[itemprop="datePublished"]').length > 0 ||
    nodesOfType(blocks, new Set(["Article", "NewsArticle", "BlogPosting"])).some((n) => n.datePublished !== undefined);

  const headings = $("h1, h2, h3, h4, h5, h6")
    .map((_, el) => ({ level: Number(el.tagName.slice(1)), text: clean($(el).text()) }))
    .get()
    .filter((h) => h.text);

  const host = (() => {
    try {
      return new URL(url).hostname;
    } catch {
      return "";
    }
  })();
  const own = host ? registrableDomain(host) : "";
  const external = new Set<string>();
  $("a[href]").each((_, el) => {
    try {
      const u = new URL($(el).attr("href") ?? "", url);
      if (!/^https?:$/.test(u.protocol)) return;
      const domain = registrableDomain(u.hostname);
      if (domain && domain !== own && !SOCIAL.has(domain)) external.add(domain);
    } catch {
      // not a usable link
    }
  });

  $("script, style, noscript, template, svg, nav, footer, aside").remove();
  const paragraphs = $("p")
    .map((_, el) => clean($(el).text()))
    .get()
    .filter((p) => p.length > 0);
  const text = clean($("body").text());

  return {
    url, title, h1, words: wordCount(text), paragraphs, headings,
    schemaTypes: [...schemaTypes], externalDomains: [...external], hasByline, hasDate, html,
  };
}

/** The name of the site: og:site_name, then Organization or WebSite schema, then the brand part of the title. */
export function siteEntity(s: SiteSnapshot): string | null {
  const $ = cheerio.load(s.home.body);
  // Leftover template text such as [Business Name] is not a name, so it is never treated as one.
  const usable = (name: string) => name !== "" && !/[[\]{}<>]|your (business|company|name)|business name|company name|lorem|^untitled/i.test(name);
  const og = clean($('meta[property="og:site_name"]').attr("content") ?? "");
  if (usable(og)) return og.slice(0, 80);
  const named = nodesOfType(readJsonLd($), new Set(["Organization", "LocalBusiness", "Corporation", "Store", "WebSite", "Person"]))
    .map((n) => (typeof n.name === "string" ? clean(n.name) : ""))
    .find(usable);
  if (named) return named.slice(0, 80);
  const title = clean($("head > title").first().text());
  const brand = title.split(/\s[|–—-]\s|:\s/)[0]?.trim() ?? "";
  return usable(brand) ? brand.slice(0, 80) : null;
}
