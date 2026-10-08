# Roadmap and status

## Built and tested

- The audit: SEO, AI visibility, content and conversion, speed, social, competitors, marketing ideas, fix prompt
- Rate limiting, quotas, queue, cancellation, SSRF protection
- The Python fetch service, including a real Chromium render run through the killable-subprocess path (checked by hand on this machine against example.com and georgemridun.dev; not part of the automated tests)
- `/methodology`, `/accuracy`, `/api/accuracy`, MLflow logging
- Eval harness (9 fixture sites, 48 seeded problems) and an adversarial set (10 cases). Both run in CI, and the deploy workflow only starts after CI succeeds on a push to master. The adversarial competitor case was checked with a mutation test (the defence removed, the case fails).
- The portfolio section (`george-portfolio`, hidden until `NEXT_PUBLIC_SITERECON_URL` is set)
- Report downloads as Markdown and JSON, and a permalink

## Written but not run

These need a real VM, which was not available during the build.

- The fetch service image was built and run on 2026-10-06 with the hardened flags from `deploy/vm/run-fetch.sh` (non-root, `--read-only`, `--cap-drop=ALL`, no-new-privileges, pid, memory and CPU limits). Chromium rendered real pages inside it, and loopback, metadata and IP-literal addresses were refused. That run found one bug, fixed in the Dockerfile: the app user has no home directory, so Chromium died at launch until `HOME=/tmp` was set. Not yet tried on the VM itself: the iptables egress rules, and the Docker build on a 1 GB e2-micro.
- `deploy/vm/setup.sh`, `egress-rules.sh` and `verify-egress.sh` have only been syntax-checked.
- The GitHub workflows have never run. `deploy.yml` needs the variables listed at its top.

## Checked against the real services

- **NVIDIA NIM**: checked live on 2026-10-06 with a real key. It accepts JSON mode (HTTP 200, about 2 s a call), and the content review, competitor discovery and marketing ideas all returned output that passed validation. Full scans of georgemridun.dev took 44 to 116 s.
- **GitHub API, Jina Reader, Chromium, Hacker News**: exercised in the same scans.

## Not verified against the real services

Gemini (the fallback), Tavily, MLflow and the Instagram Graph API reader (`lib/social/instagram.ts`) are tested against fakes only. The Instagram reader needs a connected professional account and a token, and Business Discovery has not yet been confirmed to work with this app's token in development mode.

## Also checked live (2026-10-06)

- **PageSpeed Insights**, with a real key (Google refuses keyless calls). The speed module scored real pages. Scores for the same site moved noticeably between runs (40 and 100 on georgemridun.dev), which is how lab measurements behave, so treat the speed score as indicative.
- **Content review against the real model.** Eight live runs showed the model answering only some of the four questions, quoting short button text, and adding or dropping commas when copying. The review now matches quotes ignoring punctuation and typography (the words and their order must still match), accepts three-word quotes, and asks once more for missing answers. Before this, 12 of 32 answers were thrown away. The evidence rule itself is unchanged.

## Known gaps (deferred review findings)

- The browser request filter is best effort. Playwright does not route service-worker traffic through it, and a DNS-rebinding name can pass its check and then resolve privately. The container firewall is the boundary, which is why the deploy refuses to start the container without it.
- If Scrapling's setup hook fails silently, the page has already loaded before the failure is noticed. Only two numbers leave the worker, but the filter is not guaranteed for that one load.
- The deploy builds on the live machine (`npm run build` rewrites `.next` under the running server) and can pull the container image before the new one is published. A deploy that follows a change to `fetch-service/` may start the previous image until the next deploy.
- `/usr/bin/env npm` in the systemd unit needs npm on the default PATH (an nvm install would need `Environment=PATH=...`).
- Social is scored on 65 weight units when the fetch service is absent, yet still counts 15% of the overall score.
- A failure after MLflow's run is created can leave that run marked RUNNING.

