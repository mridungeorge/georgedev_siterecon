# The prompts

Three steps call a model. The prompts live in code, next to the validation that checks their answers, so they cannot drift from it. This page says what each one is for and what the code does with the reply.

All three share the same rules:
- Everything taken from the audited site is fenced between `<<<UNTRUSTED_PAGE_TEXT>>>` and `<<<END_UNTRUSTED_PAGE_TEXT>>>`, and the system prompt says it is data, not instructions. Any run of three angle brackets in the page text is removed first, so a page cannot forge the fence.
- The model must reply with JSON only. The reply is parsed and validated; anything malformed becomes a "couldn't check" entry.
- No model output is ever shown as a score, a severity above medium, or advice text taken verbatim into the fix prompt.

| Step | File | Asks the model | What the code does with the answer |
|---|---|---|---|
| Content review | `lib/checks/content.ts` (`SYSTEM`, `RUBRIC`) | Four yes/no questions about the homepage copy, each with a quote of at least four words from the page | A quote that is not wholly inside one field of the page is dropped. A verified pass or fail is worth 5 points (20 in total). The wording of any problem is ours, written in `RUBRIC`. |
| Competitors | `lib/competitors.ts` (`SYSTEM`) | Up to six direct competitors as bare domain names | Each name is cleaned and rejected if it is an IP, a social network, a marketplace or the site itself. Each survivor is fetched, respecting robots.txt, and measured by the fixed checks. |
| Marketing ideas | `lib/ideas.ts` (`SYSTEM`) | Up to eight ideas, each tied to one finding id from a list | An idea citing an unknown finding id, a duplicate title, or containing a link, email, phone number, code or markup is dropped. |

The router (`lib/llm/router.ts`) tries NVIDIA NIM first and Gemini second (`LLM_PRIMARY` reverses that), counts each call against the daily LLM budget, and never reaches a paid tier: with no key, or once the budget is used, it throws and the step reports "couldn't check".
