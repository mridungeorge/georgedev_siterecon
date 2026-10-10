import * as cheerio from "cheerio";
import type { SiteSnapshot } from "@/lib/snapshot";
import type { CheckOutcome, CouldntCheck } from "@/lib/pipeline/schemas";
import { countInjectionAttempts } from "@/lib/injection";
import type { LlmClient } from "@/lib/llm/router";
import { clip, makeChecker } from "./helpers";
import { readingEase } from "./readability";
import { runAiReview } from "./ai-review";

// Content and conversion. 80 of the 100 weight is deterministic. The AI review can move at
// most 20 points, and only with evidence: every answer, pass or fail, must quote a specific
// passage that is really on the page. The model's own wording is never shown to the visitor
// or put in the fix prompt, and the severity it can assign is capped. A model's opinion
// without evidence is dropped, never scored.

export interface ContentResult {
  outcomes: CheckOutcome[];
  couldntCheck: CouldntCheck[];
  injectionFlags: number;
}

export const RUBRIC = [
  { id: "value-prop", title: "The homepage does not make its value clear",
    question: "Within the first screen, can a visitor tell what the business offers and why it is worth choosing?",
    detail: "A visitor should understand within seconds what the business offers and why to choose it. The review found the opening copy unclear on this.",
    fix: "Rewrite the headline and opening paragraph so they state what you offer, who it is for and the main benefit." },
  { id: "audience", title: "The homepage does not say who it is for",
    question: "Is it clear who the product or service is for?",
    detail: "Visitors stay when they can see the page is meant for them. The review found the intended customer unclear.",
    fix: "Name the customers you serve, for example small households, tradies or restaurants, in the headline or first paragraph." },
  { id: "cta-clarity", title: "The next step is not clear",
    question: "Is there one clear next step, worded as a specific action rather than Submit or Click here?",
    detail: "Pages convert better with one obvious next step worded as a specific action. The review found the next step unclear.",
    fix: "Use one primary button with a specific action label such as Get a free quote, and repeat it down the page." },
  { id: "differentiation", title: "Nothing concrete sets the business apart",
    question: "Does the page say what makes the business different from the alternatives, with something concrete rather than just quality or best?",
    detail: "Claims like quality and best do not persuade. The review found nothing concrete that sets the business apart.",
    fix: "Add one concrete difference: a number, guarantee, method or result that competitors cannot easily claim." },
] as const;

const words = (s: string) => s.split(/\s+/).filter(Boolean).length;

const CTA_WORDS = /\b(buy|shop|get|start|try|book|contact|call|request|sign ?up|subscribe|order|download|learn more|quote|enquire|inquire|schedule|join|apply|reserve|add to cart)\b/i;
const TRUST_WORDS = /\b(reviews?|testimonials?|trusted|rated|ratings?|stars?|guarantee[ds]?|customers|clients|awards?|certified|accredited|loved by|\d+ years|years of|since \d{4}|locals)\b/i;
const CONTACT_TEXT = /\b(contact|get in touch|enquir\w*|inquir\w*|reach us|talk to us|call us|email us|visit us)\b/i;
const CONTACT_HREF = /(contact|touch|enquir|inquir)/i;
const NAV_LINKS = 'nav a, header a, [role="navigation"] a, [class*="menu"] a, [class*="nav"] a, [id*="menu"] a, [id*="nav"] a';
const ABOUT_HREF = /(about|our-story|who-we-are|\bteam\b|\/company)/i;
const ABOUT_TEXT = /\b(about|our story|who we are|meet the team|our team|the team)\b/i;
const PRIVACY = /privacy/i;
const COPYRIGHT = /(?:©|copyright)\s*(?:\(c\)\s*)?(\d{4})(?:\s*[-–—]\s*(\d{4}))?/gi;
const MIN_COPY_WORDS = 300;
const MIN_PROSE_WORDS = 100;
const MIN_READING_EASE = 50;

