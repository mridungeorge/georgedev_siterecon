# SiteRecon — design spec

Date: 2026-10-05 · Status: draft for review · Owner: George Mridun

## 1. Purpose and success criteria

SiteRecon is a free, public marketing-audit tool and a portfolio showpiece, a sibling to RepoRecon. A visitor pastes a website URL and gets a marketing-agency-style audit that covers SEO, AI-search visibility (AEO/GEO), content and conversion, public social presence, and a comparison against the three nearest competitors. The report ends with a prioritised fix list, marketing ideas, and one copy-paste **Claude fix prompt**.

Success means:
- A scan of a typical small-business site usually finishes in 2 to 5 minutes (hard ceiling 6) on the shared-core e2-micro VM, and streams honest progress the whole way.
- Every finding in the report cites evidence (a URL, a quote, or a screenshot region). Nothing is invented.
- It runs entirely on free tiers, on the existing GCP VM, with hard caps so it cannot run up a bill or exhaust a quota.
- The portfolio embeds it the way it embeds RepoRecon, with a sample report and a live scan.
- When a check cannot run, the report says so ("couldn't check") instead of guessing.

Out of scope for v1: logins, accounts, paid data sources (DataForSEO, SERP APIs), logged-in social scraping, scheduled re-scans, PDF export, multi-language audits.

## 2. Inputs that shaped this design

| Source | What we take from it | What we do not take |
|---|---|---|
| marketingskills (MIT) | Prompts and checklists for `seo-audit`, `ai-seo`, `cro`, `copywriting`, `competitors`, `social`, `marketing-ideas`. Vendored into the repo with attribution. | Their Claude Code packaging (slash commands, skill loading). Only the prompt content is reused. |
| claude-seo (MIT) | The check catalogue: 9 technical categories, GEO/citability, schema, agentic readiness. We reimplement the deterministic ones in TypeScript. | Its paid or credentialed tiers (Search Console, GA4, Ads, MCP extensions). |
| open-seo (MIT) | The feature list as a reference. | Everything else. It depends on the paid DataForSEO API. |
| Agent-Reach (MIT) | Public reads: web (Jina Reader), YouTube, RSS, GitHub, public LinkedIn. | Anything that needs cookies or logins (X, Reddit, Instagram, Facebook). |
| Scrapling (BSD-3) | `Fetcher` for fast HTTP, `DynamicFetcher` for JS rendering and screenshots. | `StealthyFetcher` against the audited site. See section 8. |

## 3. Architecture

A new repo, `siterecon`, deployed as two services on the existing GCP VM, the same way RepoRecon is (see section 11).

- **`siterecon-web`** (Next.js, TypeScript, run under `systemd`). Public. Serves the UI, the API, the SSE stream, the rate limits, the deterministic checks, the LLM agents, scoring and the report store.
- **`siterecon-fetch`** (Python, FastAPI, in a hardened Docker container). Internal only: bound to `127.0.0.1` with no public port. It wraps Scrapling and the Agent-Reach CLI behind a small HTTP API and holds the headless browser. The two services share a secret header.

Public URL: `siterecon.georgemridun.dev`. The portfolio calls `/api/scan/stream` the way it calls RepoRecon today and reuses the shape of `useAuditStream`.

The code mirrors RepoRecon's structure and security model (sections 7, 8, 10 and 11): `rate-limit.ts`, `cors.ts`, the LLM router (NVIDIA NIM, then Gemini, then Ollama), the SSE route pattern, the eval harness with its CI gate, MLflow run logging, the `/accuracy` page, and the `systemd` plus GitHub Actions deploy.

### Units and interfaces

| Unit | Does | Depends on |
|---|---|---|
| `fetch-client` | Calls `siterecon-fetch`. Returns `PageSnapshot` (html, rendered DOM, status, headers, screenshots). | fetch service |
| `ssrf-guard` | Validates and normalises the input URL and every redirect hop. | none |
| `checks/technical` | Deterministic technical SEO findings plus a PageSpeed Insights call. | `PageSnapshot` |
| `checks/geo` | AI-crawler access, `llms.txt`, structured data, citability scoring. | `PageSnapshot` |
| `checks/content` | Vision LLM critique of copy, positioning and conversion. | `PageSnapshot`, LLM router |
| `checks/social` | Finds social links, reads public profiles, searches public mentions. | fetch service |
| `competitors` | Grounded search for three competitors, then a light run of technical, GEO and social presence on each. | search provider, checks |
| `synthesis` | Scoring rubric, evidence review, prioritisation, ideas, Claude fix prompt. | all of the above |
| `report-store` | Persists a finished report under a short id for 30 days. | disk (SQLite file) |

