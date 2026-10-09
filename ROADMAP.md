# Roadmap

This plan comes from an independent review of 3.0 that ran the code. Numbers quoted here were measured on one Linux machine (4 cores, Node 22) and are marked as such. Effort is **S** (days), **M** (weeks) or **L** (months) for one person. "Success" says how we would know it worked.

The order is a decision, not a wish list. Items are in the order they should be done, and the reasons for changing the original order are at the end.

---

## Now: before a public launch

These are blockers. The verdict in [docs/review/REVIEW.md](docs/review/REVIEW.md) depends on them.

### N1. Run it on Windows and macOS, and make CI green there
- **Problem.** Every test and every manual check so far ran on Linux. Windows and macOS paths (file locking, file permissions, browser-history folders, `memvault open`, launchers) have never run. CI jobs for both now exist but are not blocking, and have never run.
- **Who benefits.** Most non-technical users are on Windows or macOS.
- **Approach.** Push the branch, read the first Windows and macOS results, fix what fails, then make those jobs blocking. Then do a clean-machine install by hand on one real Windows and one real macOS computer.
- **Effort.** S to M (depends on what fails). **Risk.** Medium: file locking and renaming behave differently on Windows, and the retry added in this review is only tested with simulated errors.
- **Success.** All CI jobs green on 3 systems × Node 20/22/24; a person who has never seen MemVault gets from nothing to "Claude remembers my preference" on Windows without help.

### N2. Release process, provenance and a way back
- **Problem.** Nothing is published. There is no recorded release or rollback procedure.
- **Approach.** Write `docs/release.md` (done in this review as a draft); publish from CI with `npm publish --provenance`; attach a software bill of materials; tag the release; keep the previous version installable. If a release is bad: `npm deprecate` the version at once and publish a fixed patch; `npm unpublish` is only possible for a short time after release and should not be relied on.
- **Effort.** S. **Risk.** Low. **Success.** `npx @mrchartist/memvault setup` works on a computer that has never had MemVault; the package page shows a provenance badge; a rollback was practised once on a test version.

### N3. A working private security contact
- **Problem.** SECURITY.md points to GitHub private vulnerability reporting, which the owner must switch on.
- **Approach.** Switch it on, send a test report to yourself, add a fallback email if the owner wants one.
- **Effort.** S. **Success.** A test report arrives privately.

### N4. A demo and a clean-machine walkthrough
- **Problem.** There is no demo asset and no recorded first-run on a clean machine.
- **Approach.** Record one 2-minute screen recording from a clean install (set up, connect Claude Desktop, say "remember I prefer short answers", open the dashboard). Use it as the launch asset.
- **Effort.** S. **Success.** The recording matches the README steps exactly.

### N5. A way to connect Claude Desktop without editing a file
- **Problem.** The hardest step for a non-technical person is hand-merging JSON into `claude_desktop_config.json` (the review counted about 19 actions from zero on Windows, with several likely stopping points).
- **Approach (interim).** `memvault mcp-config --install claude-desktop` merges the entry for the right operating system, after taking a copy of the file. (The proper fix is N-next-2, a one-click extension.)
- **Effort.** S. **Risk.** Low (backup first; never overwrites other servers). **Success.** A new user connects Claude Desktop with one command and no file editing.

---

## Next: 0 to 3 months

### X1. A real SQLite engine
- **Problem.** The database library (`sql.js`) loads the whole file into memory and rewrites it on every save. Measured: 1,000 notes: a save takes about 9 ms. 10,000 notes: 71 ms (172 ms slowest). 100,000 notes: 0.65 seconds typical, 1.9 s slowest, and the writing program uses about 1 GB; five programs (one server plus four AI apps) would need roughly 4 GB. With three writers at 10,000 notes the same job took 10.6 s against 0.9 s on a native engine. There is also no full-text index.
- **Who benefits.** Anyone with more than a few tens of thousands of notes, and anyone running several AI apps at once.
- **Approach.** Put a small adapter behind `db.mjs`. Use Node's built-in `node:sqlite` (WAL mode, FTS5) when it exists (Node 22+); keep `sql.js` unchanged on Node 20 with a warning above about 20,000 notes. The same file format works for both, so no conversion is needed. Do **not** make `better-sqlite3` a requirement: the review found it needs Node 22+, segfaulted on Node 20, and needs a compiler on some systems. Agent isolation today works by deleting rows from a private copy; it must be re-done as a filtered view and given a new isolation test before anything ships. Backups must switch to `VACUUM INTO` (a plain file copy is unsafe with WAL). `node:sqlite` is still marked experimental, which is a risk to watch.
- **Effort.** L. **Risk.** High (this is the security-critical isolation code). **Success.** At 100,000 notes a save is under 50 ms and a process stays under 150 MB; every existing isolation and integrity test passes on both engines; a search for a rare word is under 100 ms.
- **Note on search quality.** The review compared the current search with FTS5 on 20 labelled queries: about equal overall (precision 0.53 vs 0.52). FTS5 is better for plurals and accents; the current search is better for Chinese, Japanese and Korean and for parts of words. So FTS5 must keep a fallback for those. Neither understands meaning (X5).

