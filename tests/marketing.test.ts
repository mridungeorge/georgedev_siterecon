import { describe, it, expect } from "vitest";
import { runMarketingChecks } from "@/lib/checks/marketing";
import { FindingSchema } from "@/lib/pipeline/schemas";
import { snap } from "./helpers/snap";

// The marketing checks that need no AI: can the business measure its marketing, capture a lead, show
// what it costs, publish content, prove its claims and be reached. Each reads the page's own HTML.

const GOOD = `<html lang="en"><head><title>Acme Storage</title>
<script async src="https://www.googletagmanager.com/gtag/js?id=G-ABC123"></script>
<script type="application/ld+json">{"@context":"https://schema.org","@type":"Store","name":"Acme","address":"1 High St, Melbourne","aggregateRating":{"@type":"AggregateRating","ratingValue":"4.8","reviewCount":"1200"}}</script>
</head><body>
<header><nav><a href="/shop">Shop</a><a href="/blog">Blog</a><a href="/contact">Contact</a></nav></header>
<h1>Shelving that fits small homes</h1>
<p>Shelves from $49. Free delivery over $100. Loved by 12,000 customers and rated 4.8 out of 5. If it does not fit, we offer a 30 day money back guarantee.</p>
<form action="/subscribe"><input type="email" name="email" placeholder="Your email"><button>Get tips</button></form>
<a href="tel:+61300000000">Call us</a><a href="mailto:hi@acme.test">Email us</a>
</body></html>`;

const run = async (html: string) => runMarketingChecks(snap(html), null);
const failed = async (html: string) => (await run(html)).outcomes.filter((o) => !o.passed).map((o) => o.id);
const finding = async (html: string, id: string) => (await run(html)).outcomes.find((o) => o.id === id)!.finding!;
const without = (pattern: RegExp) => GOOD.replace(pattern, "");

