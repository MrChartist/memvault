# Changelog

## Unreleased

Fixes found by installing the packed package and by testing each part again, plus documentation checked line by line against the code. Nothing here is on npm yet.

**Server workspace (new, off by default)**
- Three dashboard tabs for running MemVault on a server: **Server** (CPU, memory, disk, uptime, and PM2 apps and Docker containers with restart, stop, start and logs), **Terminal** (a shell in the browser, with touch keys for phones) and **Files** (browse and edit text files with line numbers; saves are atomic). Turn it on with `"security": { "workspace": { "enabled": true } }`. Every route needs the dashboard key or a paired device's key, files stay inside the chosen folder, and terminals, service actions and saved files are written to the audit log. xterm.js 6.0.0 ships in `public/vendor/`, so the strict CSP is unchanged. See [docs/workspace.md](docs/workspace.md).
- **Control other machines:** link another MemVault (a VPS, a work computer) with its address and a one-time pairing code, then pick it in the **Machine** list on the Server, Terminal and Files tabs. A phone paired with one dashboard can use every machine linked to it. Only the workspace routes are relayed, the linked machine's key stays on the server (`~/.memvault/machines.json`, 0600), and both sides audit the actions.

**Getting started list (new)**
- The welcome card on the Memory screen is now a checklist that ticks itself: MemVault installed, an AI app connected (by name, for example "Connected: Claude Desktop"), an AI has saved a memory, a first backup, and a backup passphrase. Three optional steps sit below it: an app tied to an agent, your other computers, and your phone. It is checked again whenever you come back to the browser window, and it is not shown on a phone. `memvault doctor` prints the same list, for a server with no browser.
- To know which app connected, MemVault keeps one small file per app in `~/.memvault/apps/`: only the name and version the app reports, the agent it is tied to, and when it connected. Nothing from your memory, and it never leaves your computer.

**Your devices (new)**
- One memory on all your computers: `memvault devices` (or **Settings → Your devices**) syncs this computer with your others through a folder you share between them (Syncthing, iCloud Drive, Dropbox, OneDrive, Google Drive or your own server). Each computer keeps its own full copy and writes one file of its own to the folder, encrypted with your sync passphrase. The newest change wins on every computer, deletions travel, Undo sticks, and a sync that would delete many notes takes a backup first. It runs every 5 minutes while the dashboard or an AI app is open, and with `memvault sync`. The Secure Vault, uploaded files and the access log stay on each computer. See [docs/devices.md](docs/devices.md).
- Your phone or tablet: `memvault devices hub --address https://…` lets the dashboard answer at a private address (for example `tailscale serve`; MemVault keeps listening on `127.0.0.1`), and `memvault devices pair` gives a one-time code that signs a phone in with a key of its own, which you can sign out on its own.
- The vault now records when each memory last changed and which were deleted (for sync). Older versions can still open it.
- Before release, a review tried to break device sync. What it found is fixed, each with a test:
  - Antigravity capture removed the Antigravity notes that came from your other computers, and the "current state" notes (system details, VS Code, watched folders) replaced other computers' notes of the same name. The next sync then deleted them on those computers too. Each computer now replaces only what it wrote itself.
  - Every update re-installed the starter agents with a new time, which undid your changes to them on other computers and brought deleted ones back. They now carry a fixed old time.
  - What to change is worked out again inside the write lock, so a note edited a moment ago on this computer is not overwritten by an older copy. A change that came from another computer is passed on to the computers that only sync with this one.
  - Each change is stamped later than the one before, even when a clock is behind. A new note counts as a change made now.
  - A restore reads the other computers' files again, so their newer changes come back. A computer whose settings folder was copied from another one notices and takes a new id.
  - Files in the shared folder are read only if they are plain files under 256 MB, and a file that asks for unusual key settings (which could make deriving the key take a very long time) is refused unopened. This computer's own file is written under a new random name and then renamed, so a link in the folder cannot redirect the write. A file that could not be read is tried again after 30 minutes or when it changes, not on every sync.
  - A phone's key can no longer make pairing codes, change a passphrase or the shared folder, or sign phones out, and the dashboard on a phone hides those controls.
  - Background sync runs in a separate process (hidden on Windows), so the dashboard does not pause while it works. Deletion records older than 180 days are removed.