### X2. A one-click extension for Claude Desktop
- **Problem.** Needing Node and a terminal is the biggest barrier. Claude Desktop can install a packaged extension (an `.mcpb` bundle) that ships its own Node.
- **Approach.** Build the bundle in CI, sign it, and add a "Open the dashboard" tool because there is no terminal. Then Cursor and others follow their own conventions.
- **Effort.** M (about 1 to 2 days to a first version, then weeks of testing; the bundle format and manifest still need to be checked against the current specification: *Needs verification*). **Risk.** Medium. **Success.** A non-technical person installs by double-clicking and never opens a terminal.

### X3. Ask before giving an agent more access
- **Problem.** Permission changes today happen only by the owner editing in the dashboard or the CLI. An AI that needs more access cannot ask.
- **Approach.** An agent can post a "request" (visible only to the owner, never applied automatically). The dashboard shows it with Approve and Deny. Approving writes the permission; the AI never can.
- **Effort.** M. **Risk.** Medium (must not become a path for an AI to talk the owner into approving). **Success.** The request text is always shown with the exact permission being granted; a test proves a request alone changes nothing.

### X4. A keyed, externally anchored access log
- **Problem.** The log's hash chain does not detect records cut from the end or a whole-file rewrite (verified in the review).
- **Approach.** Add a secret key (HMAC) held outside the vault, and let the dashboard export a short "head" value to keep elsewhere.
- **Effort.** S. **Success.** Truncating the log or rewriting it is detected.

### X5. Memory that stays tidy
- **Problem.** Over months the vault fills with duplicates and stale notes, and there is no "forget".
- **Approach.** Optional expiry per memory, duplicate detection with a "merge" suggestion, periodic summaries the owner approves, and a "forget everything about X" action (with a plan for backups and the Markdown copies).
- **Effort.** M. **Risk.** Medium (deleting the wrong thing). **Success.** A one-year-old vault can be reduced by a measured share with the owner approving every change.

### X6. Translations, and how to get them reviewed
- **Problem.** The dashboard is English only; the page language is now correctly marked English.
- **Approach.** Move every string into one table (the plain-language pass already made them short). Start with Hindi, Spanish and Arabic (which also exercises right-to-left). A machine translation is only a draft: every language needs a native speaker to review it before release. Ask volunteers through the project page, and offer paid review for the languages where none come forward.
- **Effort.** M. **Success.** Each shipped language has a named native reviewer and a screenshot test in that language.

### X7. An accessibility review with real people
- **Problem.** Only automated tools and scripted keyboard checks have been run. No real screen reader, no voice control, no disabled users.
- **Approach.** Test with NVDA (Windows), VoiceOver (macOS/iOS), TalkBack, and voice control; pay disabled testers and fix what they report. Publish an accessibility statement with the findings.
- **Effort.** M. **Success.** A written report from at least five testers using their own tools, with every blocking issue fixed.

### X8. Signed releases and a software bill of materials
- **Approach.** Provenance (N2) plus a CycloneDX bill of materials per release and signed tags. Re-run a licence and `npm audit` check in CI (the audit job exists).
- **Effort.** S. **Success.** Each release links to its build and its bill of materials.

### X9. Safer bridges
- **Problem.** The built-in bridge presets run `npx -y <package>`, which downloads the newest version each time, and bridge output has no size limit.
- **Approach.** Pin exact versions with a hash check, cap what a bridge can return, and show the owner exactly what will run before first use.
- **Effort.** S. **Success.** A new release of a bridge package does not run until the owner approves the update.

### X10. Smaller tool list
- **Problem.** The 29 tools cost about 4,400 tokens in every chat (an estimate: characters ÷ 4) and some overlap (`vault_search`, `vault_smart_search`, `vault_get_context`, `vault_smart_context`).
- **Approach.** Merge overlapping tools behind clearer ones, keeping old names working for one release. Measure with a real tokenizer.
- **Effort.** M. **Risk.** Medium (AI apps may depend on tool names). **Success.** At least 30% fewer tokens with the same results on a fixed set of tasks.

