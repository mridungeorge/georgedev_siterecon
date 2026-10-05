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

/** Standard robots matching: the most specific agent group, then the longest matching rule. */
export function isAllowed(rules: RobotsRules | null, userAgent: string, path: string): boolean {
  if (!rules) return true;
  const ua = userAgent.toLowerCase();

  let group: RobotsGroup | undefined;
  let bestAgentLength = -1;
  for (const g of rules.groups) {
    for (const agent of g.agents) {
      if (agent !== "*" && ua.includes(agent) && agent.length > bestAgentLength) {
        group = g;
        bestAgentLength = agent.length;
      }
    }
  }
  group ??= rules.groups.find((g) => g.agents.includes("*"));
  if (!group) return true;

  let verdict = true;
  let bestRuleLength = -1;
  for (const rule of group.rules) {
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
