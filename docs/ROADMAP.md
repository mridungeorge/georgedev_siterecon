# Roadmap and status

## Built and tested

- The audit: SEO, AI visibility, content and conversion, speed, social, competitors, marketing ideas, fix prompt
- Rate limiting, quotas, queue, cancellation, SSRF protection
- The Python fetch service, including a real Chromium render (verified locally against example.com and georgemridun.dev)
- `/methodology`, `/accuracy`, `/api/accuracy`, MLflow logging
- Eval harness (9 fixture sites, 48 seeded problems) and an adversarial set (10 cases), both CI gates
- The portfolio section (`george-portfolio`, hidden until `NEXT_PUBLIC_SITERECON_URL` is set)

## Written but not run

These need a real VM or Docker, which were not available during the build.

- `fetch-service/Dockerfile` has not been built, and the hardened `docker run` flags in `deploy/vm/run-fetch.sh` have not been tried (Chromium running with `--cap-drop=ALL` and a read-only filesystem is the part most likely to need adjusting).
- `deploy/vm/setup.sh`, `egress-rules.sh` and `verify-egress.sh` have only been syntax-checked.
- The GitHub workflows have never run. `deploy.yml` needs the variables listed at its top.

## Not verified against the real services

No API keys were available, so the AI router (NVIDIA NIM and Gemini), PageSpeed, Tavily and MLflow are tested against fakes only. Whether NIM's model accepts JSON-mode output is untested; if it does not, every call falls through to Gemini.

## Known gaps (deferred review findings)

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
- The Markdown download described in the spec is not built (JSON only).
- Vision review of screenshots is not built; the browser step only measures word count and mobile overflow.

## Ideas for later

- A vision-model pass over a screenshot of the homepage
- Logged-in social sources as a separate, private mode
- Re-scan scheduling and drift alerts
- More fixture sites in the eval, especially real-world messy ones
