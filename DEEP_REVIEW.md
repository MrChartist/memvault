# MemVault Deep-Dive Review & Brainstorm

This document captures a deep read of the current codebase and highlights:

- ✅ What is already strong
- ⚠️ Concrete errors / risks
- 🚀 Improvement opportunities (prioritized)
- 🧠 Product brainstorm ideas

---

## 1) What is already strong

1. **Clear local-first architecture with minimal moving parts**
   - A single Node server, SQLite persistence through `sql.js`, and static UI hosting keeps deployment simple. This lowers operational complexity for a personal knowledge system.

2. **Useful API surface for multi-input knowledge ingestion**
   - The app supports direct item insertion, uploads, search, listing, and health checks, giving a practical base for CLI + UI + sync scripts.

3. **Good UX-driven feature scope for v1**
   - Diary + worklogs + conversations + attachments + browser sync + encrypted secrets is a strong foundation and reflects real workflows.

4. **Secrets use AEAD mode (AES-256-GCM)**
   - Confidentiality + integrity are covered with authenticated encryption and per-item random IVs.

---

## 2) Confirmed errors / mismatches / high-risk issues

### A. README capability mismatch: claims FTS5, implementation uses `LIKE`
- README explicitly claims SQLite FTS5 search, but current `/search` endpoint runs `title/content/tags LIKE ?` query against `items` without any FTS virtual table.
- This is not only a documentation mismatch; it can become a serious performance bottleneck at scale.

### B. `/clear` is unauthenticated destructive endpoint
- Any caller that can reach the server can wipe all entries via `POST /clear`.
- Since CORS is wildcard and bind is `0.0.0.0`, accidental exposure has high blast radius.

### C. Secrets metadata exposure without password
- `/secrets/list` returns secret IDs, categories, labels, and timestamps without password verification.
- Even if ciphertext remains safe, metadata leakage can be sensitive (e.g., labels that reveal vendors, clients, or systems).

### D. File upload naming bug (double extension)
- Upload target uses `${safeSlug(original)}${path.extname(original)}`.
- `safeSlug(original)` already includes the extension string transformed into slug text; appending ext again causes names like `photo-png.png`.

### E. Secrets KDF uses static salt
- PBKDF2 parameters are fixed and the salt is static (`memvault-salt-v1`).
- Static salt weakens resistance to precomputation/rainbow-style attacks across users; per-user or per-secret salt should be used and stored alongside ciphertext.

### F. Hardcoded environment assumptions in sync scripts
- `sync-antigravity.mjs` hardcodes API URL and Windows profile defaults; assumes specific user paths.
- This reduces portability and increases setup friction for new environments.

### G. No authentication model for non-secret endpoints
- `/add`, `/upload`, `/list`, `/search`, `/clear` currently operate without auth.
- In local-only mode this may be acceptable, but defaults (`0.0.0.0`, permissive CORS) mean this can become unsafe if machine/network config changes.

---

## 3) Improvement roadmap (prioritized)

## P0 (security + correctness)

1. **Add an auth gate for all mutating endpoints**
   - Introduce API token header (e.g., `X-Vault-Token`) loaded from env.
   - Protect at least: `/add`, `/upload`, `/clear`, `/secrets/*`.

2. **Lock down CORS + host binding by default**
   - Default bind to `127.0.0.1` (not `0.0.0.0`), with explicit opt-in for LAN mode.
   - Restrict CORS to configured origin list.

3. **Fix secrets metadata leak**
   - Require password verification before listing secrets or return only aggregate counts by category.

4. **Replace static salt strategy**
   - Generate a per-vault random salt once and store it in DB settings table, or per-secret salt for defense-in-depth.

5. **Protect `/clear` with explicit confirmation flow**
   - Require token + confirmation payload like `{ confirm: "DELETE_ALL_ITEMS" }`.

## P1 (performance + scalability)

1. **Implement true full-text search using SQLite FTS5**
   - Create virtual table + triggers on insert/update/delete.
   - Use `MATCH` queries + ranked results (`bm25`) for relevance.

2. **Move from sync filesystem/crypto calls to async where practical**
   - Current blocking operations can reduce responsiveness under concurrent usage.

3. **DB lifecycle reliability**
   - Add periodic snapshot/checkpoint strategy and graceful shutdown hooks to reduce corruption risk on abrupt exits.

## P2 (product + DX)

1. **Config centralization**
   - Introduce a single config module for paths, API URL, limits, and mode flags.

2. **Input schema strengthening**
   - Add max lengths and sanitization for `title`, `tags`, `content` to avoid very large payload stress.

3. **Error envelope standardization**
   - Return consistent `{ ok, error, code }` shape across all endpoints.

4. **Automated tests**
   - Add smoke tests for core routes and secrets crypto flow.

---

## 4) Deep brainstorm: high-value feature ideas

1. **Memory Graph / Knowledge Linking**
   - Auto-detect entities (projects, APIs, clients, bugs) and build graph links between diary entries, worklogs, and conversation artifacts.

2. **Semantic search layer**
   - Keep existing lexical search and add optional embedding-based semantic retrieval over selected corpora.

3. **“Session Replay” for engineering worklogs**
   - Reconstruct chronological context across terminal logs, AI chats, and code decisions for any date range.

4. **Encrypted export bundle with integrity manifest**
   - One-click encrypted archive (entries + attachments + manifest hash tree) for backup and migration.

5. **Risk detector on secrets labels/content patterns**
   - Warn on insecure entries (full card numbers, plaintext private keys, expired credentials).

6. **Pluggable sync connectors**
   - Beyond Antigravity/browser: Git commits, Jira, Slack snippets, email digests.

7. **Personal analytics dashboard**
   - Trends: most active projects, recurring incident themes, search misses, forgotten tasks resurfaced.

8. **Policy-driven retention & redaction**
   - Auto-redact PII in selected entry types and enforce retention windows.

---

## 5) Concrete “next 7 days” execution plan

1. Day 1–2: Security hardening (auth token, CORS lockdown, localhost binding default).
2. Day 2–3: Fix `/secrets/list` protection + `/clear` confirmation flow.
3. Day 3–4: Implement FTS5 table and migrate `/search` to ranked MATCH query.
4. Day 4–5: Add API integration tests (health/add/search/secrets).
5. Day 5–7: Config cleanup + documentation refresh to align README with actual behavior.

---

## 6) Quick wins (can be merged immediately)

- Remove unused imports in `sync-browser.mjs` (`path`, `os`) to reduce lint noise.
- Make API URL in `sync-antigravity.mjs` env-configurable like other scripts.
- Fix upload naming logic to avoid extension duplication.
- Add a startup warning when running with wildcard CORS + `0.0.0.0`.

---

## 7) Closing perspective

MemVault already has a compelling core proposition: **private, local-first memory infrastructure for humans + AI workflows**. The biggest opportunity now is to tighten security defaults and align implementation with advertised scale claims (FTS5), then add smart retrieval and linkage features to become a true “developer memory OS.”
