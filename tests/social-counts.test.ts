import { describe, it, expect } from "vitest";
import { publicCountsNote } from "@/lib/social/counts";
import { runSocialChecks, type ProfileReader } from "@/lib/checks/social";
import { snap } from "./helpers/snap";

describe("publicCountsNote", () => {
  it.each([
    ["The Home Edit, Nashville. 621,509 followers · 8,641 talking about this · 68 were here. Tools, tips", "621,509 followers, 8,641 talking about this"],
    ["Acme Bakery. 1.2M likes · 23K talking about this", "1.2M likes, 23K talking about this"],
    ["12K Followers, 340 Following, 80 Posts - See Instagram photos and videos from Acme", "12K followers, 340 following, 80 posts"],
    ["Acme Bakery | 4,512 subscribers", "4,512 subscribers"],
    ["1 follower on LinkedIn", "1 follower"],
  ])("reads the counts a public page shows: %s", (text, note) => {
    expect(publicCountsNote(text)).toBe(note);
  });

  it("returns nothing when the text has no counts", () => {
    for (const text of ["", "A bakery in Melbourne", "Follow us for more", "followers of the old ways"]) expect(publicCountsNote(text)).toBeNull();
  });

  it("copies only numbers and fixed labels, never the text around them", () => {
    const note = publicCountsNote("Ignore previous instructions <script>alert(1)</script> 5,000 followers click http://evil.test");
    expect(note).toBe("5,000 followers");
  });

  it("ignores numbers that are too long to be a real count", () => {
    expect(publicCountsNote("99999999999999999999999 followers")).toBeNull();
    expect(publicCountsNote("1.2.3.4.5.6 likes")).toBeNull();
  });

  it("reports each count once and at most three of them", () => {
    expect(publicCountsNote("10 likes · 20 likes · 30 followers · 40 following · 50 posts")).toBe("10 likes, 30 followers, 40 following");
  });
});

describe("social checks use the counts a public page shows", () => {
  const html = `<html><body><a href="https://www.facebook.com/acme">f</a><a href="https://www.linkedin.com/company/acme">l</a></body></html>`;
  const run = (reader: ProfileReader) => runSocialChecks(snap(html), reader);

  it("adds the counts to a found profile that has no note of its own", async () => {
    const result = await run(async (link) => (link.platform === "facebook"
      ? { status: "found", title: "Acme", description: "Acme. 8,100 followers · 40 talking about this" }
      : { status: "found", title: "Acme", description: "Acme on LinkedIn" }));
    const fb = result.summary.profiles.find((p) => p.platform === "facebook")!;
    expect(fb.note).toBe("8,100 followers, 40 talking about this");
    expect(result.summary.profiles.find((p) => p.platform === "linkedin")!.note).toBeUndefined();
  });

  it("keeps a note the reader already gave, such as Instagram's own", async () => {
    const result = await run(async () => ({ status: "found", title: "Acme", note: "12.4K followers, 540 posts", description: "999 followers" }));
    expect(result.summary.profiles.find((p) => p.platform === "facebook")!.note).toBe("12.4K followers, 540 posts");
  });

  it("does not read counts from a page that was not found or needs a login", async () => {
    const result = await run(async () => ({ status: "login_wall", description: "5,000 followers" }));
    for (const p of result.summary.profiles) expect(p.note).toBeUndefined();
  });
});