Every check returns the same `ModuleResult`: `{ module, status: "ok" | "partial" | "failed", score, findings[], couldntCheck[] }`. A `Finding` is `{ id, module, severity, title, detail, evidence[], fix, effort }`, and `evidence` must be non-empty.

### Fetch tiers on a 1 GB host

The VM is a GCP e2-micro (shared core, 1 GB RAM, 0.25-vCPU baseline with bursts) that already runs RepoRecon, so memory is the scarcest resource and the design treats Chromium as optional.

- **Tier 1, always on.** Scrapling `Fetcher` (plain HTTP with TLS impersonation) inside the small Python process. It fetches the HTML of every page. All deterministic checks and the text-based content analysis run on Tier 1 alone.
- **Tier 2, on demand.** Scrapling `DynamicFetcher` with Chromium, used only for the homepage's rendered DOM and its desktop and mobile above-the-fold screenshots. The browser runs in a short-lived container started per scan with `--memory=512m` and removed straight afterwards, so it costs nothing while idle. Before launching it, the fetch service checks `MemAvailable` (default minimum 400 MB). If there isn't enough, for example while a RepoRecon scan is running, Tier 2 is skipped and the report says "couldn't render the page or take screenshots". The content analysis then falls back to text only. A scan never takes the VM or RepoRecon down.
- **Headroom.** A 2 GB swap file on the VM's free disk, and `NODE_OPTIONS=--max-old-space-size=256` on the web service.
- **Upgrade path, not needed for v1.** If Tier 2 is skipped too often, `siterecon-fetch` alone can move to another free host with more RAM (for example an Oracle Cloud Always Free ARM instance; current terms to be verified). The web service reaches it over HTTP with a shared secret, so the move is a config change.

## 4. Pipeline

1. **Fetch.** Raw HTML and rendered DOM for the homepage and up to 5 key pages (picked from nav links and the sitemap). Desktop and mobile above-the-fold screenshots. Also `robots.txt`, `sitemap.xml` and `llms.txt`.
2. **Checks 2 to 5 run in parallel** after fetch:
   - **Technical SEO.** Title, meta description, headings, canonicals, indexability, robots and sitemap, internal links, images and alt text, schema, security headers, mobile viewport, and Core Web Vitals from PageSpeed Insights.
   - **AI/GEO.** GPTBot, ClaudeBot, PerplexityBot and Google-Extended access; `llms.txt`; structured data; passage-level citability.
   - **Content and conversion.** A vision-capable model reads the screenshots and page text, guided by the `cro`, `copywriting` and `seo-audit` prompts.
   - **Social (public).** Extract social links from the site, then read each profile with Agent-Reach or Scrapling. Check presence, link health, bio and brand consistency, and visible activity. Search Reddit and Hacker News for public mentions.
3. **Competitors.** Discovery has a zero-quota baseline: the LLM reads the site's content, names the industry and proposes six candidate competitors, and the Tier 1 fetcher then confirms each one is a live site in the same industry. The best three are kept and labelled "AI-suggested, verified live". When search quota is available, a search provider (section 13) improves the candidates. The same lightweight technical, GEO and social-presence checks run on each, which gives the comparison table.
4. **Synthesis and review.**
   - Scores are computed in code from a fixed rubric (see section 5).
   - A reviewer step drops any LLM finding with no valid evidence and de-duplicates the rest.
   - The synthesiser writes the prioritised fix list, marketing ideas, and the Claude fix prompt.

SSE events keep RepoRecon's names (`step-start`, `step-done`, `report`, `error`) and add `step-warn` for a module that finished partially. Steps are `fetch`, `technical`, `geo`, `content`, `social`, `competitors`, `synthesis`.

## 5. Scoring and report

Five 0 to 100 scores: **SEO**, **AI visibility**, **Content and CRO**, **Social**, **Performance**, plus an overall score. Each deterministic check contributes a weighted pass or fail from a rubric in code. LLM findings can add or remove only evidence-backed points inside their module, capped at 20 points, so a model cannot swing a score on its own. The rubric is published on the methodology page.

