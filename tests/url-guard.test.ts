import { describe, it, expect } from "vitest";
import { normalizeTargetUrl, targetDomain, isBlockedAddress, InvalidTargetError } from "@/lib/url-guard";

describe("normalizeTargetUrl", () => {
  it("adds https and tidies sloppy input", () => {
    expect(normalizeTargetUrl("  Example.COM ").toString()).toBe("https://example.com/");
  });
  it("keeps an explicit http scheme and path, drops the fragment", () => {
    expect(normalizeTargetUrl("http://example.com/a?b=1#frag").toString()).toBe("http://example.com/a?b=1");
  });
  it("converts international domains to punycode", () => {
    expect(normalizeTargetUrl("https://bücher.de").hostname).toBe("xn--bcher-kva.de");
  });
  it.each([
    ["", "empty"],
    ["ftp://example.com", "wrong scheme"],
    ["https://user:pw@example.com", "credentials"],
    ["https://example.com:8080", "odd port"],
    ["https://127.0.0.1", "IPv4 literal"],
    ["https://2130706433", "decimal IPv4"],
    ["https://[::1]", "IPv6 literal"],
    ["https://localhost", "localhost"],
    ["https://intranet", "no dot"],
    ["https://printer.local", ".local"],
    ["https://metadata.google.internal", ".internal"],
    ["javascript:alert(1)", "javascript scheme"],
    ["https://" + "a".repeat(2100) + ".com", "too long"],
  ])("rejects %s (%s)", (input) => {
    expect(() => normalizeTargetUrl(input)).toThrow(InvalidTargetError);
  });
});

describe("targetDomain", () => {
  it("drops a leading www", () => {
    expect(targetDomain(new URL("https://www.example.com/x"))).toBe("example.com");
  });
});

describe("isBlockedAddress", () => {
  it.each([
    "127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254",
    "100.64.0.1", "0.0.0.0", "224.0.0.1", "::1", "::", "fe80::1", "fc00::1",
    "::ffff:127.0.0.1", "::ffff:7f00:1",
  ])("blocks %s", (ip) => expect(isBlockedAddress(ip)).toBe(true));

  it.each(["93.184.216.34", "8.8.8.8", "2606:2800:220:1:248:1893:25c8:1946"])(
    "allows %s", (ip) => expect(isBlockedAddress(ip)).toBe(false));

  it("blocks anything that is not an IP", () => {
    expect(isBlockedAddress("not-an-ip")).toBe(true);
  });
});
