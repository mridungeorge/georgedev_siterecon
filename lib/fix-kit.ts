import * as cheerio from "cheerio";
import type { SiteSnapshot } from "@/lib/snapshot";
import type { CompetitorTable, FixKitItem, ModuleResult, SocialSummary } from "@/lib/pipeline/schemas";
import { analysePage } from "@/lib/checks/page-analysis";
import { schemaGaps } from "@/lib/checks/schema-gaps";

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

/** The script the CI workflow runs. It must not use template literals: the workflow embeds it in a here-document. */
const CI_SCRIPT = String.raw`const base = String(process.env.SITERECON || "").replace(/\/+$/, "");
const target = process.env.TARGET || "";
const min = Number(process.env.MIN_SCORE || "0");
if (!base || !target) {
  console.error("Set SITERECON and TARGET.");
  process.exit(2);
}
const res = await fetch(base + "/api/scan/stream?url=" + encodeURIComponent(target), { signal: AbortSignal.timeout(600000) });
if (!res.ok) {
  let why = "";
  try { why = JSON.parse(await res.text()).error || ""; } catch {}
  console.error("SiteRecon answered HTTP " + res.status + (why ? ": " + why : ""));
  process.exit(2);
}
let report = null;
for (const block of (await res.text()).split(/\r?\n\r?\n/)) {
  const lines = block.split(/\r?\n/);
  const event = (lines.find((l) => l.startsWith("event:")) || "").slice(6).trim();
  const data = lines.filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("\n");
  if (event === "error") {
    let message = data;
    try { message = JSON.parse(data).message || data; } catch {}
    console.error(message);
    process.exit(2);
  }
  if (event === "report") report = JSON.parse(data);
}
if (!report) {
  console.error("The scan ended without a report.");
  process.exit(2);
}
const ai = report.aiReadiness && report.aiReadiness.score;
console.log("Overall " + report.overallScore + " · AI readiness " + (ai ?? "n/a") + " (minimum " + min + ")");
if (report.overallScore === null || report.overallScore < min) {
  console.error("The overall score is below " + min + ".");
  process.exit(1);
}`;

/** Starting points for the schema types competitors publish, with every value the page does not state marked REPLACE. */
const FILL_IN: Record<string, (s: SiteSnapshot, home: cheerio.CheerioAPI) => Record<string, unknown>> = {
  FAQPage: () => ({
    "@context": "https://schema.org", "@type": "FAQPage",
    mainEntity: [
      { "@type": "Question", name: "REPLACE: a question customers ask", acceptedAnswer: { "@type": "Answer", text: "REPLACE: the answer, as it appears on the page" } },
      { "@type": "Question", name: "REPLACE: a second question", acceptedAnswer: { "@type": "Answer", text: "REPLACE: its answer" } },
    ],
  }),
  Product: (s, home) => ({
    "@context": "https://schema.org", "@type": "Product", name: "REPLACE: product name",
    ...(oneLine(home('meta[property="og:image"]').attr("content") ?? "") ? { image: oneLine(home('meta[property="og:image"]').attr("content") ?? "") } : { image: "REPLACE: image address" }),
    description: "REPLACE: one sentence describing the product",
    offers: { "@type": "Offer", price: "REPLACE: price", priceCurrency: "REPLACE: currency code", availability: "https://schema.org/InStock" },
  }),
  Article: () => ({
    "@context": "https://schema.org", "@type": "Article", headline: "REPLACE: the article headline", datePublished: "REPLACE: 2026-01-31",
    author: { "@type": "Person", name: "REPLACE: author name" },
  }),
  LocalBusiness: (s, home) => {
    const data: Record<string, unknown> = { "@context": "https://schema.org", "@type": "LocalBusiness", name: siteName(home, s.domain), url: `${s.origin}/` };
    const tel = (home('a[href^="tel:" i]').first().attr("href") ?? "").replace(/^tel:/i, "");
    try {
      const phone = decodeURIComponent(tel).replace(/[^+\d\s().-]/g, "").trim();
      if (phone) data.telephone = phone;
    } catch {
      // an unreadable number is left out
    }
    const mail = (home('a[href^="mailto:" i]').first().attr("href") ?? "").replace(/^mailto:/i, "").split("?")[0].trim();
    if (/^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/.test(mail)) data.email = mail;
    data.address = { "@type": "PostalAddress", streetAddress: "REPLACE: street address", addressLocality: "REPLACE: suburb or city", addressRegion: "REPLACE: state", addressCountry: "REPLACE: country code" };
    return data;
  },
};
const SAME_FAMILY: Record<string, string[]> = { Article: ["Article", "BlogPosting", "NewsArticle", "TechArticle"], LocalBusiness: ["LocalBusiness", "Store", "Restaurant", "ProfessionalService"] };

