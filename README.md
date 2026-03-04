# MemVault 🔐

> **Your self-hosted second brain.** MemVault is an open-source personal knowledge vault that automatically captures AI agent work logs, conversation history, diary entries, and project notes — all searchable in seconds.

[![License: MIT](https://img.shields.io/badge/License-MIT-violet.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/Node.js-18%2B-green.svg)](https://nodejs.org)
[![SQLite](https://img.shields.io/badge/Database-SQLite-blue.svg)](https://sqlite.org)
[![Self-Hosted](https://img.shields.io/badge/Hosting-Self--Hosted-orange.svg)](https://github.com)

---

## What is MemVault?

MemVault is a **lightweight, self-hosted personal knowledge base** built for developers and AI power-users who want to:

- 📓 Keep a **daily developer diary** without friction
- 🤖 **Auto-capture AI agent work** (Antigravity, ChatGPT, Claude, etc.)
- 💬 Store and search **conversation logs** from any LLM
- 🔍 **Full-text search** across everything — instantly
- 📦 Keep all data **portable** in a single folder you own

No subscriptions. No cloud. No data leaks. Just your knowledge, locally stored and instantly searchable.

---

## Features

| Feature | Description |
|---|---|
| 🌐 **Web UI** | Beautiful dark-mode dashboard — write entries, filter by type, search |
| 🔌 **REST API** | Simple HTTP API (`/add`, `/search`, `/list`, `/clear`) |
| 🤖 **Auto-Sync** | Ingests Antigravity conversation artifacts automatically |
| 🔍 **Full-Text Search** | SQLite FTS across title, content, and tags |
| 📁 **File Upload** | Attach files up to 200MB |
| 🏷️ **Tagging** | Comma-separated tags on every entry |
| 📦 **Portable** | Entire vault lives in one folder — drag and drop to migrate |

---

## Quick Start

### Prerequisites

- [Node.js 18+](https://nodejs.org) (in WSL or Linux)
- [WSL2](https://learn.microsoft.com/en-us/windows/wsl/) (if on Windows)

### 1. Clone & Install

```bash
git clone https://github.com/yourusername/memvault.git
cd memvault
npm install
```

### 2. Configure (optional)

```bash
export VAULT_ROOT="/mnt/d/AG/Vault"   # Where to store your data (default)
export VAULT_PORT=7799                 # API port (default)
```

### 3. Start the Server

```bash
node server.mjs
# → Vault API running on http://0.0.0.0:7799
```

### 4. Open the Web UI

Open **<http://127.0.0.1:7799>** in your browser.

---

## Auto-Sync with Antigravity

MemVault can **automatically ingest all your Antigravity AI agent conversations** — no manual copy-pasting needed.

```bash
# Sync all Antigravity conversation artifacts into the vault
node sync-antigravity.mjs

# Preview without writing (dry run)
node sync-antigravity.mjs --dry-run

# Sync without clearing existing data
node sync-antigravity.mjs --no-clear
```

The sync script:

1. ✅ Clears old/test data (fresh start)
2. 📁 Scans every Antigravity conversation folder
3. 📝 Reads `walkthrough.md`, `task.md`, `implementation_plan.md`
4. 🚀 Posts each artifact as a searchable entry to the vault

---

## API Reference

### `POST /add` — Add an entry

```json
{
  "type": "diary | conversation | worklog | file",
  "source": "manual | antigravity | chatgpt | claude",
  "title": "My Entry Title",
  "content": "Full content here...",
  "tags": "tag1,tag2,tag3"
}
```

### `GET /search?q=query&type=diary` — Search entries

Returns up to 50 matching entries with content snippets.

### `GET /list?type=worklog&limit=50` — List entries

Browse all entries without a search filter.

### `POST /clear` — Clear all data

Wipes the database. Used by auto-sync for a fresh start.

### `GET /health` — Health check

Returns server status and vault path.

### `POST /upload` — Upload a file (multipart)

Stores files in the vault's `files/` directory and indexes them.

---

## Directory Structure

```
memvault/
├── server.mjs              # Express API server
├── vault.mjs               # CLI tool
├── sync-antigravity.mjs    # Auto-sync from Antigravity
├── public/
│   └── index.html          # Web UI
├── package.json
└── .gitignore

# Vault data (stored at VAULT_ROOT, not in git):
/mnt/d/AG/Vault/
├── entries/                # Daily diary entries (.md)
├── conversations/          # Conversation logs
├── worklogs/               # Agent work logs
├── files/                  # Uploaded files
└── db/
    └── index.sqlite        # SQLite search index
```

---

## CLI Usage

```bash
# Add a diary entry
node vault.mjs diary "Today I shipped the auto-sync feature for MemVault."

# Add a conversation log
node vault.mjs conversation "Discussed architecture with Claude."

# Search
curl "http://127.0.0.1:7799/search?q=architecture"
```

---

## Roadmap

- [ ] Scheduled auto-sync (cron / watch mode)
- [ ] ChatGPT & Claude conversation importers
- [ ] Markdown rendering in web UI
- [ ] Export to Obsidian / Notion
- [ ] Full-text search with FTS5 ranking
- [ ] Tag cloud and analytics dashboard
- [ ] VS Code extension integration

---

## Why MemVault?

Most personal knowledge tools lock your data in the cloud, require a subscription, or are too complex to self-host. MemVault is different:

- **100% local** — your data never leaves your machine
- **Zero config** — one `node server.mjs` and you're running
- **AI-native** — built from day one to ingest agent work outputs
- **Hackable** — simple Node.js + SQLite, fork and extend freely

---

## Contributing

PRs welcome! Please open an issue first to discuss what you'd like to change.

---

## License

MIT © [Rohit](https://github.com/yourusername)

---

*MemVault — Remember everything. Own your knowledge.*