describe("runMarketingChecks (no AI)", () => {
  it("passes a page with measurement, a lead form, a price, a blog, ratings, a guarantee, proof and contact options", async () => {
    expect(await failed(GOOD)).toEqual([]);
  });

  it("keeps the no-AI checks at 70 points", async () => {
    expect((await run(GOOD)).outcomes.reduce((sum, o) => sum + o.weight, 0)).toBe(70);
  });

  it("gives every failure a valid finding in the marketing module, with evidence", async () => {
    const r = await run("<html><body><p>Welcome.</p></body></html>");
    const bad = r.outcomes.filter((o) => !o.passed);
    expect(bad.length).toBeGreaterThanOrEqual(7);
    for (const o of bad) {
      expect(() => FindingSchema.parse(o.finding)).not.toThrow();
      expect(o.finding!.id).toBe(`marketing:${o.id}`);
      expect(o.finding!.module).toBe("marketing");
    }
  });

  describe("analytics", () => {
    it("flags a site with no measurement or advertising tag, and says what that costs", async () => {
      const html = without(/<script async src="https:\/\/www\.googletagmanager[^>]*><\/script>/);
      expect(await failed(html)).toContain("analytics");
      expect((await finding(html, "analytics")).detail).toMatch(/which (marketing|channel)|measure/i);
    });
    it.each([
      ['<script src="https://www.googletagmanager.com/gtm.js?id=GTM-ABCD"></script>'],
      ['<script>window.dataLayer=[];function gtag(){};gtag("config","G-1")</script>'],
      ['<script defer data-domain="a.test" src="https://plausible.io/js/script.js"></script>'],
      ['<script>!function(f){fbq("init","1")}()</script><script src="https://connect.facebook.net/en_US/fbevents.js"></script>'],
      ['<script src="https://static.hotjar.com/c/hotjar-1.js"></script>'],
      ['<script src="/_vercel/insights/script.js"></script>'],
      ['<script src="https://cdn.usefathom.com/script.js"></script>'],
    ])("accepts %s", async (tag) => {
      const html = without(/<script async src="https:\/\/www\.googletagmanager[^>]*><\/script>/).replace("</head>", `${tag}</head>`);
      expect(await failed(html)).not.toContain("analytics");
    });
    it("does not mistake a mention in the page text for a tag", async () => {
      const html = without(/<script async src="https:\/\/www\.googletagmanager[^>]*><\/script>/).replace("<h1>", "<h1>We love Google Analytics and Hotjar ");
      expect(await failed(html)).toContain("analytics");
    });
  });

  describe("lead-capture", () => {
    it("flags a page where a visitor cannot leave an email or book", async () => {
      expect(await failed(without(/<form[\s\S]*?<\/form>/))).toContain("lead-capture");
    });
    it.each([
      ['<form><input type="text" name="e-mail"></form>'],
      ['<form><input name="phone" type="tel"></form>'],
      ['<a href="https://calendly.com/acme/intro">Book a call</a>'],
      ['<a href="https://form.typeform.com/to/abc">Take the quiz</a>'],
      ['<div class="mc-embedded-subscribe"><form action="https://acme.us1.list-manage.com/subscribe"><input type="email"></form></div>'],
    ])("accepts %s", async (snippet) => {
      expect(await failed(without(/<form[\s\S]*?<\/form>/).replace("</body>", `${snippet}</body>`))).not.toContain("lead-capture");
    });
    it("does not count a search box as a lead form", async () => {
      expect(await failed(without(/<form[\s\S]*?<\/form>/).replace("</body>", '<form role="search"><input type="search" name="q"></form></body>'))).toContain("lead-capture");
    });
  });

  describe("offer-clarity", () => {
    it("flags copy that never says what anything costs or what the offer is", async () => {
      expect(await failed(GOOD.replace("Shelves from $49. Free delivery over $100. ", ""))).toContain("offer-clarity");
    });
    it.each([["From $49 a month"], ["Free quote within 24 hours"], ["30% off this week"], ["Plans start at $9"], ["Free shipping on every order"]])("accepts %s", async (text) => {
      expect(await failed(GOOD.replace("Shelves from $49. Free delivery over $100. ", `${text}. `))).not.toContain("offer-clarity");
    });
    it.each([["rated 4.9 stars from over 800 reviews"], ["serving families from 1990 to today"], ["delivery from our warehouse within 3 days"]])("does not mistake '%s' for a price", async (text) => {
      expect(await failed(GOOD.replace("Shelves from $49. Free delivery over $100. ", `We are ${text}. `))).toContain("offer-clarity");
    });
    it.each([["49 dollars a month"], ["from 99 AUD"]])("accepts a price written as %s", async (text) => {
      expect(await failed(GOOD.replace("Shelves from $49. Free delivery over $100. ", `Plans ${text}. `))).not.toContain("offer-clarity");
    });
    it("accepts a link to a pricing page", async () => {
      expect(await failed(GOOD.replace("Shelves from $49. Free delivery over $100. ", "").replace('<a href="/shop">Shop</a>', '<a href="/pricing">Pricing</a>'))).not.toContain("offer-clarity");
    });
  });

  describe("content-hub", () => {
    it("flags a site that publishes nothing", async () => {
      expect(await failed(GOOD.replace('<a href="/blog">Blog</a>', ""))).toContain("content-hub");
    });
    it.each([["/news"], ["/resources"], ["/guides/storage"], ["/articles"], ["/insights"], ["/case-studies"]])("accepts a link to %s", async (href) => {
      expect(await failed(GOOD.replace('<a href="/blog">Blog</a>', `<a href="${href}">More</a>`))).not.toContain("content-hub");
    });
    it("only counts the site's own pages", async () => {
      expect(await failed(GOOD.replace('<a href="/blog">Blog</a>', '<a href="https://medium.com/blog">Our blog</a>'))).toContain("content-hub");
    });
  });

  describe("reviews-markup", () => {
    it("flags ratings that are only words on a page, which search engines and AI cannot read", async () => {
      expect(await failed(GOOD.replace(/"aggregateRating":\{[^}]*\}/, '"description":"x"'))).toContain("reviews-markup");
    });
    it("accepts Review schema", async () => {
      expect(await failed(GOOD.replace(/"aggregateRating":\{[^}]*\}/, '"review":{"@type":"Review","reviewBody":"Great"}'))).not.toContain("reviews-markup");
    });
    it.each([['<script src="https://widget.trustpilot.com/bootstrap/v5/tp.widget.bootstrap.min.js"></script>'], ['<div class="yotpo-widget"></div>'], ['<script src="https://cdn.judge.me/widget.js"></script>']])("accepts a review widget: %s", async (widget) => {
      expect(await failed(GOOD.replace(/"aggregateRating":\{[^}]*\}/, '"description":"x"').replace("</body>", `${widget}</body>`))).not.toContain("reviews-markup");
    });
  });

  describe("risk-reversal", () => {
    it("flags an offer with nothing to lower the buyer's risk", async () => {
      expect(await failed(GOOD.replace("we offer a 30 day money back guarantee", "we think it is great"))).toContain("risk-reversal");
    });
    it.each([["free returns"], ["no obligation quote"], ["cancel anytime"], ["a full refund"], ["risk-free trial"], ["a 2 year warranty"], ["a free consultation"]])("accepts %s", async (phrase) => {
      expect(await failed(GOOD.replace("we offer a 30 day money back guarantee", `we give you ${phrase}`))).not.toContain("risk-reversal");
    });
  });

  describe("specific-proof", () => {
    it("flags proof that is only adjectives", async () => {
      expect(await failed(GOOD.replace("Loved by 12,000 customers and rated 4.8 out of 5.", "Loved by our trusted happy customers."))).toContain("specific-proof");
    });
    it.each([["12,000 customers"], ["4.9 out of 5"], ["over 800 reviews"], ["since 2004"], ["20 years of experience"], ["50+ projects"]])("accepts %s", async (phrase) => {
      expect(await failed(GOOD.replace("Loved by 12,000 customers and rated 4.8 out of 5.", `Known for ${phrase}.`))).not.toContain("specific-proof");
    });
    it("accepts a named testimonial", async () => {
      expect(await failed(GOOD.replace("Loved by 12,000 customers and rated 4.8 out of 5.", "<blockquote>It changed our garage. Sam, Carlton</blockquote>"))).not.toContain("specific-proof");
    });
  });

  describe("contact-channels", () => {
    it("flags a page with only one way to get in touch", async () => {
      const one = without(/<a href="mailto:[^>]*>Email us<\/a>/).replace(/<form[\s\S]*?<\/form>/, "").replace('<a href="/contact">Contact</a>', "").replace('"address":"1 High St, Melbourne",', "");
      expect(await failed(one)).toContain("contact-channels");
      expect((await finding(one, "contact-channels")).evidence[0].note).toMatch(/1 /);
    });
    it("counts phone, email, a contact page, a form, chat and an address as separate channels", async () => {
      const phoneAndChat = without(/<a href="mailto:[^>]*>Email us<\/a>/).replace(/<form[\s\S]*?<\/form>/, "").replace('<a href="/contact">Contact</a>', "").replace("</body>", '<script src="https://embed.tawk.to/abc/1"></script></body>');
      expect(await failed(phoneAndChat)).not.toContain("contact-channels");
    });
  });

  describe("a newsletter box is not a way to contact the business", () => {
    const base = () => without(/<a href="mailto:[^>]*>Email us<\/a>/).replace('<a href="/contact">Contact</a>', "").replace('"address":"1 High St, Melbourne",', "").replace('<a href="tel:+61300000000">Call us</a>', "");
    it("does not count an email-only sign-up form as a contact route", async () => {
      const html = base();
      expect(await failed(html)).toContain("contact-channels");
      expect((await finding(html, "contact-channels")).evidence[0].note).toMatch(/^0 /);
    });
    it("counts a form with a message box, which is how people write in", async () => {
      const html = base().replace("</body>", '<form action="/contact"><textarea name="message"></textarea></form><a href="tel:+61300000000">Call</a></body>');
      expect(await failed(html)).not.toContain("contact-channels");
    });
  });

  it("returns outcomes instead of throwing on broken input", async () => {
    for (const html of ["", "<html><head><title>x<body><form><input", "\u0000<<<>>>&&&", '<script type="application/ld+json">{oops</script>']) {
      expect((await run(html)).outcomes).toHaveLength(8);
    }
  });
});

// ---- The messaging review (AI), held to the same rule as the content review: quote the page or it does not count ----
import { MARKETING_RUBRIC } from "@/lib/checks/marketing";
import type { LlmClient } from "@/lib/llm/router";

describe("the messaging review", () => {
  const IDS = MARKETING_RUBRIC.map((r) => r.id);
  const QUOTE = "Shelves from $49. Free delivery over $100.";
  const answer = (over: Record<string, { passed?: boolean; quote?: string; severity?: string }> = {}): LlmClient => async () => ({
    content: JSON.stringify({ items: IDS.map((id) => ({ id, passed: true, quote: QUOTE, severity: "medium", ...over[id] })) }),
    provider: "nim", model: "m",
  });

  it("has six questions worth 30 points, which with the 70 no-AI points makes the module 100", async () => {
    expect(IDS).toHaveLength(6);
    const r = await runMarketingChecks(snap(GOOD), answer());
    expect(r.outcomes.reduce((sum, o) => sum + o.weight, 0)).toBe(100);
    expect(r.outcomes.filter((o) => IDS.includes(o.id as never))).toHaveLength(6);
  });

  it("turns an answer that quotes the page into a finding worded by us, not by the model", async () => {
    const r = await runMarketingChecks(snap(GOOD), answer({ objections: { passed: false, quote: QUOTE, severity: "high" } }));
    const f = r.outcomes.find((o) => o.id === "objections")!.finding!;
    expect(f.id).toBe("marketing:objections");
    expect(f.module).toBe("marketing");
    expect(f.severity).toBe("medium"); // the model cannot raise it
    expect(f.title).toBe(MARKETING_RUBRIC.find((x) => x.id === "objections")!.title);
    expect(f.evidence[0].quote).toBe(QUOTE);
  });

  it("drops an answer whose quote is not on the page", async () => {
    const r = await runMarketingChecks(snap(GOOD), answer({ voice: { passed: false, quote: "this sentence is nowhere on the page at all" } }));
    expect(r.outcomes.map((o) => o.id)).not.toContain("voice");
    expect(r.couldntCheck.map((c) => c.what)).toContain("AI review: voice");
  });

  it("says plainly that the review did not run when no AI is available", async () => {
    const r = await runMarketingChecks(snap(GOOD), null);
    expect(r.couldntCheck).toEqual([{ what: "AI review of the marketing messaging", why: "no AI provider is available" }]);
  });

  it("keeps the deterministic results when the AI fails", async () => {
    const boom: LlmClient = async () => { throw new Error("provider down"); };
    const r = await runMarketingChecks(snap(GOOD), boom);
    expect(r.outcomes).toHaveLength(8);
    expect(r.couldntCheck[0].what).toBe("AI review of the marketing messaging");
  });
});
