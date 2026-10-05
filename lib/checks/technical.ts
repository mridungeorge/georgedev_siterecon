import * as cheerio from "cheerio";
import type { SiteSnapshot } from "@/lib/snapshot";
import type { CheckOutcome } from "@/lib/pipeline/schemas";
import { clip, makeChecker } from "./helpers";

/** True when the page has at least one JSON-LD block that parses. Broken blocks are ignored. */
export function hasValidJsonLd($: cheerio.CheerioAPI): boolean {
  let found = false;
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      JSON.parse($(el).text());
      found = true;
    } catch {
      // invalid JSON-LD is treated as absent
    }
  });
  return found;
}

export function runTechnicalChecks(s: SiteSnapshot): CheckOutcome[] {
  const { outcomes, check } = makeChecker("technical");
  const $ = cheerio.load(s.home.body);
  const url = s.home.finalUrl;
  const at = (note: string, quote?: string) => [{ url, note, ...(quote ? { quote: clip(quote) } : {}) }];

  check("status-ok", 10, s.home.status === 200, {
    severity: "critical", effort: "medium",
    title: `The homepage returns HTTP ${s.home.status}`,
    detail: "Search engines only index pages that return a 200 status. Any other status keeps the page out of results.",
    fix: "Make the homepage return HTTP 200 for normal visitors and crawlers.",
    evidence: at(`HTTP status ${s.home.status}`),
  });

  check("https", 8, url.startsWith("https://"), {
    severity: "high", effort: "low",
    title: "The site is served over plain HTTP",
    detail: "Browsers mark HTTP pages as not secure, and search engines prefer HTTPS.",
    fix: "Install a TLS certificate and redirect every http:// URL to https://.",
    evidence: at("final URL uses http://"),
  });

  const metaRobots = $('meta[name="robots" i]').attr("content") ?? "";
  const headerRobots = s.home.headers["x-robots-tag"] ?? "";
  check("indexable", 10, !/noindex/i.test(metaRobots) && !/noindex/i.test(headerRobots), {
    severity: "critical", effort: "low",
    title: "The homepage tells search engines not to index it",
    detail: "A noindex directive removes the page from search results entirely.",
    fix: "Remove noindex from the robots meta tag and the X-Robots-Tag header on pages that should rank.",
    evidence: at("noindex directive", metaRobots ? `<meta name="robots" content="${metaRobots}">` : `X-Robots-Tag: ${headerRobots}`),
  });

  const title = $("head > title").first().text().trim();
  check("title", 8, title.length > 0, {
    severity: "high", effort: "low",
    title: "The homepage has no title tag",
    detail: "The title is the main headline shown in search results and browser tabs.",
    fix: "Add a <title> that names the business and what it offers.",
    evidence: at("no <title> in <head>"),
  });
  check("title-length", 4, title.length === 0 || (title.length >= 15 && title.length <= 60), {
    severity: "low", effort: "low",
    title: `The title is ${title.length} characters long`,
    detail: "Titles under 15 characters say too little. Titles over 60 are usually cut off in search results.",
    fix: "Rewrite the title to between 15 and 60 characters, leading with the main keyword.",
    evidence: at("title text", title),
  });

  const description = ($('meta[name="description" i]').attr("content") ?? "").trim();
  check("meta-description", 6, description.length > 0, {
    severity: "medium", effort: "low",
    title: "The homepage has no meta description",
    detail: "Without one, search engines pick their own snippet, which is often a poor pitch for the page.",
    fix: "Add a meta description that says who the page is for and why they should click.",
    evidence: at('no <meta name="description">'),
  });
  check("meta-description-length", 3, description.length === 0 || (description.length >= 70 && description.length <= 160), {
    severity: "low", effort: "low",
    title: `The meta description is ${description.length} characters long`,
    detail: "Descriptions under 70 characters waste the space. Over 160 they are cut off.",
    fix: "Rewrite the meta description to between 70 and 160 characters.",
    evidence: at("meta description", description),
  });

  const h1s = $("h1");
  check("single-h1", 6, h1s.length === 1, {
    severity: "medium", effort: "low",
    title: h1s.length === 0 ? "The homepage has no H1 heading" : `The homepage has ${h1s.length} H1 headings`,
    detail: "One clear H1 tells readers and search engines what the page is about.",
    fix: "Use exactly one H1 that states the main topic of the page. Use H2 and H3 for the rest.",
    evidence: at(`${h1s.length} <h1> elements`, h1s.first().text()),
  });

  check("canonical", 4, Boolean($('link[rel="canonical" i]').attr("href")), {
    severity: "medium", effort: "low",
    title: "The homepage has no canonical link",
    detail: "A canonical link tells search engines which URL is the main one when the same page is reachable at several.",
    fix: `Add <link rel="canonical" href="${url}"> to the page head.`,
    evidence: at('no <link rel="canonical">'),
  });

  check("html-lang", 3, Boolean($("html").attr("lang")), {
    severity: "low", effort: "low",
    title: "The page does not declare its language",
    detail: "The lang attribute helps search engines and screen readers handle the text correctly.",
    fix: 'Add a lang attribute to the <html> tag, for example <html lang="en">.',
    evidence: at("<html> has no lang attribute"),
  });

  check("viewport", 6, Boolean($('meta[name="viewport" i]').attr("content")), {
    severity: "high", effort: "low",
    title: "The page has no mobile viewport tag",
    detail: "Without it, phones show a shrunken desktop layout. Google indexes the mobile version of a site first.",
    fix: 'Add <meta name="viewport" content="width=device-width, initial-scale=1"> to the head.',
    evidence: at('no <meta name="viewport">'),
  });

  const images = $("img");
  const missingAlt = images.filter((_, el) => $(el).attr("alt") === undefined);
  check("image-alt", 5, images.length === 0 || missingAlt.length / images.length <= 0.1, {
    severity: "medium", effort: "medium",
    title: `${missingAlt.length} of ${images.length} images have no alt text`,
    detail: "Alt text describes images to search engines and to people using screen readers.",
    fix: 'Add a short descriptive alt attribute to every meaningful image, and alt="" to decorative ones.',
    evidence: at("first image without alt", $.html(missingAlt.first())),
  });

  check("robots-txt", 4, s.robotsTxt !== null, {
    severity: "low", effort: "low",
    title: "The site has no robots.txt file",
    detail: "robots.txt tells crawlers what they may visit and where the sitemap is.",
    fix: "Add a robots.txt at the site root that allows crawling and lists the sitemap URL.",
    evidence: [{ url: `${s.origin}/robots.txt`, note: "not found, or not a text file" }],
  });

  check("sitemap", 6, s.sitemapXml !== null, {
    severity: "medium", effort: "low",
    title: "No XML sitemap was found",
    detail: "A sitemap helps search engines find every page, including ones that are not well linked.",
    fix: "Generate an XML sitemap, serve it at /sitemap.xml, and reference it from robots.txt.",
    evidence: [{ url: `${s.origin}/sitemap.xml`, note: "not found, or not a sitemap" }],
  });

  check("structured-data", 6, hasValidJsonLd($), {
    severity: "medium", effort: "medium",
    title: "The homepage has no structured data",
    detail: "Schema.org markup lets search engines show rich results and helps AI systems understand the business.",
    fix: "Add JSON-LD for the organisation (name, logo, URL, social profiles) and for the main page type.",
    evidence: at("no valid application/ld+json block"),
  });

  const og = Boolean($('meta[property="og:title"]').attr("content")) && Boolean($('meta[property="og:image"]').attr("content"));
  check("open-graph", 4, og, {
    severity: "low", effort: "low",
    title: "Links to this page will share without a proper preview",
    detail: "og:title and og:image control the card shown when the page is shared on social platforms and chat apps.",
    fix: "Add og:title, og:description and og:image (1200x630) meta tags.",
    evidence: at("missing og:title or og:image"),
  });

  check("hsts", 3, Boolean(s.home.headers["strict-transport-security"]), {
    severity: "low", effort: "low",
    title: "The site does not send an HSTS header",
    detail: "Strict-Transport-Security tells browsers to always use HTTPS for this site.",
    fix: "Send Strict-Transport-Security: max-age=31536000; includeSubDomains from the server.",
    evidence: at("no strict-transport-security response header"),
  });

  check("not-truncated", 4, !s.home.truncated, {
    severity: "medium", effort: "high",
    title: "The homepage HTML is over 2 MB",
    detail: "SiteRecon read only the first 2 MB. Very large HTML slows loading and crawlers may stop reading it early.",
    fix: "Reduce inline scripts, styles and embedded data so the HTML document is well under 2 MB.",
    evidence: at("response exceeded the 2,000,000-byte cap"),
  });

  return outcomes;
}
