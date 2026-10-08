import { describe, it, expect } from "vitest";
import { createInstagramReader, composeProfileReaders, type InstagramDeps } from "@/lib/social/instagram";
import type { ProfileRead } from "@/lib/checks/social";
import type { SocialLink } from "@/lib/social/platforms";

const TOKEN = "EAAB-secret-token-value-123";
const link = (handle: string | null, platform: SocialLink["platform"] = "instagram"): SocialLink => ({
  platform, url: `https://www.instagram.com/${handle ?? ""}/`, handle, kind: "profile",
});

const ok = (over: Record<string, unknown> = {}) => ({
  status: 200,
  body: { business_discovery: { username: "acme", name: "Acme Bakery", followers_count: 12400, media_count: 540, biography: "Fresh bread daily", media: { data: [{ timestamp: "2026-09-01T10:00:00+0000" }, { timestamp: "2026-09-20T10:00:00+0000" }, { timestamp: "2026-08-01T10:00:00+0000" }] }, ...over }, id: "17841416820112709" },
});

function reader(over: Partial<InstagramDeps> & { reply?: { status: number; body: unknown } } = {}) {
  const urls: string[] = [];
  const read = createInstagramReader({
    userId: "17841416820112709",
    token: TOKEN,
    quotaOk: () => true,
    fetchJson: async (url) => { urls.push(url); return over.reply ?? ok(); },
    ...over,
  });
  return { read, urls };
}

describe("createInstagramReader", () => {
  it("asks the Graph API for the public details of the business, through the connected account", async () => {
    const { read, urls } = reader();
    await read(link("acme"));
    expect(urls).toHaveLength(1);
    const u = new URL(urls[0]);
    expect(u.hostname).toBe("graph.facebook.com");
    expect(u.pathname).toMatch(/^\/v\d+\.\d+\/17841416820112709$/);
    expect(u.searchParams.get("fields")).toMatch(/^business_discovery\.username\(acme\)\{[^}]*followers_count[^}]*media_count/);
    expect(u.searchParams.get("access_token")).toBe(TOKEN);
  });

  it("turns a business account into a found profile with its audience and latest post", async () => {
    const r = await reader().read(link("acme"));
    expect(r).toEqual({
      status: "found",
      title: "Acme Bakery",
      description: "Fresh bread daily",
      note: "12.4K followers, 540 posts",
      lastActivityAt: "2026-09-20T10:00:00.000Z",
    });
  });
  it.each([[0, "0"], [999, "999"], [1000, "1K"], [1250, "1.3K"], [12400, "12.4K"], [999_999, "1M"], [2_500_000, "2.5M"]])("formats %i followers as %s", async (count, text) => {
    const r = await reader({ reply: ok({ followers_count: count }) }).read(link("acme"));
    expect(r.note).toBe(`${text} followers, 540 posts`);
  });
  it("copes with a business that has no posts or no name", async () => {
    const r = await reader({ reply: ok({ media: undefined, name: undefined, biography: undefined, media_count: 0 }) }).read(link("acme"));
    expect(r.status).toBe("found");
    expect(r.title).toBe("acme");
    expect(r.lastActivityAt).toBeUndefined();
  });

  describe("errors", () => {
    const err = (error: Record<string, unknown>, status = 400) => ({ status, body: { error } });

    it("says the token has expired, without repeating the token", async () => {
      const r = await reader({ reply: err({ code: 190, message: `Error validating access token: ${TOKEN} expired` }) }).read(link("acme"));
      expect(r.status).toBe("unreadable");
      expect(r.note).toMatch(/token.*(expired|revoked|invalid)/i);
      expect(JSON.stringify(r)).not.toContain(TOKEN);
    });
    it.each([[110, undefined], [100, 2207013], [24, 2207001]])("explains that only business and creator accounts can be read (code %i)", async (code, sub) => {
      const r = await reader({ reply: err({ code, error_subcode: sub, message: "Invalid user id" }) }).read(link("acme"));
      expect(r.status).toBe("unreadable");
      expect(r.note).toMatch(/business or creator/i);
    });
    it.each([4, 17, 32, 613])("reports Instagram's own rate limit (code %i)", async (code) => {
      const r = await reader({ reply: err({ code, message: "limit" }) }).read(link("acme"));
      expect(r.status).toBe("unreadable");
      expect(r.note).toMatch(/rate limit/i);
    });
    it("reports a server error without echoing what the server said", async () => {
      const r = await reader({ reply: { status: 502, body: "<html>Bad gateway</html>" } }).read(link("acme"));
      expect(r).toEqual({ status: "unreadable", note: "Instagram did not give a usable answer (HTTP 502)" });
    });
    it("reports an answer with no business details as unreadable", async () => {
      const r = await reader({ reply: { status: 200, body: { id: "1" } } }).read(link("acme"));
      expect(r.status).toBe("unreadable");
    });
    it("never lets a network error through, because its message can contain the request address and so the token", async () => {
      const { read } = reader({ fetchJson: async (url) => { throw new Error(`request to ${url} failed`); } });
      const r = await read(link("acme"));
      expect(r.status).toBe("unreadable");
      expect(JSON.stringify(r)).not.toContain(TOKEN);
      expect(r.note).not.toMatch(/graph\.facebook\.com/);
    });
    it("passes a cancellation on, so a scan that was abandoned stops", async () => {
      const controller = new AbortController();
      controller.abort();
      const { read } = reader({ fetchJson: async () => { throw new Error("aborted"); } });
      await expect(read(link("acme"), controller.signal)).rejects.toThrow();
    });
  });

  describe("what is sent to Instagram", () => {
    it.each([["has space"], ["a)b"], ["a{b"], ["a,b"], [""], ["x".repeat(31)], ["a/b"], ["a?b=1"], ["../x"]])("never sends the handle %j", async (handle) => {
      const { read, urls } = reader();
      const r = await read(link(handle));
      expect(urls).toHaveLength(0);
      expect(r.status).toBe("unreadable");
    });
    it("never sends a missing handle", async () => {
      const { read, urls } = reader();
      expect((await read(link(null))).status).toBe("unreadable");
      expect(urls).toHaveLength(0);
    });
    it.each(["acme", "acme.bakery", "acme_bakery", "A1.b_2"])("sends the valid handle %s", async (handle) => {
      const { read, urls } = reader();
      await read(link(handle));
      expect(urls).toHaveLength(1);
    });
    it("makes no request once the daily budget is spent", async () => {
      const { read, urls } = reader({ quotaOk: () => false });
      const r = await read(link("acme"));
      expect(urls).toHaveLength(0);
      expect(r.status).toBe("unreadable");
      expect(r.note).toMatch(/daily/i);
    });
  });
});

