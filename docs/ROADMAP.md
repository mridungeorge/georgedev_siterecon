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

These need a real VM or Docker, which were not available during the build.

- `fetch-service/Dockerfile` has not been built, and the hardened `docker run` flags in `deploy/vm/run-fetch.sh` have not been tried (Chromium running with `--cap-drop=ALL` and a read-only filesystem is the part most likely to need adjusting).
- `deploy/vm/setup.sh`, `egress-rules.sh` and `verify-egress.sh` have only been syntax-checked.
- The GitHub workflows have never run. `deploy.yml` needs the variables listed at its top.

## Checked against the real services

- **NVIDIA NIM**: checked live on 2026-10-06 with a real key. It accepts JSON mode (HTTP 200, about 2 s a call), and the content review, competitor discovery and marketing ideas all returned output that passed validation. Full scans of georgemridun.dev took 44 to 116 s.
- **GitHub API, Jina Reader, Chromium, Hacker News**: exercised in the same scans.

## Not verified against the real services

Gemini (the fallback), PageSpeed (needs a free key, and Google refuses keyless calls), Tavily and MLflow are tested against fakes only.

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
