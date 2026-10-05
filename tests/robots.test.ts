import { describe, it, expect } from "vitest";
import { parseRobots, isAllowed } from "@/lib/robots";

const TXT = `
# comment
User-agent: *
Disallow: /admin
Allow: /admin/public
Disallow: /*.pdf$
Disallow:

User-agent: GPTBot
User-agent: ClaudeBot
Disallow: /

Sitemap: https://example.com/sitemap.xml
`;

describe("robots", () => {
  const rules = parseRobots(TXT);

  it("collects sitemaps", () => {
    expect(rules.sitemaps).toEqual(["https://example.com/sitemap.xml"]);
  });
  it("applies the wildcard group to unknown agents", () => {
    expect(isAllowed(rules, "SiteReconBot/0.1", "/")).toBe(true);
    expect(isAllowed(rules, "SiteReconBot/0.1", "/admin/users")).toBe(false);
  });
  it("lets the longest matching rule win", () => {
    expect(isAllowed(rules, "SiteReconBot/0.1", "/admin/public/page")).toBe(true);
  });
  it("supports * and $ patterns", () => {
    expect(isAllowed(rules, "SiteReconBot/0.1", "/files/a.pdf")).toBe(false);
    expect(isAllowed(rules, "SiteReconBot/0.1", "/files/a.pdf.html")).toBe(true);
  });
  it("uses a named group for every agent listed above it", () => {
    expect(isAllowed(rules, "Mozilla/5.0 (compatible; GPTBot/1.2)", "/")).toBe(false);
    expect(isAllowed(rules, "ClaudeBot", "/anything")).toBe(false);
  });
  it("allows everything when there is no robots.txt", () => {
    expect(isAllowed(null, "GPTBot", "/")).toBe(true);
  });
  it("does not throw on junk", () => {
    expect(isAllowed(parseRobots("<html>not robots</html>\n:::\nDisallow"), "x", "/")).toBe(true);
  });
});
