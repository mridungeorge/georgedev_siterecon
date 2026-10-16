import * as cheerio from "cheerio";
import type { SiteSnapshot } from "@/lib/snapshot";
import type { CheckOutcome, Finding } from "@/lib/pipeline/schemas";
import { analysePage, siteEntity, wordCount, type PageAnalysis } from "./page-analysis";
import { faqPairs, schemaFit } from "./schema-gaps";
import { clip } from "./helpers";
import { isKnownSource, type AuthoritySignals } from "@/lib/authority";

// Citation potential: how easy it is for an AI answer engine to lift a clear, attributable passage
// from each page. Every criterion is a fixed rule over the HTML. The weights are published on
// /methodology, and no model takes part in the score.

export type PageCriterion = "entity-early" | "definition" | "answer-passage" | "facts" | "structure" | "clarity" | "schema-fit" | "authority";
/** Every criterion in the published rubric: the page criteria, and one that belongs to the whole site. */
export type CitationCriterion = PageCriterion | "external-authority";
export type CriterionState = "pass" | "partial" | "fail" | "n/a";

const PAGE_WEIGHTS: Record<PageCriterion, number> = {
  "entity-early": 12, definition: 12, "answer-passage": 18, facts: 8, structure: 10, clarity: 8, "schema-fit": 10, authority: 10,
};
export const CITATION_WEIGHTS: Record<CitationCriterion, number> = { ...PAGE_WEIGHTS, "external-authority": 12 };

export interface CitationPageInsight {
  url: string;
  /** 0 to 100 over the criteria that applied to this page, or null when none did. */
  score: number | null;
  criteria: Record<PageCriterion, CriterionState>;
}

/** What an AI could lift from the site today, found by rule. */
export interface Extractable {
  entity: string | null;
  /** The first sentence that says what the business does. */
  definition: string | null;
  /** Numbers with something to say about, such as "30 years" or "4 shops". */
  facts: string[];
  /** Question headings with an answer directly beneath. */
  questions: { q: string; a: string }[];
}

export interface CitationInsights {
  pages: CitationPageInsight[];
  extractable: Extractable;
  /** Outside signals read for the site, when any were: domain rank, Wikidata and Hacker News. */
  authority: AuthoritySignals | null;
}

/** The passage length answer engines lift whole most often, used as a heuristic and not as a rule of any engine. */
const IDEAL_MIN = 134;
const IDEAL_MAX = 167;
const QUOTABLE_MIN = 40;
const QUOTABLE_MAX = 200;
const MIN_WORDS_TO_JUDGE = 100;
const SUBSTANTIVE_WORDS = 8;
const FACT = /(?:[$€£]\s?\d[\d,]*(?:\.\d+)?)|(?:\b\d[\d,]*(?:\.\d+)?\s?(?:%|percent\b|[a-z]{3,}))/gi;
const NOT_A_FACT = /^\d{4}\s?(?:acme|all|copyright)/i;
const DEFINING = /\b(is|are|was|provides?|offers?|helps?|specialis(?:es|e)s?|makes?|sells?|builds?|designs?|runs?|delivers?|creates?|supplies|serves?|bakes?|brews?|repairs?|teaches|trains?|treats?|manufactures?)\b/i;

const VAGUE = /\b(best|leading|world[- ]class|cutting[- ]edge|state[- ]of[- ]the[- ]art|innovative|unique|premier|top[- ]quality|unrivall?ed|second to none|number one|revolutionary|next[- ]generation)\b/gi;
const COMMON_ACRONYMS = new Set(["USA", "AUD", "USD", "FAQ", "FAQS", "CEO", "PDF", "URL", "HTML", "CSS", "UK", "EU", "NSW", "VIC", "QLD", "WA", "SA", "TAS", "ACT", "AM", "PM", "TV", "DIY", "GST", "ABN", "ACN", "NZ", "AI", "SEO", "RRP", "OK", "ID", "FAQS", "CBD", "HQ", "PO", "BBQ", "LED", "USB", "WIFI", "NBN"]);

/** Sentences with sweeping claims and no figure to back them, with how many such terms each holds. */
function vagueClaims(paragraphs: string[]): { sentence: string; terms: number }[] {
  const out: { sentence: string; terms: number }[] = [];
  for (const p of paragraphs) {
    for (const sentence of p.split(/(?<=[.!?])\s+/)) {
      if (/\d/.test(sentence)) continue;
      const terms = [...sentence.matchAll(VAGUE)].length;
      if (terms > 0) out.push({ sentence, terms });
    }
  }
  return out;
}
const vagueTermCount = (paragraphs: string[]) => vagueClaims(paragraphs).reduce((n, c) => n + c.terms, 0);

