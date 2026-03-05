<div align="center">

<img src="https://img.shields.io/badge/MemVault-v2.0-6366f1?style=for-the-badge&logo=data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCI+PHBhdGggZmlsbD0id2hpdGUiIGQ9Ik0xMiAxTDMgNXY2YzAgNS41NSAzLjg0IDEwLjc0IDkgMTIgNS4xNi0xLjI2IDktNi40NSA5LTEyVjVsLTktNHoiLz48L3N2Zz4=" />
<img src="https://img.shields.io/badge/AES--256--GCM-Encrypted-f59e0b?style=for-the-badge" />
<img src="https://img.shields.io/badge/Self--Hosted-Local_First-10b981?style=for-the-badge" />
<img src="https://img.shields.io/badge/Node.js-ESM-339933?style=for-the-badge&logo=node.js" />
<img src="https://img.shields.io/badge/SQLite-FTS5-003B57?style=for-the-badge&logo=sqlite" />

# 🗄️ MemVault

**Your personal, self-hosted knowledge vault — with AES-256-GCM encrypted secrets, browser sync, and full AI work-log support.**

*Everything you know. Everything you've done. Searchable in milliseconds. Fully private.*

[Features](#-features) · [Use Cases](#-use-cases) · [Architecture](#-architecture) · [API Reference](#-api-reference) · [Quick Start](#-quick-start) · [Security](#-security-model) · [Roadmap](#-roadmap)

</div>

---

## 🧭 What is MemVault?

MemVault is a **local-first personal knowledge management system** built for developers, AI power-users, and anyone who works with large amounts of information daily and needs a **private, portable, and searchable place to store it all**.

Unlike cloud-based tools (Notion, Obsidian Sync, Roam), **MemVault runs entirely on your machine**. Your data never leaves your computer unless you explicitly export it. Sensitive information — API keys, passwords, user IDs, payment details — is stored with **military-grade AES-256-GCM encryption** and your master password is never written anywhere.

Think of it as your own **private second brain** that your AI assistant can read and write to, making every future interaction smarter and more context-aware.

---

## ✨ Features

### 📔 Knowledge Entry System

- **Daily Diary** — Write freeform personal notes with a clean, distraction-free editor
- **Conversation Logs** — Store AI conversation exports (ChatGPT, Gemini, Claude) for future reference
- **Work Logs** — Record development sessions, decisions, bugs fixed, and project progress
- **File Attachments** — Upload any file (up to 200MB) and attach it to an entry
- **Full-Text Search** — SQLite FTS5 full-text search across all 100k+ entries in milliseconds
- **Auto-Sync** — Pull all Antigravity AI conversation histories automatically

### 🔐 Encrypted Secure Vault

- **AES-256-GCM** encryption — the same standard used by banks and governments
- **6 secret categories**: API Keys, Passwords, User IDs, Payment Details, Phone Numbers, Custom
- **PBKDF2** key derivation (100,000 iterations) from your master password
- **Per-secret random IV** — even identical values produce different ciphertext
- **Master password never stored** — verified via encrypted sentinel pattern
- **Click-to-copy** — click any revealed field to copy to clipboard instantly
- **Session-scoped unlock** — re-lock with one click, or on page refresh

### 🌐 Browser Activity Sync

- **Chrome history** — automatically imports visited sites (deduped by URL + date)
- **Edge history** — cross-browser support
- **Bookmarks** — folder structure preserved as tags
- **Smart filtering** — skips `localhost`, `chrome://`, `about:`, and extension pages
- **Dry-run mode** — preview what would sync before committing

### 🎨 Modern Web UI

- **Dark + Light theme** — instant toggle, preference saved to localStorage
- **Inter + DM Mono** typography — clean, professional, readable
- **Responsive** — works on any screen size
- **Access Map** — built-in API documentation panel showing all endpoints live
- **Real-time stats** — live entry counts per category

---

## 🎯 Use Cases

### Use Case 1: AI Developer with Multiple Projects

**Problem**: You work with 10+ AI tools daily (ChatGPT, Claude, Gemini, Copilot). After a session, you close the tab and the context is gone. Next week when you're debugging the same issue, you start from scratch.

**Solution with MemVault**:

- Run `node sync-antigravity.mjs` — all 88+ past AI conversations are indexed in SQLite
- Search "React hydration bug" → instantly find the exact session where you fixed it 3 months ago
- AI reads your vault before answering → responses always build on your existing work

---

### Use Case 2: Freelancer Managing Multiple Client Credentials

**Problem**: You have 30+ client API keys, login credentials, and payment details scattered across sticky notes, emails, and text files. One data breach = catastrophe.

**Solution with MemVault**:

- Store every API key under `🔑 API Keys` → encrypted with AES-256-GCM
- Passwords under `🔐 Passwords` with username, URL, and notes
- Payment info under `💳 Payment Details` → last 4 digits + expiry only
- Everything behind ONE master password that's never written down or stored
- Local-only → no cloud company can be breached to expose your data

---

### Use Case 3: Daily Journaling with Search

**Problem**: You journal daily in a notes app but searching old entries is slow, unreliable, or locked behind a subscription.

**Solution with MemVault**:

- Write directly in the web UI → `Save to Vault` stores entries in SQLite
- Search "feeling anxious about" → all relevant diary entries surfaced in milliseconds
- Export-friendly: all data is in a local SQLite file you can open with any DB browser

---

### Use Case 4: Knowledge Worker Building a Personal Wiki

**Problem**: You read dozens of articles and try tools weekly. Within 3 months you've forgotten 90% of what you learned.

**Solution with MemVault**:

- Browser sync captures every article you visited (Chrome/Edge history → vault)
- Add notes as diary entries with context on what you learned
- Search "kubernetes init containers" → find the article you read + your own notes on it
- Nothing is cloud-locked — your knowledge stays permanently accessible

---

### Use Case 5: Developer Tracking Progress

**Problem**: At stand-up, you struggle to remember what you did yesterday. Your PR history doesn't capture design decisions or dead-ends you explored.

**Solution with MemVault**:

- End each work session: write a brief worklog entry in the UI
- Sync your AI coding assistant conversations → context preserved
- Search by date or keyword to reconstruct any past work session
- Build a queryable history of every technical decision you've ever made

---

## 🏗️ Architecture

```
MemVault
├── server.mjs              # Node.js ESM API server (Express)
│   ├── /add                # Store knowledge entries
│   ├── /search             # FTS5 full-text search
│   ├── /list               # List entries by type
│   ├── /clear              # Delete all entries
│   ├── /upload             # File attachment handler
│   └── /secrets/*          # AES-256-GCM encrypted secrets API
│
├── public/index.html       # Single-file web UI
│   ├── Dark + Light themes (CSS variables)
│   ├── Inter + DM Mono typography
│   ├── Entry browser (All / Diary / Conversations / Worklogs)
│   ├── Secure Vault tab (master password → session unlock)
│   └── API Access Map (live documentation panel)
│
├── sync-antigravity.mjs    # Ingest Antigravity AI conversation histories
├── sync-browser.mjs        # Chrome/Edge history + bookmarks importer
│
└── Vault Storage (D:\AG\Vault)
    ├── db/index.sqlite     # SQLite: items table (FTS5) + secrets table (AES-GCM)
    ├── entries/            # Flat-file diary backups
    ├── conversations/      # Conversation backups
    ├── worklogs/           # Worklog backups
    └── files/              # File attachments (up to 200MB each)
```

### Storage layers

| Layer | What | Where |
|---|---|---|
| Primary index | SQLite FTS5 | `db/index.sqlite` |
| Encrypted secrets | AES-256-GCM blobs in SQLite | `db/index.sqlite` (secrets table) |
| File attachments | Raw files | `files/` directory |
| UI | Served as static HTML | `public/index.html` |

---

## 🔑 API Reference

All endpoints available at `http://127.0.0.1:7799`

### Knowledge Entries

| Method | Endpoint | Body / Params | Description |
|--------|----------|--------------|-------------|
| `GET` | `/health` | — | Server health check |
| `POST` | `/add` | `{type, source, title, content, tags}` | Add entry |
| `GET` | `/search?q=…&type=…` | Query string | Full-text search with optional type filter |
| `GET` | `/list?type=…&limit=…` | Query string | List entries |
| `POST` | `/clear` | `{confirm:"DELETE_ALL_ITEMS"}` | Delete all knowledge entries |
| `POST` | `/upload` | `multipart/form-data` | Upload file attachment |

**Entry types**: `diary` · `conversation` · `worklog` · `file`

### Encrypted Secrets

| Method | Endpoint | Body | Description |
|--------|----------|------|-------------|
| `POST` | `/secrets/verify` | `{password}` | Verify/register master password |
| `POST` | `/secrets/add` | `{password, category, label, fields}` | Encrypt & store a secret |
| `POST` | `/secrets/get` | `{password, id}` | Decrypt & return a secret |
| `GET` | `/secrets/list?password=...` | Query string | List labels + categories (password required) |
| `DELETE` | `/secrets/delete/:id` | `{password}` | Delete a secret (password required) |

**Secret categories**: `apikey` · `password` · `userid` · `payment` · `phone` · `custom`

---

## 🚀 Quick Start

### Prerequisites

- **Windows** with WSL2 (Ubuntu 20.04+)
- **Node.js 18+** in WSL
- Git

### 1. Clone & Install

```bash
git clone https://github.com/MrChartist/memvault.git
cd memvault
npm install
```

### 2. Set Vault Root (optional, defaults to `/mnt/d/AG/Vault`)

```bash
export VAULT_ROOT=/your/path/to/vault
```

### 3. Start the Server

```bash
# From WSL
node server.mjs

# From Windows PowerShell (runs hidden)
Start-Process wsl -ArgumentList "-d Ubuntu-24.04 -- bash -c `"cd /path/to/vault && node server.mjs`"" -WindowStyle Hidden
```

### 4. Open the UI

Navigate to **<http://127.0.0.1:7799>** in your browser.

### Optional hardening env vars

```bash
VAULT_HOST=127.0.0.1
VAULT_TOKEN=choose-a-long-random-token
VAULT_CORS_ORIGINS=http://127.0.0.1:7799,http://localhost:7799
```

When `VAULT_TOKEN` is set, mutating and secrets endpoints require the header `x-vault-token`.

### 5. First-time Secure Vault Setup

Click **🔒 Secure Vault** tab → enter any password → it becomes your master password permanently. **Write it down somewhere safe offline.** If lost, encrypted secrets cannot be recovered.

### 6. Sync Your Data

```bash
# Sync AI conversation histories (Antigravity)
node sync-antigravity.mjs

# Preview browser history (dry run)
node sync-browser.mjs --dry-run

# Live browser sync
node sync-browser.mjs
```

---

## 🔒 Security Model

### What is encrypted

Everything in the **Secure Vault** (API keys, passwords, user IDs, payment details, phone numbers, custom secrets) is encrypted with AES-256-GCM before being stored in SQLite.

### Encryption chain

```
Your Master Password
       │
       ▼
PBKDF2(SHA-256, 100,000 iterations, static salt)
       │
       ▼
256-bit AES key (never stored, derived on-demand)
       │
       ▼  ┌─ 12-byte random IV (unique per secret)
AES-256-GCM
       │
       ▼
{ iv: "base64", authTag: "base64", ciphertext: "base64" }
       │
       ▼
Stored in SQLite secrets table
```

### What is NOT stored

- ❌ Your master password (never written anywhere)
- ❌ The derived AES key (computed fresh each request, discarded immediately)
- ❌ Plaintext versions of any secret

### What IS stored (safely)

- ✅ AES-256-GCM ciphertext (base64)
- ✅ Random IV per secret (base64)
- ✅ GCM authentication tag (prevents tampering)
- ✅ Secret labels (plaintext) — only the label, not the value

### Password verification mechanism

On first use, MemVault encrypts a known test value (`"memvault-ok"`) with your password and stores it as a special `__sentinel__` record. On subsequent unlocks, it attempts to decrypt this sentinel — a match confirms your password is correct without storing the password itself.

### What's excluded from GitHub (`.gitignore`)

- `db/` — your entire SQLite database (entries + encrypted secrets)
- `entries/`, `conversations/`, `worklogs/`, `files/` — all personal vault content
- `.env`, `*.key`, `*.pem`, `credentials.json` — any credential files
- `test-add.json`, `test-secrets.sh` — any test data with real credentials

> **⚠️ Important**: Never commit `db/index.sqlite`. It contains your encrypted secrets. Even though they're encrypted, exposing the ciphertext unnecessarily is bad practice.

---

## 📁 .gitignore Coverage

The following are always excluded from version control:

```gitignore
db/              # SQLite database (your data lives here)
*.sqlite         # Any SQLite files
entries/         # Diary entries
conversations/   # Conversation exports
worklogs/        # Work logs
files/           # File attachments
.env             # Environment variables / secrets
*.key, *.pem     # Cryptographic keys
credentials.json # Any credential files
```

---

## 🗺️ Roadmap

### v2.1 — Sync Expansion

- [ ] ChatGPT JSON export importer (`sync-chatgpt.mjs`)
- [ ] Daily auto-summary (AI-generated day summary at midnight)
- [ ] Clipboard quick-capture (`vault.mjs clip "paste text here"`)
- [ ] Tags and manual categories for entries

### v2.2 — Enhanced Search

- [ ] Date range filtering in search
- [ ] Saved search queries / bookmarks
- [ ] Entry tagging + tag-based filtering
- [ ] Semantic search via local embeddings (ONNX)

### v2.3 — AI Integration

- [ ] Context API — serve relevant vault entries to local AI tools
- [ ] Auto-ingestion of new AI sessions via file-watcher
- [ ] Summarization of long entries via local LLM

### v3.0 — Multi-device

- [ ] Optional sync backend (self-hosted, end-to-end encrypted)
- [ ] Mobile companion app (read-only)
- [ ] Export/import between vault instances

---

## 🛠️ Tech Stack

| Component | Technology | Why |
|---|---|---|
| API Server | Node.js 20 ESM, Express | Fast, portable, zero-config |
| Database | SQLite (via sql.js) + FTS5 | Serverless, single-file, full-text search |
| Encryption | Node.js built-in `crypto` | No external deps, audited, AES-256-GCM |
| Key Derivation | PBKDF2 SHA-256 100k iters | Brute-force resistant |
| UI | Vanilla HTML/CSS/JS | No framework = zero attack surface, fast |
| Typography | Inter + DM Mono (Google Fonts) | Professional, legible |
| Browser Sync | Direct SQLite read of Chrome/Edge | No extension needed |

---

## 📄 License

MIT — use it, fork it, self-host it. Your data is yours.

---

<div align="center">
<strong>Built for developers who value privacy, speed, and full ownership of their data.</strong><br>
<sub>MemVault — Everything you know. Searchable. Private. Yours.</sub>
</div>
