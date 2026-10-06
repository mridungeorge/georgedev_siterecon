# Credits

SiteRecon stands on other people's open-source work. This page says what was used and how, so nobody is left guessing what is copied and what is only inspired.

## Used as software (installed, not copied)

| Project | Licence | What SiteRecon uses it for |
|---|---|---|
| [Scrapling](https://github.com/D4Vinci/Scrapling) by D4Vinci | BSD-3-Clause | Rendering the homepage in a headless browser (`fetch-service/app/render.py`) |
| [Agent-Reach](https://github.com/Panniantong/Agent-Reach) by Panniantong | MIT | Deciding which social platform a URL belongs to (`fetch-service/app/routing.py`). Agent-Reach is an installer and health-checker for agent tools, not a reader, so the actual reads use the free tools it lists for each platform: the GitHub API, yt-dlp, and Jina Reader. Pinned to the commit that was tested |
| [yt-dlp](https://github.com/yt-dlp/yt-dlp) | Unlicense | Reading public YouTube channel details |
| [Jina Reader](https://jina.ai/reader/) | Service | Reading public social pages without logging in |
| [Playwright](https://playwright.dev) | Apache-2.0 | The browser underneath Scrapling |
| [cheerio](https://cheerio.js.org), [zod](https://zod.dev), [undici](https://undici.nodejs.org), [Next.js](https://nextjs.org), [FastAPI](https://fastapi.tiangolo.com), [httpx](https://www.python-httpx.org) | MIT and similar | Building blocks |

## Used as a reference (ideas, not code)

No code or prompt text was copied from these. Each shaped what is checked, and the checks were written fresh in this repository.

| Project | Licence | What it informed |
|---|---|---|
| [marketingskills](https://github.com/coreyhaines31/marketingskills) by Corey Haines | MIT | The questions in the content and conversion review (value, audience, call to action, differentiation) and the idea of tying advice to evidence |
| [claude-seo](https://github.com/AgriciDaniel/claude-seo) by AgriciDaniel | MIT | The catalogue of technical SEO and AI-search readiness checks (crawlability, schema, AI crawler access, `llms.txt`) |
| [open-seo](https://github.com/every-app/open-seo) by every-app | MIT | The feature list of an SEO platform. Its data comes from the paid DataForSEO service, which SiteRecon deliberately does not use |
| [RepoRecon](https://github.com/mridungeorge/georgedev_AI) | (the same author) | The structure: streaming progress, rate limits, the eval gate, the accuracy page, and the deploy |

The spec originally planned to vendor marketingskills' prompt text with attribution. That was not done: the review questions were written independently so that every AI answer could be held to the evidence rule (it must quote the page), which the original prompts are not built around. If prompt text from that project is ever copied in, its MIT notice must be added here.
