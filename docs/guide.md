# 📖 Master User Guide

MemVault operates as a high-speed, unified digital timeline. Every entry (Diary, Browser History, AI Conversation, Documentation) is treated as a searchable "Memory."

## 🛠️ The Global Search Engine (FTS5)

The search bar is powered by a native **Full-Text Search (FTS5)** engine mapped directly via SQLite.

- **Intelligent Querying**: Fuzzy and direct string matching across titles, content, tags, and projects.
- **Cross-Index Context**: Selecting `#bugs` in the `Worklogs` panel specifically isolates bugs within your daily AI work history. Alternatively, querying the `Conversations` panel for a piece of code instantly tracks down the session where it was generated.
- **Shortcut**: `Ctrl + /` snaps your cursor instantly precisely here from any tab.

---

## 📁 The Projects Hub

The timeline can become overwhelming. MemVault's **Project Hub** (`6`) gives your context structure by unifying streams of data by a specific tag.

- Create a brand new project (e.g., `MemVault Dev`) directly via the modal.
- Start tagging specific entries, browser bookmarks, or auto-tracked GitHub commits as `#MemVault Dev`.
- The **Projects Explorer** filters down to exclusively display the timeline, diary, and worklogs concerning the active Project.

### ✨ Local AI Summaries

If you run **Ollama** locally, MemVault operates an integration (`OLLAMA_URL=http://localhost:11434`).
A **Sparkle Icon** sits alongside every project. By clicking it, the 30 most recent artifacts representing the project are sent natively to your local Qwen3.5 LLM. A 2-sentence summary outlining the current development state of your project will be generated directly in the UI.

---

## 🔒 The Encrypted Secrets Vault

You likely store API keys in insecure `.env` files or Notion databases. This is a vulnerability. The **Secure Vault** (`V`) fixes this.

1. **The Core Mechanism**: Unlocking the vault demands a session-backed **Master Password**.
2. **Encryption Standards**: All secrets are individually salted and encrypted via Node's native **AES-256-GCM**.
3. **No Key Storage**: Wait, where is your master password? Nowere. It is not saved in the DB, not hashed, nor written to disk. MemVault uses an encrypted sentinel record verification method: opening the vault attempts to decrypt a dummy-safe file. If the sentinel opens successfully, your password is mathematically mathematically proven to be valid.
4. **Copy-on-Click**: Clicking a revealed `password` or `apikey` field inside the vault copies the string directly to your clipboard, allowing lightning-fast workflow deployment. And your session locks when the browser is manually refreshed.

---

## 🌍 Headless Synchronization & Expansion

You operate on a central primary workstation, but you might need to push data from an alternate AI rig or a laptop on your local network.

- Your main host acts as the server via `node server.mjs` (e.g., `192.168.1.100:7800`).
- From your *secondary* rig/laptop, you can simply feed data automatically into the remote vault running on your primary workstation using environmental overriding:

```bash
# Push history natively onto the primary Host:
VAULT_API="http://192.168.1.100:7800" node sync-antigravity.mjs
```

---

## 📅 Chronological Heatmap Review

You might just want to understand your volume of work.
Clicking **Explore by Date** opens the chronological calendar heatmap. Much like public GitHub contributions, MemVault renders the volume of your daily personal tasks and agentic workflows logically across the color spectrum. Actively clicking a specific matrix brings forward everything produced natively on that particular date.

*MemVault — 100% Fully Portable, Blisteringly Fast, Entirely Local.*