Report sections:
1. Scorecard with the overall score and the five module scores.
2. Top 10 prioritised fixes, ranked by impact over effort.
3. Detail tabs: SEO, AI visibility, Content and CRO, Social.
4. Competitor comparison table, with the audited site and each competitor side by side, and the gaps called out.
5. Marketing ideas: 8 to 12, each tied to a specific finding or competitor gap.
6. **Claude fix prompt:** a single block, built in code from the findings (the same approach as RepoRecon's `buildFixPrompt`), with a copy button.
7. "Couldn't check": every module or platform that was skipped and why.

Actions: copy the fix prompt, download the report as Markdown or JSON, and share a permalink (`/r/{id}`, kept 30 days).

## 6. UI

A standalone app page with the URL form, a live pipeline strip that shows the real trace messages, and the report. The portfolio gets a `TrySiteRecon` section modelled on `TryRepoRecon`, with a pre-generated sample report so visitors see value before waiting. Visual language follows the portfolio's tokens (see `DECISIONS.md`). The `/methodology` page lists every check, data source, rubric weight and known limit. The `/accuracy` page shows the live eval scorecard, as RepoRecon's does.

## 7. Rate limiting and free-tier budget

RepoRecon's `lib/rate-limit.ts` is the starting point (per-IP window plus a global daily cap), kept API-compatible: `checkRateLimit(ip)` and `getClientIp(req)`. SiteRecon needs more layers, because a scan costs more quota than an audit and, unlike RepoRecon, it sends traffic to third-party websites.

| Layer | Default (all env-configurable) | Why |
|---|---|---|
| Per-IP, hourly | 5 scans per hour | Parity with RepoRecon's PRD §7 value. |
| Per-IP, daily | 10 scans per day | Stops one visitor spending the whole day's budget in hourly bursts. |
| Global, daily | 50 scans per day | Parity with RepoRecon. Keeps total LLM, search and PageSpeed use inside the free quotas. |
| Per-target domain | 3 scans per hour per domain, across all visitors | Protects the audited site from being hammered through our tool. RepoRecon has no equivalent because it clones from GitHub only. |
| Concurrency | 1 active scan, queue of up to 5 | The VM has 1 GB of RAM shared with RepoRecon. A full queue returns 503 "busy" with a retry hint. The browser step also has its own memory guard (see "Fetch tiers on a 1 GB host"). |
| Provider quota guards | Separate daily counters for LLM calls, grounded searches and PageSpeed, each set below the verified free cap | A provider can run dry before the global scan cap is reached. |
| Domain cache | A finished report is reused for 24 hours | A cache hit costs no quota and does not count against any limit. |

**Mechanics**
- **Persistence.** Counters live in the same SQLite file as the report store, so they survive restarts. RepoRecon's in-memory counters reset on every deploy restart, which is acceptable there but not for quota guards that stand in for a spending limit. It stays single-instance. Moving to Redis is only needed if this ever runs on more than one instance.
- **Client IP.** Same rule as RepoRecon: `x-forwarded-for` is attacker-controlled, so unless `TRUST_PROXY=true` every request falls into one shared bucket. That default is safe but under-protective. The VM's edge is Caddy (confirmed from RepoRecon's response headers), which sets its own `X-Forwarded-For` for untrusted clients. SiteRecon runs with `TRUST_PROXY=true`, and the plan includes a test that a spoofed header from outside is overwritten before it is relied on.
- **Order of checks:** validate the URL (400, not counted), peek at the limits, look up the cache (a hit returns at once), check that the fetch service is healthy (503, not counted), commit the limit counters, then run. RepoRecon consumes quota before validation and readiness checks, so a typo costs a visitor a scan. SiteRecon does not.
- **Failed fetch.** If the target is unreachable or blocked, the scan does not count against the visitor.
- **Response contract.** Errors are JSON with CORS headers, like RepoRecon's. A 429 carries `{ error, reason, retryAfterMs }` where `reason` is `per-ip`, `per-ip-daily`, `global`, `per-target` or `provider-quota`, plus a `Retry-After` header. The portfolio hook shows `error` as written.
- **Degradation.** An exhausted provider quota turns that module into "couldn't check". If every LLM provider is down, the report is deterministic-only and labelled as such.

