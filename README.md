<img src="https://capsule-render.vercel.app/api?type=waving&color=0:0d1117,50:1a1a2e,100:6366f1&height=180&section=header&text=MemVault&fontSize=52&fontColor=ffffff&animation=fadeIn&fontAlignY=35&desc=Your%20AI's%20Persistent%20Memory%20Layer&descSize=16&descAlignY=55&descColor=8b5cf6" width="100%" />

<p align="center">
  <img src="https://raw.githubusercontent.com/MrChartist/memvault/main/docs/images/hero-banner.png" alt="MemVault -- Your AI's Persistent Memory Layer" width="100%">
</p>

<p align="center">
  A self-hosted MCP server that gives Claude, Cursor, and every AI tool<br>
  persistent memory about <em>you</em> -- your code, projects, habits, and preferences.
</p>

<p align="center">
  Built by <a href="https://github.com/MrChartist"><strong>Mr. Chartist</strong></a> | Part of the <a href="https://mrchartist.com">Mr. Chartist Ecosystem</a>
</p>

<p align="center">
  <a href="https://github.com/MrChartist/memvault/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/MrChartist/memvault/ci.yml?branch=main&style=for-the-badge&label=CI" alt="CI"></a>
  <a href="https://www.npmjs.com/package/@mrchartist/memvault"><img src="https://img.shields.io/npm/v/%40mrchartist%2Fmemvault?style=for-the-badge&color=cb3837" alt="npm"></a>
  <a href="https://github.com/MrChartist/memvault/blob/main/LICENSE"><img src="https://img.shields.io/badge/License-MIT-green?style=for-the-badge" alt="MIT License"></a>
  <a href="#-use-it-with-your-ai-client"><img src="https://img.shields.io/badge/MCP-Compatible-8b5cf6?style=for-the-badge" alt="MCP Compatible"></a>
  <img src="https://img.shields.io/badge/Node.js-20+-339933?style=for-the-badge&logo=nodedotjs&logoColor=white" alt="Node.js">
</p>

---

## 🤔 What is MemVault?

Every time you start a new AI conversation, your assistant forgets everything. **MemVault fixes that.**

