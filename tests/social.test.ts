import { describe, it, expect } from "vitest";
import { classifySocialUrl, extractSocialLinks } from "@/lib/social/platforms";
import { runSocialChecks, type ProfileReader } from "@/lib/checks/social";
import { FindingSchema } from "@/lib/pipeline/schemas";
import { snap } from "./helpers/snap";

describe("classifySocialUrl", () => {
  it.each([
    ["https://www.facebook.com/AcmeStorage/", "facebook", "AcmeStorage", "profile"],
    ["https://m.facebook.com/AcmeStorage?ref=x", "facebook", "AcmeStorage", "profile"],
    ["https://facebook.com/profile.php?id=1000123", "facebook", "profile.php?id=1000123", "profile"],
    ["https://www.instagram.com/acme.storage/", "instagram", "acme.storage", "profile"],
    ["https://twitter.com/acme", "x", "acme", "profile"],
    ["https://x.com/acme", "x", "acme", "profile"],
    ["https://www.linkedin.com/company/acme-storage/", "linkedin", "company/acme-storage", "profile"],
    ["https://www.linkedin.com/in/jane-doe", "linkedin", "in/jane-doe", "profile"],
    ["https://www.youtube.com/@AcmeStorage", "youtube", "@AcmeStorage", "profile"],
    ["https://www.youtube.com/channel/UC123abc", "youtube", "channel/UC123abc", "profile"],
    ["https://www.tiktok.com/@acme", "tiktok", "@acme", "profile"],
    ["https://au.pinterest.com/acme/", "pinterest", "acme", "profile"],
    ["https://github.com/acme", "github", "acme", "profile"],
  ])("recognises %s", (href, platform, handle, kind) => {
    expect(classifySocialUrl(href)).toMatchObject({ platform, handle, kind });
  });

  it.each([
    ["https://www.facebook.com/", "facebook"],
    ["https://instagram.com", "instagram"],
    ["https://twitter.com/", "x"],
  ])("treats the bare homepage %s as a placeholder link", (href, platform) => {
    expect(classifySocialUrl(href)).toMatchObject({ platform, kind: "homepage", handle: null });
  });

  it.each([
    "https://www.facebook.com/sharer/sharer.php?u=https://acme.com",
    "https://twitter.com/intent/tweet?text=hi",
    "https://www.linkedin.com/shareArticle?mini=true",
    "https://www.pinterest.com/pin/create/button/",
    "https://www.instagram.com/p/ABC123/",
    "https://www.youtube.com/watch?v=abc",
    "https://youtu.be/abc",
    "https://www.facebook.com/login",
    "https://example.com/facebook.com/acme",
    "mailto:a@b.co",
    "not a url",
  ])("ignores %s", (href) => expect(classifySocialUrl(href)).toBeNull());

  it("resolves relative links against a base", () => {
    expect(classifySocialUrl("/AcmeStorage", "https://www.facebook.com/")).toMatchObject({ platform: "facebook" });
  });
});

describe("extractSocialLinks", () => {
  const html = `<html><head><script type="application/ld+json">
    {"@type":"Organization","name":"Acme","sameAs":["https://www.facebook.com/acme","https://www.linkedin.com/company/acme","https://acme.example/about"]}
  </script></head><body>
    <a href="https://www.facebook.com/acme/">Facebook</a><a href="https://facebook.com/acme">again</a>
    <a href="https://twitter.com/intent/tweet">Share</a><a href="https://instagram.com/">Instagram</a>
    <a href="https://www.instagram.com/acme">Instagram</a>
  </body></html>`;
  it("finds each profile once, keeps placeholder links, and reads schema sameAs", () => {
    const { links, sameAs } = extractSocialLinks(html, "https://acme.example/");
    expect(links.map((l) => `${l.platform}:${l.kind}`).sort()).toEqual(["facebook:profile", "instagram:homepage", "instagram:profile"]);
    expect(sameAs).toEqual(["https://www.facebook.com/acme", "https://www.linkedin.com/company/acme", "https://acme.example/about"]);
  });
  it("survives broken HTML and invalid JSON-LD", () => {
    expect(extractSocialLinks('<script type="application/ld+json">{oops</script><a href="https://x.com/a">x', "https://a.example/").links).toHaveLength(1);
  });
});

const PAGE = (extra = "") => `<html><head><script type="application/ld+json">{"@type":"Organization","sameAs":["https://www.facebook.com/acme"]}</script></head><body>
  <a href="https://www.facebook.com/acme">f</a><a href="https://www.instagram.com/acme">i</a><a href="https://www.linkedin.com/company/acme">l</a>${extra}</body></html>`;
const NOW = Date.parse("2026-10-05T00:00:00Z");
const found = (over: object = {}): ProfileReader => async () => ({ status: "found", title: "Acme", ...over });
const failed = (r: Awaited<ReturnType<typeof runSocialChecks>>) => r.outcomes.filter((o) => !o.passed).map((o) => o.id);

