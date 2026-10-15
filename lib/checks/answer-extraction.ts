import * as cheerio from "cheerio";
import type { SiteSnapshot } from "@/lib/snapshot";
import type { CheckOutcome, CouldntCheck } from "@/lib/pipeline/schemas";
import type { LlmClient } from "@/lib/llm/router";
import { runAiReview, type AiRubricItem } from "./ai-review";

// Two AI reviews of the homepage, both held to the evidence rule every AI claim in SiteRecon meets: an
// answer counts only when it quotes the page, and the model's own wording is never shown.
//
// 1. Answer extraction: could a model lift a who, what, for whom and proof from the page, and could it
//    answer a question about each of the page's own top keywords? An insight, never a score.
// 2. Clarity: vague claims, unexplained terms and unclear references. Each failed answer is a finding
//    with weight 0, so it appears in the report and the plan but cannot move a score.

const STOP = new Set([
  "this", "that", "with", "from", "your", "have", "will", "about", "more", "what", "when", "where", "which", "their", "them", "they", "home",
  "page", "also", "been", "each", "every", "into", "most", "other", "over", "than", "then", "there", "these", "those", "were", "would",
  "while", "such", "only", "very", "just", "like", "make", "made", "many", "much", "some", "same", "here", "does", "doing", "being",
  "ours", "ourselves", "yours", "click", "menu", "search", "contact", "privacy", "policy", "terms", "cookie", "cookies", "login", "cart",
]);