**Your profile, Wispr Flow import and a security check (new)**
- **A central profile of you** (`memvault profile`, [docs/profile.md](docs/profile.md)): short facts about how you like things written, what you work on and the tools you use, offered to every connected AI app. Ten fixed headings; passwords, keys, ID numbers, health and money are refused. Learns from your own notes when you ask (preview first), and wraps a dictated request with your background (`memvault profile prompt`).
- Two MCP tools: `profile_get` (a bound agent gets a reduced view) and `profile_suggest` (an AI can only suggest; you accept with `memvault profile accept`). Owner routes for the same under `/profile`.
- **Wispr Flow import** (`memvault wispr <file-or-folder>`): notes and meeting summaries. The attendee list, every e-mail address (also inside the title or text) and share links are left out; secrets are masked before the text is shortened.
- **Final security check**: `docs/review/final-security-check.md` is a brief for Claude Opus or Fable that lists all 14 connections and the threat model, and `npm run security-review` (`scripts/security-review.mjs`) runs it through the Anthropic API. `--dry-run` shows the plan and a rough cost first. Reports go to `.security-review/` (ignored by git). The script is a maintainer tool: it is not in the npm package, and the SDK it uses is a development dependency.
- The source names `profile` and `profile-suggestion` are reserved in `ingest`, so only the profile module can write profile items.
- Fixed before merging, after a review of this work:
  - An agent allowed to read every project space (`project:*`, such as the starter Coordinator) could search the whole profile, including the parts `profile_get` holds back. The profile is now left out of every agent's copy of the vault, and out of "See what this agent can see".
  - Learning kept the names of people mentioned in dictation ("Priya, Rahul") and gave them to every agent. It now keeps only product-like terms. It no longer learns from what an AI app saved, and `vault_add` cannot label a note as typed or dictated by you (`manual`, `cli`, `wispr`).
  - The Wispr import kept e-mail addresses and share links that sat in a title or the text, and could cut a secret in half before masking it.
  - Importing a profile rewrote the vault once per fact; a file is now saved in one write. One app can no longer fill the suggestion queue or replace another app's suggestion. Hidden text-direction characters are removed from facts.
  - A bound agent's process no longer keeps a full copy of the vault open for the profile tools.
  - The security-review script stops outside a git checkout (instead of sending every file in the folder) and masks error messages, which can repeat an API key. A test no longer opens the real vault in your home folder.

**Security and privacy**
- A key or password that crossed the 80-character cut of a title was stored half-masked: its first part stayed in the title, and search returned it. This affected `vault_remember`, `vault_capture_prompt`, `vault_log_conversation`, git capture, the Gemini and Perplexity importers and Antigravity capture. Secrets are now masked first, and the title is shortened after that.
- Taking access away now works at once. An AI app tied to an agent checks the agent's profile again on every request. If you delete the agent, or change what it may read, write or use, the request is refused and that connection ends. Restart the app to connect with the new access. (Before, it kept the old access until the app was restarted.)
- `agent_define` with only a name used to replace an existing agent of that name with default settings (all tools, no read limits). It now updates that agent and keeps its permissions, and anything the AI leaves out stays as it was.
- Gemini features are off until you set `"ai": { "enabled": true }` in `~/.memvaultrc.json`. A `GEMINI_API_KEY` that happens to be set for another program no longer sends your notes to Google. The key can still come from the settings file or from `GEMINI_API_KEY`.
- `memvault open` only hands the dashboard key to a server that answers as MemVault, refuses to start when another program uses the port, and removes its short-lived key page when no browser could be opened.
- An agent is no longer shown the full path of the vault folder when it saves a note with `vault_add`.

**Data safety**
- A reload of the vault that failed (file busy, out of memory, a file from a newer MemVault) no longer leaves MemVault holding a closed database.
- A save that fails (for example, a full disk) is now dropped, instead of showing up anyway and being saved by the next write.
- A settings file with a mistake in it still loads as the defaults, but the dashboard's Settings, the backup passphrase and `memvault bridge add` now refuse to save and name the file, instead of writing an empty file over yours. Settings are saved in one step (a temporary file, then a rename).
- Short "file busy" moments on Windows no longer cut a normal wait for the lock short.
- A half-written last line in the access log (after a crash) is cut off before the next record, and `memvault audit --verify` calls it an interrupted write, not tampering. A damaged line in the middle still fails the check.
- Git capture saved the same commits again on every run and after every branch switch. Each commit is now stored with its hash and saved once. Every folder in `gitDirs` is scanned (before, only the first), and a repository found twice is read once.
- `memvault vault diary` also wrote the note into a daily file that deleting or editing could not find, so a deleted note's words stayed on disk. The copy is now named with the memory's id like every other copy, so it goes when the note goes.
- The daily digest and the daily brief use your local day, not the UTC date.
- An owner connection that tries to acknowledge an agent's handoff is told it cannot, instead of being told it did.
- Tools that take a limit refuse a fraction (such as 2.5) with a clear message instead of failing.

