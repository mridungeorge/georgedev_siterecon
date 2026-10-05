export interface RobotsRule { allow: boolean; path: string }
export interface RobotsGroup { agents: string[]; rules: RobotsRule[] }
export interface RobotsRules { groups: RobotsGroup[]; sitemaps: string[] }

export function parseRobots(txt: string): RobotsRules {
  const groups: RobotsGroup[] = [];
  const sitemaps: string[] = [];
  let current: RobotsGroup | null = null;
  let lastWasAgent = false;

  for (const rawLine of txt.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    const sep = line.indexOf(":");
    if (sep === -1) continue;
    const key = line.slice(0, sep).trim().toLowerCase();
    const value = line.slice(sep + 1).trim();

    if (key === "sitemap") {
      if (value) sitemaps.push(value);
    } else if (key === "user-agent") {
      // Consecutive User-agent lines share one group.
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
    } else if (key === "allow" || key === "disallow") {
      if (current && value) current.rules.push({ allow: key === "allow", path: value });
      lastWasAgent = false;
    } else {
      lastWasAgent = false;
    }
  }
  return { groups, sitemaps };
}

function matches(pattern: string, path: string): boolean {
  const anchored = pattern.endsWith("$");
  const body = (anchored ? pattern.slice(0, -1) : pattern)
    .split("*")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${body}${anchored ? "$" : ""}`).test(path);
}

/**
 * The product tokens in a user agent, so "Mozilla/5.0 (compatible; GPTBot/1.2)" gives
 * mozilla, 5.0, compatible, gptbot and 1.2. Our own "(+https://...)" contact URL is
 * dropped, otherwise a robots.txt group named "https" or "methodology" would match us.
 */
function uaTokens(userAgent: string): Set<string> {
  const withoutContactUrl = userAgent.replace(/\(\+[^)]*\)/g, " ");
  return new Set(withoutContactUrl.toLowerCase().split(/[^a-z0-9._-]+/).filter(Boolean));
}

/**
 * Standard robots matching (RFC 9309): every group that names this crawler is merged,
 * and only if none does, every "*" group is. The longest matching rule then wins.
 */
export function isAllowed(rules: RobotsRules | null, userAgent: string, path: string): boolean {
  if (!rules) return true;
  const tokens = uaTokens(userAgent);

  const named = rules.groups.filter((g) => g.agents.some((agent) => agent !== "*" && tokens.has(agent)));
  const groups = named.length > 0 ? named : rules.groups.filter((g) => g.agents.includes("*"));
  if (groups.length === 0) return true;

  let verdict = true;
  let bestRuleLength = -1;
  for (const rule of groups.flatMap((g) => g.rules)) {
    if (!matches(rule.path, path)) continue;
    const longer = rule.path.length > bestRuleLength;
    const tieGoesToAllow = rule.path.length === bestRuleLength && rule.allow;
    if (longer || tieGoesToAllow) {
      verdict = rule.allow;
      bestRuleLength = rule.path.length;
    }
  }
  return verdict;
}
