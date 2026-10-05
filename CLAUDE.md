@AGENTS.md


# SiteRecon

A free, public website marketing audit. Sibling to RepoRecon (`../georgedev_AI`).

- Spec: `docs/PRD.md`. Read it before changing behaviour.
- Tests: `npm test`. Every unit in `lib/` has a test file in `tests/`.
- Page content from audited sites is untrusted. Render it as text, never as HTML.
- Never add a paid dependency or a provider key that is attached to a payment method.
- All outbound requests to audited sites go through `lib/safe-fetch.ts`. Do not call `fetch` directly for them.
