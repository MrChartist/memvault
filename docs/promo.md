# Launch copy — MemVault 3.0

> **Draft. Do not post until the "Before you post" list below is true.** This copy was rewritten for 3.0 after an independent review. The earlier (2.1) text made claims that are no longer correct, for example that capture runs silently (it is now off until you switch it on) and that your AI logs every prompt (it now only does so if you ask).

## Before you post

| Check | Status |
|---|---|
| The package is published to npm, and `npx @mrchartist/memvault setup` works on a computer that has never had MemVault (try it on Windows, macOS and Linux) | **Not done.** Nothing has been published. |
| The MCP registry entry (`server.json`) is published and a registry install starts the server | **Not done.** The entry now validates against the published schema; publishing has not been tried. |
| Private vulnerability reporting is switched on for the repository | **Needs verification** by the owner. |
| A short demo (screen recording) exists | **Not found in files.** No demo asset exists yet. Record it from a clean install. |
| The CI jobs for Windows and macOS are green, or the post says plainly that they are untried | **Done in CI.** Tests and the install check pass. No person has tried them by hand yet, so keep saying so. |
| Every number in the post is one you measured | See "Numbers you may use" below. |

## What to say, in one paragraph

MemVault is a notebook on your own computer that your AI apps (Claude, Cursor, Antigravity, VS Code and others that support MCP) can all read and write, so you stop repeating yourself. You can give each AI its own helper (an "agent") with its own rules and a limited view of your notes. Your notes stay on your computer. What an AI reads from them goes to that AI's company, like anything you type to it, so MemVault limits how much each AI sees and hides passwords and ID numbers before saving, but it cannot make that part disappear. It is free, open source (MIT), and has no tracking.

## What to be honest about

- It needs Node.js and a few terminal commands today. A one-click installer is planned, not built.
- It was built on Linux. Windows and macOS pass the automated tests but have not been tried by hand.
- The dashboard is English only. It has been checked with automated accessibility tools, not with a real screen reader or with disabled users.
- Search finds the words you type, not the meaning.
- It is comfortable up to a few tens of thousands of notes; beyond that saving gets slow.
- Hiding secrets is pattern matching. Unusual formats get through.

## Numbers you may use (all measured in the review; re-measure if the code changes)

| Claim | Measured |
|---|---|
| Tools offered to an AI | 29 for you, 23 for an agent with default settings |
| Space those tool descriptions use in each chat | about 4,400 tokens (an estimate: characters ÷ 4) |
| Writes lost when 8 programs save at once | 0 of 7,200 (three runs) |
| Time to import 200 conversations | about 0.06 seconds in one batch |
| Notes before saving becomes noticeably slow | around 10,000 feels instant; 100,000 takes 0.7 to 1.9 seconds per save |
| Tests | see the latest CI run; do not quote a number from this file |

## 1. X (Twitter) thread

**Post 1**
Every new AI chat starts with an empty head. I got tired of repeating myself, so I built MemVault: one private notebook, on your own computer, that Claude, Cursor and other MCP apps can all use.

**Post 2**
Tell one AI "remember that I prefer short answers". Another AI can find it later. You can also give each AI its own helper, with its own rules and its own limited view of your notes.

**Post 3**
Your notes stay on your computer. Be clear about one thing: when an AI reads a note, that text goes to the company behind that AI, like anything you type. MemVault limits how much each AI can see and hides passwords and ID numbers before saving. It cannot make that part disappear.

**Post 4**
There is a dashboard to write, search, correct, pin and delete notes (with Undo). Settings, backups and capture are switches, not config files. Everything automatic is off until you turn it on. No tracking.

**Post 5**
Free and open source (MIT). It needs Node.js today and was built on Linux; Windows and macOS pass the automated tests but nobody has used them by hand, so tell me what breaks.
`npx @mrchartist/memvault setup`
https://github.com/MrChartist/memvault

*(Post only after the package is published and the command above works.)*

## 2. Reddit (r/selfhosted, r/ClaudeAI, r/LocalLLaMA)

**Title:** MemVault: a private memory on your own computer that all your AI apps share (MCP)

**Body**

I use more than one AI app and was tired of explaining the same things to each. MemVault is a local notebook your AI apps read and write through MCP.

- Notes are stored on your computer in one file. No account, no tracking, no cloud unless you add an encrypted backup yourself.
- "Agents" are saved helpers (job, tone, always/never rules, which notes they may see). An app connected to one agent can only ever be that agent, and the limit is enforced on the data, not by asking the AI nicely.
- Passwords, keys, card numbers and ID numbers are hidden before saving. It is pattern matching and will miss unusual formats.
- Importers for ChatGPT, Claude, Gemini (Google Takeout) and Perplexity exports. Export formats change, so tell me if a file does not import.
- Optional capture (git commits, VS Code projects, file names, browser page titles, clipboard) is all off by default.

Limits, so you do not find them the hard way: it needs Node 20+ and a terminal, it is only tested on Linux, the dashboard is English only, search is by word not meaning, and it slows down past a few tens of thousands of notes. What an AI reads from your notes goes to that AI's company; see SECURITY.md.

Repo: https://github.com/MrChartist/memvault

## 3. Hacker News (Show HN)

**Title:** Show HN: MemVault – one local memory shared by all your AI apps (MCP)

**Body**

MemVault is a local-first memory for AI assistants. Your AI apps connect to it over MCP (one stdio server process per app) and read and write one SQLite file on your machine. A small dashboard lets you correct, pin and delete memories.

Design points I would like feedback on: agent isolation is enforced by giving a bound process a filtered copy of the database rather than trusting each query; every write goes through one function that masks secrets and writes a hash-chained audit record; cloud backups are encrypted or refused; the server listens on loopback only and needs a key on every data route.

What it does not do: it cannot stop an AI you allowed from sending what it read to its provider; masking is regexes; it uses sql.js, so every save rewrites the file and it gets slow past tens of thousands of notes (a native SQLite engine is the first roadmap item); and it has only been run on Linux.

https://github.com/MrChartist/memvault