export async function runContentChecks(s: SiteSnapshot, llm: LlmClient | null, signal?: AbortSignal): Promise<ContentResult> {
  const { outcomes, check } = makeChecker("content");
  const couldntCheck: CouldntCheck[] = [];
  const url = s.home.finalUrl;
  const at = (note: string, quote?: string) => [{ url, note, ...(quote ? { quote: clip(quote) } : {}) }];

  const $ = cheerio.load(s.home.body);
  $("script, style, noscript, template, svg").remove();
  // Keep neighbouring blocks apart, otherwise "Heading" and "Paragraph" glue into "HeadingParagraph".
  $("p, div, li, h1, h2, h3, h4, h5, h6, section, article, header, footer, nav, td, th, tr, br, a, button, span").after(" ");
  const bodyText = $("body").text().replace(/\s+/g, " ").trim();
  const title = $("head > title").first().text().replace(/\s+/g, " ").trim();
  const description = ($('meta[name="description" i]').attr("content") ?? "").replace(/\s+/g, " ").trim();
  const h1El = $("h1").first();
  // A logo image inside the headline is a normal way to write one, so its alt text counts.
  const h1 = (h1El.text().replace(/\s+/g, " ").trim() || (h1El.find("img").first().attr("alt") ?? "")).trim();

  const actions = $("a, button").filter((_, el) => {
    const text = $(el).text().replace(/\s+/g, " ").trim();
    return text.length > 0 && text.length <= 40 && CTA_WORDS.test(text);
  });
  check("cta-present", 18,actions.length > 0, {
    severity: "high", effort: "low",
    title: "The homepage has no clear call to action",
    detail: "Visitors need an obvious next step such as Get a quote, Book a call or Shop now. Without one, interested visitors leave.",
    fix: "Add a button or link with a specific action label above the fold, and repeat it further down the page.",
    evidence: at("no button or link with an action label such as Get, Book, Shop or Contact"),
  });

  const h1Words = words(h1);
  check("headline-clear", 10,h1Words >= 3 && h1Words <= 20, {
    severity: "medium", effort: "low",
    title: h1 ? "The main headline is too short or too long to be clear" : "The homepage has no main headline",
    detail: "A good headline says in one line what the business offers. Very short or very long headlines rarely do.",
    fix: "Write a headline of roughly 5 to 15 words that states what you offer and who it is for.",
    evidence: at(h1 ? `main headline is ${h1Words} words` : "no <h1> found", h1),
  });

  const contactLinks = $("a").filter((_, el) => {
    const href = $(el).attr("href") ?? "";
    return /^(tel:|mailto:)/i.test(href) || CONTACT_HREF.test(href) || CONTACT_TEXT.test($(el).text());
  });
  check("contact-info", 10,contactLinks.length > 0, {
    severity: "medium", effort: "low",
    title: "There is no easy way to contact the business",
    detail: "A phone number, email link or contact page builds trust and gives ready-to-buy visitors a way in.",
    fix: "Add a visible phone number or email link in the header or footer, and link to a contact page.",
    evidence: at("no tel:, mailto: or contact link found"),
  });

  check("trust-signals", 8,TRUST_WORDS.test(bodyText), {
    severity: "medium", effort: "medium",
    title: "The homepage shows no social proof",
    detail: "Reviews, customer numbers, awards or guarantees reduce the perceived risk of buying.",
    fix: "Add customer reviews, a rating, a customer count or a guarantee near the main call to action.",
    evidence: at("no words such as reviews, testimonials, rated, guarantee or customers on the page"),
  });

  const navLinks = $(NAV_LINKS).length;
  check("navigation", 10,navLinks >= 3, {
    severity: "medium", effort: "low",
    title: "The homepage has little or no navigation",
    detail: "Visitors who do not buy straight away need clear paths to products, pricing and information.",
    fix: "Add a header menu with at least three links such as Products, About and Contact.",
    evidence: at(`${navLinks} links found in the header or menu`),
  });

  // ---- Who is behind the site, and does it look looked after? None of this needs an AI ----
  const links = $("a")
    .map((_, el) => ({ href: $(el).attr("href") ?? "", text: $(el).text().replace(/\s+/g, " ").trim() }))
    .get();
  // Only the site's own pages count: a LinkedIn "company" page or another site's /about says nothing about this one.
  const siteHost = new URL(url).hostname.replace(/^www\./, "");
  const isOwn = (href: string) => {
    try {
      return new URL(href, url).hostname.replace(/^www\./, "") === siteHost;
    } catch {
      return false;
    }
  };
  check("about-page", 6, links.some((l) => isOwn(l.href) && (ABOUT_HREF.test(l.href) || ABOUT_TEXT.test(l.text))), {
    severity: "low", effort: "low",
    title: "Nothing on the homepage says who is behind the business",
    detail: "Visitors, Google and AI systems look for an About page or a team to decide whether a business is real and who stands behind it. Google's quality guidelines call this trust.",
    fix: "Add an About page with who runs the business, how long it has operated and where, and link to it from the header or footer.",
    evidence: at(`${links.length} links found, none to an about, team or company-story page`),
  });
  check("policy-pages", 6, links.some((l) => PRIVACY.test(l.href) || PRIVACY.test(l.text)), {
    severity: "medium", effort: "low",
    title: "There is no link to a privacy policy",
    detail: "A privacy policy is expected by visitors, by Google for sites that collect any data, and by Australian law for most businesses. Its absence is a trust signal against the site.",
    fix: "Publish a privacy policy and link to it from the footer of every page.",
    evidence: at("no link with privacy in its address or its text"),
  });

  // The copy a visitor reads: everything except menus, footers and sidebars.
  const copy = cheerio.load(s.home.body);
  copy("script, style, noscript, template, svg, nav, footer, aside, [role=\"navigation\"]").remove();
  copy("p, div, li, h1, h2, h3, h4, h5, h6, section, article, td, th, br").after(" ");
  const copyWords = words(copy("body").text().replace(/\s+/g, " ").trim());
  check("content-depth", 4, copyWords >= MIN_COPY_WORDS, {
    severity: "low", effort: "medium",
    title: `The homepage has only ${copyWords} words of copy`,
    detail: "Search engines and AI systems have little to understand or quote from a page with this little text. A homepage that explains what the business does, for whom and why usually needs 300 words or more.",
    fix: "Add copy that explains what you offer, who it is for, how it works, what it costs or how to start, and answers the questions customers ask most.",
    evidence: at(`${copyWords} words of copy outside the menu and footer (300 or more is a healthy minimum)`),
  });

  const prose = copy("p").map((_, el) => copy(el).text().replace(/\s+/g, " ").trim()).get().join(" ");
  const read = readingEase(prose);
  check("readability", 4, read === null || read.words < MIN_PROSE_WORDS || read.ease >= MIN_READING_EASE, {
    severity: "low", effort: "medium",
    title: "The copy is hard to read",
    detail: `The reading ease score is ${read?.ease ?? "n/a"}. Most customers read at around a school-year-nine level, and scores below ${MIN_READING_EASE} mean long sentences and long words that lose them. Plain English converts better.`,
    fix: "Shorten sentences to about 15 words, replace long words with short ones, and write the way you would explain it to a customer in person.",
    evidence: at(`reading ease ${read?.ease ?? "n/a"} over ${read?.words ?? 0} words of paragraph text (${MIN_READING_EASE} or more is easy to read)`),
  });

  const year = new Date(s.fetchedAt).getUTCFullYear();
  const years = [...bodyText.matchAll(COPYRIGHT)].flatMap((m) => [Number(m[1]), m[2] ? Number(m[2]) : 0]);
  const newest = years.length > 0 ? Math.max(...years) : null;
  check("copyright-year", 4, newest === null || newest >= year - 1, {
    severity: "low", effort: "low",
    title: `The footer says © ${newest}`,
    detail: "An out-of-date copyright year is the most visible sign of a site nobody looks after. It costs trust with visitors and with anyone judging whether the business is still operating.",
    fix: `Update the notice to the current year, or write it so that it updates itself (for example ${year} from the server's date).`,
    evidence: at(`the newest year in the copyright notice is ${newest}, and the page was read in ${year}`),
  });

  const injectionFlags = countInjectionAttempts([title, description, h1, bodyText].join(" "));

  if (!llm) {
    couldntCheck.push({ what: "AI review of the page copy", why: "no AI provider is available" });
    return { outcomes, couldntCheck, injectionFlags };
  }

  // The AI part only counts when it quotes the page; see ai-review.ts.
  const ai = await runAiReview({
    module: "content", rubric: RUBRIC, weight: 5, subject: "the page copy",
    intro: "You review the homepage copy of a website for a marketing audit.",
    page: { url, title, description, h1, bodyText }, llm, signal,
  });
  outcomes.push(...ai.outcomes);
  couldntCheck.push(...ai.couldntCheck);
  return { outcomes, couldntCheck, injectionFlags };
}
