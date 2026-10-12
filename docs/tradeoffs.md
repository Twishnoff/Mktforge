# Trade-offs log

One line per decision: what was built, bought or skipped, and why.

- 2026-10-12 — Switched from zip uploads via the GitHub web UI to local clones + branches + PRs. Cost: a day of setup and a new habit. Gain: history, reviewable diffs, and the foundation for CI deploys (Day 3).
- 2026-10-12 — Local Worker secrets live in .dev.vars (gitignored), not in wrangler.jsonc, so the Workers repo can be public without leaking keys.
