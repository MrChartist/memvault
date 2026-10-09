# Contributing to MemVault

Thanks for helping! This guide gets you from clone to pull request.

By participating you agree to the [Code of Conduct](CODE_OF_CONDUCT.md). Security problems: see [SECURITY.md](SECURITY.md),
**not** public issues.

## Development setup

Requires Node.js 20+ and Git.

```bash
git clone https://github.com/MrChartist/memvault.git
cd memvault
npm install
npm test          # the full suite (a few seconds)
npm run check     # syntax + version-consistency + "no personal paths" checks
```

Never develop against your real vault. Point the code at a scratch folder:

```bash
export VAULT_ROOT=$(mktemp -d)
node server.mjs            # web UI on http://localhost:7799
node mcp-server.mjs        # MCP server on stdio
```

> **Note on npm versions:** if `npm install`/`npm audit fix` crashes with `Cannot read properties of null (reading 'edgesOut')`,
> you hit an npm 10 resolver bug — use `npx npm@11 install`.

## How the code is organised

| Area | Files |
|------|-------|
| Database (**single owner of the vault file**) | `db.mjs` |
| MCP server / web server | `mcp-server.mjs`, `server.mjs`, `security.mjs`, `secrets.mjs` |
| Capture engines | `sync-*.mjs` (+ `sync-lib.mjs`) |
| Importers | `import-*.mjs` (+ `import-lib.mjs`) |
| Config | `config.mjs` |

Ground rules:

1. **All vault reads/writes go through `db.mjs`.** Never open `index.sqlite` with your own sql.js instance — several
   processes share the file and `db.mjs` is what keeps them from overwriting each other.
2. **Never build SQL with string interpolation.** Use `?` parameters. For user text in `LIKE`, use `searchItems()` (it escapes wildcards).
3. **Escape everything you put into `innerHTML`** in `public/index.html` (`esc()`).
4. **Don't add dependencies lightly.** MemVault installs with `npx` and no native build step; that is a feature.
5. **ES modules, Node 20+, no TypeScript build step.** Match the surrounding style.
6. **Write paths with `path.join`, never hard-code `/` or `C:\`, and never hard-code personal directories.**
   Use `os.homedir()` / config values. `npm run check` fails on leftover personal paths.

## Adding or changing a capture engine

A capture engine is a `sync-<name>.mjs` that builds entries and calls `saveEntries()` from `sync-lib.mjs`.
Please follow these rules — they are what makes MemVault safe to run on a schedule on people's real machines:

- **Idempotent.** Re-running must not duplicate data. Either give entries their real `created_at` (the id is then a hash of the
  content, so duplicates are ignored) or set `upsert: true` for "current state" snapshots (older entries with the same
  `source` + `title` + `file_path` are replaced — set `file_path` when two snapshots can share a title).
- **Never delete or overwrite vault data** that the engine did not create.
- **Privacy first.** Capture the minimum. Anything sensitive (browser history, clipboard, messages, anything that could contain
  credentials) must be **off by default** and documented in the README privacy table. Never capture file *contents* by default.
- **Cross-platform.** Support Windows, macOS and Linux (and WSL where relevant), or exit politely with a clear message. Use
  `execFileSync` with an argument array instead of building shell strings.
- Support `--dry-run`, export a `main()` and guard the entry point with `isMainModule(import.meta.url)` (see any existing engine)
  so the engine can be imported by tests.
- Add it to `sync-all.mjs`, the config defaults in `config.mjs`, the README, and add tests.

## Tests

We use [Vitest](https://vitest.dev). Tests live in `tests/` and use temporary vaults — they must **never** touch `~/.memvault`
or `~/.memvaultrc.json`. Set `VAULT_ROOT`, `HOME` and `USERPROFILE` to a temp folder **before** importing the module under test
(use dynamic `await import()`), as the existing tests do.

- Bug fix → add a test that fails without your fix.
- New MCP tool → add it to the expected list in `tests/mcp-server.e2e.test.js` and update the README tool count.
- Security-relevant changes (server, secrets, SQL, HTML) need tests for the hostile input, not just the happy path.

## Pull requests

1. Fork, create a branch (`git checkout -b fix/short-description`).
2. Make your change with tests. Run `npm test` and `npm run check`.
3. Update `CHANGELOG.md` (under *Unreleased*) and any docs you touched.
4. Open a PR describing **what** and **why**, and how you tested it. Small, focused PRs get reviewed fastest.

Commit messages: short imperative subject (`fix: stop re-importing renamed branches`); `feat:`, `fix:`, `docs:`, `test:`,
`chore:` prefixes are welcome but not required.

## Releasing (maintainers)

1. Update the version in `package.json` **and** `server.json` (the lock file via `npm install --package-lock-only`), and move the
   `CHANGELOG.md` *Unreleased* notes under the new version. `npm run check` verifies they agree.
2. Merge to `main` with CI green, then create a GitHub **Release** for tag `vX.Y.Z`.
3. The `Release` workflow publishes to npm with provenance (needs the `NPM_TOKEN` repository secret).
4. Publish the new `server.json` to the MCP registry with the official `mcp-publisher` tool
   (see <https://github.com/modelcontextprotocol/registry>).