describe("runSocialChecks", () => {
  it("passes a well-linked brand whose profiles all exist, weights total 100", async () => {
    const r = await runSocialChecks(snap(PAGE()), found({ lastActivityAt: "2026-09-20T00:00:00Z" }), undefined, NOW);
    expect(failed(r)).toEqual([]);
    expect(r.outcomes.reduce((s, o) => s + o.weight, 0)).toBe(100);
    expect(r.summary.profiles.map((p) => p.platform).sort()).toEqual(["facebook", "instagram", "linkedin"]);
    expect(r.summary.profiles.every((p) => p.status === "found")).toBe(true);
    expect(r.summary.missing).toEqual([]);
  });

  it("flags a site with no social presence, each finding with evidence", async () => {
    const r = await runSocialChecks(snap("<html><body>hi</body></html>"), null, undefined, NOW);
    expect(failed(r)).toEqual(expect.arrayContaining(["has-profiles", "key-platforms", "schema-sameas"]));
    for (const o of r.outcomes.filter((x) => !x.passed)) expect(() => FindingSchema.parse(o.finding)).not.toThrow();
    expect(r.summary.missing).toEqual(["facebook", "instagram", "linkedin"]);
  });

  it("flags placeholder links to a platform's homepage", async () => {
    const r = await runSocialChecks(snap(PAGE('<a href="https://twitter.com/">x</a>')), null, undefined, NOW);
    expect(failed(r)).toContain("profile-links-valid");
  });

  it("scores only what it could read when there is no profile reader, and says so", async () => {
    const r = await runSocialChecks(snap(PAGE()), null, undefined, NOW);
    expect(r.outcomes.reduce((s, o) => s + o.weight, 0)).toBe(65);
    expect(r.couldntCheck.some((c) => /profile/i.test(c.what))).toBe(true);
    expect(r.summary.profiles.every((p) => p.status === "linked")).toBe(true);
  });

  it("flags a profile that does not exist", async () => {
    const reader: ProfileReader = async (link) => (link.platform === "instagram" ? { status: "not_found" } : { status: "found" });
    const r = await runSocialChecks(snap(PAGE()), reader, undefined, NOW);
    expect(failed(r)).toContain("profiles-reachable");
    const f = r.outcomes.find((o) => o.id === "profiles-reachable")!.finding!;
    expect(f.evidence[0].url).toContain("instagram.com");
  });

  it("flags profiles that have not posted for six months", async () => {
    const r = await runSocialChecks(snap(PAGE()), found({ lastActivityAt: "2025-01-01T00:00:00Z" }), undefined, NOW);
    expect(failed(r)).toContain("profile-activity");
  });

  it("does not guess about activity when nothing reports a date", async () => {
    const r = await runSocialChecks(snap(PAGE()), found(), undefined, NOW);
    expect(r.outcomes.find((o) => o.id === "profile-activity")).toBeUndefined();
  });

  it("reports login-walled and unreadable profiles as could not check, not as failures", async () => {
    const reader: ProfileReader = async (l) =>
      l.platform === "facebook" ? { status: "login_wall" } : l.platform === "instagram" ? { status: "unreadable", note: "timed out" } : { status: "found" };
    const r = await runSocialChecks(snap(PAGE()), reader, undefined, NOW);
    expect(failed(r)).not.toContain("profiles-reachable");
    expect(r.couldntCheck.map((c) => c.what).join(" ")).toMatch(/facebook/);
    expect(r.couldntCheck.map((c) => c.what).join(" ")).toMatch(/instagram/);
    expect(r.summary.profiles.find((p) => p.platform === "facebook")!.status).toBe("login_wall");
  });

  it("a reader that throws becomes unreadable for that profile only", async () => {
    const reader: ProfileReader = async (l) => { if (l.platform === "linkedin") throw new Error("boom"); return { status: "found" }; };
    const r = await runSocialChecks(snap(PAGE()), reader, undefined, NOW);
    expect(r.summary.profiles.find((p) => p.platform === "linkedin")!.status).toBe("unreadable");
    expect(r.summary.profiles.find((p) => p.platform === "facebook")!.status).toBe("found");
  });

  it("reads at most six profiles", async () => {
    const many = [
      "https://www.facebook.com/acme", "https://www.instagram.com/acme", "https://www.linkedin.com/company/acme",
      "https://www.youtube.com/@acme", "https://www.tiktok.com/@acme", "https://www.pinterest.com/acme",
      "https://github.com/acme", "https://x.com/acme",
    ].map((href) => `<a href="${href}">link</a>`).join("");
    let reads = 0;
    const reader: ProfileReader = async () => { reads++; return { status: "found" }; };
    await runSocialChecks(snap(`<html><body>${many}</body></html>`), reader, undefined, NOW);
    expect(reads).toBe(6);
  });
});
