import { describe, it, expect } from "vitest";
import { runContentChecks } from "@/lib/checks/content";
import { snap } from "./helpers/snap";

// The checks that need no AI: who is behind the site, whether it has a privacy policy, how much real
// copy it has, how easy that copy is to read, and whether it looks looked after.

// Plain, short sentences: easy to read, and enough of them to count as real copy.
const PLAIN = "<p>We make shelves. They fit small rooms. You pick a size and a colour. We build it and send it to your door. Most orders arrive in five days. If it does not fit, we take it back and give you your money. Call us if you need help.</p>";
const DENSE = "<p>The organisational infrastructure facilitates comprehensive operationalisation of multidimensional methodologies, notwithstanding considerable interdepartmental heterogeneity and characteristically unpredictable environmental contingencies.</p>";

const GOOD = `<html lang="en"><head><title>Acme Storage</title></head><body>
<header><nav><a href="/shop">Shop</a><a href="/about">About</a><a href="/contact">Contact</a></nav></header>
<h1>Modular shelving made for small homes</h1>
<p>Trusted by 12,000 customers, rated 4.8 out of 5 in independent reviews.</p>
${PLAIN.repeat(8)}
<a href="/quote">Get a free design quote</a>
<a href="tel:+61300000000">Call us</a>
<footer>© 2026 Acme Storage. <a href="/privacy">Privacy policy</a></footer>
</body></html>`;

const failedIds = async (html: string, fetchedAt?: string) =>
  (await runContentChecks(snap(html, fetchedAt ? { fetchedAt } : {}), null)).outcomes.filter((o) => !o.passed).map((o) => o.id);
const finding = async (html: string, id: string) => (await runContentChecks(snap(html), null)).outcomes.find((o) => o.id === id)!.finding!;

describe("trust, depth and readability checks", () => {
  it("passes a page with copy, an about link, a privacy link and a current copyright", async () => {
    expect(await failedIds(GOOD)).toEqual([]);
  });

  it("keeps the no-AI checks at 80 points", async () => {
    const r = await runContentChecks(snap(GOOD), null);
    expect(r.outcomes.reduce((sum, o) => sum + o.weight, 0)).toBe(80);
  });

  describe("about-page", () => {
    it("flags a site with no way to learn who is behind it", async () => {
      expect(await failedIds(GOOD.replace('<a href="/about">About</a>', '<a href="/blog">Blog</a>'))).toContain("about-page");
    });
    it("does not count a link to another site, such as a LinkedIn company page", async () => {
      const html = GOOD.replace('<a href="/about">About</a>', '<a href="https://www.linkedin.com/company/acme">LinkedIn</a><a href="https://other.test/about">Partner</a><a href="/blog">Blog</a>');
      expect(await failedIds(html)).toContain("about-page");
    });
    it("counts an absolute link to the site's own about page, with or without www", async () => {
      expect(await failedIds(GOOD.replace('<a href="/about">About</a>', '<a href="https://www.example.com/about">Hi</a><a href="/blog">Blog</a>'))).not.toContain("about-page");
      expect(await failedIds(GOOD.replace('<a href="/about">About</a>', '<a href="https://example.com/team">Hi</a><a href="/blog">Blog</a>'))).not.toContain("about-page");
    });
    it.each([
      ['<a href="/who-we-are">Team</a>'],
      ['<a href="/x">Our story</a>'],
      ['<a href="/company">Meet the team</a>'],
      ['<a href="/about-us">Hi</a>'],
    ])("accepts %s", async (link) => {
      expect(await failedIds(GOOD.replace('<a href="/about">About</a>', `${link}<a href="/blog">Blog</a>`))).not.toContain("about-page");
    });
  });

  describe("policy-pages", () => {
    it("flags a site with no privacy policy link", async () => {
      expect(await failedIds(GOOD.replace(' <a href="/privacy">Privacy policy</a>', ""))).toContain("policy-pages");
    });
    it.each([['<a href="/legal/privacy-policy">Legal</a>'], ['<a href="/x">Privacy</a>']])("accepts %s", async (link) => {
      expect(await failedIds(GOOD.replace('<a href="/privacy">Privacy policy</a>', link))).not.toContain("policy-pages");
    });
  });

  describe("content-depth", () => {
    it("flags a homepage with very little copy and says how many words it has", async () => {
      const thin = GOOD.replace(PLAIN.repeat(8), "");
      expect(await failedIds(thin)).toContain("content-depth");
      expect((await finding(thin, "content-depth")).title).toMatch(/only \d+ words/);
    });
    it("does not count the menu as copy", async () => {
      const link = '<a href="/x">word word word word word</a>';
      const menuHeavy = GOOD.replace(PLAIN.repeat(8), "").replace("</nav>", `${link.repeat(80)}</nav>`);
      expect(await failedIds(menuHeavy)).toContain("content-depth");
    });
  });

  describe("readability", () => {
    it("flags dense, jargon-heavy copy", async () => {
      const html = GOOD.replace(PLAIN.repeat(8), DENSE.repeat(10));
      expect(await failedIds(html)).toContain("readability");
      expect((await finding(html, "readability")).detail).toMatch(/reading ease/i);
    });
    it("cannot judge a page with almost no prose, so it does not fail it", async () => {
      expect(await failedIds(GOOD.replace(PLAIN.repeat(8), PLAIN))).not.toContain("readability");
    });
    it("passes plain language", async () => {
      expect(await failedIds(GOOD)).not.toContain("readability");
    });
  });

  describe("copyright-year", () => {
    const WITH = (text: string) => GOOD.replace("© 2026 Acme Storage.", text);
    it.each([["© 2019 Acme"], ["Copyright 2020 Acme"], ["&copy; 2018 - 2021 Acme"]])("flags an out-of-date notice: %s", async (text) => {
      expect(await failedIds(WITH(text))).toContain("copyright-year");
    });
    it.each([["© 2026 Acme"], ["© 2025 Acme"], ["© 2015-2026 Acme"], ["All rights reserved."]])("accepts: %s", async (text) => {
      expect(await failedIds(WITH(text))).not.toContain("copyright-year");
    });
    it("judges the year against when the page was fetched, not the clock, so the result never changes with the date", async () => {
      expect(await failedIds(WITH("© 2019 Acme"), "2020-03-01T00:00:00.000Z")).not.toContain("copyright-year");
    });
  });
});