- `extractJson` is slow on huge whitespace and fails when prose before the JSON contains `[`.
- AI quote matching is not Unicode-normalised, so curly versus straight quotes can drop a genuine quote.
- The live-progress parser breaks on the U+2028 character.
- "Couldn't check" text names providers and status codes.
- Trailing-dot hostnames and redirect targets get separate cache and per-target buckets.
- robots.txt answering 5xx is treated as allow-all (the standard says disallow-all).
- The organisation-schema check misses full-IRI types and LocalBusiness subtypes such as Dentist.
- Page bodies are always read as UTF-8.
- Bare domains always use https, with no http fallback.
- Four unusual IPv6 ranges are not blocked (probably unroutable on GCP).
- The overall score is reweighted, without saying so, when PageSpeed is missing.
- A vision-model review of a screenshot is deliberately not built. Anything a vision model says about layout cannot be verified by quoting the page, which is the evidence rule every AI claim here must meet, so it could only ever be an unscored opinion, and an image is one more place for a hostile page to hide instructions. The browser step measures word count and mobile overflow instead, both of which are checkable.
- Marketing ideas are capped at 8 (the spec says 8 to 12).
- An AI-written idea can be factually wrong. One said `llms.txt` carries "language and character encoding". The section is labelled AI-generated, but the wording is not checked. Showing the finding's own fixed explanation first would reduce this.
- Competitor suggestions suit businesses better than individuals: a personal portfolio was compared with Microsoft, NVIDIA and Salesforce.

## Ideas for later

- A vision-model pass over a screenshot of the homepage
- Logged-in social sources as a separate, private mode
- Re-scan scheduling and drift alerts
- More fixture sites in the eval, especially real-world messy ones

## Report depth upgrade (2026-10-09)

Done, test-first and covered by the eval (19 fixture sites, 66 seeded problems, 0 false positives):

- **AI crawlers are judged by what they control.** OAI-SearchBot, Claude-SearchBot, PerplexityBot and Googlebot decide whether the site can be cited, so they are scored. GPTBot, ClaudeBot, Google-Extended and CCBot only control model training; blocking them is reported as a choice, never as a problem. This was wrong before.
- **Structured data is validated**, not just detected: broken JSON-LD blocks, missing required properties, and leftover template text such as [Business Name].
- **About 20 more SEO checks**: canonical correctness, heading order, security headers, image dimensions, internal and broken links, sitemap and robots quality, AI freshness signals.
- **Up to 10 inner pages are read** (four at a time) and checked site-wide: missing or duplicate titles and descriptions, H1s, thin pages.
- **Speed earns partial credit** in Google's needs-improvement band, so a page at 85 no longer scores like a failure.
- **The report opens with a grade and a plain-language verdict**, then a roadmap of every finding by effort (this week, this month, this quarter), then **ready-to-paste fixes** (canonical tag, robots.txt, sitemap.xml, Organization JSON-LD, llms.txt, Open Graph tags, security headers) built only from the site's own data. None of it is written by an AI.

Not done yet, in the order I would do them:

1. Content and E-E-A-T checks that need no AI: readability, author and about signals, trust pages, content depth by page type.
2. Per-page results table, and passage-level citability scoring (the 134 to 167 word range).
3. Deeper competitor comparison (run the same checks on each competitor, show a gap table) and richer social: Instagram through Meta's Business Discovery once a token exists.
4. www/non-www and http to https redirect checks, hreflang, and a soft-404 probe. These need extra requests per scan.

### Social: what each platform gives

- **Facebook** is read without a login through Jina Reader. Meta only lets approved apps read other Pages' followers and posts through its API (an app-review feature), so SiteRecon does not. When a public Page states its followers in its description, that count is shown. Many pages show only a login wall to a bot, and then only the title is available. The report cannot say whether a Facebook Page is active.
- **Instagram** business and creator accounts are read through Meta's official Business Discovery API when a token is configured (follower count, post count, latest post).
- **LinkedIn** almost always answers with a login wall.