describe("composeProfileReaders", () => {
  const found: ProfileRead = { status: "found", title: "from the fetch service" };
  const wall: ProfileRead = { status: "login_wall" };
  const fallback = (r: ProfileRead) => {
    const calls: string[] = [];
    return { read: async (l: SocialLink) => { calls.push(l.platform); return r; }, calls };
  };
  const instagram = (r: ProfileRead) => {
    const calls: string[] = [];
    return { read: async (l: SocialLink) => { calls.push(l.platform); return r; }, calls };
  };

  it("is nothing when neither reader exists", () => {
    expect(composeProfileReaders(null, null)).toBeNull();
  });
  it("uses the Instagram reader for Instagram and the fetch service for everything else", async () => {
    const ig = instagram({ status: "found", title: "from instagram" });
    const fb = fallback(found);
    const read = composeProfileReaders(ig.read, fb.read)!;
    expect((await read(link("acme"))).title).toBe("from instagram");
    expect((await read(link("acme", "facebook"))).title).toBe("from the fetch service");
    expect(ig.calls).toEqual(["instagram"]);
    expect(fb.calls).toEqual(["facebook"]);
  });
  it("keeps Instagram's explanation when the fallback cannot do better", async () => {
    const note = "this is a personal account";
    const read = composeProfileReaders(instagram({ status: "unreadable", note }).read, fallback(wall).read)!;
    expect(await read(link("acme"))).toEqual({ status: "unreadable", note });
  });
  it("takes the fetch service's answer for Instagram when Instagram gave none and it found the page", async () => {
    const read = composeProfileReaders(instagram({ status: "unreadable", note: "expired" }).read, fallback(found).read)!;
    expect((await read(link("acme"))).status).toBe("found");
  });
  it("trusts Instagram when it says the profile does not exist", async () => {
    const fb = fallback(found);
    const read = composeProfileReaders(instagram({ status: "not_found" }).read, fb.read)!;
    expect((await read(link("acme"))).status).toBe("not_found");
    expect(fb.calls).toEqual([]);
  });
  it("works with the Instagram reader alone, and says other platforms were not opened", async () => {
    const read = composeProfileReaders(instagram({ status: "found" }).read, null)!;
    expect((await read(link("acme"))).status).toBe("found");
    const other = await read(link("acme", "facebook"));
    expect(other.status).toBe("unreadable");
    expect(other.note).toMatch(/not (set up|configured)/i);
  });
  it("works with the fetch service alone", async () => {
    const read = composeProfileReaders(null, fallback(found).read)!;
    expect((await read(link("acme"))).title).toBe("from the fetch service");
  });
});
