import { describe, it, expect } from "vitest";
import { analysePage, siteEntity } from "@/lib/checks/page-analysis";
import { schemaGaps } from "@/lib/checks/schema-gaps";
import { page, snap } from "./helpers/snap";

const URL_ = "https://example.com/";
const words = (n: number, w = "word") => Array.from({ length: n }, () => w).join(" ");

describe("analysePage", () => {
  it("reads paragraphs, headings and the title, ignoring navigation, footers and scripts", () => {
    const a = analysePage(URL_, `<html><head><title>Acme | Shelving</title></head><body>
      <nav><p>Menu paragraph that should not count at all here</p></nav>
      <h1>Shelving for small homes</h1><h2>Why us?</h2>
      <p>Acme makes shelving for small homes and apartments across Australia.</p>
      <script>var x = "script text";</script><footer><p>Footer text appears here too</p></footer></body></html>`);
    expect(a.title).toBe("Acme | Shelving");
    expect(a.h1).toBe("Shelving for small homes");
    expect(a.headings).toEqual([{ level: 1, text: "Shelving for small homes" }, { level: 2, text: "Why us?" }]);
    expect(a.paragraphs).toEqual(["Acme makes shelving for small homes and apartments across Australia."]);
  });

  it("lists the other sites a page links to, leaving out its own site and social networks", () => {
    const a = analysePage(URL_, `<body><p>Read <a href="https://www.abs.gov.au/stats">ABS</a>, <a href="https://example.com/about">us</a>,
      <a href="https://www.facebook.com/acme">fb</a> and <a href="https://news.bbc.co.uk/x">bbc</a>.</p></body>`);
    expect(a.externalDomains.sort()).toEqual(["abs.gov.au", "bbc.co.uk"]);
  });

  it("finds a byline and a date", () => {
    const a = analysePage(URL_, `<head><meta name="author" content="Jo Bloggs"></head><body><time datetime="2026-01-02">Jan</time><p>x</p></body>`);
    expect(a.hasByline).toBe(true);
    expect(a.hasDate).toBe(true);
  });
});

describe("siteEntity", () => {
  it("prefers og:site_name, then Organization schema, then the brand part of the title", () => {
    expect(siteEntity(snap('<head><meta property="og:site_name" content="Sunrise Bakery"><title>Other</title></head>'))).toBe("Sunrise Bakery");
    expect(siteEntity(snap('<head><title>Other</title><script type="application/ld+json">{"@type":"Organization","name":"Acme Ltd"}</script></head>'))).toBe("Acme Ltd");
    expect(siteEntity(snap("<head><title>Sunrise Bakery | Fresh sourdough</title></head>"))).toBe("Sunrise Bakery");
  });
  it("returns null when the title is only a slogan-less generic word", () => {
    expect(siteEntity(snap("<head></head><body></body>"))).toBeNull();
  });
});

describe("schemaGaps", () => {
  const faq = `<body><h1>Help</h1><h2>How long is delivery?</h2><p>${words(30)}</p><h2>Can I return it?</h2><p>${words(30)}</p><h2>Do you ship overseas?</h2><p>${words(30)}</p></body>`;

  it("finds FAQ content with no FAQPage schema and builds the JSON-LD from the page", () => {
    const gaps = schemaGaps(snap(faq));
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toMatchObject({ type: "FAQPage", url: URL_ });
    const q = (gaps[0]!.snippet as { mainEntity: { name: string }[] }).mainEntity;
    expect(q.map((x) => x.name)).toEqual(["How long is delivery?", "Can I return it?", "Do you ship overseas?"]);
  });

  it("finds nothing when the matching schema is already there", () => {
    const withSchema = faq.replace("<body>", '<body><script type="application/ld+json">{"@context":"https://schema.org","@type":"FAQPage","mainEntity":[]}</script>');
    expect(schemaGaps(snap(withSchema))).toEqual([]);
  });

  it("finds an article page with no Article schema, using its own headline, date and author", () => {
    const html = `<head><meta name="author" content="Jo Bloggs"><meta property="og:type" content="article"></head><body><article><h1>How we build shelves</h1><time datetime="2026-02-03">3 Feb</time><p>${words(350)}</p></article></body>`;
    const s = snap("<body><p>home</p></body>");
    s.pages = [page("https://example.com/blog/how-we-build-shelves", html)];
    const gaps = schemaGaps(s);
    expect(gaps[0]).toMatchObject({ type: "Article", url: "https://example.com/blog/how-we-build-shelves" });
    expect(gaps[0]!.snippet).toMatchObject({ "@type": "Article", headline: "How we build shelves", datePublished: "2026-02-03", author: { "@type": "Person", name: "Jo Bloggs" } });
  });

  it("finds a product page with no Product schema, and never invents a price", () => {
    const html = `<head><meta name="description" content="A sturdy oak shelf."></head><body><h1>Oak Shelf</h1><p>$120.00</p><button>Add to cart</button></body>`;
    const s = snap("<body><p>home</p></body>");
    s.pages = [page("https://example.com/products/oak-shelf", html)];
    const gap = schemaGaps(s)[0]!;
    expect(gap.type).toBe("Product");
    expect(gap.snippet).toMatchObject({ "@type": "Product", name: "Oak Shelf", description: "A sturdy oak shelf." });
    expect(JSON.stringify(gap.snippet)).not.toContain("120");
  });

  it("does not call a plain page a product, an article or an FAQ", () => {
    expect(schemaGaps(snap(`<body><h1>About us</h1><p>${words(120)}</p></body>`))).toEqual([]);
  });
});

describe("schemaGaps on listing pages", () => {
  const card = (n: number) => `<article class="card"><h3>Item ${n}</h3><span>$${10 + n}.00</span><button>Add to cart</button></article>`;

  it("does not call a product listing a single product", () => {
    const html = `<head><meta name="description" content="Shop the sale."></head><body><h1>SALE</h1>${[1, 2, 3, 4, 5, 6, 7, 8].map(card).join("")}</body>`;
    const s = snap("<body><p>home</p></body>");
    s.pages = [page("https://example.com/sale/", html)];
    expect(schemaGaps(s).filter((g) => g.type === "Product")).toEqual([]);
  });

  it("still finds a real product page with one price and one buy button", () => {
    const html = `<head><meta name="description" content="A sturdy oak shelf."></head><body><h1>Oak Shelf</h1><p>$120.00</p><p>Was $150.00</p><button>Add to cart</button></body>`;
    const s = snap("<body><p>home</p></body>");
    s.pages = [page("https://example.com/products/oak-shelf", html)];
    expect(schemaGaps(s).map((g) => g.type)).toEqual(["Product"]);
  });
});