export function buildFixKit(s: SiteSnapshot, modules: ModuleResult[], social: SocialSummary | null, competitors: CompetitorTable | null = null): FixKitItem[] {
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

  // Structured data the page's own content calls for, built from the page. Only when the citation check fired.
  const fit = triggers(["citation:schema-fit"]);
  if (fit.length) {
    schemaGaps(s).slice(0, 3).forEach((gap, i) => {
      let path = gap.url;
      try {
        path = new URL(gap.url).pathname || "/";
      } catch {
        // keep the full address
      }
      kit.push({
        id: `schema-${gap.type.toLowerCase()}-${i + 1}`, title: `${gap.type} structured data for ${oneLine(path, 80)}`,
        filename: `a <script type="application/ld+json"> in the head of ${oneLine(path, 80)}`, language: "json",
        content: safeJson(gap.snippet), note: gap.note, forFindings: fit,
      });
    });
  }

  // Schema types most competitors publish and this site does not. When the page has the content to build
  // one from, the item above already covers it, so a fill-in is only offered for the rest.
  if (competitors && competitors.rows.length > 0) {
    const owned = new Set([s.home, ...s.pages].flatMap((r) => analysePage(r.finalUrl, r.body).schemaTypes));
    const alreadyBuilt = new Set(kit.filter((k) => k.id.startsWith("schema-")).map((k) => k.id.split("-")[1]));
    const half = Math.ceil(competitors.rows.length / 2);
    for (const type of Object.keys(FILL_IN)) {
      const family = SAME_FAMILY[type] ?? [type];
      if (family.some((t) => owned.has(t)) || alreadyBuilt.has(type.toLowerCase())) continue;
      const domains = competitors.rows.filter((r) => r.schemaTypes.some((t) => family.includes(t))).map((r) => r.domain);
      if (domains.length < half) continue;
      kit.push({
        id: `competitor-schema-${type.toLowerCase()}`, title: `${type} structured data (${domains.length} of ${competitors.rows.length} competitors have it)`,
        filename: 'a <script type="application/ld+json"> in the head of the page it describes', language: "json",
        content: safeJson(FILL_IN[type]!(s, home)),
        note: `Competitors that publish it: ${domains.join(", ")}. Every value marked REPLACE must come from your own page, because markup that disagrees with the visible content can be ignored or penalised.`,
        forFindings: [],
      });
    }
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

  const meta = triggers(["technical:title", "technical:title-length", "technical:meta-description", "technical:meta-description-length", "technical:viewport"]);
  if (meta.length) {
    const lines = [`<title>${escapeAttr(pageTitle(home) || siteName(home, s.domain))}</title>`];
    const d = description(home);
    lines.push(d ? `<meta name="description" content="${escapeAttr(d)}">` : '<meta name="description" content="Write one sentence of 120 to 155 characters saying what this page offers.">');
    lines.push('<meta name="viewport" content="width=device-width, initial-scale=1">');
    kit.push({
      id: "meta-tags", title: "Title, description and viewport tags", filename: "the <head> of the homepage", language: "html",
      content: lines.join("\n"),
      note: "Values come from your own page. Keep the title under about 60 characters and the description between 120 and 155, and make each page's different.",
      forFindings: meta,
    });
  }

  const headers = triggers(["technical:security-headers", "technical:hsts"]);
  if (headers.length) {
    kit.push({
      id: "security-headers", title: "Security headers", filename: "your web server or CDN settings", language: "text",
      content: [
        "# nginx (inside the server block)",
        'add_header X-Content-Type-Options "nosniff" always;',
        'add_header X-Frame-Options "SAMEORIGIN" always;',
        'add_header Referrer-Policy "strict-origin-when-cross-origin" always;',
        'add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;',
        "",
        "# Caddy",
        "header {",
        '\tX-Content-Type-Options "nosniff"',
        '\tX-Frame-Options "SAMEORIGIN"',
        '\tReferrer-Policy "strict-origin-when-cross-origin"',
        "}",
      ].join("\n"),
      note: "On Vercel, Netlify or Cloudflare, set the same headers in that service's headers settings. Only send Strict-Transport-Security once every subdomain is served over HTTPS.",
      forFindings: headers,
    });
  }

  // Always offered: scheduled audits catch a regression the week it ships. The script is real Node
  // (checked by tests/ci-snippet.test.ts against a local server), so it needs no jq or shell parsing.
  const target = escapeAttr(`${s.origin}/`);
  kit.push({
    id: "ci-audit", title: "Scheduled audit in GitHub Actions", filename: ".github/workflows/siterecon.yml", language: "text",
    content: [
      "name: SiteRecon audit",
      "on:",
      "  schedule:",
      '    - cron: "0 21 * * 0"',
      "  workflow_dispatch:",
      "jobs:",
      "  audit:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - name: Run the audit and fail below the threshold",
      "        env:",
      "          SITERECON: https://siterecon.georgemridun.dev  # your SiteRecon address",
      `          TARGET: ${target}`,
      '          MIN_SCORE: "80"',
      "        run: |",
      "          node --input-type=module <<'JS'",
      ...CI_SCRIPT.split("\n").map((line) => `          ${line}`),
      "          JS",
    ].join("\n"),
    note: "Replace the SiteRecon address with where you run it. Exit code 1 means the score fell below MIN_SCORE, and 2 means the audit itself could not run (a rate limit, an unreachable site or no report). SiteRecon limits how often one address can be scanned, and a scan reuses a report under 24 hours old, so run it weekly or daily, not on every commit.",
    forFindings: [],
  });

  return kit;
}
