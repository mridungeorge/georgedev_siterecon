import * as cheerio from "cheerio";
import type { SiteSnapshot } from "@/lib/snapshot";
import type { CheckOutcome, CouldntCheck } from "@/lib/pipeline/schemas";
import type { LlmClient } from "@/lib/llm/router";
import { clip, makeChecker } from "./helpers";
import { nodesOfType, readJsonLd } from "./jsonld";
import { runAiReview } from "./ai-review";

// Marketing. What an agency looks at beyond the words: can the business measure what works, capture a
// lead, show what it costs, publish content, prove its claims and be reached. 70 of the 100 weight is
// read straight from the page's own HTML, with no AI. Detection looks at script sources, attributes and
// visible text separately, so a page that merely mentions "Google Analytics" in its copy cannot pass.

export interface MarketingResult {
  outcomes: CheckOutcome[];
  couldntCheck: CouldntCheck[];
  injectionFlags: number;
}

const ANALYTICS: [name: string, pattern: RegExp][] = [
  ["Google Analytics or Tag Manager", /googletagmanager\.com|google-analytics\.com|\bgtag\s*\(|GoogleAnalyticsObject/i],
  ["Meta (Facebook) Pixel", /connect\.facebook\.net\/[^'"]*fbevents|\bfbq\s*\(/i],
  ["Plausible", /plausible\.io\/js/i],
  ["Fathom", /usefathom\.com/i],
  ["Matomo", /matomo|_paq\.push/i],
  ["Hotjar", /hotjar\.com/i],
  ["Microsoft Clarity", /clarity\.ms/i],
  ["LinkedIn Insight Tag", /snap\.licdn\.com|_linkedin_partner_id/i],
  ["TikTok Pixel", /analytics\.tiktok\.com/i],
  ["Segment, PostHog or Mixpanel", /cdn\.segment\.com|posthog|mixpanel/i],
  ["Vercel Analytics", /_vercel\/(insights|speed-insights)/i],
  ["Cloudflare Web Analytics", /static\.cloudflareinsights\.com/i],
];

const LEAD_SERVICES = /calendly\.com|cal\.com|typeform\.com|tally\.so|meetings\.hubspot|hubspot\.com\/meetings|jotform|formspree|mailchi\.mp|list-manage\.com|klaviyo|convertkit|substack\.com|getresponse|acuityscheduling|setmore|squareup\.com\/appointments|bookings\.|\/book(ing)?\b/i;
const FORM_FIELD = /e-?mail|newsletter|subscribe|phone|mobile|\btel\b/i;
// A price needs a currency sign or word: "from over 800 reviews" and "from 1990" are not offers.
const OFFER = /(\$|£|€)\s?\d|\b\d[\d,.]*\s?(dollars|aud|usd|gbp|eur|nzd)\b|\b\d+\s?%\s?off\b|\bfree\s+(quote|trial|shipping|delivery|consultation|estimate|assessment|returns|installation|demo)\b|\bpricing\b|\bsale\b/i;
const OFFER_LINK = /pricing|plans|packages/i;
const HUB_HREF = /\/(blog|news|articles?|resources?|guides?|insights?|journal|stories|learn|case-stud(y|ies)|library|knowledge|tips)(\/|$|\?|#)/i;
const HUB_TEXT = /^(blog|news|articles?|resources?|guides?|insights?|journal|stories|learn)$/i;
const REVIEW_WIDGET = /trustpilot|yotpo|reviews\.io|feefo|bazaarvoice|judge\.me|stamped\.io|okendo|loox|birdeye|podium|reviews-widget|elfsight/i;
const RISK_REVERSAL = /money[- ]back|guarantee[ds]?|warranty|no[- ]obligation|free returns|easy returns|cancel any ?time|risk[- ]free|satisfaction|refund|free consultation|free quote|\b\d+[- ]day (trial|return|money)/i;
const PROOF_NUMBER = /\b\d[\d,.]*\+?\s?(k|m)?\s*(customers?|clients?|reviews?|ratings?|stars?|projects?|users?|members?|stores?|locations?|years?|orders?|businesses|families|students|patients|installations?|jobs?|companies)\b/i;
const PROOF_SCORE = /\b\d(\.\d)?\s*(\/|out of)\s*5\b/i;
const PROOF_SINCE = /\b(since|established|founded|est\.?)\s*(in\s*)?(19|20)\d\d\b/i;
const CHAT_WIDGET = /tawk\.to|intercom|drift\.com|crisp\.chat|livechatinc|zdassets|zendesk|tidio|freshchat|olark|hs-scripts\.com/i;
const MESSAGING_LINK = /wa\.me|api\.whatsapp\.com|m\.me\/|messenger\.com/i;
const CONTACT_LINK = /contact|get-in-touch|enquir|inquir/i;

/**
 * The messaging review. Six questions an agency asks of the copy, each worth five points (30 in all).
 * Like the content review, an answer only counts when it quotes the page, and the wording in the report
 * is ours, never the model's.
 */
export const MARKETING_RUBRIC = [
  { id: "benefits-first", title: "The copy talks about the business, not what the customer gets",
    question: "Does the copy lead with what the customer gains (outcomes and benefits) rather than listing features or the company's own history?",
    detail: "People buy outcomes. Copy that opens with the company's history or a list of features makes the visitor work out what is in it for them, and most will not. The review found the copy centred on the business.",
    fix: "Rewrite the opening so each line says what the customer gets: save time, save money, avoid a problem, get a result. Keep features as the proof underneath." },
  { id: "customer-problem", title: "The page never names the problem it solves",
    question: "Does the page name the customer's problem or frustration before offering the solution?",
    detail: "Visitors respond when they see their own problem described accurately, because it shows the business understands them. The review found no clear statement of the problem being solved.",
    fix: "Add one or two sentences near the top that describe the problem in the customer's own words, then introduce your offer as the answer." },
  { id: "objections", title: "Likely doubts are not answered near the call to action",
    question: "Does the page answer the doubts a buyer is likely to have (price, risk, time, quality) close to its main call to action?",
    detail: "Every buyer has a reason to hesitate. When the page leaves those doubts unanswered at the moment of decision, many leave to think about it and never return. The review found the likely doubts unaddressed.",
    fix: "List the three questions customers ask before buying, and answer each in a line or two next to the main button, or in a short FAQ right above it." },
  { id: "next-step-reward", title: "It is not clear what happens after the visitor takes the next step",
    question: "Is it clear what the visitor gets, and how soon, when they take the main next step?",
    detail: "A button is easier to press when the result is clear: 'Get your quote in 24 hours' beats 'Submit'. The review found the outcome of the next step unclear.",
    fix: "Reword the main button and the line beside it to say what the visitor receives and how quickly, for example 'Get a free quote, reply within 24 hours'." },
  { id: "message-focus", title: "The page makes too many competing points",
    question: "Does the first screen carry one main message, rather than several competing ones?",
    detail: "When the top of the page makes five points at once, none of them lands. The review found no single main message.",
    fix: "Choose the one thing a new visitor must remember, put it in the headline, and move the rest further down the page." },
  { id: "voice", title: "The writing is vague or full of filler",
    question: "Is the writing specific and in plain language that suits the intended customer, rather than vague, jargon-heavy or full of filler?",
    detail: "Vague words such as 'solutions', 'innovative' and 'world-class' say nothing a competitor could not say. The review found the writing vague for its audience.",
    fix: "Replace each vague phrase with a specific fact, number or example, and write the way your customers talk." },
] as const;

export async function runMarketingChecks(s: SiteSnapshot, llm: LlmClient | null, signal?: AbortSignal): Promise<MarketingResult> {
  const { outcomes, check } = makeChecker("marketing");
  const couldntCheck: CouldntCheck[] = [];
  const url = s.home.finalUrl;
  const at = (note: string, quote?: string) => [{ url, note, ...(quote ? { quote: clip(quote) } : {}) }];

  const $ = cheerio.load(s.home.body);
  const blocks = readJsonLd($);

  // The code a browser would run, the attributes that name widgets, and the words a visitor reads, kept apart.
  const scriptText = $("script")
    .map((_, el) => `${$(el).attr("src") ?? ""} ${$(el).text()}`)
    .get()
    .join("\n");
  const noscriptHtml = $("noscript").map((_, el) => $(el).html() ?? "").get().join("\n");
  const attributeText = $("[src],[href],[class],[id],[action]")
    .map((_, el) => ["src", "href", "class", "id", "action"].map((a) => $(el).attr(a) ?? "").join(" "))
    .get()
    .join("\n");
  const siteHost = new URL(url).hostname.replace(/^www\./, "");
  const links = $("a")
    .map((_, el) => ({ href: $(el).attr("href") ?? "", text: $(el).text().replace(/\s+/g, " ").trim() }))
    .get();
  const isOwn = (href: string) => {
    try {
      return new URL(href, url).hostname.replace(/^www\./, "") === siteHost;
    } catch {
      return false;
    }
  };
  const textOnly = cheerio.load(s.home.body);
  textOnly("script, style, noscript, template, svg").remove();
  textOnly("p, div, li, h1, h2, h3, h4, h5, h6, section, article, td, th, br, a, button, span, blockquote").after(" ");
  const bodyText = textOnly("body").text().replace(/\s+/g, " ").trim();

  // ---- Can the business measure what its marketing does? ----
  const found = ANALYTICS.filter(([, re]) => re.test(scriptText) || re.test(noscriptHtml)).map(([name]) => name);
  check("analytics", 10, found.length > 0, {
    severity: "medium", effort: "low",
    title: "No analytics or advertising tag was found on the homepage",
    detail: "Without a measurement tag the business cannot tell which marketing brings visitors, which pages convert, or whether a change helped. Advertising pixels (Meta, Google, LinkedIn) also need to be installed before ads can be targeted or measured. A tag added only after cookie consent may not show in the page source.",
    fix: "Install one analytics tool (Google Analytics 4, Plausible or Fathom are all free or cheap), set up conversion events for the key actions, and add any advertising pixels you plan to use.",
    evidence: at("no Google Analytics, Tag Manager, Meta Pixel, Plausible, Hotjar or similar tag in the page source"),
  });

  // ---- Can a visitor who is not ready to buy leave something behind? ----
  const forms = $("form").filter((_, el) => {
    const form = $(el);
    if (form.attr("role") === "search" || form.find('input[type="search"]').length > 0) return false;
    return form.find("input, select, textarea").filter((__, f) => {
      const field = $(f);
      return /^(email|tel)$/i.test(field.attr("type") ?? "") || FORM_FIELD.test(`${field.attr("name") ?? ""} ${field.attr("id") ?? ""} ${field.attr("placeholder") ?? ""} ${field.attr("aria-label") ?? ""}`);
    }).length > 0;
  });
  const leadLinks = links.filter((l) => LEAD_SERVICES.test(l.href));
  check("lead-capture", 12, forms.length > 0 || leadLinks.length > 0, {
    severity: "medium", effort: "medium",
    title: "A visitor cannot leave an email address or book from the homepage",
    detail: "Most visitors are not ready to buy on the first visit. A way to leave an email, book a call or request a quote turns some of them into leads you can follow up, instead of losing every one who is not ready today.",
    fix: "Add one low-commitment option near the top: a newsletter or offer sign-up with an email field, a booking link, or a short quote request form.",
    evidence: at("no form with an email or phone field, and no booking or sign-up link"),
  });

  // ---- Does it say what it costs, or what the offer is? ----
  const offerLinks = links.filter((l) => isOwn(l.href) && (OFFER_LINK.test(l.href) || OFFER_LINK.test(l.text)));
  check("offer-clarity", 10, OFFER.test(bodyText) || offerLinks.length > 0, {
    severity: "medium", effort: "low",
    title: "Nothing on the homepage says what it costs or what the offer is",
    detail: "Visitors who cannot see a price, a starting price or a clear offer assume the worst, or leave to find a competitor who shows one. Even a range, or 'free quote within 24 hours', does better than silence.",
    fix: "State a starting price, a range, or a concrete offer (free quote, free delivery over an amount, a first-order discount), or link prominently to a pricing page.",
    evidence: at("no price, discount, free offer or pricing link found"),
  });

  // ---- Does the business publish anything? ----
  const hubLinks = links.filter((l) => isOwn(l.href) && (HUB_HREF.test(l.href) || HUB_TEXT.test(l.text)));
  check("content-hub", 8, hubLinks.length > 0, {
    severity: "low", effort: "high",
    title: "The homepage links to no blog, guides or other content",
    detail: "Useful content is how most small businesses are found by people who are not yet searching for them by name, and how they earn links and shares. A site with none relies entirely on paid reach and word of mouth.",
    fix: "Start a small content hub: answer the five questions customers ask most as guides or posts, link it from the header, and share each one on your social profiles.",
    evidence: at("no link to a blog, news, guides, resources or case studies page"),
  });

  // ---- Are the reviews machine-readable? ----
  const reviewNodes = nodesOfType(blocks, new Set(["AggregateRating", "Review"]));
  check("reviews-markup", 8, reviewNodes.length > 0 || REVIEW_WIDGET.test(attributeText) || REVIEW_WIDGET.test(scriptText), {
    severity: "low", effort: "medium",
    title: "Reviews and ratings are not marked up where search engines and AI can read them",
    detail: "A rating that exists only as words in a paragraph cannot earn star ratings in search results, and AI answer engines cannot reliably quote it. Review markup, or a review widget that adds it, makes the same proof visible to machines.",
    fix: "Add AggregateRating (or Review) structured data fed by your real reviews, or install a review service such as Trustpilot or Google reviews with its widget.",
    evidence: at("no AggregateRating or Review structured data, and no review widget"),
  });

  // ---- Is there anything that lowers the risk of buying? ----
  check("risk-reversal", 8, RISK_REVERSAL.test(bodyText), {
    severity: "low", effort: "low",
    title: "Nothing on the homepage lowers the buyer's risk",
    detail: "A guarantee, free returns, a no-obligation quote or a free trial removes the main reason people hesitate. It is one of the cheapest ways to raise conversion.",
    fix: "Offer and state one risk-reducer in plain words next to your main call to action: a money-back guarantee, free returns, a no-obligation quote or a free consultation.",
    evidence: at("no guarantee, refund, warranty, free returns, trial or no-obligation wording found"),
  });

  // ---- Is the proof specific? ----
  const testimonials = $("blockquote, [class*='testimonial']").length;
  check("specific-proof", 8, PROOF_NUMBER.test(bodyText) || PROOF_SCORE.test(bodyText) || PROOF_SINCE.test(bodyText) || testimonials > 0, {
    severity: "medium", effort: "medium",
    title: "The social proof is general, not specific",
    detail: "'Trusted by happy customers' persuades nobody. Numbers (12,000 customers, 4.8 out of 5, since 2004), named testimonials and real results are believed far more, and they are the facts AI answers quote.",
    fix: "Replace general claims with specific ones: a customer count, a rating with its source, years in business, or two named testimonials with a result.",
    evidence: at("no figures such as a customer count, rating or year, and no testimonial found"),
  });

  // ---- How many ways can a customer reach the business? ----
  const channels: string[] = [];
  if (links.some((l) => /^tel:/i.test(l.href))) channels.push("phone");
  if (links.some((l) => /^mailto:/i.test(l.href))) channels.push("email");
  // A sign-up box with only an email field is a way to be marketed to, not a way to write in; a form with a message box is.
  if ($("form textarea").length > 0 || links.some((l) => isOwn(l.href) && CONTACT_LINK.test(`${l.href} ${l.text}`))) channels.push("form or contact page");
  if (CHAT_WIDGET.test(scriptText)) channels.push("live chat");
  if (links.some((l) => MESSAGING_LINK.test(l.href))) channels.push("messaging app");
  if (nodesOfType(blocks, new Set(["PostalAddress"])).length > 0 || blocks.some((b) => b.data && JSON.stringify(b.data).includes('"address"')) || $("address").length > 0 || links.some((l) => /google\.[a-z.]+\/maps|goo\.gl\/maps|maps\.apple\.com/i.test(l.href))) channels.push("address or map");
  check("contact-channels", 6, channels.length >= 2, {
    severity: "low", effort: "low",
    title: `Only ${channels.length} way${channels.length === 1 ? "" : "s"} to contact the business ${channels.length === 0 ? "were found" : "was found"}`,
    detail: "Customers differ in how they want to reach you: some call, some email, some message. Offering at least two, plus an address if you have a premises, captures more enquiries and builds trust.",
    fix: "Offer at least two contact routes on every page, for example a phone number and an enquiry form, and add live chat or a messaging link if you can answer quickly.",
    evidence: at(`${channels.length} contact channel${channels.length === 1 ? "" : "s"} found${channels.length ? `: ${channels.join(", ")}` : ""}`),
  });

  if (!llm) {
    couldntCheck.push({ what: "AI review of the marketing messaging", why: "no AI provider is available" });
    return { outcomes, couldntCheck, injectionFlags: 0 };
  }

  const title = $("head > title").first().text().replace(/\s+/g, " ").trim();
  const description = ($('meta[name="description" i]').attr("content") ?? "").replace(/\s+/g, " ").trim();
  const h1 = $("h1").first().text().replace(/\s+/g, " ").trim();
  const ai = await runAiReview({
    module: "marketing", rubric: MARKETING_RUBRIC, weight: 5, subject: "the marketing messaging",
    intro: "You review the homepage copy of a website the way a marketing agency would, for messaging and persuasion.",
    page: { url, title, description, h1, bodyText }, llm, signal,
  });
  outcomes.push(...ai.outcomes);
  couldntCheck.push(...ai.couldntCheck);
  return { outcomes, couldntCheck, injectionFlags: 0 };
}
