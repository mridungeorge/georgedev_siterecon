// What each fixture site must produce. `expect` findings must appear. `absent` findings must not.
// `exact` means nothing else may appear in the checked modules. `error` means the scan itself must
// stop with that error (a site that forbids crawlers, or serves a bot challenge).

export interface Truth {
  expect: string[];
  absent?: string[];
  exact?: boolean;
  error?: string;
}

export const TRUTH: Record<string, Truth> = {
  "healthy-bakery": { expect: [], exact: true },

  "bare-page": {
    expect: [
      "technical:title", "technical:meta-description", "technical:single-h1", "technical:canonical", "technical:html-lang",
      "technical:viewport", "technical:robots-txt", "technical:sitemap", "technical:structured-data", "technical:open-graph", "technical:hsts",
      "geo:content-in-html", "geo:organisation-schema", "geo:question-headings", "geo:citable-passage", "geo:llms-txt", "geo:freshness-signals",
      "content:cta-present", "content:headline-clear", "content:contact-info", "content:trust-signals", "content:navigation",
      "social:has-profiles", "social:key-platforms", "social:schema-sameas",
    ],
    absent: [
      "technical:status-ok", "technical:https", "technical:indexable", "technical:image-alt", "technical:title-length",
      "technical:meta-description-length", "technical:not-truncated", "geo:ai-crawler-oai-searchbot", "geo:ai-crawler-googlebot", "social:profile-links-valid",
    ],
  },

  noindex: { expect: ["technical:indexable"], absent: ["technical:title", "geo:content-in-html"], exact: true },

  "ai-blocked": {
    expect: ["geo:ai-crawler-oai-searchbot", "geo:ai-crawler-claude-searchbot"],
    absent: ["geo:ai-crawler-perplexitybot", "geo:ai-crawler-googlebot"],
    exact: true,
  },

  // Blocking the training crawlers (GPTBot, ClaudeBot, Google-Extended, CCBot) is a choice, never a finding.
  "training-opt-out": { expect: [], exact: true },

  "js-shell": {
    expect: ["geo:content-in-html", "technical:meta-description", "technical:single-h1", "technical:structured-data"],
    absent: ["technical:viewport", "technical:title", "technical:html-lang"],
  },

  "broken-meta": {
    expect: ["technical:title-length", "technical:meta-description-length", "technical:single-h1", "technical:image-alt"],
    absent: ["technical:title", "technical:meta-description", "technical:viewport", "technical:html-lang"],
  },

  "no-contact-cta": {
    expect: [
      "content:cta-present", "content:contact-info", "content:trust-signals", "content:navigation",
      "social:has-profiles", "social:key-platforms", "social:schema-sameas",
      "technical:robots-txt", "technical:sitemap", "geo:llms-txt", "geo:question-headings", "geo:freshness-signals",
    ],
    absent: [
      "technical:title", "technical:meta-description", "technical:viewport", "technical:structured-data",
      "content:headline-clear", "geo:organisation-schema", "geo:citable-passage",
    ],
  },

  // One seeded problem each, on an otherwise healthy site, so every new check has a case it must catch
  // and a clean control (the healthy bakery, which must report nothing).
  // Broken JSON-LD is ignored by search engines, so the page also counts as having no structured data.
  "schema-broken": {
    expect: ["technical:json-ld-valid", "technical:structured-data", "geo:organisation-schema", "social:schema-sameas"],
    absent: ["technical:schema-complete"],
    exact: true,
  },
  "schema-incomplete": { expect: ["technical:schema-complete"], absent: ["technical:json-ld-valid", "technical:structured-data"], exact: true },
  "bad-canonical": { expect: ["technical:canonical-valid"], absent: ["technical:canonical"], exact: true },
  "broken-link": { expect: ["technical:broken-links"], exact: true },
  "duplicate-pages": {
    expect: ["technical:pages-titles", "technical:pages-descriptions", "technical:pages-h1", "technical:pages-content"],
    exact: true,
  },
  "no-security-headers": { expect: ["technical:security-headers"], absent: ["technical:hsts"], exact: true },
  "layout-shift": { expect: ["technical:heading-order", "technical:image-dimensions"], absent: ["technical:image-alt", "geo:question-headings"], exact: true },
  "bad-sitemap": { expect: ["technical:sitemap-quality"], absent: ["technical:sitemap"], exact: true },
  "robots-no-sitemap": { expect: ["technical:robots-sitemap"], absent: ["technical:robots-txt"], exact: true },
  "no-https-redirect": { expect: ["technical:https-redirect"], absent: ["technical:https"], exact: true },
  "www-duplicate": { expect: ["technical:host-redirect"], exact: true },
  "soft-404": { expect: ["technical:soft-404"], exact: true },
  "hreflang-broken": { expect: ["technical:hreflang-valid"], exact: true },
  "article-no-author": { expect: ["technical:article-authorship"], absent: ["technical:schema-complete"], exact: true },
  "unanswered-question": { expect: ["geo:question-answers"], absent: ["geo:question-headings"], exact: true },
  "no-trust-pages": { expect: ["content:about-page", "content:policy-pages"], absent: ["content:navigation"], exact: true },
  "stale-copyright": { expect: ["content:copyright-year"], exact: true },
  "thin-homepage": { expect: ["content:content-depth"], absent: ["geo:content-in-html"], exact: true },
  "hard-to-read": { expect: ["content:readability"], absent: ["content:content-depth"], exact: true },

  "blocked-by-robots": { expect: [], error: "BlockedByRobotsError" },
  "bot-challenge": { expect: [], error: "TargetUnreachableError" },
};
