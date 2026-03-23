# Promotion Strategy — MemVault v2.1

Here are templates and strategies for launching MemVault on various platforms.

## 1. Twitter / X (Thread)

**Tweet 1:**
Every time you start a new AI conversation, it forgets everything you’ve ever told it. 

I got tired of repeating myself, so I built MemVault — a persistent memory layer for Claude, Cursor, and any MCP tool. And yes, it’s 100% local. 🧠👇

**Tweet 2 (Demo):**
[Insert the demo GIF showing `memvault import` and Claude accessing context]
MemVault acts as a local data capture engine. It silently syncs your Git commits, VS Code activity, clipboard history, and now... your entire past AI chats.

**Tweet 3:**
Have older chats in ChatGPT, Claude, Nexus, or Gemini? 
I’ve built universal importers. Just point MemVault at your data export folder, and it automatically reads and indexes years of AI conversations in seconds.

**Tweet 4 (How it works):**
It serves this data directly into your AI assistant using the new Model Context Protocol (MCP). 
You just ask Claude: "What did we decide about the database schema last week?" and MemVault instantly pulls the right context from your vault. No cloud, no tracking.

**Tweet 5 (Call to action):**
It's completely free and open-source. Try it locally:
`npx @mrchartist/memvault init`

Star the repo if you hate repeating yourself to AI! ⭐
🔗 https://github.com/MrChartist/memvault

---

## 2. Reddit (r/LocalLLaMA, r/selfhosted, r/ClaudeAI)

**Title:** I built a local MCP server that gives Claude/Cursor persistent memory (and imports all your past ChatGPT/Claude histories)

**Body:**
Hey everyone,

One of the biggest pain points I have with AI is that every new session starts with a blank slate. I built **MemVault** to solve this. It's a universal, offline memory layer that serves context to your AI tools via the Model Context Protocol (MCP).

**What it does:**
- Runs completely locally as an MCP stdio server
- Captures context: Git commits, VS Code workspaces, Clipboard, System info
- **New in v2.1:** Native importers for your ChatGPT, Claude, Perplexity, and Google Takeout (Gemini) data exports. You can dump your ZIPs into a folder, run `memvault import`, and your new AI assistant instantly knows your entire history.
- AI Intelligence Layer: Uses your own Gemini API key (optional) to auto-tag, summarize, and semantically re-rank search results before sending them to Claude/Cursor.

**Tools it exposes to your AI:**
It gives your AI 20 different tools, including `vault_smart_search`, `vault_capture_prompt` (auto-logs what you ask), and `vault_remember` (lets the AI save facts for the future).

**How to try it:**
Requires Node.js 18+. Just run:
`npx @mrchartist/memvault init`

Repo: [GitHub Link](https://github.com/MrChartist/memvault)

Would love to hear what other data capture engines you'd like to see! Let me know what you think.

---

## 3. Hacker News (Show HN)

**Title:** Show HN: MemVault – Persistent local memory for Claude and Cursor via MCP

**Body:**
I built MemVault because I was tired of copy-pasting the same context into new AI chats. It's a local Node.js server that implements the Model Context Protocol (MCP). 

It runs background sync engines to capture your Git commits, VS Code activity, and clipboard. The new v2.1 release adds universal importers that parse your data exports from ChatGPT, Claude, Gemini, and Perplexity, converting them into searchable context.

When you ask Claude a question, MemVault uses a custom context engine (with optional semantic re-ranking via the Gemini API) to inject highly relevant past decisions, code snippets, and conversational history. Data never leaves your machine unless you explicitly enable the semantic AI features with your own API key.

Source code and setup instructions are on GitHub: https://github.com/MrChartist/memvault
