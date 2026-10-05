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
      "geo:content-in-html", "geo:organisation-schema", "geo:question-headings", "geo:citable-passage", "geo:llms-txt",
      "content:cta-present", "content:headline-clear", "content:contact-info", "content:trust-signals", "content:navigation",
      "social:has-profiles", "social:key-platforms", "social:schema-sameas",
    ],
    absent: [
      "technical:status-ok", "technical:https", "technical:indexable", "technical:image-alt", "technical:title-length",
      "technical:meta-description-length", "technical:not-truncated", "geo:ai-crawler-gptbot", "social:profile-links-valid",
    ],
  },

  noindex: { expect: ["technical:indexable"], absent: ["technical:title", "geo:content-in-html"], exact: true },

  "ai-blocked": {
    expect: ["geo:ai-crawler-gptbot", "geo:ai-crawler-claudebot"],
    absent: ["geo:ai-crawler-perplexitybot", "geo:ai-crawler-google-extended"],
    exact: true,
  },

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
      "technical:robots-txt", "technical:sitemap", "geo:llms-txt", "geo:question-headings",
    ],
    absent: [
      "technical:title", "technical:meta-description", "technical:viewport", "technical:structured-data",
      "content:headline-clear", "geo:organisation-schema", "geo:citable-passage",
    ],
  },

  "blocked-by-robots": { expect: [], error: "BlockedByRobotsError" },
  "bot-challenge": { expect: [], error: "TargetUnreachableError" },
};