It captures your digital footprint — Git commits, VS Code projects, file activity, system info, notes and your past AI conversations (optionally also browser history and clipboard) — keeps it in a **local SQLite vault on your machine**, and serves it to **any AI tool** through the [Model Context Protocol (MCP)](https://modelcontextprotocol.io).

> **Think of it as a second brain for your AI assistants.**

### The Problem

```
You:    "Fix the login bug we discussed yesterday"
AI:     "I don't have any context about previous conversations..."
```

### With MemVault

```
You:    "Fix the login bug we discussed yesterday"
AI:     (queries MemVault) → finds yesterday's conversation, related commits, and file changes
AI:     "I found 3 relevant entries. The auth bug was in middleware/session.js..."
```

---

## ✨ Features

<table>
<tr>
<td width="50%">

### 🧠 24 MCP Tools
Your AI gets superpowers:
- **`vault_smart_context`** — Relevance-ranked, de-duplicated context
- **`vault_smart_search`** — Ranked search (optional Gemini re-ranking)
- **`vault_remember`** — The AI saves facts, decisions and preferences
- **`vault_capture_prompt`** — Log prompts from any AI tool
- **`vault_backup`** — Back up to Google Drive + local
- **`vault_bridge_sync`** — Pull memory from other AI MCP servers
- ...and 18 more tools

</td>
<td width="50%">

### 🕸️ 7 Capture Engines + 4 AI Importers
Reads what *you* choose to share:
- 📦 **Git commits** from your local repos
- 💻 **VS Code** projects, extensions, preferences
- 📁 **File activity** (names and dates only, never contents)
- 🖥️ **System info** (OS, hardware, dev tools)
- 🌐 **Browser** history & bookmarks — *opt-in*
- 📋 **Clipboard** — *opt-in, secrets filtered*
- 🤖 **Antigravity** conversations — *opt-in*
- 📥 **Importers** for ChatGPT, Claude, Gemini, Perplexity exports

</td>
</tr>
</table>

### ☁️ Storage everywhere &nbsp;•&nbsp; 🔌 One memory across every AI

- **Local-first** SQLite vault, always on your machine
- **Google Drive backup** — folder mirror *and/or* Drive API ([guide](docs/google-drive.md))
- **MCP bridges** — MemVault connects OUT to other AI tools' MCP servers, pulls their context, and stores it in your vault so every AI shares one brain ([guide](docs/mcp-bridge.md))

### 🏗️ Architecture

<p align="center">
  <img src="https://raw.githubusercontent.com/MrChartist/memvault/main/docs/images/architecture.png" alt="MemVault Architecture" width="100%">
</p>

### 🎨 Local Web UI

<p align="center">
  <img src="https://raw.githubusercontent.com/MrChartist/memvault/main/docs/images/web-ui.png" alt="MemVault Web Interface" width="100%">
</p>

A dark/light dashboard served from your own machine:
- 📔 Diary entry writer
- 🔍 Search across all entries
- 📊 Vault statistics
- 🔐 Encrypted secrets manager
- 🗺️ API access map

---

## 🚀 Quick Start

### Prerequisites

- **Node.js** 20+ ([download](https://nodejs.org))
- **Git** (only for the Git capture engine)

### 1. Run the setup wizard

```bash
npx -y @mrchartist/memvault init
```

It asks where to keep your vault, which capture engines to enable (browser history and clipboard are **off** unless you say yes) and whether to configure Google Drive backup or AI features. It prints the MCP config for your AI client at the end.

### 2. Capture your data

```bash
npx -y @mrchartist/memvault sync     # runs every enabled engine; safe to re-run, never duplicates
```

### 3. Connect your AI client

See [Use it with your AI client](#-use-it-with-your-ai-client) below.

### 4. (Optional) Open the web UI

```bash
npx -y @mrchartist/memvault serve    # → http://localhost:7799
```

<details>
<summary><b>Install from source instead</b></summary>

```bash
git clone https://github.com/MrChartist/memvault.git
cd memvault
npm install
node init.mjs          # setup wizard
npm run sync           # capture
npm start              # web UI on http://localhost:7799
```
</details>

### Import your past AI conversations

```bash
npx -y @mrchartist/memvault import ~/Downloads/chatgpt-export/
npx -y @mrchartist/memvault import ~/Downloads/claude-export/
npx -y @mrchartist/memvault import ~/Downloads/Takeout/        # Gemini (Google Takeout)
npx -y @mrchartist/memvault import ~/Downloads/perplexity-export/
```

Each conversation keeps its **original date**, and importing the same export twice adds nothing new. Sharded ChatGPT exports (`conversations-000.json`, …) and Gemini Takeout answers are supported on a best-effort basis — please report any export that does not import.

---

## 🔌 Use it with your AI client

MemVault speaks the [Model Context Protocol](https://modelcontextprotocol.io) over **stdio** — your AI client launches it as a local process. No server needs to be running, and nothing listens on the network.

Add this to the client's MCP configuration:

```json
{
  "mcpServers": {
    "memvault": {
      "command": "npx",
      "args": ["-y", "@mrchartist/memvault", "mcp"]
    }
  }
}
```

| Client | Where the config goes |
|--------|-----------------------|
| **Claude Desktop** | `claude_desktop_config.json` (Settings → Developer → Edit Config) |
| **Cursor** | Settings → MCP → Add new MCP server (or `~/.cursor/mcp.json`) |
| **VS Code (Cline / Roo Code)** | The extension's MCP settings file |
| **Antigravity** | `~/.gemini/antigravity/mcp_config.json` |

The vault location is read from `~/.memvaultrc.json`. To point a client at a different vault add `"env": { "VAULT_ROOT": "/path/to/vault" }`. Running from a git clone? Use `"command": "node", "args": ["/path/to/memvault/mcp-server.mjs"]`. More detail in [docs/mcp-clients.md](docs/mcp-clients.md).

---

## 🛠️ All 24 MCP Tools

### Core

| Tool | Description |
|------|-------------|
| `vault_search` | Keyword / phrase search across all entries (wildcards are matched literally) |
| `vault_add` | Add a diary, worklog, or conversation entry |
| `vault_list` | List recent entries by type |
| `vault_get_context` | Entries relevant to a topic (newest first) |
| `vault_stats` | Entry counts by type, date range, vault path |
| `vault_secret_list` | List encrypted secret **labels** (values are never exposed to the AI) |

### Smart context

| Tool | Description |
|------|-------------|
| `vault_smart_context` | **Best core tool.** Relevance-ranked, auto-tagged, de-duplicated context |
| `vault_project_context` | Full background on a project — tech stack, timeline, activity |
| `vault_daily_digest` | Summary of a day's activity (your local day) |
| `vault_remember` | The AI saves facts, decisions and preferences for future sessions |
| `vault_capture_prompt` | Log a prompt from any AI tool |
| `vault_log_conversation` | Save a conversation summary |

### Captured data

| Tool | Description |
|------|-------------|
| `vault_git_log` | Recent commits across tracked repositories |
| `vault_recent_files` | Recently modified files, grouped by project |
| `vault_system_info` | OS, hardware, dev tool versions |
| `vault_projects` | Recent VS Code workspaces and extensions |

### AI-assisted (optional — needs a Gemini API key)

| Tool | Description |
|------|-------------|
| `vault_smart_search` | Locally ranked search; re-ranked by Gemini when a key is configured |
| `vault_ai_summarize` | Summarise matching entries with Gemini |
| `vault_ai_insights` | Patterns and productivity insights |
| `vault_weekly_digest` | AI-written weekly digest |

> These four send entry titles/snippets to Google's Gemini API. Without a key they simply say AI is not configured; everything else works offline.

### Storage & bridges

| Tool | Description |
|------|-------------|
| `vault_backup` | Back up the vault to local + Google Drive (folder mirror & API) |
| `vault_backups` | List local backups available to restore |
| `vault_bridge_list` | List connected AI MCP servers and their tools/resources |
| `vault_bridge_sync` | Pull data from other AI MCP servers into the vault |

Plus **5 resources** (recent entries by type, vault stats) and **3 prompts** (`user_context`, `project_summary`, `daily_brief`).

### Smart Context Engine

| Feature | How It Works |
|---------|-------------|
| **Auto-Tagging** | ~30 regex patterns detect `react`, `python`, `docker`, `bugfix`, etc. |
| **Relevance Scoring** | Keyword match strength + recency + entry type |
| **Project Detection** | Recognises *your* projects — define them under `"projects"` in the config |
| **De-duplication** | Jaccard similarity filters near-duplicate entries |
| **Session Memory** | Optionally hides entries the AI already saw this session |
| **Daily Digest** | Aggregates a day's activity with project + tech stack breakdown |

---

## 🔒 Privacy & what gets stored

MemVault is **local-first**: the vault is a SQLite file on your disk, and nothing leaves your machine unless *you* switch on a feature marked ☁️.

| Engine | What it stores | Default |
|--------|----------------|---------|
| **Git** | Commit subject/body, author name, repo name and path | On |
| **VS Code** | Recent project folders, installed extensions, a few editor preferences | On |
| **System** | Hostname, OS, CPU/RAM, disk usage, dev tool versions, local IP addresses, names of the 20 largest processes (executable names only — never their command-line arguments) | On |
| **Files** | Names, sizes and modified dates of recent files in `~/Documents` and `~/Desktop` — **never file contents** | On |
| **Browser** | Pages visited 2+ times and bookmarks (Chrome, Edge, Brave) | **Off** |
| **Clipboard** | Copied text — anything that looks like a secret is skipped (best effort) | **Off** (manual daemon) |
| **Antigravity** | Conversation artifacts (plans, tasks, walkthroughs) | **Off** |
| **Importers** | The conversations in the export you point them at | Manual |

Turn any engine off with `"sync": { "systemEnabled": false }` (etc.) in `~/.memvaultrc.json`. Exclude browser domains with `"browserExcludeDomains": ["bank.example"]`.

**☁️ Things that send data off your machine — only if you enable them:**

- **Gemini AI features** — entry titles/snippets needed for a request go to Google's Gemini API, using *your* key.
- **Google Drive backup** — uploads a copy of the vault. **Entries are stored unencrypted in the vault file; only the Secure Vault is encrypted.** Treat your Drive account accordingly.
- **MCP bridges** — launch third-party MCP servers (via `npx`) that you configured.

There is **no telemetry, no analytics, and no account**. The web UI loads no third-party fonts, scripts or images.

---

## 🛡️ Security

- **stdio transport** — the MCP server talks over stdin/stdout, never over the network.
- **Loopback-only web server** — `memvault serve` binds to `127.0.0.1`. It has **no login**, so it also rejects requests with a foreign `Host` header (DNS rebinding) or a cross-site `Origin` (a web page you visit cannot read or write your vault), sends no CORS headers, and applies a strict Content-Security-Policy.
- **Encrypted secrets** — AES-256-GCM, key from your master password with PBKDF2-SHA256 (600k iterations, random salt per secret). The master password is never stored; failed guesses are rate-limited. Secret *values* are never exposed to the MCP server or the AI.
- **Safe re-runs** — sync and import are idempotent. Engines never delete anything they did not create; "current state" snapshots (system info, VS Code extensions, per-folder file activity, bridge pulls) are *replaced* by the newer snapshot instead of piling up.
- **Safe local edits** — several MemVault processes (web UI, MCP server, sync job) can share one vault without overwriting each other.

> ⚠️ Do **not** set `"host": "0.0.0.0"` unless the network is fully trusted — anyone who can reach the port could read and change your vault. The server prints a warning if you do.

What is **not** protected: anyone with access to your user account or disk can read the vault file (only secrets are encrypted at rest). Use full-disk encryption. Report vulnerabilities as described in [SECURITY.md](SECURITY.md).

---

## 📁 Project Structure

```
memvault/
├── cli.mjs                # `memvault` command (init, serve, mcp, sync, import, backup, bridge, vault)
├── mcp-server.mjs         # MCP server: 24 tools, 5 resources, 3 prompts (stdio)
├── server.mjs             # Local web UI + HTTP API (127.0.0.1)
├── db.mjs                 # The ONE database layer: locking, atomic writes, de-dupe, search
├── secrets.mjs            # Secure Vault encryption (AES-256-GCM + PBKDF2)
├── security.mjs           # Host/Origin guards, CSP, password-attempt limiter
├── config.mjs             # Settings (~/.memvaultrc.json + env vars)
├── context-engine.mjs     # Auto-tag, relevance scoring, de-dupe, digests
├── ai-engine.mjs          # Optional Gemini features
├── storage.mjs            # Local backups + Google Drive (folder mirror / API)
├── mcp-bridge.mjs         # Outbound MCP client — pull memory from other AI tools
├── init.mjs               # Interactive setup wizard
├── vault.mjs              # Add/search entries from the terminal
├── setup-windows.mjs      # Optional: autostart at Windows login
│
├── sync-all.mjs           # Runs every enabled engine
├── sync-git.mjs  sync-vscode.mjs  sync-system.mjs  sync-files.mjs
├── sync-browser.mjs  sync-clipboard.mjs  sync-antigravity.mjs
├── sync-lib.mjs           # Shared helpers for engines
│
├── import-all.mjs         # Auto-detect + import AI exports
├── import-chatgpt.mjs  import-claude.mjs  import-gemini.mjs  import-perplexity.mjs
├── import-lib.mjs
│
├── public/                # Web UI (single HTML file)
├── docs/                  # Guides
└── tests/                 # Vitest suite
```

---

## ⚙️ Configuration

MemVault reads `~/.memvaultrc.json` (the wizard creates it owner-only on Linux/macOS). Everything is optional. Paths may start with `~` (your home folder):

```json
{
  "vaultRoot": "~/.memvault/data",
  "port": 7799,
  "sync": {
    "gitDirs": ["/home/you/projects"],
    "filesDirs": ["/home/you/Documents", "/home/you/Desktop"],
    "gitEnabled": true,
    "vscodeEnabled": true,
    "systemEnabled": true,
    "filesEnabled": true,
    "browserEnabled": false,
    "browserExcludeDomains": [],
    "clipboardEnabled": false,
    "antigravityEnabled": false
  },
  "projects": [
    { "name": "My App", "patterns": ["my-?app", "myapp\\.com"], "tags": "myapp,web" }
  ],
  "ai": {
    "enabled": true,
    "apiKey": "YOUR_GEMINI_API_KEY",
    "model": "gemini-2.0-flash"
  },
  "storage": {
    "local": { "enabled": true },
    "gdriveFolder": { "enabled": false, "path": "/home/you/Google Drive" },
    "gdriveApi": { "enabled": false, "clientId": "", "clientSecret": "", "refreshToken": "", "folderId": "" },
    "keepLocalBackups": 20
  },
  "mcpBridges": [
    { "name": "memory", "command": "npx", "args": ["-y", "@modelcontextprotocol/server-memory"], "enabled": true, "importTool": "read_graph" }
  ]
}
```

> **☁️ Google Drive** — see [docs/google-drive.md](docs/google-drive.md). &nbsp; **🔌 MCP bridges** — see [docs/mcp-bridge.md](docs/mcp-bridge.md). &nbsp; **🚀 Autostart** — see [docs/autostart.md](docs/autostart.md).

### Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `VAULT_ROOT` | `~/.memvault/data` | Where vault data is stored |
| `VAULT_PORT` (or `PORT`) | `7799` | Web UI / API port |
| `VAULT_HOST` | `127.0.0.1` | Interface to listen on (see the security note above) |
| `GEMINI_API_KEY` | – | Gemini key (alternative to `ai.apiKey`) |
| `BRAIN_DIR` | `~/.gemini/antigravity/brain` | Antigravity artifacts folder |
| `BROWSER_PROFILE` | `Default` | Chromium profile folder for the browser engine |

---

## 🧰 CLI Commands

```bash
memvault init                       # setup wizard
memvault serve                      # web UI + API on http://localhost:7799
memvault mcp                        # MCP stdio server (what AI clients launch)

memvault sync                       # run all enabled engines (add --dry-run to preview)
memvault import <folder>            # import ChatGPT / Claude / Gemini / Perplexity exports

memvault backup                     # back up to local (+ Google Drive if enabled)
memvault backup list                # list local backups
memvault backup restore <name>      # restore one (a safety snapshot is taken first)

memvault bridge presets             # popular AI memory servers you can connect
memvault bridge add memory          # enable one
memvault bridge sync                # pull their memories into your vault

memvault vault diary "Shipped the new auth flow"
memvault vault search "auth"
```

From a git clone the same things are available as `npm start`, `npm run sync`, `npm run backup`, `npm run sync:browser`, `npm run sync:clipboard` (daemon) and so on — see `package.json`.

### Platform support

| | Linux | macOS | Windows |
|---|:---:|:---:|:---:|
| MCP server, web UI, importers, backup | ✅ | ✅ | ✅ |
| Git, VS Code, files, system engines | ✅ | ✅ | ✅ |
| Browser engine (Chrome/Edge/Brave) | ✅ | ✅ | ✅ (and WSL → Windows profiles) |
| Clipboard daemon | needs `wl-paste`, `xclip` or `xsel` | ✅ | ✅ |
| Autostart | [systemd](docs/autostart.md) | [launchd](docs/autostart.md) | `node setup-windows.mjs` |

The automated test suite runs on all three systems. Engines that read OS-specific locations (browser profiles, PowerShell calls) are written for each platform but have had less real-world use than Linux — please [open an issue](https://github.com/MrChartist/memvault/issues) if one misbehaves on your machine.

---

## ⚠️ Known limitations

- **Whole-database-in-memory storage.** MemVault uses [sql.js](https://github.com/sql-js/sql.js) (SQLite compiled to WebAssembly) to stay dependency-light and install anywhere with no native build step. The database is loaded into memory and rewritten on each change, which is comfortable for tens of thousands of entries but not for millions.
- **Keyword search, not semantic search.** Search is substring matching with relevance ranking; this build of SQLite has no full-text index. Gemini re-ranking is optional.
- **No authentication on the local web server** — it relies on being reachable only from your own machine (see [Security](#️-security)).
- **Vault entries are not encrypted at rest** — only the Secure Vault is.

---

## 🗺️ Roadmap

- [x] **Phase 1** — Core MCP Server
- [x] **Phase 2** — Universal Data Capture (7 sync engines)
- [x] **Phase 3** — Smart Context Engine (auto-tag, relevance, dedup, memory)
- [x] **Phase 4** — CLI Wizard & Configuration
- [x] **Phase 5** — AI Intelligence (Gemini) + Importers for ChatGPT, Claude, Gemini, Perplexity
- [x] **Phase 6** — Auto-start on boot
- [x] **Phase 7** — Google Drive backup & MCP bridges to other AI servers
- [x] **Phase 8** — Open-source hardening (local-only server, safe sync, de-duplication, test suite)
- [ ] **Phase 9** — Ollama integration for local AI summarization

---

## 🤝 Contributing

Contributions are welcome! Please read [CONTRIBUTING.md](CONTRIBUTING.md) first — it covers the dev setup, the test suite, and the privacy rules new capture engines must follow. Please also follow our [Code of Conduct](CODE_OF_CONDUCT.md).

```bash
git clone https://github.com/MrChartist/memvault.git
cd memvault && npm install && npm test
```

---

## 📄 License

MIT © [Rohit (MrChartist)](https://github.com/MrChartist)

---

<p align="center">
  <b>Made with care by <a href="https://github.com/MrChartist">Mr. Chartist</a></b><br>
  <i>Built for developers who want their AI to actually understand them.</i><br><br>
  <a href="https://mrchartist.com"><img src="https://img.shields.io/badge/mrchartist.com-6366f1?style=flat-square&logo=safari&logoColor=white" alt="Website"/></a>
  <a href="https://github.com/MrChartist"><img src="https://img.shields.io/badge/More_Projects-0d1117?style=flat-square&logo=github&logoColor=white" alt="GitHub"/></a>
</p>

<img src="https://capsule-render.vercel.app/api?type=waving&color=0:0d1117,50:1a1a2e,100:6366f1&height=100&section=footer" width="100%" />
