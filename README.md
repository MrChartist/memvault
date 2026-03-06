<div align="center">

<img src="https://img.shields.io/badge/MemVault-v2.1-6366f1?style=for-the-badge&logo=data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCI+PHBhdGggZmlsbD0id2hpdGUiIGQ9Ik0xMiAxTDMgNXY2YzAgNS41NSAzLjg0IDEwLjc0IDkgMTIgNS4xNi0xLjI2IDktNi40NSA5LTEyVjVsLTktNHoiLz48L3N2Zz4=" />
<img src="https://img.shields.io/badge/AES--256--GCM-Encrypted-f59e0b?style=for-the-badge" />
<img src="https://img.shields.io/badge/Self--Hosted-Local_First-10b981?style=for-the-badge" />
<img src="https://img.shields.io/badge/Node.js-ESM-339933?style=for-the-badge&logo=node.js" />
<img src="https://img.shields.io/badge/SQLite-FTS5-003B57?style=for-the-badge&logo=sqlite" />

# 🗄️ MemVault

**A high-performance, local-first personal knowledge vault. Consolidate your AI agent logs, browser history, encrypted secrets, and technical documentation into a single, searchable memory.**

*Everything you know. Everything you've built. Searchable in milliseconds. 100% Private.*

[Motive](#-motive-why-memvault) · [Features](#-key-features) · [Architecture](#-architecture) · [Quick Start](#-quick-start) · [Sync Engines](#-sync-engines)

</div>

---

## 🎯 Motive: Why MemVault?

In the age of AI, our knowledge is scattered. We have half-finished conversations in ChatGPT, technical design decisions hidden in agent worklogs, relevant research buried in browser history, and sensitive API keys in insecure `.env` files.

**MemVault's motive is to solve the "Fleeting Context" problem.**

It serves as your **Digital Second Brain** — a persistent, searchable, and secure index of your digital life. Instead of losing the context of a 3-hour coding session when you close the tab, MemVault ingests that session, indexes it with SQLite FTS5, and makes it searchable for years to come.

---

## ✨ Key Features

### 🧠 Unified Memory Timeline

- **Universal Search**: Search through thousands of entries (Diary, Conversations, Worklogs, Browser history) in under 5ms using SQLite FTS5.
- **Project Context**: Automatically groups related logs by project title or repository name.
- **Media Support**: Upload and attach relevant files directly to your knowledge entries.

### 🔐 Multi-Layer Safety

- **Encrypted Secrets**: Store API keys and credentials using **AES-256-GCM** encryption.
- **Local-First**: Your data never touches the cloud. It lives in a portable SQLite database on your machine.
- **Sentinal Security**: Master passwords are never stored; verified via encrypted pattern detection.

### 🌐 automated Sync Engines

- **Antigravity AI**: Automated ingestion of agent logs and exports.
- **Browser Pulse**: Sync history and bookmarks from Chrome/Edge (deduplicated).
- **GitHub Pulse**: Keep a searchable record of your code contributions.

---

## 🚀 Quick Start

### 1. Prerequisites

- **Node.js 22.5+** (Required for native `DatabaseSync`)
- A modern browser (Chrome/Edge/Firefox)

### 2. Installation

```bash
# Clone the repository
git clone https://github.com/MrChartist/memvault.git
cd memvault

# Install dependencies
npm install
```

### 3. Environment Setup

Copy `.env.example` to `.env` and configure your paths:

```bash
# Example .env
VAULT_ROOT="D:\AG\Vault"
VAULT_PORT=7800
```

### 4. Launch

```bash
# Start the server
npm start
```

Open **[http://localhost:7800](http://localhost:7800)** to enter your vault.

---

## 🏗️ Architecture

MemVault is built for speed and zero-friction portability.

- **Frontend**: Vanilla JS + Modern CSS (Glassmorphism). No heavy frameworks, just raw performance.
- **Backend**: Node.js ESM server with Express.
- **Database**: Native `node:sqlite` with Full-Text Search (FTS5).
- **Encryption**: AES-256-GCM (Node Crypto).

---

## ⌨️ Navigation & Shortcuts

Memorize these to fly through your data:

- `Ctrl + /`: **Search** across everything.
- `Alt + N`: **Quick Entry** (Focus Diary).
- `1 - 6`: **Panel Switching** (Timeline, Diary, Convos, Worklogs, Docs, Projects).
- `V`: Open the **Secure Vault**.
- `?`: Show **Help Modal**.

---

## 🛠️ Sync Engines

| Script | Purpose |
|---|---|
| `sync-antigravity.mjs` | Pulls logs from your AI agent brain directory. |
| `sync-browser.mjs` | Ingests Chrome/Edge history and bookmarks. |
| `github-sync.mjs` | Syncs your GitHub commit history. |
| `sync-docs.mjs` | Indexes your internal markdown docs for the searchable explorer. |

---

*Built for those who value privacy, speed, and 100% ownership of their knowledge.*
