import * as cheerio from "cheerio";
import type { SiteSnapshot } from "@/lib/snapshot";
import type { FixKitItem, ModuleResult, SocialSummary } from "@/lib/pipeline/schemas";

// Files and snippets built from what the site itself says, one for each finding that has a standard
// fix. Nothing here is written by an AI: a value is either copied from the page or left out, and every
// value is escaped for the format it will be pasted into, because it all comes from the audited site.

/** One line of plain text: control characters and newlines become spaces. */
const oneLine = (s: string, max = 200): string =>
  s.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);

const escapeAttr = (s: string) =>
  oneLine(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
const escapeXml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
/** Text for a markdown link label or a blockquote: no brackets or parentheses to break out of the syntax. */
const markdownSafe = (s: string, max = 120) => oneLine(s, max).replace(/[[\]()<>]/g, " ").replace(/\s+/g, " ").trim();

function siteName($: cheerio.CheerioAPI, domain: string): string {
  const fromOg = oneLine($('meta[property="og:site_name"]').attr("content") ?? "", 80);
  if (fromOg) return fromOg;
  const title = oneLine($("head > title").first().text(), 160);
  // "Sunrise Bakery | Fresh sourdough", "Acme: shelving", "George - AI engineer": the brand comes first.
  const first = title.split(/\s[|–—-]\s|:\s/)[0]?.trim();
  return first ? first.slice(0, 80) : domain;
}

const description = ($: cheerio.CheerioAPI) => oneLine($('meta[name="description" i]').attr("content") ?? "", 300);
const pageTitle = ($: cheerio.CheerioAPI) => oneLine($("head > title").first().text(), 160);

function pageUrl(raw: string): string | null {
  try {
    const u = new URL(raw);
    return /^https?:$/.test(u.protocol) ? u.href : null;
  } catch {
    return null;
  }
}

/** Embeds JSON in a page without letting a "<" in a value end the script tag it sits in. */
const safeJson = (value: unknown) => JSON.stringify(value, null, 2).replace(/</g, "\\u003c");

export function buildFixKit(s: SiteSnapshot, modules: ModuleResult[], social: SocialSummary | null): FixKitItem[] {
  const fired = new Set(modules.flatMap((m) => m.findings.map((f) => f.id)));
  const triggers = (ids: string[], prefix?: string) => [
    ...ids.filter((id) => fired.has(id)),
    ...(prefix ? [...fired].filter((id) => id.startsWith(prefix)) : []),
  ];
  const kit: FixKitItem[] = [];
  const home = cheerio.load(s.home.body);
  const url = s.home.finalUrl;

  const canonical = triggers(["technical:canonical", "technical:canonical-valid"]);
  if (canonical.length) {
    kit.push({
      id: "canonical", title: "Canonical tag", filename: "the <head> of the homepage", language: "html",
      content: `<link rel="canonical" href="${escapeAttr(url)}">`,
      note: "Tells search engines this address is the main version of the page. Use the page's own address on every page.",
      forFindings: canonical,
    });
  }

  const robots = triggers(["technical:robots-txt", "technical:robots-sitemap"], "geo:ai-crawler-");
  if (robots.length) {
    const sitemap = s.sitemapUrl ?? `${s.origin}/sitemap.xml`;
    const allow = ["OAI-SearchBot", "Claude-SearchBot", "PerplexityBot", "Googlebot"].map((bot) => `User-agent: ${bot}\nAllow: /`).join("\n\n");
    kit.push({
      id: "robots-txt", title: "robots.txt", filename: "robots.txt", language: "text",
      content: `User-agent: *\nAllow: /\n\n${allow}\n\nSitemap: ${sitemap}\n`,
      note: "Merge this with any rules you already need (such as blocking admin pages). The AI training crawlers (GPTBot, ClaudeBot, Google-Extended, CCBot) are not listed: blocking them is your choice and does not remove the site from AI search.",
      forFindings: robots,
    });
  }

  const sitemap = triggers(["technical:sitemap", "technical:sitemap-quality"]);
  if (sitemap.length) {
    const seen = new Set<string>();
    const host = new URL(url).hostname.replace(/^www\./, "");
    for (const raw of [url, ...s.pages.map((p) => p.finalUrl)]) {
      const href = pageUrl(raw);
      if (href && new URL(href).hostname.replace(/^www\./, "") === host) seen.add(href);
    }
    const urls = [...seen].map((u) => `  <url><loc>${escapeXml(u)}</loc></url>`).join("\n");
    kit.push({
      id: "sitemap-xml", title: "sitemap.xml", filename: "sitemap.xml", language: "xml",
      content: `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`,
      note: `Lists the ${seen.size} page${seen.size === 1 ? "" : "s"} SiteRecon found. Add the rest of your pages, or generate the file from your site, and add a lastmod date only if it is the real date the page last changed.`,
      forFindings: sitemap,
    });
  }

  const org = triggers(["geo:organisation-schema", "technical:structured-data", "technical:schema-complete"]);
  if (org.length) {
    const data: Record<string, unknown> = { "@context": "https://schema.org", "@type": "Organization", name: siteName(home, s.domain), url: `${s.origin}/` };
    const desc = description(home);
    if (desc) data.description = desc;
    const logo = pageUrl(new URL(home('meta[property="og:image"]').attr("content") ?? "", url).href.replace(/^$/, "x"));
    if (home('meta[property="og:image"]').attr("content") && logo) data.logo = logo;
    const tel = (home('a[href^="tel:" i]').first().attr("href") ?? "").replace(/^tel:/i, "");
    let phone = "";
    try {
      phone = decodeURIComponent(tel).replace(/[^+\d\s().-]/g, "").trim();
    } catch {
      phone = "";
    }
    if (phone) data.telephone = phone;
    const mail = (home('a[href^="mailto:" i]').first().attr("href") ?? "").replace(/^mailto:/i, "").split("?")[0].trim();
    if (/^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/.test(mail)) data.email = mail;
    const sameAs = [...new Set((social?.profiles ?? []).filter((p) => p.kind === "profile").map((p) => p.url))];
    if (sameAs.length) data.sameAs = sameAs;
    kit.push({
      id: "organisation-schema", title: "Organization structured data", filename: 'a <script type="application/ld+json"> in the homepage head', language: "json",
      content: safeJson(data),
      note: "Built only from details found on your homepage. Check every value, add your logo if it is missing, and if you serve customers at a place change the type to LocalBusiness and add an address.",
      forFindings: org,
    });
  }

  const llms = triggers(["geo:llms-txt"]);
  if (llms.length) {
    const lines = [`# ${markdownSafe(siteName(home, s.domain), 80) || s.domain}`];
    const desc = markdownSafe(description(home), 200);
    if (desc) lines.push(`> ${desc}`);
    const pages = s.pages.flatMap((p) => {
      const href = pageUrl(p.finalUrl);
      if (!href) return [];
      const $p = cheerio.load(p.body);
      const label = markdownSafe(pageTitle($p), 100) || new URL(href).pathname;
      const d = markdownSafe(description($p), 160);
      return [`- [${label}](${href})${d ? `: ${d}` : ""}`];
    });
    if (pages.length) lines.push("", "## Pages", ...pages);
    kit.push({
      id: "llms-txt", title: "llms.txt", filename: "llms.txt", language: "text",
      content: `${lines.join("\n")}\n`,
      note: "A short guide to the site for AI tools. Google Search ignores it, so treat it as a small bonus. Add the pages that matter most.",
      forFindings: llms,
    });
  }

  const og = triggers(["technical:open-graph"]);
  if (og.length) {
    const tags = [
      `<meta property="og:title" content="${escapeAttr(pageTitle(home))}">`,
      ...(description(home) ? [`<meta property="og:description" content="${escapeAttr(description(home))}">`] : []),
      '<meta property="og:type" content="website">',
      `<meta property="og:url" content="${escapeAttr(url)}">`,
    ];
    const image = home('meta[property="og:image"]').attr("content");
    if (image) tags.push(`<meta property="og:image" content="${escapeAttr(image)}">`);
    else tags.push(`<!-- Also add og:image: a 1200x630 picture, for example ${s.origin}/og-image.jpg -->`);
    kit.push({
      id: "open-graph", title: "Open Graph tags", filename: "the <head> of the homepage", language: "html",
      content: tags.join("\n"),
      note: "Controls the preview card when the page is shared. Use a real 1200x630 image.",
      forFindings: og,
    });
  }

  const headers = triggers(["technical:security-headers"]);
  if (headers.length) {
    kit.push({
      id: "security-headers", title: "Security headers", filename: "your web server or CDN settings", language: "text",
      content: [
        "# nginx (inside the server block)",
        'add_header X-Content-Type-Options "nosniff" always;',
        'add_header X-Frame-Options "SAMEORIGIN" always;',
        'add_header Referrer-Policy "strict-origin-when-cross-origin" always;',
        "",
        "# Caddy",
        "header {",
        '\tX-Content-Type-Options "nosniff"',
        '\tX-Frame-Options "SAMEORIGIN"',
        '\tReferrer-Policy "strict-origin-when-cross-origin"',
        "}",
      ].join("\n"),
      note: "On Vercel, Netlify or Cloudflare, set the same three headers in that service's headers settings.",
      forFindings: headers,
    });
  }

  return kit;
}