Free quotas change often, and some figures in my research were not confirmed against live docs. The first implementation task re-verifies each quota and sets the provider guards from the real numbers.

## 8. Security and ethics

SiteRecon keeps RepoRecon's security posture. The table maps each control to its SiteRecon form.

| RepoRecon control | SiteRecon form |
|---|---|
| Input allowlist regex (only `https://github.com/<owner>/<repo>`) | Strict URL parsing. `http(s)` only, ports 80 and 443 only, no embedded credentials, no IP-literal hosts, bounded length, IDN normalised to punycode, fragment stripped. |
| Sandbox container: `--network=none`, `--memory=1g`, `--cpus=1`, `--pids-limit=256`, read-only mount, non-root user | The fetch container runs with `--memory`, `--cpus` and `--pids-limit` caps, a non-root user, `--read-only` with tmpfs scratch, `--cap-drop=ALL` and `no-new-privileges`. A fresh browser context per scan. |
| Nothing from the repo is ever executed | Page scripts run only inside the disposable headless browser. Nothing from a page runs on the host or in the web service. |
| Timeouts and a 4 MB process-output cap, `spawn` with `shell: false` | Per-request, per-module and whole-scan timeouts (6-minute ceiling), capped response and screenshot sizes, capped page count, and no shell invocation anywhere. |
| Temp dirs cleaned in `finally` | Same: scratch space and browser contexts are torn down in `finally`, including on error or client disconnect. |
| Origin-gated CORS allowlist, no wildcard (`lib/cors.ts`) | Same helper, allowing the portfolio's production and local-dev origins. |
| Prompt-injection flag count, zod-validated agent output, adversarial eval | Same. Page text is data, never instructions. LLM output is schema-validated and rendered as plain text. |
| Secrets in env, `.env.example` | Same. No keys reach the browser. The two services authenticate with a shared secret header. |

Two risks that RepoRecon did not have, because SiteRecon's browser needs the internet:
- **Server-side request forgery.** `--network=none` is not possible here. The app-level guard resolves DNS and rejects loopback, private, link-local and metadata addresses, and re-checks every redirect hop. But a browser also follows subresources and can be tricked by DNS rebinding, so the container additionally sits on its own Docker network with egress rules (in `DOCKER-USER`) that drop RFC 1918 ranges, loopback, link-local and, critically, **the GCP metadata server (169.254.169.254)**. The same VM also hosts RepoRecon and its services, so those local ports must be unreachable from the browser container.
- **Hitting third parties.** The per-target limit in section 7, the crawl-size caps, and respecting `robots.txt` on the audited site. If a site blocks automated access or serves a bot challenge, that becomes a report finding. We do not use Scrapling's `StealthyFetcher` to get around it.

**Social:** public pages only, no stored credentials, no cookies. The social module sits behind a provider interface, so logged-in sources can be added later without touching the pipeline.

**Privacy:** reports contain only public data. Stored reports expire after 30 days.

## 9. Failure handling

Each module runs independently with its own timeout. A failure returns `status: "failed"` with a reason, and the scan still produces a report if fetch succeeded. If fetch itself fails (DNS error, blocked, timeout), the visitor gets a plain-language explanation and the scan is not counted. The whole scan has a 6-minute ceiling, SSE heartbeats keep the connection open, and a closed connection cancels the work. Errors that happen before streaming starts use the same JSON error bodies as RepoRecon (400, 429, 503), so the portfolio hook can show them honestly.

## 10. Testing, evaluation and observability

This follows RepoRecon's approach: tests prove the code works, and an eval harness proves the audit is accurate.

