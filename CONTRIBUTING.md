# Contributing to MemVault

Thank you for helping. This guide takes you from a clone to a pull request.

By taking part you agree to the [Code of Conduct](CODE_OF_CONDUCT.md). Security problems go through [SECURITY.md](SECURITY.md), **not** public issues.

## Set up

You need Node.js 20 or newer and Git.

```bash
git clone https://github.com/MrChartist/memvault.git
cd memvault
npm install
npm test            # unit and integration tests (about 15 seconds)
npm run test:e2e    # dashboard tests in a real browser (needs Chrome or Chromium, see below)
```

**Never develop against your real vault.** Point the code at a scratch folder:

```bash
export VAULT_ROOT="$(mktemp -d)"
export MEMVAULT_TOKEN_FILE="$VAULT_ROOT/token"
node server.mjs          # dashboard and API on http://127.0.0.1:7799
node mcp-server.mjs      # MCP server on stdio
```

The browser tests need a Chromium-based browser. Set `CHROME_PATH` to its executable, or run `npx playwright-core install chromium`.

If `npm install` crashes with `Cannot read properties of null (reading 'edgesOut')`, that is a bug in npm 10. Use `npx npm@11 install`.

## How the code is organised

| Area | Files |
|---|---|
| The vault file (the only code that opens it) | `db.mjs`, `filelock.mjs` |
| The one door for writes: mask secrets, write once, copy to Markdown, audit | `ingest.mjs`, `redact.mjs`, `mirror.mjs`, `audit.mjs` |
| Agents, scopes, access key | `agents.mjs`, `profiles/`, `auth.mjs` |
| Dashboard and API | `server.mjs`, `public/` |
| MCP server and bridges | `mcp-server.mjs`, `mcp-bridge.mjs` |
| Automatic capture (all off by default) | `sync-*.mjs`, `sync-guard.mjs`, `git-log.mjs` |
| Importers | `import-*.mjs`, `import-common.mjs` |
| Settings and paths | `config.mjs`, `paths.mjs` |
| Backups and the Secure Vault | `storage.mjs`, `crypto-vault.mjs` |
| Command line | `cli.mjs`, `cli-tools.mjs`, `diagnostics.mjs`, `init.mjs` |

Ground rules. Most of them exist because a review found a real bug.

1. **Every write goes through `ingest()` or `createIngestQueue()` in `ingest.mjs`.** That is what masks secrets, writes in one locked step and records the write. Do not call `addItem` or `addItems` from new code that handles outside text, and never write to the vault with your own SQL.
2. **Only `db.mjs` opens the vault file.** Use `openVaultDb()` or `getVaultDb()`. Several programs share the file (the dashboard and each AI app), and `db.mjs` is what stops them overwriting each other.
3. **No SQL built from text.** Use `?` placeholders. For user text inside `LIKE`, escape `%`, `_` and `\`.
4. **Escape everything you put into the dashboard.** Use the existing `esc()` helper in `public/app.js`. The dashboard has a strict Content-Security-Policy, so no inline scripts or styles.
5. **Paths from people go through `paths.mjs`.** JSON settings and environment variables do not expand `~`. Use `resolveUserPath()` for command-line arguments, environment variables and wizard answers (relative means "the folder you are in"), and `expandHome()` for values read from the settings file (relative means "under the home folder"). Build paths with `path.join`, never with a hard-coded `/` or `C:\`, and never hard-code a personal folder.
6. **Do not add dependencies lightly.** MemVault installs with `npx` and has no native build step. That is a feature.
7. **Plain JavaScript modules for Node 20 or newer. No TypeScript build step.** Match the style of the file you are in.

## Adding or changing a capture engine

An engine is a `sync-<name>.mjs` script that builds entries and hands them to an ingest queue. These rules are what make it safe to run on a schedule on someone's real computer:

- **Off by default.** Call `requireEnabled()` from `sync-guard.mjs` first, add the setting to `config.mjs`, and list the engine in the README privacy table. Anything that can hold passwords or private messages (browser history, the clipboard) must stay opt-in. Never capture file contents by default.
- **Safe to run again.** Running twice must not add copies. Either give each entry its real `created_at` (its id is then derived from what it is, so a repeat is ignored), or set `upsert: true` on a "current state" snapshot such as system info, which replaces the earlier snapshot with the same source, title and `file_path` in the same scope. Set `file_path` when two snapshots can share a title. Notes without their own timestamp always get a new id; that is deliberate, because writing the same sentence twice on different days is two notes.
- **Never delete or overwrite vault data the engine did not create.**
- **Windows, macOS and Linux.** Support all three, or exit politely with a clear message. Use `execFileSync` with an argument list rather than building a shell command from text.
- Support `--dry-run`, and add the engine to `sync-all.mjs`.
- Add tests (see the next section).

## Tests

We use [Vitest](https://vitest.dev). Tests live in `tests/` and use throwaway folders. They must never touch the real `~/.memvault` or `~/.memvaultrc.json`: set `VAULT_ROOT`, `HOME`, `USERPROFILE` and `MEMVAULT_TOKEN_FILE` to a temporary folder **before** importing the code under test (use a dynamic `await import()`), or run the script in a child process with those variables, as the existing tests do.

- A bug fix comes with a test that fails without the fix.
- A new MCP tool is added to `tests/mcp-tools-smoke.test.js`, and the tool count in the README is updated.
- Changes to the server, secret masking, SQL or HTML need tests with hostile input, not only the happy path.
- Tests also run on Windows and macOS in CI. Use `path.join` and `pathToFileURL` for paths and imports, and compare real paths, not strings with `/`.
- Dashboard changes: run `npm run test:e2e`.

## Pull requests

1. Fork and make a branch (`git checkout -b fix/short-description`).
2. Make the change, with tests. Run `npm test`.
3. Update `CHANGELOG.md` and any documentation you touched.
4. Open the pull request and say **what** changed, **why**, and how you tested it. Small, focused pull requests are reviewed fastest.

Commit messages: a short imperative subject, for example `fix: stop re-importing renamed branches`. Prefixes such as `feat:`, `fix:`, `docs:`, `test:` and `chore:` are welcome but not required.

Translations, accessibility fixes and tests are especially welcome. A new starter pack of agents is a folder of JSON files in `profiles/`; see [docs/agents.md](docs/agents.md).

## Releasing (maintainers)

The steps, including the checks to run first and how to roll back, are in [docs/release.md](docs/release.md).