---

## Later: 3 to 12 months

### L1. Local semantic search
- **Problem.** Search finds words, not meaning (paraphrases and typos scored zero in the review).
- **Approach.** Optional local embeddings (for example through Ollama or a small bundled model), stored next to each memory, combined with word search. Off by default; nothing leaves the computer.
- **Effort.** L. **Risk.** Medium (size, speed, language coverage). **Success.** On a labelled set, paraphrase queries find the right note in the top five at least 60% of the time.

### L2. Encrypted sync between your own devices
- **Problem.** One computer only; people use several.
- **Approach.** End-to-end encrypted sync with a key only the owner holds, with conflict handling designed first (the lock-file design cannot be used over a shared drive).
- **Effort.** L. **Risk.** High (data loss, key loss, conflicts). **Success.** Two devices converge after offline edits with no lost note in a long randomised test.

### L3. Several people on one computer
- **Approach.** One profile per operating-system user, each with its own vault and key; the dashboard shows only the current profile's data.
- **Effort.** M. **Success.** A second account cannot read or reach the first account's vault.

### L4. Import and export standards
- **Approach.** A documented JSON export (exists), import of that file, Markdown export, and import from other memory tools. Re-check each AI service's export format on a schedule.
- **Effort.** M. **Success.** A vault round-trips (export, import, compare) with no change.

### L5. A safe way to share agent packs
- **Problem.** Packs are folders of JSON; sharing them means trusting strangers' rules.
- **Approach.** Packs as data only (never code), validated against a schema, shown to the owner before install, with an optional signature.
- **Effort.** M. **Risk.** Medium. **Success.** A pack cannot change permissions beyond what the owner confirms.

### L6. Package managers and a single-file app
- **Approach.** winget, scoop and Homebrew entries; then a single executable (Node's single-executable feature) if X2 is not enough. Windows needs code signing, which costs money and time.
- **Effort.** M to L. **Success.** Install without Node on all three systems.

### L7. A documentation site
- **Approach.** Task-based pages (connect each app, back up, move computer, uninstall), screenshots, and translated pages after X6.
- **Effort.** M. **Success.** The top five support questions are answered by a page.

### L8. Community and governance
- **Approach.** CONTRIBUTING and a code of conduct, issue templates (including a "this does not work for me" accessibility template), a stated policy on response times, and a second maintainer with access to releases.
- **Effort.** S, ongoing. **Success.** Someone other than the owner has shipped a fix.

---

## Not doing, and why

| Not doing | Why |
|---|---|
| Whole-vault encryption inside MemVault | The key has to live somewhere the same computer can read, so it protects little beyond what disk encryption (BitLocker, FileVault, LUKS) already does. The docs tell people to turn that on. Revisit with multi-device sync (L2), where it matters. |
| A hosted MemVault, accounts or sign-in | It would break the central promise: your notes stay on your computer. |
| Any telemetry or analytics, even optional | Trust is the product. Learn from issues and interviews instead. |
| Logging every prompt by default | Private prompts would land in shared memory. It is now opt-in and says so. |
| Rewriting the dashboard in a framework | No evidence it is needed. The plain HTML needs no build step, keeps the strict content policy simple, and is passing 108 browser checks. Revisit only if the interface grows past what one person can keep consistent. |
| A mobile app | Different security model and a large cost; the dashboard already works on a phone screen. |
| Sandboxing bridge programs | Too large for now. X9 reduces the risk; the docs say a bridge runs as you. |
| Claiming "100% safe" | Not true of any software. The documents say what is and is not protected. |

---

## What changed from the original plan, and why

- **"A real SQLite engine" stayed first in Next, not Now.** The measured limit (tens of thousands of notes) does not affect launch users, and a rushed change to the isolation code would be riskier than the limit.
- **"A zero-terminal installer" was split.** A one-command Claude Desktop connect (N5) is a launch blocker because it is cheap; the real one-click extension (X2) is next. A desktop wrapper and package managers moved to Later (L6) because they cost signing fees and have the highest maintenance load.
- **"Local embeddings" moved to Later.** Search quality today is a tie with a native index; embeddings are the only fix for meaning, but they are large and need a language plan.
- **"Approval prompt for more access" moved up** (X3), because the review found a bound agent cannot ask for access at all, which pushes owners toward wide-open settings.
- **"Docs site" moved to Later:** the README, SECURITY.md and `docs/` are enough until translations exist.
- **Added: N1 (Windows and macOS), X4 (log anchoring), X9 (safer bridges).** The review found these gaps; none were in the original list.