- **Unit tests** for every deterministic check against saved HTML fixtures. No live network in CI.
- **Eval harness** (mirrors `eval/run-eval.ts`): a set of fixture sites with hand-labelled ground truth (`eval/ground-truth.json`) covering known issues and known-good pages. It measures recall of the seeded issues, the share of findings with valid evidence, and score stability across repeated runs. Results go to `eval/scorecard.json`.
- **CI gate** (`eval-gate.yml`, mirroring RepoRecon's): fails a push or PR if recall drops below a floor. The LLM is mocked or replayed from recorded outputs so the gate is deterministic.
- **Adversarial eval** (mirrors `run-adversarial.ts`): pages containing prompt-injection text, hostile redirect chains, SSRF payloads, oversized pages, bot challenges and malformed HTML. It checks that nothing escapes the guards and that injection attempts are flagged.
- **`/accuracy` page and `/api/accuracy`** show the live scorecard and are also the deploy health check, like RepoRecon's. The page states exactly how many fixtures back the numbers, so the claims never overreach. (RepoRecon's own site notes its benchmark is still a small stand-in set.)
- **`ssrf-guard` tests** for private IPs, redirect chains, DNS rebinding and odd URL encodings.
- **Run logging** to the existing self-hosted MLflow (`MLFLOW_URL`, experiment `siterecon`): run id, duration, per-module status, LLM provider, tokens and cost lines, quota use, and injection flags. Logging failures are non-fatal, as in `logAuditRun`.
- **Integration test:** the full pipeline against a local static site, with the fetch service in a container.
- **Manual smoke checklist** against 3 live sites before launch, including one that blocks bots.

## 11. Repository layout and deployment

The layout mirrors RepoRecon so either project is easy to navigate.

```
siterecon/
  app/            page, accuracy, methodology, r/[id], api/scan/stream, api/report/[id], api/accuracy
  lib/            rate-limit.ts, cors.ts, ssrf-guard.ts, fetch-client.ts, report-store.ts
    llm/          router.ts (NIM -> Gemini -> Ollama, same LLM_PRIMARY switch), search providers
    pipeline/     state.ts, schemas.ts (zod), agents/ (fetch, technical, geo, content, social, competitors, synthesis, reviewer)
    observability/mlflow.ts
  fetch-service/  Python (FastAPI) wrapping Scrapling and Agent-Reach
  docker/         fetch.Dockerfile
  docs/           PRD.md, ARCHITECTURE.md, ROADMAP.md, agent-system-prompts.md
  eval/           fixtures/, ground-truth.json, run-eval.ts, run-adversarial.ts, scorecards
  .github/workflows/   deploy.yml, build-fetch.yml, eval-gate.yml
  CLAUDE.md, AGENTS.md, .env.example
```

`router.ts`, `cors.ts` and `rate-limit.ts` are copied from RepoRecon and adapted, not shared as a package. The cost is some duplication, and the benefit is two independent repos with no coupling. This design drops three RepoRecon parts on purpose: Qdrant and hybrid retrieval (a website audit doesn't need code search), the trained triage classifier (no labelled data and no need), and the Mastra workflow wrapper (RepoRecon's own stream route calls the step functions directly, and SiteRecon will do the same).

**Deployment** follows RepoRecon's pattern on the same GCP VM:
- `siterecon-web` is a Node service under `systemd` on its own port, fronted by whatever proxy fronts RepoRecon.
- `siterecon-fetch` is a small Python service (Tier 1) bound to `127.0.0.1` only. The Chromium image (Tier 2) is built by `build-fetch.yml`, pushed to GHCR (as `build-sandbox.yml` does for RepoRecon), and started per scan as a short-lived hardened container.
- One-time VM setup, scripted and documented: a 2 GB swap file, the `DOCKER-USER` egress rules, and the `systemd` unit with a memory cap so SiteRecon can't starve RepoRecon.
- `deploy.yml` matches RepoRecon's: Workload Identity Federation auth, `ssh-compute` to the VM, `git pull`, `npm install && npm run build`, restart the service, pull and restart the fetch container, then a health check against `/api/accuracy` that prints `DEPLOY_OK`.
- Configuration is by environment variables, documented in `.env.example`: LLM keys and router order, PageSpeed key, search keys, all limit values, `TRUST_PROXY`, `MLFLOW_URL`, and the shared secret.

## 12. Assumptions and open items