/** Acronyms used at least twice and never spelled out in the text. */
function undefinedAcronyms(text: string): string[] {
  const counts = new Map<string, number>();
  for (const m of text.matchAll(/\b[A-Z]{2,6}\b/g)) counts.set(m[0], (counts.get(m[0]) ?? 0) + 1);
  return [...counts]
    .filter(([a, n]) => n >= 2 && !COMMON_ACRONYMS.has(a) && !new RegExp(`\\(${a}\\)|${a}\\s*\\(`).test(text))
    .map(([a]) => a);
}

const sentences = (text: string) => text.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);

function factsIn(text: string): string[] {
  const found = new Set<string>();
  for (const m of text.matchAll(FACT)) {
    const f = m[0].trim();
    if (!NOT_A_FACT.test(f)) found.add(f.toLowerCase());
  }
  return [...found];
}

interface PageEval {
  a: PageAnalysis;
  states: Record<PageCriterion, CriterionState>;
  gapTypes: string[];
  longParagraphs: string[];
}

function evaluate(a: PageAnalysis, entity: string | null, isHome: boolean, fit: { detected: string[]; gaps: { type: string }[] }): PageEval {
  const substantive = a.paragraphs.filter((p) => wordCount(p) >= SUBSTANTIVE_WORDS);
  const states = {} as Record<PageCriterion, CriterionState>;
  const judge = a.words >= MIN_WORDS_TO_JUDGE;

  states["entity-early"] = isHome && entity ? (substantive[0]?.toLowerCase().includes(entity.toLowerCase()) ? "pass" : "fail") : "n/a";

  if (isHome) {
    const head = substantive.slice(0, 2);
    const says = head.some((p) => sentences(p).some((s) => DEFINING.test(s) && (Boolean(entity && s.toLowerCase().includes(entity.toLowerCase())) || /\b(we|our|i|my)\b/i.test(s))));
    states.definition = says ? "pass" : "fail";
  } else states.definition = "n/a";

  // Words in real paragraphs. A product grid or a menu has many words and almost no prose, so it is
  // judged on neither passage length nor structure: there is no essay to restructure.
  const proseWords = a.paragraphs.reduce((n, p) => n + wordCount(p), 0);
  const hasProse = proseWords >= MIN_WORDS_TO_JUDGE;
  if (judge && hasProse) {
    const lengths = a.paragraphs.map(wordCount);
    states["answer-passage"] = lengths.some((n) => n >= IDEAL_MIN && n <= IDEAL_MAX) ? "pass" : lengths.some((n) => n >= QUOTABLE_MIN && n <= QUOTABLE_MAX) ? "partial" : "fail";
    // Figures are about the business itself, so only the homepage is held to them.
    states.facts = !isHome ? "n/a" : factsIn([...a.paragraphs, ...a.headings.map((h) => h.text)].join(" ")).length >= 3 ? "pass" : "fail";
  } else {
    states["answer-passage"] = "n/a";
    states.facts = "n/a";
  }

  const long = a.paragraphs.filter((p) => wordCount(p) > QUOTABLE_MAX);
  const sections = a.headings.filter((h) => h.level === 2 || h.level === 3).length;
  states.structure = judge && hasProse ? (long.length > 0 || (proseWords >= 400 && sections < 2) ? "fail" : "pass") : "n/a";

  if (judge) {
    states.clarity = vagueTermCount(a.paragraphs) >= 3 || undefinedAcronyms(a.paragraphs.join(" ")).length >= 2 ? "fail" : "pass";
  } else states.clarity = "n/a";

  states["schema-fit"] = fit.detected.length === 0 ? "n/a" : fit.gaps.length === 0 ? "pass" : "fail";
  // Citing sources is expected of articles and guides, not of a shop front or a contact page.
  // Product cards are often <article> elements too, so one or two of them is an article and forty is a grid.
  const articleTags = (a.html.match(/<article[\s>]/gi) ?? []).length;
  const articleLike = (articleTags >= 1 && articleTags <= 2) || a.schemaTypes.some((t) => /Article|BlogPosting/.test(t));
  states.authority = a.words >= 300 && articleLike ? (a.externalDomains.length >= 2 ? "pass" : "fail") : "n/a";

  return { a, states, gapTypes: fit.gaps.map((g) => g.type), longParagraphs: long };
}

function pageScore(states: Record<PageCriterion, CriterionState>): number | null {
  let total = 0;
  let earned = 0;
  for (const id of Object.keys(PAGE_WEIGHTS) as PageCriterion[]) {
    const s = states[id];
    if (s === "n/a") continue;
    total += PAGE_WEIGHTS[id];
    earned += s === "pass" ? PAGE_WEIGHTS[id] : s === "partial" ? PAGE_WEIGHTS[id] / 2 : 0;
  }
  return total === 0 ? null : Math.round((earned / total) * 100);
}

