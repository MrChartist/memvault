# TASK: Independent launch review and finishing pass for MemVault 3.0

## 1. Your role

You are a senior engineer, security reviewer, accessibility specialist and product designer. You are taking over a project that was built by someone else (an earlier AI coding session). You are its independent reviewer **and** its finisher.

Treat every claim in the README, SECURITY.md, CHANGELOG and the PR description as a hypothesis to test, not as a fact. Be demanding of the code and kind to the end user.

**Goal:** make MemVault ready for a public launch, for everyone: all ages, abilities, languages and technical skill levels. Find the big problems, fix what you can with tests, redesign what needs it, and write the roadmap.

## 2. The project

MemVault is a local-first "one memory for every AI". A user's AI apps (Claude, Cursor, Antigravity, VS Code, any MCP client) read and write one private memory on the user's own computer.

- Stack: Node.js 20+ (ESM), sql.js (SQLite in WASM), Express 5, the MCP SDK (stdio, one server process per AI app), zod. Dashboard is static HTML/CSS/JS with no build step.
- Key ideas: shared / private / project memory spaces; **agents** (saved profiles: job, voice, always/never rules, brand, memory access) that any AI can become; handoffs between agents; secret masking on every write; encrypted cloud backups; tamper-evident audit log.
- Brand: Mr. Chartist (MrChartist.com). Official logo SVGs and colour tokens are in `public/brand/`. Never invent, redraw or alter the logo.
- Repo: https://github.com/MrChartist/memvault
- Start from branch `mrchartist/tender-thompson-0diky3` (draft PR #5 into `main`).

## 3. Get oriented first (do not skip)

```bash
git checkout mrchartist/tender-thompson-0diky3 && npm install
npm test                      # expect 172 passing tests in 12 files
npm run test:e2e              # expect 54/54; needs Chromium: set CHROME_PATH or run `npx playwright-core install chromium`
node cli.mjs setup && node cli.mjs doctor
npm pack --dry-run            # what would be published
```

Read, in this order: `SECURITY.md`, `CHANGELOG.md`, `README.md`, `docs/agents.md`. Then the code:

| Area | Files |
|---|---|
| Storage | `db.mjs` (lock, atomic write, scoped read copies), `filelock.mjs`, `storage.mjs` (backups), `crypto-vault.mjs` |
| Single write path | `ingest.mjs` → `redact.mjs` → `audit.mjs` |
| Access | `auth.mjs`, `server.mjs` (API and dashboard), `mcp-server.mjs` (AI-facing tools, `MEMVAULT_AGENT` binding) |
| Agents | `agents.mjs`, `profiles/general`, `profiles/markets` |
| CLI | `cli.mjs`, `cli-tools.mjs`, `init.mjs`, `diagnostics.mjs` |
| Capture and import | `sync-*.mjs`, `import-*.mjs`, `mcp-bridge.mjs` |
| UI | `public/index.html`, `public/app.css`, `public/app.js` |
| Tests | `tests/*.test.js`, `tests/e2e/dashboard.e2e.mjs` |

## 4. Invariants: never weaken these without the owner's explicit approval

If you believe one should change, write the argument and ask. Do not change it quietly.

1. The server listens on loopback only, needs a key on every data route, checks Host and Origin, sends no CORS headers, and sends a strict CSP (no inline script or style, no third-party origins).
2. Every write goes through `ingest.mjs` (mask, then one batched atomic write, then audit). No path may store or mirror unmasked text.
3. Agent isolation is enforced **on the data** (a filtered copy), identity comes from `MEMVAULT_AGENT`, and a missing profile stops the server. Never from anything the AI says.
4. Owner-only tools are never offered to a bound agent. `agent_define` can never set permissions.
5. Cloud backups are encrypted or refused. Destructive actions are confirmed and backed up first.
6. No telemetry. The dashboard makes zero third-party requests. Capture engines are off by default.
7. The default starter pack is neutral (no personal brand, no region assumptions). The `markets` pack is optional.
8. Never claim "100% safe". Docs must keep saying that what an AI reads goes to that AI's provider.
9. Node 20 compatible, no build step for the dashboard, minimal runtime dependencies (justify any new one: size, maintenance, licence).

## 5. Known gaps: the previous author's own assessment

Verify each one. Some may be wrong. Add what was missed.

1. **Install needs Node.js and a terminal.** That is the biggest barrier for non-technical users. No installer or desktop wrapper.
2. **The dashboard has no Settings screen** (capture, backups, passphrase, projects need the CLI or JSON) and **no way to edit, delete, pin or export a single memory**, and no undo. The API has no per-item delete route.
3. **Storage:** sql.js rewrites the whole file on every save (about 0.3 s at 60,000 notes). Every MCP process holds a copy in RAM, and each AI app starts one. Search is `LIKE` plus a simple scorer, with no full-text index.
4. **The lock is a lock file.** Untested on Windows, network drives, and cloud-synced folders (OneDrive, Dropbox, iCloud, Google Drive). No directory fsync after rename. Crash and power-loss recovery are lightly tested.
5. **Only ever run on Linux.** Windows and macOS paths (browser-history discovery, `memvault open`, file permissions, `setup-windows.mjs`, folders with spaces or non-Latin names) are unexercised. CI is Linux only.
6. **Masking** is regex based and runs on user text up to 20 MB. Possible catastrophic backtracking or slowness is unmeasured. False negatives are certain.
7. **Prompt injection surface.** Briefings fence memory as data, but tools such as `vault_search` return raw memory text. Owner-mode connections can call `agent_define`. Review what a poisoned memory, handoff or bridge result could make an AI do.
8. **UI:** English only. Checked with axe and a keyboard script, but never with a real screen reader, never with real users, no visual-regression tests. The "describe the agent in words" reader is English-only heuristics.
9. **Importers and sync engines have little or no automated tests.** Export formats from ChatGPT, Claude, Gemini and Perplexity change over time.
10. **Migration** was tested only on a synthetic old database, not a real long-lived vault or an interrupted write.
11. **Licensing and brand.** The fonts (Plus Jakarta Sans, Inter, SIL OFL) ship without their licence texts. The repo is MIT but the Mr. Chartist name and logo are not covered by it; add a trademark notice.
12. **Docs:** `docs/promo.md` is stale v2.1 copy. The README needs a claims ledger.
13. **Secure Vault** has no password recovery by design. Is the warning strong enough? Optional Gemini features send content to Google with the user's key. Is consent clear?
14. **Release:** nothing published to npm. Package name, provenance, `server.json` registry entry, rollback plan.
15. **Tool surface:** 29 MCP tools cost about 4.4k tokens per AI session. Consider consolidation.

## 6. What to do (in this order; stop after a complete, tested slice if you run out of time)

**Phase A: Verify.** Run everything. Build a *claims ledger*: each claim in README, SECURITY.md, CHANGELOG, PR #5 → evidence (test or command) → TRUE / FALSE / UNVERIFIABLE. Fix or remove every claim that is not TRUE.

**Phase B: Find the big problems.** If you can run sub-agents, run these lanes in parallel, then have each lane try to *refute* another lane's top three findings.
- *Data integrity:* concurrency, crashes, large vaults, memory use, migration and restore, cloud-synced folders, Windows file semantics.
- *Security and privacy:* redo the threat model. Attack the server (Host/Origin, DNS rebinding, WSL2 or Docker forwarding, other OS users, CSRF, body-size DoS, `/upload`, any path or `file_path` handling, path traversal in names), the MCP layer (injection, scope escape through ids or tags, spoofed `agent_id`, audit gaps), the crypto (parameters, nonce use, backup format, downgrade), redaction (fuzz and ReDoS), bridges (command execution, SSRF), and dependencies (`npm audit`, supply chain).
- *Product, UX, accessibility:* see Phase D.
- *Performance:* benchmark 1k / 10k / 100k notes; measure RAM per MCP process and search quality. Compare a real SQLite engine (`node:sqlite`, `better-sqlite3`) with FTS5 against the current one, with numbers.
- *Cross-platform and install:* Windows, macOS, Linux, WSL2; Node 20/22/24; paths with spaces and Unicode; no admin rights; offline; cold `npx` start; uninstall.
- *Tests and CI:* gaps, flaky timing, add a Windows and macOS matrix, importer and sync tests.
- *Docs, licensing, brand.*

Rank findings **P0** (data loss, security, wrong claim), **P1** (blocks launch), **P2** (should fix), **P3** (nice to have).

**Phase C: Fix.** For P0 and P1, and any P2 you are confident about: write the failing test first, then the smallest correct fix. One concern per commit. No mass reformatting. Ask before changing a data format or breaking an interface, and ship a migration with tests.

**Phase D: The UI.** Walk three personas through the whole product: a 12-year-old student, a 70-year-old non-technical writer, a developer. Also check low vision, screen reader, keyboard-only, voice control, right-to-left and a phone. Review every screen in light and dark, at three widths and three text sizes, and attach before and after screenshots. Must-do: a Settings screen (capture, backups, passphrase status, projects); edit, delete, pin and export for a single memory, with undo and confirmed bulk delete; install and first run with no terminal if feasible; empty, loading and error states; a plain-language pass on all text (about grade 8 reading level); consistent Mr. Chartist styling from the official tokens. Keep zero third-party requests, the strict CSP and no build step unless you can justify a framework with evidence. Extend `tests/e2e`. State plainly what you could not test (for example a real screen reader).

**Phase E: Roadmap.** Write `ROADMAP.md` with Now (launch blockers), Next (0 to 3 months), Later (3 to 12 months) and Not doing (with reasons). Each item: the problem, who benefits, approach, effort (S/M/L), risk, and how success is measured. Consider at least: a real SQLite engine; a zero-terminal installer or desktop wrapper and package managers; translations and how to get native review; an approval prompt when an agent asks for more access; encrypted multi-device sync; local embeddings for semantic search; memory lifecycle (expiry, duplicates, summaries, "forget"); several profiles on a shared computer; import and export standards; a safe pack ecosystem; signed releases, provenance and an SBOM; an accessibility review with disabled users; a docs site; community and governance. Reorder or drop items with reasons.

**Phase F: Launch readiness.** Produce a go / no-go checklist with objective gates, for example: tests green on 3 operating systems and Node 20/22/24; e2e green; no open P0 or P1; clean-machine install tested; a working private security contact; licence and notice files complete; the claims ledger is all TRUE; demo assets; a rollback plan; an honest launch message (refresh `docs/promo.md`). Give a verdict, **GO** or **NO-GO**, with reasons.

## 7. Working rules

- **Evidence over opinion.** Every finding has a repro, a command, or `file:line`. Label statements `[Verified]`, `[Inferred]` or `[Needs verification]`. Never invent numbers, benchmarks, OS behaviour or news. Measure, or mark as an estimate.
- If you cannot run something (no browser, no Windows), say so and lower your confidence. Do not claim it.
- Do not add telemetry or third-party requests. Do not remove a feature without a reason and a migration.
- Prefer the simplest change. Do not rewrite for taste. Do not widen scope silently.
- Git: create `review/launch-pass` from `mrchartist/tender-thompson-0diky3`. Small commits. Run `npm test` and `npm run test:e2e` before each push. Never force-push. Open a **draft** PR into the PR #5 branch. Do not merge anything.
- Ask the owner only for decisions that block you, in one batch. Otherwise decide, and record the decision.
- **Writing to the owner:** simple, formal Indian English; direct and practical; short paragraphs; no fluff or long bullet dumps; write "Needs verification" for anything uncertain; never guess numbers or news. If the owner's files do not contain something, write "Not found in files." Brand casing: `@MrChartist` for market content, `NISMExams.com` for NISM and education content. These style rules apply to how you write **to the owner** and to the optional `markets` pack. The product's default behaviour must stay neutral for everyone.

## 8. Deliverables

1. `docs/review/REVIEW.md`: verdict; claims ledger; findings table (ID, severity, area, evidence, impact, status, commit); what you changed; UI review with screenshots; launch checklist with status; remaining risks; "Needs verification"; questions for the owner.
2. `ROADMAP.md`.
3. Commits and a draft PR as described above.
4. A final message of at most 300 words: verdict, the five most important findings, what the owner must decide.

## 9. Finish line

Before you stop: re-run all tests and the browser tests, re-read your own diff as an attacker would, confirm each invariant in section 4 still holds, and list what is still risky. "Perfect" is not reachable; an honest, tested, clearly bounded launch is.
