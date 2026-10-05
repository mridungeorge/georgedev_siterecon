# Architecture

Two services on one machine, plus the browser.

```
visitor ──HTTPS──▶ Caddy ──▶ siterecon-web (Next.js, systemd)  ──▶ audited sites (via safeFetch only)
                                  │   SQLite: rate limits, quotas, reports
                                  │──▶ NVIDIA NIM, Gemini, PageSpeed, Tavily, Hacker News (free tiers)
                                  └──▶ siterecon-fetch (Python, Docker, 127.0.0.1:8787)
                                            ├─ public social pages: GitHub API, yt-dlp, Jina Reader
                                            └─ headless Chromium render of the homepage
```

## The scan pipeline (`lib/pipeline/run.ts`)

`fetch` → `render` → `technical` → `geo` → `content` → `performance` → `social` → `competitors` → `synthesis`, streamed as server-sent events (`step-start`, `step-done`, `step-warn`, `report`, `error`).

Only `fetch` can fail a scan: with nothing to read there is nothing to audit. Every later step is isolated, so a failure becomes a "couldn't check" entry and the rest of the report still arrives. Steps that call outside services get a time budget each, and every one checks for cancellation before it starts.

## Security layers

| Layer | Where | What it stops |
|---|---|---|
| URL allowlist | `lib/url-guard.ts` | Non-http(s), credentials, odd ports, IP literals, internal names |
| Connect-time address check | `lib/safe-fetch.ts` | Names that resolve to private, loopback or metadata addresses, including after redirects and DNS tricks |
| Size, time and redirect caps | `lib/safe-fetch.ts` | Giant or never-ending responses |
| robots.txt | `lib/robots.ts`, `lib/snapshot.ts` | Crawling a site that forbids it. A bot challenge is reported, not bypassed |
| Per-visitor, per-target and global limits | `lib/rate-limit.ts` | Abuse, and using the tool to hit someone else's site |
| Provider quota guards | `lib/quota.ts` | Spending beyond a free tier |
| One scan at a time | `lib/scan-queue.ts` | Exhausting the 1 GB VM |
| Cancellation | `lib/scan-handler.ts` | Work continuing after the visitor leaves |
| Untrusted-text fence | `lib/injection.ts` | Page text acting as instructions to a model |
| Evidence rule | `lib/checks/content.ts` | A model's claim counting without a verbatim quote from one field of the page |
| Idea filter | `lib/ideas.ts` | Links, contact details or code planted in marketing ideas |
| Shared secret | `fetch-service/app/main.py` | Anyone but the web app calling the Python service |
| App-level and firewall egress rules | `fetch-service/app/netguard.py`, `deploy/vm/egress-rules.sh` | The browser reaching the metadata server or services on the VM |

## Why scores can be trusted

Scores come from `lib/scoring.ts`: the share of check weight that passed. The only model-influenced points are 20 of the content module, and each needs a verified quote. `eval/` measures the fixed checks against hand-built sites and measures that a model which does exactly what a hostile page says cannot plant text or move a score past that bound.

## Scan budget (worst case)

Fetch about 150 s, render 75, content review 75, PageSpeed 60, social 45, competitors 90, ideas 45: 540 s, which is the whole-scan ceiling (9 minutes). Typical scans are a fraction of that.
