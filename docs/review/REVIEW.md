# MemVault 3.0 — independent launch review

Reviewer: Claude (AI), on behalf of the owner. Branch: `mrchartist/ecstatic-clarke-e81ecc`, draft PR [#6](https://github.com/MrChartist/memvault/pull/6) into the PR #5 branch. Nothing was merged or force-pushed.

## 1. Verdict

**NO-GO for a public launch today. GO for the code itself.**

The code is in good shape after this pass: 363 unit and integration tests and 108 browser checks pass on Linux (Node 22). The blockers are things only the owner can do or that have never been run:

1. Nothing is published. `npx @mrchartist/memvault setup` has never run on a clean machine.
2. Windows and macOS now pass the tests, an install check and the dashboard browser tests in CI, but nobody has used the dashboard on either by hand.
3. No private way to report a security problem is confirmed switched on.
4. No demo exists.
5. Saving is slow beyond tens of thousands of notes (sql.js rewrites the whole file). This is a documented limit, not a blocker, if the post says so.

When items 1–4 are done and the Windows/macOS jobs are green (or the post says they are untried), the verdict becomes **GO**.

## 2. Claims ledger

| Claim | Where | Evidence | Result |
|---|---|---|---|
| 172 tests in 12 files pass | PR #5 / CHANGELOG | Ran at start: 172 passed, 12 files | TRUE (now 363 in 21 files) |
| Browser tests 54/54 | PR #5 | Ran at start: 54/54 | TRUE (now 108/108) |
| 29 tools, 23 for a bound agent | README | Counted from the server | TRUE |
| About 4.4k tokens of tool text | README | chars ÷ 4 estimate, not a tokenizer | TRUE as an estimate; wording now says so |
| Capture runs silently | 2.1 promo | Each engine was off or crashed (git found no commits, browser capture crashed) | FALSE. Corrected: everything automatic is off until switched on |
| "Your AI logs every prompt" | 2.1 promo | `vault_capture_prompt` was always offered | FALSE as stated. Now opt-in ("ONLY when the user asks") |
| "Nothing leaves your computer" | README / promo | What an AI reads goes to that AI's company | MISLEADING. Reworded in README, SECURITY.md, promo |
| Secrets are masked before saving | SECURITY.md | 48 of 63 common real formats slipped through; `source`, tags, upload names and audit were unmasked | PARTLY TRUE → fixed, now covered by tests; still pattern matching |
| Agents are isolated | SECURITY.md | A bound agent could activate another agent and forge handoffs with tags | PARTLY TRUE → fixed (INT/SEC below) |
| Secure Vault needs the password | SECURITY.md | Old vaults without the check accepted any password | FALSE for old vaults → fixed |
| No data lost under concurrent writers | SECURITY.md | 0 of 7,200 lost in three runs; but a paused writer could erase another's save | TRUE for the normal case; edge case fixed |
| Survives crashes | SECURITY.md | 200 SIGKILLs, no corruption; audit tail could tear | TRUE; torn tail fixed |
| Registry entry installs | `server.json` | Missing `mcp` argument; description over 100 chars | FALSE → fixed, validated against the published schema |
| Importers work with real exports | CHANGELOG | Dates lost, replies lost, one bad record lost the batch | FALSE → fixed |
| Works on Windows and macOS | README | Never run | UNVERIFIABLE here. Wording changed to "built and tested on Linux" |
| Accessible (WCAG 2.1 AA) | README | axe-core in light, dark, phone; keyboard; right-to-left | TRUE for automated checks only. No screen reader or user test |
| Zero telemetry | README | No outbound calls except opt-in Google Drive and AI features | TRUE (code search; no network call on a default run) |

## 3. Findings

Severity: P0 harms data or security now; P1 serious; P2 should fix; P3 minor. Commit is the commit that fixed it in this branch.

### Fixed

| ID | Sev | Area | Evidence | Impact | Commit |
|---|---|---|---|---|---|
| F-1 | P0 | Security | `vault_daily_digest` pasted the date into SQL | An AI (or injected text) could read or change any row, even outside an agent's scope | `21150a8` |
| F-2 | P0 | Privacy | Tags, `source`, upload file names and audit lines were saved unmasked | Secrets saved in plain text despite the promise | `c1f9051`, `5ab4129` |
| F-3 | P0 | Security | Masking regexes were quadratic | One crafted note could freeze the server (ReDoS) | `6b87acb` |
| F-4 | P0 | Security | A bound agent could activate another agent | Isolation could be dropped by the AI itself | `b41b214` |
| F-5 | P0 | Security | Old Secure Vaults accepted any password | The "vault" gave no protection | `b41b214` |
| F-6 | P0 | Data | A writer whose lock was taken over could save over the new holder's work | Silent loss of notes | `b9f88f8` |
| F-7 | P1 | Security | Handoff and acknowledgement were decided by tags anyone could write | Forged messages between agents | `02f8c61` |
| F-8 | P1 | Privacy | Resources and prompts were not audited; prompt logging was always offered | Reads not in the audit log; unexpected logging | `fd4110f` |
| F-9 | P1 | Privacy | Bridge processes got our whole environment | API keys leaked to third-party bridges | `f836134` |
| F-10 | P1 | Security | `memvault open` put the dashboard key on a command line | Key visible to other users in the process list | `790d186` |
| F-11 | P1 | Privacy | Deleting a memory left its Markdown copy | "Deleted" text stayed on disk | `bb751ee` |
| F-12 | P1 | Privacy | Masking missed 48 of 63 real formats | Tokens, webhooks, passwords in sentences got through | `40f4c0e` |
| F-13 | P1 | Data | Restore accepted any file | A wrong file could replace the vault | `b9f88f8` |
| F-14 | P1 | Function | Importers lost dates, replies and whole batches | Silent loss on first real use | `e5682e3` |
| F-15 | P1 | Function | Git capture found no commits; browser capture crashed | Advertised feature did nothing | `1accf61`, `e5682e3` |
| F-16 | P1 | Function | `server.json` could not install | Registry listing would fail | `1accf61` |
| F-17 | P1 | Function | Scripts started through a symlink did nothing | `npm i -g` would give silent commands | `c706fe7` |
| F-18 | P1 | Function | `memvault bridge` broke when the path had a space | Failure on many Windows names | `3c9d95e` |
| F-19 | P1 | Privacy | Computer-info capture saved host name, addresses, running programs | Unneeded personal data | `45f3013` |
| F-20 | P1 | Security | The data fence could be closed with unusual spellings | Stored text could pose as instructions | `117ef3d` |
| F-21 | P2 | Function | Two-letter and CJK words returned no results | Search broken for many users | `ef68185` |
| F-22 | P2 | Function | "Describe it in words" agent reader guessed wrongly | Wrong agent names and roles | `60e4f91` |
| F-23 | P2 | Security | Vault path shown to bound agents | Information leak | `117ef3d` |
| F-24 | P2 | UX | No edit, delete, pin or export; no settings screen | Users could not correct a wrong memory | `cb3c33b`, `a24cffb`, `6eba95b` |
| F-25 | P2 | UX | Claude Code command had the wrong order | Copy-paste setup failed | `c2ed58d` |
| F-26 | P2 | Data | Empty lock from a crash blocked writes for 15 s; files busy on Windows failed at once | Slow recovery, spurious errors | `b16ecbc` |
| F-27 | P2 | Release | CI only on main; no Windows/macOS; 11 advisories; licences and trademark notice missing | Weak release hygiene | `bb8fd31`, `b3f05e0` |
| F-28 | P2 | Docs | README and SECURITY.md overstated; no uninstall guide | Trust | `b3f05e0`, `b5f0674`, `61faeba` |

### Open

| ID | Sev | Area | Evidence | Impact | Status |
|---|---|---|---|---|---|
| INT-8 | P2 | Data | `scrub --apply` has no backup of the Markdown copies | A scrub cannot be undone for `.md` files | Open; roadmap |
| INT-9 | P2 | Performance | 100k notes: 0.65–1.9 s per write, ~1 GB peak; lock timeouts possible | Slow, not wrong | Documented; roadmap X1 (native SQLite) |
| SEC-7 | P3 | Security | Hostile backup blob can force scrypt work | Bounded delay only | Open |
| SEC-10 | P2 | Security | Audit chain detects edits but not removal of the end | Truncation not detected | Documented; roadmap X4 |
| SEC-11 | P3 | Data | `created_at` is not validated | Odd sort order | Open |
| SEC-13 | P2 | Security | Bridge presets use unpinned `npx -y`; no size cap | Supply-chain risk on first run | Open; roadmap X9 |
| PLAT-17 | P3 | Platform | VS Code `servers` key vs Cline/Roo label | Config may not load | Needs verification |
| PLAT-x | P3 | Platform | `setup-windows.mjs` added hidden start-up items without asking; clipboard used `xclip` only on Linux; `wmic` removed from newer Windows; no `windowsHide` | Windows/Linux polish | Fixed: the script now asks (`--yes`/`--remove`); clipboard tries xclip, xsel, wl-paste; disk size uses a built-in call; PowerShell window hidden |
| TST-10 | P3 | Privacy | Perplexity source URLs not masked | Rare secret in a URL | Open |
| TST-13 | P3 | Function | Files and system snapshots duplicate by design | Clutter | By design |
| UX-9 | P3 | UX | Loading states are partial | Blank moment on slow load | Open |
| REL-1 | P2 | Size | `docs/review/screenshots` is 2.7 MB | Larger clone | Owner decides |

## 4. What changed

All in 33 small commits (see `git log`). In short:

- **Security and privacy:** SQL binding, linear-time masking with 48 more formats, masked metadata, agent identity fixed, handoffs unforgeable, fence hardened, bridge environment cleaned, dashboard key kept off command lines, old Secure Vaults closed, vault path hidden.
- **Data safety:** lock ownership tokens, retried saves, safe restore with checks, torn-log repair, newer-schema refusal, stale-file cleanup, delete removes the Markdown copy.
- **Function:** importers (dates, replies, dedupe, per-record isolation), working git and browser capture, search for short and CJK words, registry entry, symlink and space-in-path launch, `memvault clipboard`.
- **Dashboard:** per-memory open, edit, pin, delete with Undo and export; select several with a typed confirmation; Settings (capture switches, projects, backup passphrase); trash; clear error and empty states; grade-8 wording; 44 px targets; two-tone focus ring.
- **Release hygiene:** CI for every PR, Linux Node 20/22/24, Windows/macOS (not blocking yet), install smoke test with a path containing a space and Devanagari, `npm audit`, licences, trademark notice, uninstall guide, rewritten launch copy.

No data format was changed. The backup file, database schema and audit log keep their layout (the audit reader is now more tolerant).

## 5. UI review

Checked as three people: a first-time non-technical user, a keyboard-only user, and a daily power user. Screenshots are in `docs/review/screenshots/` (`before-*` and `after-*`).

- **Before:** no way to fix or remove a memory; settings only in config files; jargon ("scope", "handoff") with no explanation; two controls under 44 px; Show/Hide button label mismatch (axe).
- **After:** every memory can be opened, edited, pinned, deleted (with Undo) and exported. Bulk delete needs the typed words `DELETE n` and makes a backup first. Settings has plain switches. Errors stay on screen until read. Focus moves to dialogs and back.
- **Checked automatically:** axe-core WCAG 2.1 AA in light, dark and phone layouts; keyboard use; right-to-left text; script-injection and CSP attacks.
- **Not checked:** a real screen reader, voice control, any disabled user, any real first-time user, Windows/macOS browsers, non-English interface (there is none).

## 6. Launch checklist

| # | Gate | Status |
|---|---|---|
| 1 | All unit and integration tests pass | **Done** — 363/363 (Linux, Node 22) |
| 2 | Browser tests pass | **Done** — 108/108 |
| 3 | Node 20 and 24 pass | **Done** — green in CI on commit `442c69e` |
| 4 | Windows and macOS tests pass | **Done in CI** (`d16b7d2`): unit tests, install check and the dashboard browser tests on both. Not tried by a person on a real Windows or macOS computer |
| 5 | `npm audit --omit=dev` clean | **Done** (locally) |
| 6 | Package contents checked (`npm pack`, 82 files) | **Done** |
| 7 | Secret scan of the repo and history | **Done** for pushed commits (GitHub push protection) |
| 8 | Published to npm and installed on a clean machine | **Not done** |
| 9 | Registry entry published | **Not done** |
| 10 | Private vulnerability reporting on | **Needs verification** (owner) |
| 11 | Trademark and contact details confirmed | **Needs verification** (owner) |
| 12 | Demo recording | **Not done** |
| 13 | Launch copy matches reality | **Done** (`docs/promo.md`, with a before-you-post list) |
| 14 | Release and rollback steps written | **Done** (`docs/release.md`) |

## 7. Remaining risks

- A bug on Windows or macOS is likely; nobody has run it there.
- Past tens of thousands of notes, saving is slow and memory use is high.
- Masking is pattern matching; unusual secrets get through. What an AI reads still goes to its company.
- A bridge started through `npx -y` runs unpinned third-party code.
- The audit log can lose its last lines without detection.
- Plain-text passphrase file (for scheduled encrypted backups) is a deliberate tradeoff: the file is mode 0600 and outside the vault.

## 8. Needs verification

- Windows and macOS behaviour (everything).
- Antigravity config path; Cline/Roo settings location; VS Code key name.
- Google Drive upload against a real account (never run).
- Real export files from ChatGPT, Claude, Gemini and Perplexity in their newest formats (tests use sample shapes).
- The token count (an estimate).
- Private vulnerability reporting switch.

## 9. Questions for the owner

1. Branch: I used `mrchartist/ecstatic-clarke-e81ecc` as required by the session, not `review/launch-pass`. Is that fine?
2. Do you want to enable private vulnerability reporting, and which email is the security contact?
3. npm name: `@mrchartist/memvault`. Do you own the scope? Publish with provenance (see `docs/release.md`)?
4. Trademark: the notice says what it can; is a registration planned?
5. The Windows and macOS CI jobs are now blocking (they are green). Switch this on in the repository's branch protection too if you want it enforced; I cannot see those settings.
6. Is the plain-text passphrase file in Settings acceptable, or should scheduled encrypted backups be removed?
7. Keep the 2.7 MB of screenshots in the repo, or move them to the release page?
8. Roadmap order: is native SQLite (X1) before or after Windows/macOS (N1)?

## 10. First CI run (found after the review was written)

The first CI run on the PR failed, although everything passed locally. Cause, all in tests or CI scripts, not product code as far as is known:

- Linux and macOS: the browser-capture test assumed a Linux folder and the local `XDG_CONFIG_HOME`. Fixed: the test now sets both and uses the right folder per system.
- Windows: tests used Unix quoting for git, a raw `D:\…` path as an import, and `/` paths for the `~` check; the install smoke test lost backslashes in the temp path. Fixed in the tests and CI script.
- Windows: two test files that import a script starting with `#!` failed with a syntax error. Probable cause is Windows line endings; `.gitattributes` now forces LF. Confirmed: Windows tests pass after that change (commit `442c69e`).

After the fixes, all 11 CI checks passed on `442c69e`: Linux Node 20/22/24, Windows and macOS tests and install checks, browser tests and the dependency audit. This shows the tests and a global install work there. It does not replace a person using the dashboard on Windows or macOS.

## Appendix: list licences of installed packages

```
node -e "const l=require('./package-lock.json').packages;const c={};for(const[k,v]of Object.entries(l)){if(!k||v.dev)continue;c[v.license||'?']=(c[v.license||'?']||0)+1}console.log(c)"
```
