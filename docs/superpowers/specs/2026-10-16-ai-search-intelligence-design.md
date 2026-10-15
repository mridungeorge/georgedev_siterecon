# SiteRecon: AI Search + Technical SEO Intelligence

Goal: SiteRecon reads as a technical-SEO and AI-search-visibility tool for engineers, with evidence, measurable
scores and ready-to-paste fixes. Scoring stays deterministic: a model only explains or suggests, never scores.
Constraint (CLAUDE.md): free tiers only, no paid dependency, all outbound fetches through `lib/safe-fetch.ts`.

## Spec A: positioning and surfacing

1. **AI Readiness Score** (`lib/ai-readiness.ts`): a lens over existing check outcomes, not a second module.
   Six fixed components (crawler access 25, structured data 20, answer blocks 20, entity clarity 15,
   render parity 12, freshness 8). The one-line verdict is a template over the weakest components.
   Overall grade and `/methodology` weights are unchanged.
2. **Positioning**: tagline "Technical SEO + LLM Search Intelligence", home page, README, metadata, methodology.
3. **Impact vs Effort matrix** (`lib/impact-matrix.ts`): severity x effort, in the report and Markdown export.
4. **Telemetry**: per-step duration, per-module could-not-check and error counts, provider calls and an
   estimated cost (all free tier, so the cost is a usage count against the cap). On the report, in MLflow,
   and on a `/telemetry` page.
5. **Architecture and principles**: SVG pipeline diagram and design principles on `/methodology`.
6. **Ready-to-paste artifacts**: fix kit gains meta tags, HTTP header block and a CI snippet for scheduled audits.

## Spec B: analysis modules

1. **Core Web Vitals to elements**: LCP element, CLS shifting nodes and INP (field data) from PageSpeed audits,
   mapped to the file or resource that caused them, plus blocking scripts and stylesheets.
2. **Schema gap audit**: page-type detection (article, product, FAQ, organisation) and the exact JSON-LD
   to add, built from the page's own data.
3. **Crawlability**: HTTP status distribution, orphan pages (in the sitemap, not linked from pages read),
   canonical mismatches across pages.
4. **Rendered vs raw**: what a browser sees against what a bot sees: words, headings, links, JSON-LD.
5. **Answer-extraction simulation**: per page, the facts a model could lift, checked deterministically
   (entity named in the first paragraph, definition sentence, numbers with units). An optional model
   summary is shown only with a verbatim quote from the page.
6. **Citation potential score per page**: entity clarity, structured data, answer blocks (134-167 word
   passages), authority signals (Hacker News mentions, outbound citations, authorship).
7. **LLM-unfriendly content**: long unstructured paragraphs, undefined core terms, ambiguous claims,
   all rule-based, flagged with quotes.
8. **Competitor evidence**: schema coverage, entity overlap and content depth against competitors, with
   statements such as "competitor.com has FAQPage, you do not" plus the snippet to add.

Every new check gets eval fixtures (0 false positives is the gate) and unit tests written first.
