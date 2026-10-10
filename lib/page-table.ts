import type { SiteSnapshot } from "@/lib/snapshot";
import type { ModuleResult, PageRow } from "@/lib/pipeline/schemas";
import { pageFacts } from "@/lib/page-facts";

// One row for each page that was read, so a visitor can see the whole site at a glance: which pages
// have a title, a description and a single H1, how much text each has, and where the problems are.
// The text comes from the audited site, so it is cut short.

const key = (url: string) => {
  try {
    const u = new URL(url);
    return `${u.hostname.toLowerCase().replace(/^www\./, "")}${u.pathname.replace(/\/+$/, "")}`;
  } catch {
    return url;
  }
};

export function buildPageTable(s: SiteSnapshot, modules: ModuleResult[]): PageRow[] {
  // How many distinct findings point at each page. A finding that quotes one page twice counts once.
  const issues = new Map<string, number>();
  for (const f of modules.flatMap((m) => m.findings)) {
    for (const k of new Set(f.evidence.map((e) => key(e.url)))) issues.set(k, (issues.get(k) ?? 0) + 1);
  }
  return [s.home, ...s.pages].map((res) => {
    const facts = pageFacts(res);
    return {
      url: facts.url,
      title: facts.title.slice(0, 120),
      description: facts.description.slice(0, 160),
      h1: facts.h1,
      words: facts.words,
      issues: issues.get(key(facts.url)) ?? 0,
    };
  });
}