- **Proxy and `TRUST_PROXY`.** Resolved: Caddy on the VM is the edge, and Cloudflare is DNS only. The spoofed-header test in the plan confirms the behaviour. It's still worth checking what `TRUST_PROXY` is set to for RepoRecon on the VM, because if it is unset, all of RepoRecon's visitors share one rate-limit bucket.
- **VM is an e2-micro (1 GB RAM, shared core).** Decided: stay on it, run one scan at a time, and treat the browser as an optional, memory-guarded step. RepoRecon's Semgrep scans are heavy, so the real headroom has to be measured during implementation. If the browser step is skipped often, the fetch service can move to another free host (section 3).
- **Network egress.** See section 13. It is the one cost that can't be driven to exactly zero on this VM.
- **Free quotas are unverified.** See section 7.
- **Agent-Reach's exact command surface needs a short spike** in the planning phase. It is documented as a CLI where most social platforms need logins. If the public reads we need aren't exposed cleanly, the fetch service uses the same underlying free backends (Jina Reader, `yt-dlp`, `feedparser`) directly.
- **Egress filtering needs a one-time VM change** (the `DOCKER-USER` rules in section 8). The plan includes it as an explicit step and tests it from inside the container.
- **Final name and subdomain.** `SiteRecon` at `siterecon.georgemridun.dev` is my choice. They are easy to change.

## 13. Cost audit and decisions

Goal: zero marginal cost, with no way for a traffic spike or a bug to create a bill. Checked on 2026-10-05.

| Item | Finding | Decision |
|---|---|---|
| GCP VM | The Always Free tier covers one `e2-micro` in `us-west1`, `us-central1` or `us-east1`, with 30 GB of standard disk. RepoRecon already uses it in `us-central1`. | SiteRecon shares that VM. No new instance, disk or IP. |
| GCP egress | Free: "1 GB of outbound data transfer from North America to all region destinations (excluding China and Australia) per month". Traffic to Australian visitors is billed from the first byte. I have not verified the per-GB rate. | Keep VM responses tiny (see below). Set a US$1 budget alert on the GCP project. If egress ever shows on the bill, turn on Cloudflare's free proxy so static assets are served from its cache. |
| LLM, primary | NVIDIA NIM's hosted catalogue is free with a rate limit of about 40 requests a minute and no credit system. | Primary provider, same as RepoRecon. A scan uses 6 to 10 calls. |
| LLM, fallback | Gemini Flash and Flash-Lite are free of charge for input and output, including image input. | Fallback provider. The key must come from a Google AI Studio project with **billing not enabled**, so it can never charge. |
| Competitor search | Gemini's free "Grounding with Google Search" exists only on Gemini 2.5 Flash and 2.5 Flash-Lite (500 requests a day, shared). It is "Not available" on the free tier of the 3.x models, so RepoRecon's `gemini-flash-lite-latest` alias can't be assumed to have it. | Order: (1) the zero-quota baseline in section 4, always available; (2) Gemini 2.5 Flash-Lite grounding, pinned by exact model id, while it exists; (3) Tavily. The design must work with (1) alone. |
| Tavily | 1,000 free credits a month, no card required, 1 credit per basic search. Pay-as-you-go charging exists but needs a card. | Sign up without a card so it stops at the limit. Guard at 30 searches a day. |
| PageSpeed Insights | Free with an API key, reported as 25,000 requests a day. | Use it. Guard at 200 a day. |
| Agent-Reach, Scrapling, Jina Reader | Open source and free. Jina Reader's keyless tier is rate-limited. | Use them without paid keys. A rate-limit response becomes "couldn't check". |
| GitHub Actions and GHCR | Free for public repositories. | Make the `siterecon` repo public, like RepoRecon. The eval gate replays recorded LLM output, so CI spends no LLM quota. |
| Portfolio hosting | The portfolio is on Vercel. | The embedded "Try SiteRecon" UI ships with the portfolio, so its JavaScript is served by Vercel and only the scan stream comes from the VM. |
| MLflow, SQLite, Caddy, swap | Already on the VM or free. | No cost. |

**Keeping VM egress small**
- The scan stream and report JSON are a few tens of kilobytes per scan.
- Screenshots are downscaled and compressed to about 80 KB each before they are sent to the vision model, and they are not sent to the visitor's browser by default. The report shows the findings and the page regions they refer to.
- The standalone app's static assets are the largest per-visit cost, which is why the Cloudflare cache is the fallback.

**Billing safety rules**
1. No provider key is attached to a payment method, except the GCP project that already hosts the VM.
2. Every provider has a daily guard below its free limit (section 7).
3. Exhausted quota degrades the module. It never falls through to a paid tier.
4. A US$1 GCP budget alert warns early. An alert does not stop spending, so the caps above are the real protection.

**Expected cost: US$0 a month in normal use**, with a possible few cents of Australian egress at high traffic.