export function runCitationChecks(s: SiteSnapshot, signals: AuthoritySignals | null = null): { outcomes: CheckOutcome[]; insights: CitationInsights } {
  const entity = siteEntity(s);
  const fits = schemaFit(s);
  const evals = [s.home, ...s.pages].map((res, i) => evaluate(analysePage(res.finalUrl, res.body), entity, i === 0, fits[i] ?? { detected: [], gaps: [] }));
  const outcomes: CheckOutcome[] = [];

  const finding = (id: PageCriterion, severity: Finding["severity"], effort: Finding["effort"], f: Pick<Finding, "title" | "detail" | "fix" | "evidence">): Finding =>
    ({ id: `citation:${id}`, module: "citation", severity, effort, ...f });

  for (const id of Object.keys(PAGE_WEIGHTS) as PageCriterion[]) {
    const applicable = evals.filter((e) => e.states[id] !== "n/a");
    if (applicable.length === 0) continue;
    const share = applicable.reduce((n, e) => n + (e.states[id] === "pass" ? 1 : e.states[id] === "partial" ? 0.5 : 0), 0) / applicable.length;
    const weight = PAGE_WEIGHTS[id];
    if (share === 1) {
      outcomes.push({ id, weight, passed: true });
      continue;
    }
    let failing = applicable.filter((e) => e.states[id] !== "pass");
    if (id === "answer-passage") {
      // A passage that can be quoted but is not the ideal length costs score and raises no finding. A
      // homepage with nothing quotable is already reported by geo:citable-passage, so only inner pages are named here.
      failing = failing.filter((e) => e.states[id] === "fail" && e !== evals[0]);
      if (failing.length === 0) {
        outcomes.push({ id, weight, passed: false, credit: share });
        continue;
      }
    }
    const first = failing[0]!;
    const lead = clip(first.a.paragraphs.find((p) => wordCount(p) >= SUBSTANTIVE_WORDS) ?? first.a.h1 ?? "", 160);
    const where = (e: PageEval, note: string, quote?: string) => ({ url: e.a.url, note, ...(quote ? { quote } : {}) });
    const failed = (f: Finding): CheckOutcome => ({ id, weight, passed: false, credit: share, finding: f });

    switch (id) {
      case "entity-early":
        outcomes.push(failed(finding(id, "medium", "low", {
          title: "The opening text never names who this is",
          detail: `An AI answer needs something to attribute. The first paragraph never says the name of the business (${entity ?? "unknown"}), so a quoted passage has no named source.`,
          fix: "Open the homepage with one sentence that names the business, what it does and where it operates.",
          evidence: [where(first, "the first paragraph does not contain the business name", lead || undefined)],
        })));
        break;
      case "definition":
        outcomes.push(failed(finding(id, "medium", "low", {
          title: "No opening sentence says plainly what the business does",
          detail: "Answer engines favour a plain defining sentence (\"X is a ... that ...\") near the top. Without one, they have to infer what the site offers.",
          fix: "Add a one-sentence description near the top: who you are, what you offer and for whom, in plain words.",
          evidence: [where(first, "none of the first paragraphs states what the business does", lead || undefined)],
        })));
        break;
      case "answer-passage":
        outcomes.push(failed(finding(id, "medium", "medium", {
          title: failing.every((e) => e.states[id] === "partial") ? "No passage is the length answer engines lift most often" : "No paragraph is the right length to be quoted",
          detail: `Self-contained passages of about ${IDEAL_MIN} to ${IDEAL_MAX} words are the ones answer engines most often lift whole. A paragraph of ${QUOTABLE_MIN} to ${QUOTABLE_MAX} words can still be quoted. This is a heuristic, not a rule any engine publishes.`,
          fix: `Write at least one self-contained passage of about ${IDEAL_MIN} to ${IDEAL_MAX} words under a heading that states its topic, and make it complete without the text around it.`,
          evidence: failing.slice(0, 3).map((e) => where(e, `longest paragraph is ${Math.max(0, ...e.a.paragraphs.map(wordCount))} words`)),
        })));
        break;
      case "facts":
        outcomes.push(failed(finding(id, "low", "medium", {
          title: "The page states few concrete facts an AI can quote",
          detail: "Numbers with a unit or a noun (years in business, locations, prices, counts) are what get lifted into answers. Fewer than three were found.",
          fix: "State specific, true figures in the copy: how long, how many, how much, where.",
          evidence: failing.slice(0, 3).map((e) => where(e, `${factsIn(e.a.paragraphs.join(" ")).length} concrete figures found`)),
        })));
        break;
      case "structure": {
        const bad = failing.slice(0, 3).flatMap((e) =>
          e.longParagraphs.length > 0
            ? e.longParagraphs.slice(0, 2).map((p) => where(e, `a paragraph of ${wordCount(p)} words with no break`, clip(p, 120)))
            : [where(e, `${e.a.words} words under ${e.a.headings.filter((h) => h.level === 2 || h.level === 3).length} subheadings`)],
        );
        outcomes.push(failed(finding(id, "medium", "medium", {
          title: "Long unbroken text is hard for AI to quote",
          detail: `Paragraphs over ${QUOTABLE_MAX} words, or a long page with almost no subheadings, give an answer engine no clean passage to lift.`,
          fix: "Split long paragraphs, put a descriptive subheading above each idea, and keep each paragraph to one point.",
          evidence: bad.length > 0 ? bad : [where(first, "long unbroken text")],
        })));
        break;
      }
      case "clarity": {
        const evidence = failing.slice(0, 3).flatMap((e) => {
          const claims = vagueClaims(e.a.paragraphs);
          const total = vagueTermCount(e.a.paragraphs);
          const acronyms = undefinedAcronyms(e.a.paragraphs.join(" "));
          return [
            ...(total >= 3 ? claims.slice(0, 2).map((c) => where(e, `${total} sweeping claims with no figure (superlatives)`, clip(c.sentence, 140))) : []),
            ...(acronyms.length >= 2 ? [where(e, `undefined acronyms used more than once: ${acronyms.slice(0, 4).join(", ")}`)] : []),
          ];
        });
        outcomes.push(failed(finding(id, "low", "medium", {
          title: "Vague claims and unexplained terms make the page hard to summarise accurately",
          detail: "Sweeping claims with no figure (\"the best\", \"world-class\") give an answer engine nothing it can state as fact, and acronyms that are never spelled out are easy to misread or drop.",
          fix: "Replace superlatives with a specific, checkable fact, and spell each acronym out in full the first time it appears.",
          evidence: evidence.length > 0 ? evidence : [where(first, "vague claims or undefined terms")],
        })));
        break;
      }
      case "schema-fit": {
        const types = [...new Set(failing.flatMap((e) => e.gapTypes))];
        outcomes.push(failed(finding(id, "high", "medium", {
          title: `${types.join(" and ")} content has no matching structured data`,
          detail: "The page's content is the kind that has a standard schema.org type, but no JSON-LD of that type is present, so machines have to guess its structure.",
          fix: "Add the JSON-LD from the ready-to-paste fixes. Check every value against what visitors see.",
          evidence: failing.slice(0, 3).map((e) => where(e, `content calls for ${e.gapTypes.join(", ") || "structured data"}`)),
        })));
        break;
      }
      case "authority":
        outcomes.push(failed(finding(id, "low", "medium", {
          title: "The page cites no outside sources",
          detail: "Pages that link to named, authoritative sources look more trustworthy to people and to answer engines. Fewer than two outside sites are linked.",
          fix: "Where a claim rests on research or a standard, link to the primary source.",
          evidence: failing.slice(0, 3).map((e) => where(e, `${e.a.externalDomains.length} outside source${e.a.externalDomains.length === 1 ? "" : "s"} linked`)),
        })));
        break;
    }
  }

  // Whether the source is known beyond its own pages. Score only: a small business with no Wikidata entry
  // has nothing to fix on its pages, so no finding is raised. Left out entirely when nothing was measured.
  const known = signals ? isKnownSource(signals) : null;
  if (known !== null) {
    outcomes.push(known ? { id: "external-authority", weight: CITATION_WEIGHTS["external-authority"], passed: true } : { id: "external-authority", weight: CITATION_WEIGHTS["external-authority"], passed: false, credit: 0 });
  }

  const homeEval = evals[0]!;
  const $home = cheerio.load(homeEval.a.html);
  $home("script, style, noscript, template, svg, nav, footer, aside").remove();
  const para = homeEval.a.paragraphs.filter((p) => wordCount(p) >= SUBSTANTIVE_WORDS);
  const definition = para
    .slice(0, 2)
    .flatMap(sentences)
    .find((x) => DEFINING.test(x) && (Boolean(entity && x.toLowerCase().includes(entity.toLowerCase())) || /\b(we|our|i|my)\b/i.test(x)));

  const insights: CitationInsights = {
    pages: evals.map((e) => ({ url: e.a.url, score: pageScore(e.states), criteria: e.states })),
    extractable: {
      entity,
      definition: definition ? clip(definition, 220) : null,
      facts: factsIn(homeEval.a.paragraphs.join(" ")).slice(0, 8),
      questions: faqPairs($home).slice(0, 6).map((p) => ({ q: clip(p.q, 140), a: clip(p.a, 220) })),
    },
    authority: signals,
  };
  return { outcomes, insights };
}
