import * as cheerio from "cheerio";
import type { SiteSnapshot } from "@/lib/snapshot";
import { analysePage, siteEntity, type PageAnalysis } from "./page-analysis";

// Finds pages whose content calls for a kind of structured data they do not have, and builds the
// JSON-LD to add from the page itself. A value is copied from the page or left out: the builder never
// invents a price, a rating or a date.

export type GapType = "FAQPage" | "Article" | "Product";

export interface SchemaGap {
  url: string;
  type: GapType;
  /** Why the page was judged to be this kind of page. */
  reason: string;
  /** A complete JSON-LD object, ready to paste. */
  snippet: Record<string, unknown>;
  /** Anything the visitor must add by hand. */
  note: string;
}

const ARTICLE_TYPES = ["Article", "NewsArticle", "BlogPosting", "TechArticle"];
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

export interface PageSchemaFit {
  url: string;
  /** The kinds of structured data this page's content calls for. */
  detected: GapType[];
  /** The ones it is missing, with the JSON-LD to add. */
  gaps: SchemaGap[];
}

export function faqPairs($: cheerio.CheerioAPI): { q: string; a: string }[] {
  const pairs: { q: string; a: string }[] = [];
  $("h2, h3, h4").each((_, el) => {
    const q = oneLine($(el).text());
    if (!q.endsWith("?")) return;
    const next = $(el).next();
    if (String(next.prop("tagName") ?? "").toLowerCase() !== "p") return;
    const a = oneLine(next.text());
    if (a.split(" ").length >= 5) pairs.push({ q, a });
  });
  return pairs;
}

function fitForPage(a: PageAnalysis, entity: string | null, isHome: boolean): PageSchemaFit {
  const $ = cheerio.load(a.html);
  const gaps: SchemaGap[] = [];
  const detected: GapType[] = [];
  const has = (...types: string[]) => types.some((t) => a.schemaTypes.includes(t));
  const path = (() => {
    try {
      return new URL(a.url).pathname;
    } catch {
      return "/";
    }
  })();

  const pairs = faqPairs($);
  if (pairs.length >= 3) detected.push("FAQPage");
  if (pairs.length >= 3 && !has("FAQPage", "QAPage")) {
    gaps.push({
      url: a.url, type: "FAQPage", reason: `${pairs.length} question headings, each with an answer`,
      snippet: {
        "@context": "https://schema.org", "@type": "FAQPage",
        mainEntity: pairs.slice(0, 10).map((p) => ({ "@type": "Question", name: p.q, acceptedAnswer: { "@type": "Answer", text: clip(p.a, 500) } })),
      },
      note: "Built from the question headings and the paragraph under each. The answers in the markup must match what visitors see.",
    });
  }

  const isArticle =
    !isHome &&
    $("article").length > 0 &&
    a.words >= 300 &&
    (/^\/(blog|news|articles?|insights|journal|guides?|posts?)\b/i.test(path) || $('meta[property="og:type"]').attr("content") === "article" || a.hasDate);
  if (isArticle) detected.push("Article");
  if (isArticle && !has(...ARTICLE_TYPES)) {
    const snippet: Record<string, unknown> = { "@context": "https://schema.org", "@type": "Article" };
    if (a.h1) snippet.headline = clip(a.h1, 110);
    const published = $("time[datetime]").first().attr("datetime") ?? $('meta[property="article:published_time"]').attr("content");
    if (published) snippet.datePublished = published;
    const author = oneLine($('meta[name="author" i]').attr("content") ?? "");
    if (author) snippet.author = { "@type": "Person", name: author };
    const image = $('meta[property="og:image"]').attr("content");
    if (image) snippet.image = image;
    if (entity) snippet.publisher = { "@type": "Organization", name: entity };
    gaps.push({
      url: a.url, type: "Article", reason: "an article page with no Article, NewsArticle or BlogPosting markup", snippet,
      note: `Fields the page does not state (${["headline", "datePublished", "author", "image"].filter((k) => !(k in snippet)).join(", ") || "none"}) are left out: add them.`,
    });
  }

  // One product page has one main price (perhaps a "was" price) and one buy button. A page with many
  // prices or many buy buttons is a listing, which is a CollectionPage, not a Product.
  const prices = new Set($("body").text().match(/[$€£]\s?\d[\d,]*(?:\.\d+)?/g) ?? []);
  const buyButtons = $("button, input[type=submit], a").toArray().filter((el) => /add to (cart|basket|bag|trolley)|buy now/i.test($(el).text() + ($(el).attr("value") ?? ""))).length;
  const isProduct = !isHome && prices.size >= 1 && prices.size <= 4 && buyButtons >= 1 && buyButtons <= 2 && Boolean(a.h1);
  if (isProduct) detected.push("Product");
  if (isProduct && !has("Product")) {
    const snippet: Record<string, unknown> = { "@context": "https://schema.org", "@type": "Product", name: clip(a.h1, 150) };
    const description = oneLine($('meta[name="description" i]').attr("content") ?? "");
    if (description) snippet.description = clip(description, 300);
    const image = $('meta[property="og:image"]').attr("content");
    if (image) snippet.image = image;
    const amount = $('meta[property="product:price:amount"]').attr("content") ?? $('[itemprop="price"]').attr("content");
    const currency = $('meta[property="product:price:currency"]').attr("content") ?? $('[itemprop="priceCurrency"]').attr("content");
    if (amount && currency) snippet.offers = { "@type": "Offer", price: amount, priceCurrency: currency, availability: "https://schema.org/InStock" };
    gaps.push({
      url: a.url, type: "Product", reason: "a page with a price and an add-to-cart button but no Product markup", snippet,
      note: amount && currency
        ? "Price and currency came from the page's own tags. Check availability before using it."
        : "Add offers with price, priceCurrency and availability by hand: SiteRecon does not guess a price.",
    });
  }
  return { url: a.url, detected, gaps };
}

/** For every page read, homepage first: what its content calls for, and what is missing. */
export function schemaFit(s: SiteSnapshot): PageSchemaFit[] {
  const entity = siteEntity(s);
  return [s.home, ...s.pages].map((res, i) => fitForPage(analysePage(res.finalUrl, res.body), entity, i === 0));
}

/** Every missing schema, homepage first. At most one of each type per page. */
export function schemaGaps(s: SiteSnapshot): SchemaGap[] {
  return schemaFit(s).flatMap((f) => f.gaps);
}
