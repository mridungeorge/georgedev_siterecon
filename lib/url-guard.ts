import { BlockList, isIP } from "node:net";

export class InvalidTargetError extends Error {}

const MAX_URL_LENGTH = 2048;

/**
 * Turns visitor input into a URL we are willing to scan. Mirrors RepoRecon's strict
 * input allowlist: anything that is not a plain public http(s) site is refused here,
 * before any network call.
 */
export function normalizeTargetUrl(input: string): URL {
  const raw = input.trim();
  if (!raw) throw new InvalidTargetError("Enter a website address, for example https://example.com");
  if (raw.length > MAX_URL_LENGTH) throw new InvalidTargetError("That address is too long.");

  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new InvalidTargetError("That doesn't look like a valid website address.");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new InvalidTargetError("Only http and https addresses can be scanned.");
  }
  if (url.username || url.password) {
    throw new InvalidTargetError("Addresses with a username or password can't be scanned.");
  }
  if (url.port !== "" && url.port !== "80" && url.port !== "443") {
    throw new InvalidTargetError("Only standard web ports (80 and 443) can be scanned.");
  }

  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host)) throw new InvalidTargetError("Enter a domain name, not an IP address.");
  if (!host.includes(".") || host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")) {
    throw new InvalidTargetError("Only public websites can be scanned.");
  }

  url.hash = "";
  return url;
}

/** The key used for per-target limits and the report cache. */
export function targetDomain(url: URL): string {
  return url.hostname.replace(/^www\./, "");
}

const blocked = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], // link-local, includes the cloud metadata server 169.254.169.254
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.168.0.0", 16],
  ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) blocked.addSubnet(net, prefix, "ipv4");
for (const [net, prefix] of [
  ["::", 127], // :: and ::1
  // No ::ffff:0:0/96 rule: Node checks IPv4 addresses against IPv6 rules as if mapped, so that
  // rule would block all of IPv4. IPv4-mapped IPv6 addresses (::ffff:127.0.0.1) are already
  // caught by the IPv4 rules above.
  ["64:ff9b::", 96], ["2001:db8::", 32], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8],
] as const) blocked.addSubnet(net, prefix, "ipv6");

/** True for any address a public website should never resolve to. Unknown input is blocked. */
export function isBlockedAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return blocked.check(ip, "ipv4");
  if (family === 6) return blocked.check(ip, "ipv6");
  return true;
}
