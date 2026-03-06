# 🚀 Getting Started with MemVault

Welcome to **MemVault**, your ultimate, self-hosted central hub for knowledge preservation and indexing. Designed for speed, privacy, and frictionless data capture.

---

## ⚙️ 1. Environment Details

MemVault uses a `.env` file for configuration. Start by copying `.env.example` to `.env` and adjusting it:

- **`VAULT_ROOT`**: Determines where your entire database and files reside. (Default: `~/.memvault`)
- **`VAULT_PORT`**: Sets the web server port. (Default: **7800**)
- **`TELEGRAM_BOT_TOKEN`** & **`USER_ID`**: (Optional) Allow you to dump diary notes directly into your vault via a private Telegram bot on your phone.
- **`GITHUB_TOKEN`**: (Optional) Enables syncing your commits directly to the timeline.

## 🛠️ 2. Quick Deploy Native

MemVault requires **Node.js 22.5+** to utilize the native synchronous SQLite driver (`node:sqlite`) for blistering fast speeds. No external C++ bindings are required.

```bash
# Clone and prepare
git clone https://github.com/MrChartist/memvault.git
cd memvault
npm install

# Start the high-performance ESM Server
npm start

# Access the beautiful Web Dashboard
# -> http://localhost:7800
```

## 📡 3. Background Sync Engines

MemVault lives automatically in the background. The server handles a sequential, error-checked sync loop **every 15 minutes**. It securely pulls data from:

- **Antigravity Sync**: Local AI conversation and worklog exports (e.g., from `.gemini/antigravity/brain/`).
- **Browser Pulse**: Ingests Google Chrome and Microsoft Edge history, deduplicating URLs to track your research path.
- **GitHub Sync**: Fetching your recent commits as Worklogs.
- **Doc Sync**: Automatically pushing markdown files situated in the `docs/` folder straight into the central FTS index.

### Manual Foreground Sync

Sometimes you want your logs immediately. You can trigger sync scripts manually:

```bash
# E.g., Sync AI Conversation logs right now
node sync-antigravity.mjs

# E.g., Pulse browser history right now
node sync-browser.mjs
```

## ⌨️ 4. Essential Navigation

MemVault features **SPA (Single-Page Application)** architecture. No reloads. No waiting.

- **`Ctrl + /`**: Fly instantly to the Global Search Bar.
- **`Alt + N`**: Focus the Quick-Entry Diary from any tab.
- **`1 - 6`**: Switch Views instantly (Timeline, Diary, Convos, Worklogs, Docs Explorer, Project Hub).
- **`V`**: Open the **Encrypted Vault** with your Master Password.
- **`?`**: Pop open the native **Shortcuts Guide**.

---

*Need emergency help? Your physical data exclusively lives at `[VAULT_ROOT]/db/index.sqlite`. Back this up routinely to an external drive to secure your timeline from hardware failure!*