/** The page's most repeated meaningful words: lower case, letters only, so they are safe to put in a prompt. */
export function topKeywords(text: string, limit = 5): string[] {
  const counts = new Map<string, number>();
  for (const w of text.toLowerCase().match(/[a-z]{4,20}/g) ?? []) if (!STOP.has(w)) counts.set(w, (counts.get(w) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, limit).map(([w]) => w);
}

const FACT_QUESTIONS: readonly (AiRubricItem & { label: string })[] = [
  { id: "who", label: "Who", title: "Who is behind the page is not stated", question: "Does the page state plainly who the business, person or organisation is?", detail: "", fix: "" },
  { id: "what", label: "What", title: "What is offered is not stated", question: "Does the page state plainly what the business sells or does?", detail: "", fix: "" },
  { id: "audience", label: "For whom", title: "Who it is for is not stated", question: "Does the page state who the offer is for, or where it operates?", detail: "", fix: "" },
  { id: "proof", label: "Proof", title: "No checkable fact is given", question: "Does the page give at least one specific, checkable fact about the business, such as a number, a date or a place?", detail: "", fix: "" },
];

export interface ExtractionItem {
  id: string;
  label: string;
  kind: "fact" | "keyword";
  extractable: boolean;
  /** A passage copied from the page, as the model quoted it. */
  quote: string;
}

interface Page { url: string; title: string; description: string; h1: string; bodyText: string }

function readPage(s: SiteSnapshot): Page {
  const $ = cheerio.load(s.home.body);
  const title = $("head > title").first().text().replace(/\s+/g, " ").trim();
  const description = ($('meta[name="description" i]').attr("content") ?? "").replace(/\s+/g, " ").trim();
  const h1 = $("h1").first().text().replace(/\s+/g, " ").trim();
  $("script, style, noscript, template, svg").remove();
  return { url: s.home.finalUrl, title, description, h1, bodyText: $("body").text().replace(/\s+/g, " ").trim().slice(0, 6000) };
}

export async function runAnswerExtraction(
  s: SiteSnapshot,
  llm: LlmClient | null,
  signal?: AbortSignal,
): Promise<{ items: ExtractionItem[]; couldntCheck: CouldntCheck[] }> {
  if (!llm) return { items: [], couldntCheck: [{ what: "Answer extraction simulation", why: "no AI service is configured" }] };
  if (signal?.aborted) return { items: [], couldntCheck: [{ what: "Answer extraction simulation", why: "the time allowed for the AI reviews ran out" }] };
  const page = readPage(s);

  // Keywords are taken from the page, but reduced to lower-case letters, so they cannot carry an instruction.
  const keywords = topKeywords(`${page.title} ${page.h1} ${page.h1} ${page.bodyText}`, 4);
  const rubric: (AiRubricItem & { label: string; kind: ExtractionItem["kind"] })[] = [
    ...FACT_QUESTIONS.map((q) => ({ ...q, kind: "fact" as const })),
    ...keywords.map((k, i) => ({
      id: `kw-${i + 1}`, label: k, kind: "keyword" as const, title: `Nothing quotable about "${k}"`,
      question: `Does the page say something specific about "${k}" that could be quoted as an answer to a question about it?`, detail: "", fix: "",
    })),
  ];

  const review = await runAiReview({
    module: "citation",
    rubric,
    weight: 1,
    subject: "answer extraction",
    intro: "You act as an AI answer engine deciding whether you could quote this page to answer someone asking about the business.",
    page,
    llm,
    signal,
  });

  const items: ExtractionItem[] = review.outcomes.flatMap((o) => {
    const q = rubric.find((r) => r.id === o.id);
    const quote = o.passed ? (o.quote ?? "") : (o.finding?.evidence[0]?.quote ?? "");
    return q ? [{ id: o.id, label: q.label, kind: q.kind, extractable: o.passed, quote }] : [];
  });
  return { items, couldntCheck: review.couldntCheck };
}

const CLARITY_RUBRIC: readonly AiRubricItem[] = [
  {
    id: "ambiguous-claims", title: "Some claims are too vague for an AI to state as fact",
    question: "Are the page's claims specific enough to state as fact (they name what, how much or how often), with no vague claim that depends on context the page does not give?",
    detail: "Answer engines repeat what a page says. A claim such as \"for many years\" or \"great results\" has no checkable content, so it is skipped or paraphrased into something the page never said. The review pointed at a passage like this.",
    fix: "Replace the vague claim with the specific fact behind it: the number, the date, the place or the named result.",
  },
  {
    id: "undefined-terms", title: "A key term is used without being explained",
    question: "Are the page's key terms, product names and jargon explained or obvious from context, so a reader who has never heard of the business would understand them?",
    detail: "A term the page never explains forces an answer engine to guess what it means, and it may guess wrong. The review pointed at a passage that relies on an unexplained term.",
    fix: "Define the term in a short sentence the first time it appears, or replace it with the plain words for it.",
  },
  {
    id: "unclear-reference", title: "The page leans on words that point at something missing",
    question: "Does each passage make sense on its own, without relying on words like \"this\", \"it\" or \"here\" that refer to something not stated in the same passage?",
    detail: "AI systems lift single passages out of a page. A passage that depends on text elsewhere (\"this is why\", \"as shown above\") loses its meaning once lifted. The review pointed at such a passage.",
    fix: "Make each key passage complete in itself by naming the subject instead of pointing at it.",
  },
];

/** Findings for vague claims, unexplained terms and unclear references. Every outcome has weight 0: it shows, it never scores. */
export async function runClarityReview(
  s: SiteSnapshot,
  llm: LlmClient | null,
  signal?: AbortSignal,
): Promise<{ outcomes: CheckOutcome[]; couldntCheck: CouldntCheck[] }> {
  if (!llm) return { outcomes: [], couldntCheck: [{ what: "AI review of clarity", why: "no AI service is configured" }] };
  if (signal?.aborted) return { outcomes: [], couldntCheck: [{ what: "AI review of clarity", why: "the time allowed for the AI reviews ran out" }] };
  return runAiReview({
    module: "citation",
    rubric: CLARITY_RUBRIC,
    weight: 0,
    subject: "clarity",
    intro: "You review a web page the way an AI answer engine would, checking whether its passages could be quoted accurately.",
    page: readPage(s),
    llm,
    signal,
  });
}
