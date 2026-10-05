import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { safeFetch, BlockedAddressError, USER_AGENT } from "@/lib/safe-fetch";
import { InvalidTargetError, normalizeTargetUrl } from "@/lib/url-guard";

let server: Server;
let port: number;
let lastUserAgent = "";

beforeAll(async () => {
  server = createServer((req, res) => {
    lastUserAgent = String(req.headers["user-agent"]);
    if (req.url === "/ok") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end("<html><title>hi</title></html>");
    } else if (req.url === "/hop") {
      res.writeHead(302, { location: "/ok" });
      res.end();
    } else if (req.url === "/to-internal") {
      res.writeHead(302, { location: `http://internal.test:${port}/ok` });
      res.end();
    } else if (req.url === "/to-ip") {
      res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data/" });
      res.end();
    } else if (req.url === "/loop") {
      res.writeHead(302, { location: "/loop" });
      res.end();
    } else if (req.url === "/big") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("x".repeat(50_000));
    } else if (req.url === "/hang") {
      res.writeHead(200, { "content-type": "text/html" });
      res.write("<html>"); // never ends
    } else if (req.url === "/latin1") {
      res.writeHead(200, { "content-type": "text/html; charset=iso-8859-1" });
      res.end(Buffer.from([0x3c, 0x70, 0x3e, 0xe9, 0xff, 0x3c, 0x2f, 0x70, 0x3e]));
    } else {
      res.writeHead(404, { "content-type": "text/html" });
      res.end("nope");
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
});

afterAll(() => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }));

// Test wiring: every *.test hostname resolves to the local server, except
// internal.test, which pretends to be a private address.
const local = {
  validateUrl: (u: string) => new URL(u),
  resolve: async (hostname: string) =>
    hostname === "internal.test" ? [{ address: "10.0.0.5", family: 4 }] : [{ address: "127.0.0.1", family: 4 }],
  isBlocked: (ip: string) => ip.startsWith("10."),
};
const u = (path: string) => `http://site.test:${port}${path}`;

describe("safeFetch", () => {
  it("fetches a page and identifies itself", async () => {
    const res = await safeFetch(u("/ok"), local);
    expect(res.status).toBe(200);
    expect(res.contentType).toContain("text/html");
    expect(res.body).toContain("<title>hi</title>");
    expect(res.truncated).toBe(false);
    expect(lastUserAgent).toBe(USER_AGENT);
  });

  it("follows redirects and reports the final URL", async () => {
    const res = await safeFetch(u("/hop"), local);
    expect(res.finalUrl).toBe(u("/ok"));
    expect(res.url).toBe(u("/hop"));
  });

  it("refuses a redirect to a private address", async () => {
    await expect(safeFetch(u("/to-internal"), local)).rejects.toBeInstanceOf(BlockedAddressError);
  });

  it("re-validates every redirect hop, so a redirect to an IP literal is refused", async () => {
    // The local test host is let through. Every other URL goes to the real validator,
    // so this fails on the redirect target and not on the test server's port.
    const validateUrl = (raw: string) => (new URL(raw).hostname === "site.test" ? new URL(raw) : normalizeTargetUrl(raw));
    await expect(safeFetch(u("/to-ip"), { ...local, validateUrl })).rejects.toBeInstanceOf(InvalidTargetError);
  });

  it("refuses a host that resolves to a blocked address by default", async () => {
    await expect(
      safeFetch("https://evil.example.com/", { resolve: async () => [{ address: "169.254.169.254", family: 4 }] }),
    ).rejects.toBeInstanceOf(BlockedAddressError);
  });

  it("gives up on redirect loops", async () => {
    await expect(safeFetch(u("/loop"), { ...local, maxRedirects: 3 })).rejects.toThrow(/too many redirects/);
  });

  it("truncates an oversized body instead of failing", async () => {
    const res = await safeFetch(u("/big"), { ...local, maxBytes: 1000 });
    expect(res.body.length).toBe(1000);
    expect(res.truncated).toBe(true);
  });

  it("times out on a response that never finishes", async () => {
    await expect(safeFetch(u("/hang"), { ...local, timeoutMs: 300 })).rejects.toThrow();
  });

  it("does not throw on non-UTF-8 bytes", async () => {
    const res = await safeFetch(u("/latin1"), local);
    expect(res.body.startsWith("<p>")).toBe(true);
  });
});