**First run**
- `memvault init`: pressing Enter at a capture question keeps it off. Git and VS Code used to default to "yes", although the wizard says everything is off unless you say yes. A second run keeps what was already on, and keeps storage settings it does not ask about, such as the backup passphrase file.
- `memvault <command> --help` explains the command instead of running it.
- `mcp-config`: a copy started by `npx` now points your AI app at `npx -y @mrchartist/memvault mcp` (on Windows `cmd /c npx …`) instead of npm's cache folder, which npm may clear at any time. A normal install points at the `node` found on your PATH (so a Homebrew upgrade of Node does not break it) and at the installed `mcp-server.mjs`. `--agent` with no name and `--all-agents` with no agents explain themselves, and the tip names an agent that setup really installs (`study-buddy`). A hint for Claude Code is listed.
- A copy started by `npx` shows `npx -y @mrchartist/memvault …` in its messages, because npx adds no `memvault` command. Other messages name `memvault …` commands instead of internal scripts, and link to the docs on GitHub.
- `memvault backup list`, `memvault backup restore <name>` and `memvault backup restore-encrypted <file>` work for every install, with plain usage messages. `restore-encrypted` takes the passphrase from Settings or `MEMVAULT_BACKUP_PASSPHRASE`. A restore says where your previous vault was kept (a `pre-restore-…` file in the backups folder). A mistyped backup command is refused.
- Plain messages instead of error dumps for a missing or broken agent file and for a backup that does not exist. `memvault import` of a folder that does not exist now fails (exit code 1).
- Stopping `memvault serve` (Ctrl+C, `kill`, a service manager) also stops the server it started.
- The bridge client reports MemVault's real version to the servers it connects to.

**Website**
- A first draft of a product page in `site/`: one self-contained HTML page with the official logo, fonts and screenshots, loading nothing from other websites. `.github/workflows/pages.yml` publishes it to GitHub Pages once the owner switches Pages on. It is not part of the npm package. `npm run screenshots` retakes the README and site screenshots from a throwaway vault.

**Documentation**
- The README opens with a short note from the author on why MemVault exists, a contents line and a tests badge. It has new sections for the Getting started list, your profile, and "Open source" (how to help, most useful first). `.gitignore` also keeps MemVault's own backup and sync files (`*.mvbak`, `*.mvsync`) out of git.
- The README says plainly that MemVault is **not on npm yet**, and shows the install from the source code as the way to start today. After the first release: `npm install -g @mrchartist/memvault` (recommended) or `npx -y @mrchartist/memvault …` for every command. The same fix is in `docs/mcp-bridge.md`, `docs/google-drive.md`, `docs/release.md` and the bug report form.
- GitHub's private vulnerability reporting is switched off (checked on 2026-10-11). SECURITY.md and the issue forms keep it as the intended route and give an interim one: open an issue titled "Security contact needed" with no details, and the owner replies with a private way to send them.
- The README tools table gives `vault_secret_list` its own row (offered to an agent only with `memory.allowSecrets: true`), lists `agent_define` as owner-only, and lists `vault_weekly_digest` with the Gemini tools it depends on. It explains that Gemini needs `"enabled": true`, that revoking an agent ends its connection, that Antigravity capture exists (switched on only in the settings file), how to back up and restore with `memvault backup …`, and what the WSL2 scripts do.
- SECURITY.md: CI passes on Windows and macOS but nobody has used them by hand; an agent writes to `shared`, its own space and any spaces its profile lists as writable.
- `docs/agents.md`: the button is **Copy instructions**; the warning badge and when it appears; `agent_define` only on an app connected without an agent, and it keeps an existing agent's permissions. `docs/uninstall.md`: entry names use the agent's id, where npx keeps its copy (`npm cache clean` does not remove it), and `node setup-windows.mjs --remove`. `docs/google-drive.md`: `memvault backup …` commands and the Settings passphrase.
- The npm package ships only the user guides from `docs/`, not the launch copy or the release checklist.
- ROADMAP and `docs/review/REVIEW.md` have dated status notes (2026-10-11).

**Dependencies**
- sql.js 1.14.2 and zod 4.6.5. For development: vitest 5.0.3, and the CI workflows use `actions/checkout@v7` and `actions/setup-node@v6`.

**Upgrade notes**
- **Gemini users:** add `"enabled": true` to the `"ai"` block of `~/.memvaultrc.json`, or the Gemini tools only answer that AI is off. (If you typed your key into `memvault init`, it is already set.)
- **Git capture:** commits saved from now on no longer show the branch and the folder in their text (the branch is still in the tags). Commits saved before keep their text and are not saved a second time.
- **Agents:** after you change an agent's access, restart each AI app tied to that agent.
- **Older diary notes:** notes added with `memvault vault diary` before this change are also in a daily file (`entries/<year>/<month>/<date>.md` in the vault folder) that deleting the note does not remove. Delete those files by hand if you need to.
- **Older titles:** a note saved earlier through an AI app may hold the first part of a key in its title. `memvault scrub` may not recognise a part of a key, so look for such notes yourself if you pasted keys into an AI app.

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
- Sync engines, importers, the CLI and bridges write directly to the vault in one batched step: no server needed, and 200 imports take well under a second instead of about 17 s.
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
