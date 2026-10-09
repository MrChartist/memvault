# Changelog

## 3.0.0

### Fixed or changed after the independent launch review (before release)

An independent review ran the code, wrote a test for each finding, and fixed these. The full list, with evidence, is in [docs/review/REVIEW.md](docs/review/REVIEW.md).

**Security and privacy**
- A search tool's `date` argument was pasted into SQL and could read the Secure Vault's locked data; all MCP queries now use bound values.
- Secrets in a memory's **source** or **tags** were stored, copied to the readable Markdown file and written to the access log unmasked; file uploads skipped masking and the access log; `vault_remember` repeated the secret in its reply. All are masked now.
- Secret masking now covers many more real formats (JSON and quoted `.env` values, `Authorization:` headers, `curl -u`, URL passwords containing `@`, npm, PyPI, SendGrid, GitLab, Hugging Face, Twilio and Telegram tokens, webhook links, Azure and Google keys, PGP blocks, keys pasted without their end line). 48 of 63 test strings used to get through. Plain English after "password:" is no longer masked.
- The masking patterns were slow on some text (200 KB of ordinary dotted identifiers took 34 seconds, enough to freeze every AI app sharing the vault). They are now linear-time.
- An agent could read another agent's instructions and inbox with `agent_activate`, and could forge a handoff "from the owner" (or hide a real one) by typing tags. Fixed.
- Resources and prompts were not in the access log, and an agent limited to one tool still got every memory-reading resource and prompt. Fixed. The prompt-logging tool no longer tells every AI to log every prompt.
- A Secure Vault from an older version accepted the first password typed and skipped the wrong-password limit on some routes. Fixed.
- Bridges started other programs with your whole environment, including the backup passphrase. They now get a small one.
- `memvault open` no longer puts the dashboard key on a command line.
- Capturing "computer info" no longer saves the computer's name, network addresses or running programs; browser capture no longer saves anything after a `?` and skips local pages.
- Eleven dependency advisories that affected installed code are fixed (`npm audit --omit=dev` reports none).

**Data safety**
- A writer paused longer than the lock's age limit (a laptop asleep mid-save) could erase another writer's save. It now notices and redoes its write.
- Deleting a memory left its full text in the readable Markdown copy, and two notes with the same title on the same day overwrote each other's copy. Copies are now named with the memory's id, and removed or rewritten when the memory is deleted or edited.
- Restoring a damaged or wrong file replaced the live database. Restores are now checked first. A vault from a newer MemVault is refused instead of being re-labelled. A cut-off last line in the access log no longer stops later records. Leftover temporary files are cleaned up.

**Importers and capture**
- Importers kept the import day instead of each conversation's date, duplicated everything on a second run, lost every conversation before one bad record, dropped some Claude and Gemini replies, and imported ChatGPT answers the user had abandoned. All fixed. `import-all` now finds a Claude export next to other exports.
- Git capture found no commits at all (and broke on a quote in a message); browser capture crashed on every run; computer capture and each other capture script ignored the "off by default" setting when run directly; the Antigravity sync removed its old items before checking its folder. All fixed.

**Install and platform**
- `memvault bridge` (and storage commands through a symlink) silently did nothing when the install path had a space, non-Latin letters or a link. Fixed.
- The package registry entry (`server.json`) was too long for the registry and would have started the help text instead of the server. Fixed and checked against the published schema.
- Searches for two-letter words ("AI") and for Chinese, Japanese and Korean words found nothing. Fixed.
- CI now runs for every pull request, and adds Windows, macOS, an install check and a dependency audit.

**Dashboard**
- New: open, edit, pin, download and delete a single memory, with **Undo**; choose several and delete with a typed confirmation; a **Settings** screen (automatic saving, backups and passphrase, projects, text size and colours, download everything, delete everything, recently deleted).
- Fixed: notes were silently cut at 5000 characters; a wrong dashboard key gave no explanation; the first Secure Vault password was not asked twice; secret "Delete" could not be reached by keyboard; messages hid behind open windows; touch targets were 40 px, not the 44 px claimed; the focus ring was nearly invisible; page language did not match its text; lists were announced again on every search.
- The "describe it in words" reader no longer treats "I am a teacher" as the helper's job, no longer cuts names mid-word, and says so when the text is not English.
- Licences: the fonts' licence texts, a third-party licence list and a trademark notice are now included; `docs/uninstall.md` lists everything MemVault leaves.


**Fixed in the final launch pass (found by running the sync tools and importers repeatedly on a real tree)**
- Running a capture tool again no longer adds copies. Entries that carry their own time (commits, browser visits, imported chats) are recognised by what they are, and "current state" notes (computer info, VS Code extensions and projects, recent file activity, Antigravity, bridge resources) replace their earlier version. The capture and import scripts report only what was really new.
- A `~` in a setting or a command was treated as a folder named `~`. `vaultRoot`, sync folders, the Google Drive folder and the backup passphrase file in `~/.memvaultrc.json`, `VAULT_ROOT`, `--path`, `GIT_SCAN_ROOT`, the Antigravity folder and the setup wizard's answers now expand `~`. A relative `--path` means the folder you are in.
- The setup wizard kept Google Drive API upload switched on after you answered "no".
- `vault_get_context` and `vault_smart_context`: the most specific old note is no longer pushed out by hundreds of newer notes that match one common word; question filler such as "what did we decide about" is ignored; and with `freshOnly` the notes that were not shown yet stay available for the next call.
- ChatGPT exports that come as several `conversations-NNN.json` files (large accounts) import completely, from the unzipped folder or one file.
- Uploaded files with non-English names keep their name, and a wrongly named upload field answers "400", not "500".
- The documented command is `npx -y @mrchartist/memvault`; the bare `npx memvault` is a different package.
- New: `memvault --version`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, issue and pull request templates, and `docs/autostart.md`.

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
