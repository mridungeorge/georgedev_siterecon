import * as cheerio from "cheerio";
import type { SiteSnapshot } from "@/lib/snapshot";
import type { CheckOutcome, Evidence } from "@/lib/pipeline/schemas";
import { pageFacts, type PageFacts } from "@/lib/page-facts";
import { clip, makeChecker } from "./helpers";
import { readJsonLd, schemaProblems } from "./jsonld";

/** True when the page has at least one JSON-LD block that parses. Broken blocks are ignored. */
export function hasValidJsonLd($: cheerio.CheerioAPI): boolean {
  return readJsonLd($).some((b) => b.error === undefined);
}

const stripWww = (host: string) => host.toLowerCase().replace(/^www\./, "");
const trimSlash = (path: string) => path.replace(/\/+$/, "");
/** Host and path with www and a trailing slash ignored, so two spellings of one page compare equal. */
function pageKey(href: string, base?: string): string | null {
  try {
    const u = new URL(href, base);
    return `${stripWww(u.hostname)}${trimSlash(u.pathname)}`;
  } catch {
    return null;
  }
}

/** The loc entries of a sitemap. A plain loop rather than matchAll, which older targets lack. */
function sitemapLocs(xml: string): string[] {
  const locs: string[] = [];
  const re = /<loc>\s*([^<]*?)\s*<\/loc>/gi;
  for (let m = re.exec(xml); m; m = re.exec(xml)) if (m[1]) locs.push(m[1]);
  return locs;
}

const MAX_EVIDENCE = 6;

