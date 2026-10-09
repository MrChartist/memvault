# Changelog

All notable changes to MemVault are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [2.1.0] - Unreleased

First public release.

### Security
- The web server now listens on `127.0.0.1` only (was `0.0.0.0`). Set `"host"` / `VAULT_HOST` to change it; a warning is printed
  for non-loopback addresses.
- Blocks drive-by access from web pages: `Host` header check (DNS rebinding), `Origin` / `Sec-Fetch-Site` checks, **no** wildcard
  CORS, strict Content-Security-Policy and other security headers.
- Removed the unauthenticated `POST /clear` endpoint that could wipe the whole vault.
- Fixed SQL injection in `vault_daily_digest`, `vault_ai_insights` and the `user_context` prompt; all queries are now parameterised
  and `LIKE` wildcards in user text are escaped.
- Fixed stored cross-site scripting in the web UI (entry `source`, secret field names, secret values were not escaped).
- Secure Vault: PBKDF2 now uses 600,000 iterations with a random salt per secret (existing secrets keep working); master password
  must be at least 8 characters; repeated wrong guesses are throttled.
- Fixed path traversal in backup restore; restore now validates that the backup is a real SQLite database.
- Dependencies updated; `npm audit` reports 0 vulnerabilities (was 1 critical, 11 high).
- Gemini API key is sent in a header instead of the URL.
- Bridges receive a minimal environment instead of all of `process.env`.
- `~/.memvaultrc.json` is written with owner-only permissions.
- The web UI no longer loads Google Fonts (no third-party requests).
- The clipboard engine skips text that looks like credentials.

### Fixed
- **`sync-antigravity` deleted the entire vault** before checking that Antigravity was installed. It never deletes anything now and is off by default.
- Web server and MCP server each kept a private in-memory copy of the database and overwrote each other's writes. All processes now share one
  database layer with cross-process locking and atomic writes.
- `vault_smart_search` and `vault_ai_summarize` always failed (they queried a full-text table that never existed).
- `vault_remember`, `vault_capture_prompt` and `vault_log_conversation` failed unless the web server happened to be running.
- Searching for text such as `c++` or `(` crashed `vault_smart_context` (unescaped regular expression).
- Sync engines re-added every item on every run. Entries are now de-duplicated; snapshots are replaced in place.
- Imported conversations lost their original dates (they were stamped "now").
- `sync-git` silently dropped commits whose message contained a double quote.
- `memvault backup` / `memvault bridge` printed nothing on Windows and in paths containing spaces (entry-point detection).
- VS Code project paths lost their leading `/` on Linux and macOS.
- Browser engine: skip patterns never matched real URLs; Windows-only/WSL-only profile paths replaced with per-OS detection.
- `wmic` (removed from current Windows) replaced with PowerShell for disk info.
- Daily digests used the UTC day instead of your local day.
- `backup` returned success when a Google Drive upload failed.
- Documentation and the setup wizard told users to run `npx memvault …`, which is a *different* npm package; they now use `@mrchartist/memvault`.

### Changed
- Capture engines write directly to the vault; the web server no longer has to be running for `sync`, `import`, `bridge` or the MCP tools.
- Privacy-sensitive engines (browser history, clipboard, Antigravity) are off by default and the defaults are merged with partial user settings.
- Project detection is configured with `"projects"` in `~/.memvaultrc.json` (the built-in list of the author's projects was removed).
- `POST /add/batch` and `GET /stats` added; the UI uses `/stats`.
- `memvault --version`, `memvault vault search`, `memvault backup restore`; `help` exits with status 0.
- Package ships only what it needs (`files` whitelist); `server.json` and `package.json` versions are kept in sync by `npm run check`.

### Added
- Documentation: privacy table, security model (`SECURITY.md`), `CONTRIBUTING.md`, Code of Conduct, autostart guides.
- Test suite grew from 19 to 160+ tests (database concurrency, server hardening, secrets, sync engines, importers, MCP end-to-end, CLI).
- CI on Linux, macOS and Windows; dependency review automation.
