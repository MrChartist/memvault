## What and why

<!-- What does this change, and what problem does it solve? Link the issue if there is one. -->

## How I tested it

<!-- Commands you ran, platforms you tried (Linux / macOS / Windows), screenshots for dashboard changes. -->

## Checklist

- [ ] `npm test` passes (and `npm run test:e2e` if I changed the dashboard)
- [ ] I added or updated tests (a bug fix has a test that fails without it)
- [ ] Every write goes through `ingest.mjs` / `db.mjs` (secrets are masked, the write is audited)
- [ ] No hard-coded personal paths; works on Windows, macOS and Linux (or fails politely)
- [ ] New data capture is opt-in if it can hold anything sensitive, and is listed in the README privacy table
- [ ] Docs and `CHANGELOG.md` are updated