export function runTechnicalChecks(s: SiteSnapshot): CheckOutcome[] {
  const { outcomes, check } = makeChecker("technical");
  const $ = cheerio.load(s.home.body);
  const url = s.home.finalUrl;
  const at = (note: string, quote?: string) => [{ url, note, ...(quote ? { quote: clip(quote) } : {}) }];

  check("status-ok", 8, s.home.status === 200, {
    severity: "critical", effort: "medium",
    title: `The homepage returns HTTP ${s.home.status}`,
    detail: "Search engines only index pages that return a 200 status. Any other status keeps the page out of results.",
    fix: "Make the homepage return HTTP 200 for normal visitors and crawlers.",
    evidence: at(`HTTP status ${s.home.status}`),
  });

  check("https", 7, url.startsWith("https://"), {
    severity: "high", effort: "low",
    title: "The site is served over plain HTTP",
    detail: "Browsers mark HTTP pages as not secure, and search engines prefer HTTPS.",
    fix: "Install a TLS certificate and redirect every http:// URL to https://.",
    evidence: at("final URL uses http://"),
  });

  const metaRobots = $('meta[name="robots" i]').attr("content") ?? "";
  const headerRobots = s.home.headers["x-robots-tag"] ?? "";
  check("indexable", 8, !/noindex/i.test(metaRobots) && !/noindex/i.test(headerRobots), {
    severity: "critical", effort: "low",
    title: "The homepage tells search engines not to index it",
    detail: "A noindex directive removes the page from search results entirely.",
    fix: "Remove noindex from the robots meta tag and the X-Robots-Tag header on pages that should rank.",
    evidence: at("noindex directive", metaRobots ? `<meta name="robots" content="${metaRobots}">` : `X-Robots-Tag: ${headerRobots}`),
  });

  const title = $("head > title").first().text().trim();
  check("title", 6, title.length > 0, {
    severity: "high", effort: "low",
    title: "The homepage has no title tag",
    detail: "The title is the main headline shown in search results and browser tabs.",
    fix: "Add a <title> that names the business and what it offers.",
    evidence: at("no <title> in <head>"),
  });
  check("title-length", 3, title.length === 0 || (title.length >= 15 && title.length <= 60), {
    severity: "low", effort: "low",
    title: `The title is ${title.length} characters long`,
    detail: "Titles under 15 characters say too little. Titles over 60 are usually cut off in search results.",
    fix: "Rewrite the title to between 15 and 60 characters, leading with the main keyword.",
    evidence: at("title text", title),
  });

  const description = ($('meta[name="description" i]').attr("content") ?? "").trim();
  check("meta-description", 5, description.length > 0, {
    severity: "medium", effort: "low",
    title: "The homepage has no meta description",
    detail: "Without one, search engines pick their own snippet, which is often a poor pitch for the page.",
    fix: "Add a meta description that says who the page is for and why they should click.",
    evidence: at('no <meta name="description">'),
  });
  check("meta-description-length", 2, description.length === 0 || (description.length >= 70 && description.length <= 160), {
    severity: "low", effort: "low",
    title: `The meta description is ${description.length} characters long`,
    detail: "Descriptions under 70 characters waste the space. Over 160 they are cut off.",
    fix: "Rewrite the meta description to between 70 and 160 characters.",
    evidence: at("meta description", description),
  });

  const h1s = $("h1");
  check("single-h1", 5, h1s.length === 1, {
    severity: "medium", effort: "low",
    title: h1s.length === 0 ? "The homepage has no H1 heading" : `The homepage has ${h1s.length} H1 headings`,
    detail: "One clear H1 tells readers and search engines what the page is about.",
    fix: "Use exactly one H1 that states the main topic of the page. Use H2 and H3 for the rest.",
    evidence: at(`${h1s.length} <h1> elements`, h1s.first().text()),
  });

  const canonicalHref = $('link[rel="canonical" i]').attr("href");
  check("canonical", 3, Boolean(canonicalHref), {
    severity: "medium", effort: "low",
    title: "The homepage has no canonical link",
    detail: "A canonical link tells search engines which URL is the main one when the same page is reachable at several.",
    fix: `Add <link rel="canonical" href="${url}"> to the page head.`,
    evidence: at('no <link rel="canonical">'),
  });

  check("html-lang", 2, Boolean($("html").attr("lang")), {
    severity: "low", effort: "low",
    title: "The page does not declare its language",
    detail: "The lang attribute helps search engines and screen readers handle the text correctly.",
    fix: 'Add a lang attribute to the <html> tag, for example <html lang="en">.',
    evidence: at("<html> has no lang attribute"),
  });

  check("viewport", 5, Boolean($('meta[name="viewport" i]').attr("content")), {
    severity: "high", effort: "low",
    title: "The page has no mobile viewport tag",
    detail: "Without it, phones show a shrunken desktop layout. Google indexes the mobile version of a site first.",
    fix: 'Add <meta name="viewport" content="width=device-width, initial-scale=1"> to the head.',
    evidence: at('no <meta name="viewport">'),
  });

  const images = $("img");
  const missingAlt = images.filter((_, el) => $(el).attr("alt") === undefined);
  check("image-alt", 4, images.length === 0 || missingAlt.length / images.length <= 0.1, {
    severity: "medium", effort: "medium",
    title: `${missingAlt.length} of ${images.length} images have no alt text`,
    detail: "Alt text describes images to search engines and to people using screen readers.",
    fix: 'Add a short descriptive alt attribute to every meaningful image, and alt="" to decorative ones.',
    evidence: at("first image without alt", $.html(missingAlt.first())),
  });

  check("robots-txt", 3, s.robotsTxt !== null, {
    severity: "low", effort: "low",
    title: "The site has no robots.txt file",
    detail: "robots.txt tells crawlers what they may visit and where the sitemap is.",
    fix: "Add a robots.txt at the site root that allows crawling and lists the sitemap URL.",
    evidence: [{ url: `${s.origin}/robots.txt`, note: "not found, or not a text file" }],
  });

  check("sitemap", 5, s.sitemapXml !== null, {
    severity: "medium", effort: "low",
    title: "No XML sitemap was found",
    detail: "A sitemap helps search engines find every page, including ones that are not well linked.",
    fix: "Generate an XML sitemap, serve it at /sitemap.xml, and reference it from robots.txt.",
    evidence: [{ url: `${s.origin}/sitemap.xml`, note: "not found, or not a sitemap" }],
  });

  check("structured-data", 4, hasValidJsonLd($), {
    severity: "medium", effort: "medium",
    title: "The homepage has no structured data",
    detail: "Schema.org markup lets search engines show rich results and helps AI systems understand the business.",
    fix: "Add JSON-LD for the organisation (name, logo, URL, social profiles) and for the main page type.",
    evidence: at("no valid application/ld+json block"),
  });

  const og = Boolean($('meta[property="og:title"]').attr("content")) && Boolean($('meta[property="og:image"]').attr("content"));
  check("open-graph", 2, og, {
    severity: "low", effort: "low",
    title: "Links to this page will share without a proper preview",
    detail: "og:title and og:image control the card shown when the page is shared on social platforms and chat apps.",
    fix: "Add og:title, og:description and og:image (1200x630) meta tags.",
    evidence: at("missing og:title or og:image"),
  });

  // Only when a real browser rendered the page (the optional fetch service). Weights are
  // normalised per module, so this extra check does not distort the others.
  if (s.rendered) {
    check("mobile-layout", 4, !s.rendered.mobileOverflow, {
      severity: "medium", effort: "medium",
      title: "The page is wider than a phone screen",
      detail: "On a phone the page needs sideways scrolling. Visitors leave pages like this, and Google ranks the mobile version of a page.",
      fix: "Find the element wider than the screen (often a fixed-width image, table or embed) and make it fit with max-width: 100%.",
      evidence: at("in a phone-sized browser window the page was wider than the screen"),
    });
  }

  check("hsts", 2, Boolean(s.home.headers["strict-transport-security"]), {
    severity: "low", effort: "low",
    title: "The site does not send an HSTS header",
    detail: "Strict-Transport-Security tells browsers to always use HTTPS for this site.",
    fix: "Send Strict-Transport-Security: max-age=31536000; includeSubDomains from the server.",
    evidence: at("no strict-transport-security response header"),
  });

  check("not-truncated", 2, !s.home.truncated, {
    severity: "medium", effort: "high",
    title: "The homepage HTML is over 2 MB",
    detail: "SiteRecon read only the first 2 MB. Very large HTML slows loading and crawlers may stop reading it early.",
    fix: "Reduce inline scripts, styles and embedded data so the HTML document is well under 2 MB.",
    evidence: at("response exceeded the 2,000,000-byte cap"),
  });

  // ---- Structured data: broken blocks, missing required properties, leftover placeholder text ----
  const blocks = readJsonLd($);
  const broken = blocks.filter((b) => b.error !== undefined);
  check("json-ld-valid", 4, broken.length === 0, {
    severity: "high", effort: "low",
    title: `${broken.length} structured data block${broken.length === 1 ? " is" : "s are"} broken and ignored by search engines`,
    detail: "A JSON-LD block that is not valid JSON is skipped completely, so the markup you added does nothing. A stray comma or an unescaped quote is usually the cause.",
    fix: "Paste the block into Google's Rich Results Test or schema.org's validator, fix the syntax error it names, and redeploy.",
    evidence: broken.slice(0, MAX_EVIDENCE).map((b): Evidence => ({ url, note: `block ${b.index}: ${b.error}`, quote: clip(b.raw) })),
  });

  const problems = schemaProblems(blocks);
  const describeProblem = (p: (typeof problems)[number]) =>
    p.kind === "missing" ? `${p.type} has no ${p.property}` : `placeholder text in ${p.type}`;
  check("schema-complete", 3, problems.length === 0, {
    severity: "medium", effort: "low",
    title: problems[0]?.kind === "missing"
      ? `Structured data is missing "${problems[0].property}" on ${problems[0].type}${problems.length > 1 ? ` (and ${problems.length - 1} more problem${problems.length === 2 ? "" : "s"})` : ""}`
      : `Structured data still contains placeholder text${problems.length > 1 ? ` (and ${problems.length - 1} more problem${problems.length === 2 ? "" : "s"})` : ""}`,
    detail: "Search engines ignore or distrust markup that leaves out required properties or still shows template text such as [Business Name]. AI systems quote that markup as fact.",
    fix: "Fill in every property listed in the evidence with the real value, and remove any template text.",
    evidence: problems.slice(0, MAX_EVIDENCE).map((p): Evidence => ({ url, note: describeProblem(p), ...(p.text ? { quote: clip(p.text) } : {}) })),
  });

  // ---- Canonical: if there is one, it must be this page ----
  const canonicalKey = canonicalHref ? pageKey(canonicalHref, url) : null;
  const pageUrlKey = pageKey(url);
  const canonicalHttp = Boolean(canonicalHref) && /^http:\/\//i.test(new URL(canonicalHref!, url).href) && url.startsWith("https://");
  check("canonical-valid", 3, !canonicalHref || (canonicalKey !== null && canonicalKey === pageUrlKey && !canonicalHttp), {
    severity: "medium", effort: "low",
    title: "The canonical link points at a different page",
    detail: "The canonical link says which URL is the real one. When it names another page or site, search engines can drop this page from results in favour of that one. An http:// canonical on an https:// page does the same.",
    fix: `Set the canonical link to this page's own address: <link rel="canonical" href="${url}">. Only point it elsewhere if this page really is a duplicate.`,
    evidence: at("canonical points elsewhere", `<link rel="canonical" href="${canonicalHref}">`),
  });

  // ---- Headings should step down one level at a time ----
  const headings = $("h1, h2, h3, h4, h5, h6")
    .map((_, el) => ({ level: Number(String($(el).prop("tagName") ?? "H0").slice(1)), text: $(el).text().replace(/\s+/g, " ").trim() }))
    .get();
  let skip: { from: (typeof headings)[number]; to: (typeof headings)[number] } | null = null;
  for (let i = 1; i < headings.length && !skip; i++) if (headings[i].level - headings[i - 1].level > 1) skip = { from: headings[i - 1], to: headings[i] };
  check("heading-order", 2, skip === null, {
    severity: "low", effort: "low",
    title: skip ? `Heading levels skip from H${skip.from.level} to H${skip.to.level}` : "Heading levels skip",
    detail: "Headings form an outline that screen readers and search engines follow. Jumping from H1 to H3 leaves a gap in it.",
    fix: "Use heading levels in order: H1 for the page title, H2 for its sections, H3 for sub-sections. Style them with CSS instead of picking a level for its size.",
    evidence: at(skip ? `H${skip.from.level} "${clip(skip.from.text, 60)}" is followed by H${skip.to.level} "${clip(skip.to.text, 60)}"` : "heading levels skip"),
  });

  // ---- Browser security headers ----
  const h = s.home.headers;
  const missingHeaders: string[] = [];
  if (!/nosniff/i.test(h["x-content-type-options"] ?? "")) missingHeaders.push("X-Content-Type-Options: nosniff");
  if (!h["x-frame-options"] && !/frame-ancestors/i.test(h["content-security-policy"] ?? "")) missingHeaders.push("X-Frame-Options or a CSP frame-ancestors rule");
  if (!h["referrer-policy"]) missingHeaders.push("Referrer-Policy");
  check("security-headers", 3, missingHeaders.length === 0, {
    severity: "low", effort: "low",
    title: `The site is missing ${missingHeaders.length} standard security header${missingHeaders.length === 1 ? "" : "s"}`,
    detail: `These headers stop other sites framing the page, sniffing its files as another type, and leaking full URLs to third parties. Missing: ${missingHeaders.join(", ")}.`,
    fix: "Send X-Content-Type-Options: nosniff, X-Frame-Options: SAMEORIGIN (or a CSP frame-ancestors rule) and Referrer-Policy: strict-origin-when-cross-origin from the web server or CDN.",
    evidence: at(`missing: ${missingHeaders.join(", ")}`),
  });

  // ---- Images should reserve their space, or the layout jumps as they load ----
  const sized = images.filter((_, el) => !($(el).attr("src") ?? "").startsWith("data:"));
  const noDimensions = sized.filter((_, el) => !($(el).attr("width") && $(el).attr("height")) && !/aspect-ratio/i.test($(el).attr("style") ?? ""));
  check("image-dimensions", 2, sized.length === 0 || noDimensions.length / sized.length <= 0.2, {
    severity: "low", effort: "low",
    title: `${noDimensions.length} of ${sized.length} images have no width and height`,
    detail: "Without width and height attributes the browser cannot reserve space for an image, so the text moves when it loads. That is the main cause of a poor layout-shift (CLS) score.",
    fix: "Add width and height attributes matching each image's real size, and keep max-width: 100% in the CSS so it still scales.",
    evidence: at("first image without width and height", $.html(noDimensions.first())),
  });

  // ---- The homepage should lead somewhere ----
  const here = trimSlash(new URL(url).pathname);
  const siteHost = stripWww(new URL(url).hostname);
  const linked = new Set<string>();
  $("a[href]").each((_, el) => {
    const href = ($(el).attr("href") ?? "").trim();
    if (!href || href.startsWith("#") || /^(mailto|tel|javascript|data):/i.test(href)) return;
    let u: URL;
    try {
      u = new URL(href, url);
    } catch {
      return;
    }
    if (!/^https?:$/.test(u.protocol) || stripWww(u.hostname) !== siteHost) return;
    const path = trimSlash(u.pathname);
    if (path !== here) linked.add(path);
  });
  check("internal-links", 3, linked.size >= 2, {
    severity: "low", effort: "medium",
    title: linked.size === 0 ? "The homepage does not link to any other page" : `The homepage links to only ${linked.size} other page${linked.size === 1 ? "" : "s"}`,
    detail: "Internal links are how search engines discover pages and how authority flows from the homepage to the rest of the site. A homepage with almost none leaves the other pages hard to find.",
    fix: "Link from the homepage to the main service, product and contact pages with descriptive anchor text, not just \"click here\".",
    evidence: at(`${linked.size} distinct internal page${linked.size === 1 ? "" : "s"} linked`),
  });

  // ---- Links that were followed and led to an error page ----
  const brokenLinks = s.brokenLinks ?? [];
  check("broken-links", 4, brokenLinks.length === 0, {
    severity: "high", effort: "low",
    title: brokenLinks.length === 1 ? "1 internal link leads to an error page" : `${brokenLinks.length} internal links lead to error pages`,
    detail: "Visitors and search engines that follow these links land on an error page. Broken links waste crawl budget and make the site look neglected.",
    fix: "Update each link to the page's current address, or remove it. If a page moved, add a 301 redirect from the old address.",
    evidence: brokenLinks.slice(0, 8).map((b): Evidence => ({ url: b.url, note: `returned HTTP ${b.status}` })),
  });

  // ---- How the site answers requests it should redirect or reject. Only when a probe could be made ----
  const probes = s.probes;
  if (probes?.http) {
    const stays = !probes.http.finalUrl.startsWith("https://");
    check("https-redirect", 3, !stays, {
      severity: "high", effort: "low",
      title: "The http:// address does not redirect to https://",
      detail: "Anyone who types the address without https, or follows an old link, lands on an unencrypted copy of the site. Browsers warn them, and search engines see two versions of every page.",
      fix: "Redirect every http:// address to its https:// equivalent with a permanent (301) redirect at the web server or CDN.",
      evidence: [{ url: `http://${new URL(url).host}/`, note: `ends at ${probes.http.finalUrl} (HTTP ${probes.http.status}) instead of https://` }],
    });
  }
  if (probes?.alternateHost) {
    const mainHost = new URL(url).hostname.toLowerCase();
    const altFinal = new URL(probes.alternateHost.finalUrl).hostname.toLowerCase();
    const altStart = new URL(probes.alternateHost.url).hostname.toLowerCase();
    check("host-redirect", 3, altFinal === mainHost, {
      severity: "medium", effort: "low",
      title: `Both ${altStart} and ${mainHost} serve the site`,
      detail: "When the www and non-www addresses both answer, search engines treat them as two copies of the site and split its ranking between them. One should redirect to the other.",
      fix: `Pick one address and redirect the other to it with a permanent (301) redirect. The canonical link and the sitemap should use the same one.`,
      evidence: [{ url: probes.alternateHost.url, note: `serves the site itself (HTTP ${probes.alternateHost.status}) instead of redirecting to ${mainHost}` }],
    });
  }
  if (probes?.notFound && [200, 404, 410].includes(probes.notFound.status)) {
    check("soft-404", 3, probes.notFound.status !== 200, {
      severity: "medium", effort: "medium",
      title: "A page that does not exist returns 200 instead of 404",
      detail: "When missing pages answer 'OK', search engines index the empty error pages as real content and can treat the whole site as low quality. Visitors who mistype an address also get no clear sign something is wrong.",
      fix: "Make the server return the 404 status code for addresses that do not exist, whatever the error page looks like.",
      evidence: [{ url: `${s.origin}/siterecon-check-missing-page`, note: "a made-up address returned HTTP 200" }],
    });
  }

  // ---- Only when a sitemap exists: is it any good? ----
  if (s.sitemapXml !== null && !/<sitemapindex[\s>]/i.test(s.sitemapXml)) {
    const locs = sitemapLocs(s.sitemapXml);
    const issues: string[] = [];
    if (locs.length === 0) issues.push("it lists no URLs");
    else {
      const otherHost = locs.filter((l) => {
        try {
          return stripWww(new URL(l).hostname) !== siteHost;
        } catch {
          return true;
        }
      });
      if (otherHost.length) issues.push(`${otherHost.length} URL${otherHost.length === 1 ? " is" : "s are"} on another host`);
      if (url.startsWith("https://")) {
        const insecure = locs.filter((l) => l.startsWith("http://"));
        if (insecure.length) issues.push(`${insecure.length} URL${insecure.length === 1 ? " uses" : "s use"} http:// although the site uses https://`);
      }
      const keys = locs.map((l) => pageKey(l) ?? l);
      const duplicates = keys.length - new Set(keys).size;
      if (duplicates) issues.push(`${duplicates} duplicate URL${duplicates === 1 ? "" : "s"}`);
      if (!keys.includes(pageKey(url) ?? "")) issues.push("it does not list the homepage");
      if (locs.length > 50_000) issues.push("it has more than 50,000 URLs, the limit for one file");
    }
    check("sitemap-quality", 3, issues.length === 0, {
      severity: "medium", effort: "low",
      title: "The XML sitemap has problems",
      detail: `A sitemap should list each real page of the site once, on the same host and over https. Here ${issues.join("; ")}.`,
      fix: "Regenerate the sitemap from the site's own page list so it contains each canonical https URL exactly once, including the homepage.",
      evidence: [{ url: s.sitemapUrl ?? `${s.origin}/sitemap.xml`, note: issues.join("; ") }],
    });
  }

  // ---- Only when robots.txt exists: does it say where the sitemap is? ----
  if (s.robots !== null) {
    check("robots-sitemap", 2, s.robots.sitemaps.length > 0, {
      severity: "low", effort: "low",
      title: "robots.txt does not point to the sitemap",
      detail: "A Sitemap line in robots.txt is how crawlers find the sitemap without being told in Search Console.",
      fix: `Add a line to robots.txt: Sitemap: ${s.origin}/sitemap.xml`,
      evidence: [{ url: `${s.origin}/robots.txt`, note: "no Sitemap: line" }],
    });
  }

  // ---- Only when inner pages were read: site-wide patterns ----
  if (s.pages.length > 0) {
    const home = { url, title, description, h1: h1s.length, words: 0 };
    const inner = s.pages.map(pageFacts);
    const sameAs = (a: string, b: string) => a !== "" && a.toLowerCase() === b.toLowerCase();
    const duplicateOf = (value: string, self: PageFacts, field: "title" | "description") =>
      [home, ...inner].find((p) => p.url !== self.url && sameAs(p[field], value));

    const badTitles = inner.filter((p) => p.title === "" || duplicateOf(p.title, p, "title"));
    check("pages-titles", 4, badTitles.length === 0, {
      severity: "medium", effort: "low",
      title: `${badTitles.length} inner page${badTitles.length === 1 ? " has" : "s have"} a missing or duplicate title`,
      detail: "Every page needs its own title. Pages with none, or with the same title as another page, compete with each other and are shown poorly in search results.",
      fix: "Give each page a unique title that names what that page offers, ideally 15 to 60 characters.",
      evidence: badTitles.slice(0, MAX_EVIDENCE).map((p): Evidence => {
        const twin = p.title === "" ? undefined : duplicateOf(p.title, p, "title");
        return { url: p.url, note: p.title === "" ? "no <title>" : `same title as ${twin?.url}`, ...(p.title ? { quote: clip(p.title) } : {}) };
      }),
    });

    const badDescriptions = inner.filter((p) => p.description === "" || duplicateOf(p.description, p, "description"));
    check("pages-descriptions", 3, badDescriptions.length === 0, {
      severity: "medium", effort: "low",
      title: `${badDescriptions.length} inner page${badDescriptions.length === 1 ? " has" : "s have"} a missing or repeated meta description`,
      detail: "A meta description repeated across pages, or left out, is a sign of templated metadata and gives searchers no reason to click one page over another.",
      fix: "Write a different 70 to 160 character description for each page, describing that page.",
      evidence: badDescriptions.slice(0, MAX_EVIDENCE).map((p): Evidence => {
        const twin = p.description === "" ? undefined : duplicateOf(p.description, p, "description");
        return { url: p.url, note: p.description === "" ? "no meta description" : `same description as ${twin?.url}`, ...(p.description ? { quote: clip(p.description) } : {}) };
      }),
    });

    const badH1 = inner.filter((p) => p.h1 !== 1);
    check("pages-h1", 3, badH1.length === 0, {
      severity: "low", effort: "low",
      title: `${badH1.length} inner page${badH1.length === 1 ? " does" : "s do"} not have exactly one H1`,
      detail: "Each page should have one H1 that states its topic.",
      fix: "Use exactly one H1 on every page.",
      evidence: badH1.slice(0, MAX_EVIDENCE).map((p): Evidence => ({ url: p.url, note: `${p.h1} <h1> element${p.h1 === 1 ? "" : "s"}` })),
    });

    const thin = inner.filter((p) => p.words < 100);
    check("pages-content", 3, thin.length === 0, {
      severity: "low", effort: "medium",
      title: `${thin.length} inner page${thin.length === 1 ? " has" : "s have"} very little text`,
      detail: "Pages with under 100 words rarely rank or get cited, because there is little for a search engine or an AI system to work with. Contact and utility pages can reasonably be short.",
      fix: "Expand each page that is meant to rank with the information a visitor needs: what it is, who it is for, prices or steps, and answers to common questions.",
      evidence: thin.slice(0, MAX_EVIDENCE).map((p): Evidence => ({ url: p.url, note: `${p.words} words of text` })),
    });
  }

  return outcomes;
}
