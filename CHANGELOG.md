# Changelog

## 3.0.0

A safety, efficiency and accessibility release, and the introduction of agents.

### Added
- **Agents**: saved profiles (job, voice, always/never rules, brand, memory access) that any AI can become. Starter packs (`general` by default). Handoffs between agents. Tools: `agent_list`, `agent_activate`, `agent_define`, `agent_handoff`, `agent_inbox`, and an `activate_agent` prompt.
- **Memory spaces** (`shared`, `agent:<id>`, `project:<name>`) with isolation enforced on the data. Bind an AI app to an agent with `MEMVAULT_AGENT` (`memvault mcp-config --agent <id>`).
- **Secret masking** on every write path: keys, tokens, passwords, cards, one-time codes, and national IDs (US SSN, UK NI, Canadian SIN, IBAN, Aadhaar, PAN).
- **Access key** for the API; Host and Origin checks; strict Content-Security-Policy.
- **Tamper-evident audit log** and `memvault audit`.
- **Encrypted cloud backups** (AES-256-GCM, scrypt) and `restore-encrypted`.
- Commands: `setup`, `open`, `doctor`, `scrub`, `agent`, `audit`, `token`, `mcp-config`.
- **Dashboard rebuilt**: first-run guide, "Connect an AI app" instructions, plain-language agent form, text-size control, Security page with live checks. Uses the Mr. Chartist brand, with self-hosted fonts.
- Accessibility: WCAG 2.1 AA contrast, keyboard use, screen-reader labels, 44px touch targets, right-to-left text, forced-colours mode. Locale-aware dates.
- `POST /add-many`, `GET /stats`, `GET /status`, `GET /audit`, `GET /mcp-config`.

### Changed
- **The server listens on 127.0.0.1 only** and needs a key. (2.x listened on 0.0.0.0 with `Access-Control-Allow-Origin: *` and no authentication.)
- The Secure Vault uses scrypt with a random salt per item (2.x: PBKDF2 with one fixed salt). Old items still open and upgrade on first use. Master passwords must be 10+ characters when first set; 5 wrong tries lock it for a minute.
- **Cloud backups are refused without a passphrase.** Drive folder mirror now writes one encrypted file and no longer includes your local path in its manifest.
- `POST /clear` needs an explicit confirmation phrase and takes a backup first.
- Automatic capture is **off by default** and the browser scan works on Windows, macOS and Linux (not only WSL). Config files written by older versions keep working.
- Sync engines, importers, the CLI and bridges write directly to the vault in one batched step: no server needed, and 200 imports take 0.13 s instead of 17 s.
- Reads right after a write are about 50× faster; the database is no longer re-parsed on every write by a single writer.
- Starter agents default to a general-purpose pack; project detection is user-configured (`projects`) instead of built in. Tag rules no longer treat everyday words ("rest", "go", "session") as code topics, and cover study, writing, planning, travel and food.
- Dates and times use your own locale.

### Fixed
- **Lost writes**: several processes (server plus each AI app) overwrote each other's changes (200 of 300 writes lost in a test). Writes now lock, re-read the freshest file, and replace it atomically.
- `vault_smart_search` and `vault_ai_summarize` always failed (they queried a table that does not exist).
- **`sync-antigravity` deleted the whole vault** on every run. It now replaces only items it created, after taking a backup.
- Stored script injection in the dashboard (entry fields were not escaped).
- SQL injection in the `user_context` prompt and `vault_ai_insights` (text pasted into queries).
- Searches containing `+`, `[` or `(` crashed the relevance scorer.
- The markdown copy of an entry could contain a secret the database had masked.
- The server printed "running" and exited silently when its port was already in use.
- `sync-browser` left a browser-history copy in `/tmp` after an error and failed on Windows paths; `mcp-bridge` could overwrite the vault with a stale copy.
- Config files holding API keys and Drive credentials are now private to your account.

### Removed
- Hard-coded personal paths and names (`D:\AG`, `/mnt/d/AG/Vault`, usernames), the manual `test.sh`, `test-secrets.sh`, `test-add.json`, and the generated `run-sync-silent.vbs`. Launcher examples now live in `examples/` with placeholders.
- `Investology`, `TradeBook` and other personal project names from the project detector.

### Upgrading
See the "Upgrading from 2.x" section of the README. Run `memvault doctor`, then `memvault scrub`.
