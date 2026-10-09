# Release and rollback

Do these in order. Stop at the first step that fails.

## Before publishing

1. CI is green on the release commit, including Windows and macOS, or the launch post says they are untried.
2. `npx vitest run` and `npm run test:e2e` pass.
3. `npm audit --omit=dev` shows nothing.
4. `npm pack --dry-run` lists only what you expect (about 82 files; no `db/`, no `.env`, no screenshots).
5. CHANGELOG, `package.json` version and `server.json` version are the same.
6. Private vulnerability reporting is on (Settings → Security in the GitHub repo).

## Publish

1. Log in to npm with an account that owns the `@mrchartist` scope, with two-factor on.
2. `npm publish --access public --provenance` (provenance needs a GitHub Actions run; if publishing from your computer, leave `--provenance` out and say so).
3. On a computer that has never had MemVault: `npx @mrchartist/memvault setup`, then `memvault doctor`. Try Windows, macOS and Linux.
4. Publish `server.json` to the MCP registry, then install from the registry once.
5. Tag the release: `git tag v3.0.0 && git push origin v3.0.0`.
6. Only now post the launch copy in `docs/promo.md`.

## Rollback

- Within 72 hours: `npm unpublish @mrchartist/memvault@3.0.0`.
- Later: `npm deprecate @mrchartist/memvault@3.0.0 "Use 3.0.1"` and publish a fixed version.
- Tell users in the repo README and the post. Their data is not touched by an upgrade or a removal; backups stay valid.
- Users can go back with `npm i -g @mrchartist/memvault@<old version>`. A vault saved by a newer schema is refused by an older version on purpose, with a clear message; restore a backup made before the upgrade.
