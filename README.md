# SiteRecon

**Technical SEO + LLM Search Intelligence.** Evidence-based audits for AI visibility, technical health and competitive gaps, built for engineers. Paste an address and get an AI Readiness Score, a prioritised impact-vs-effort plan, ready-to-paste fixes and a prompt you can hand to Claude. Scores are computed in code from fixed rules; a model only explains and suggests, and every claim it makes must quote the page.

It is a sibling of RepoRecon (`../georgedev_AI`) and follows its structure: a Next.js app that streams progress over SSE, per-visitor rate limits, an eval harness that gates CI, an `/accuracy` page, and a deploy to the same VM.

**Everything runs on free tiers.** No paid service is required. The AI, PageSpeed and search providers each have a daily cap below their free limit, and exhausting one turns that part of the report into "couldn't check". The unauthenticated free services (GitHub's API, Jina Reader, yt-dlp, Hacker News) have no cap of their own: they are bounded only by the per-visitor and global scan limits, and they can rate-limit us, in which case that profile is reported as unreadable.

## What a report contains

| Part | How it is produced |
|---|---|
| SEO (18 checks) | A plain fetch of the homepage, robots.txt, sitemap and headers. No AI. |
| AI visibility (9 checks) | AI crawler rules, the text in the raw HTML, structured data. With the browser step, proof when content only appears after JavaScript runs. |
| Content and conversion | 80 points of fixed checks. A small AI review can move 20 points, and only by quoting a specific passage that is really on the page. |
| AI Readiness Score | A lens over the checks above and below: crawler access, structured data, answer blocks, entity clarity, render parity and freshness. Computed in code, weights on `/methodology`. |
| AI citation potential | Fixed rules per page: names the business early, a defining sentence, a self-contained 134 to 167 word passage, concrete figures, structure, vague claims, matching schema, outside sources. Plus an AI answer-extraction simulation that only counts with a quote from the page and is never scored. |
| Crawlability and rendering | Canonicals across pages, sitemap pages nothing links to, internal redirects, and (with the browser step) what a bot is served against what a browser shows. |
| Speed | Google PageSpeed Insights (mobile lab data). Needs a free key. The LCP element and its file, shifting elements, render-blocking files, heavy scripts and field INP are named. |
| Impact vs effort | The findings placed in a 2x2 from their severity and effort. |
| Telemetry | How long each scan step took and how it ended, per report and across recent scans on `/telemetry`. |
| Social | Links found on the homepage, then each public profile opened without logging in. |
| Competitors | Suggested by AI, then each is fetched to prove it is a live site, and measured with the same checks. |
| Marketing ideas | AI-written, each tied to a real finding. Ideas with links, emails, phone numbers or code are dropped. |
| Fix prompt | Built in code from the findings, never written by a model. |

Scores are computed in code from a fixed rubric (`/methodology` is generated from the checks themselves). A model never sets a score.

## Run it

Needs Node 22.13 or newer (it uses the built-in `node:sqlite`).

```bash
npm install
cp .env.example .env.local   # every key is optional
npm run dev                  # http://localhost:3000
```

With no keys the SEO, AI-visibility, content (fixed part) and social-link checks all work. Add keys to switch on the rest:

| Variable | Switches on | Where to get it |
|---|---|---|
| `NVIDIA_NIM_API_KEY` / `GEMINI_API_KEY` | Content review, competitor discovery, marketing ideas | build.nvidia.com / aistudio.google.com. Use a Google project with billing off. |
| `PAGESPEED_API_KEY` | Speed module | Google Cloud, PageSpeed Insights API. Free. |
| `TAVILY_API_KEY` | More competitors from web search | tavily.com. 1,000 free credits a month, no card. |
| `FETCH_SERVICE_URL` + `FETCH_SERVICE_SECRET` | Opening social profiles, the browser step | The Python service in `fetch-service/` |
| `MLFLOW_URL` | One MLflow run logged per scan | A self-hosted MLflow, see docs/DEPLOY.md |

### The Python fetch service (optional)

```bash
cd fetch-service
python -m venv .venv && .venv/Scripts/pip install -r requirements-dev.txt   # Scripts -> bin on Linux/macOS
.venv/Scripts/python -m playwright install chromium
FETCH_SERVICE_SECRET=change-me .venv/Scripts/python -m uvicorn --factory app.main:build --port 8787
```

It reads public social pages (GitHub API, yt-dlp for YouTube, Jina Reader for the rest, using Agent-Reach for URL routing) and renders the homepage in headless Chromium with Scrapling. It refuses to start without a secret, and every endpoint requires it.

## Tests and checks

```bash
npm test                  # unit and integration tests (vitest)
npm run eval              # accuracy on the fixture sites; fails below the floor
npm run eval:adversarial  # attacks on the tool itself; fails if any case stops holding
npm run typecheck && npm run lint && npm run build
cd fetch-service && python -m pytest -q
```

## Deploy

See [`docs/DEPLOY.md`](docs/DEPLOY.md). The files are written and checked for syntax, but they have not been run against a real VM, and the container image has not been built (see the status section there).

## Layout

```
app/              pages (/, /r/[id], /methodology, /accuracy) and API (/api/scan/stream, /api/report/[id], /api/accuracy)
lib/              url-guard, safe-fetch, rate-limit, quota, scan-handler, scan-queue, snapshot, robots, scoring, fix-prompt
  checks/         technical, geo, content, performance, social
  pipeline/       run.ts (the steps), schemas.ts
  llm/            router.ts (NVIDIA NIM, then Gemini)
  social/         platform classification
  observability/  mlflow.ts
fetch-service/    the Python service (FastAPI, Scrapling, Agent-Reach, yt-dlp)
eval/             fixture sites, ground truth, adversarial cases, scorecards
deploy/vm/        VM setup, egress rules and their self-check, systemd unit, Caddy snippet
docs/             PRD (the spec), ARCHITECTURE, DEPLOY, ROADMAP, agent-system-prompts
```

Spec: [`docs/PRD.md`](docs/PRD.md). Credits for the projects it uses and was inspired by: [`docs/CREDITS.md`](docs/CREDITS.md).
