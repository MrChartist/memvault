# Security

MemVault keeps a private memory on your own computer for the AI assistants you use. This page says plainly what it protects, how, and what it cannot protect. **No software is perfectly safe, and MemVault does not claim to be.**

You can check your own setup at any time:

```bash
memvault doctor          # live report: permissions, exposure, backups, secrets
memvault audit --verify  # is the access log intact?
memvault scrub           # preview masking of secrets stored before masking existed
```

The dashboard's **Security** page shows the same checks.

## The honest limits

Read these first. They apply to any tool that lets an AI use your notes.

1. **What an AI reads leaves your computer.** Your memory is stored locally. But when Claude, Cursor, Gemini or any other AI app reads a note through MemVault, that text becomes part of your conversation and is sent to the company behind that AI, like anything you type. MemVault can limit *how much* each AI can see (agents, private notes, tool limits). It cannot stop an AI you allowed from sending what it read to its provider. If something must never reach an AI company, keep it out of MemVault, or use only local models.
2. **Masking is a safety net, not a guarantee.** Secrets are detected by patterns and checksums (see below). Unusual formats will be missed, and a few harmless numbers might be masked by mistake. Do not rely on it to protect something you should not have written down at all.
3. **Anything running as you can read your files.** Malware, a browser extension with file access, or another person using your operating-system account can read the vault and the access key. MemVault cannot defend against code that already runs with your permissions.
4. **A lost or stolen laptop.** The memory file is not encrypted as a whole (only the Secure Vault and cloud backups are). Turn on your system's disk encryption: BitLocker (Windows), FileVault (macOS), or LUKS (Linux).
5. **A prompt-injected AI.** Text from a web page, a document, or another agent can try to trick an AI into misusing its tools. MemVault limits the damage (see "Agents" below) but cannot stop an AI from being fooled about what to *write*.
6. **Backups made earlier.** Backups, exports and cloud copies made before a secret was masked still contain it. `memvault scrub` cleans the live vault only.
7. **Third-party tools you connect.** An MCP bridge runs a program from your config as you. The built-in presets start `npx -y <package>`, which downloads the newest version of that package each time it runs, so a later malicious release would run too. Only enable bridges you trust, and prefer pinning a version. Optional Gemini features send the text they work on to Google, using your key.
8. **A forgotten master password or backup passphrase cannot be recovered.** There is no reset, by design. Write them down somewhere safe.
9. **Automatic capture reads your computer.** When you switch a kind on, MemVault reads what that kind needs (commit messages, file names, page titles, the clipboard) and stores it. Look at Settings to see what is on.

## What MemVault protects, and how

| Risk | Defence | Checked by |
|---|---|---|
| A web page in your browser reads or wipes your vault | The server listens on `127.0.0.1` only; every request needs a 256-bit key; foreign `Origin` headers are refused; no CORS headers are ever sent | `tests/server.test.js` |
| DNS-rebinding attacks | Requests whose `Host` header is not a loopback name are refused | `tests/server.test.js` |
| Another device on your network | Not reachable. Binding to anything other than loopback refuses to start unless you set `allowRemote` | `tests/server.test.js` |
| Script injection into the dashboard (agents can write text to the vault) | All text is escaped; no inline scripts or styles; strict Content-Security-Policy; the dashboard makes no outside requests | `tests/server.test.js`, browser tests with hostile entries |
| Passwords, keys and IDs stored in the clear | Masked on every write path (API, uploads, MCP tools, importers, sync, clipboard, bridges), including titles, tags, sources and file names. The readable Markdown copies and the access log are written from the masked text. Masking is pattern matching and misses unusual formats | `tests/redact.test.js`, `tests/mcp.test.js`, `tests/server.test.js` |
| One AI seeing another agent's private notes | A bound agent reads through a copy of the database from which everything it may not see has been **removed**, so no query can reach it | `tests/db.test.js`, `tests/mcp.test.js` |
| An AI granting itself more access | An agent's identity comes from the `MEMVAULT_AGENT` setting of its MCP connection, not from the AI. A bound connection can only activate its own agent. A missing profile stops the server rather than falling back to full access. Profiles and permissions can only be changed by you | `tests/mcp.test.js` |
| One agent forging a message from another | A handoff counts only if it was written by the handoff tool and its sender matches who actually wrote it; an acknowledgement counts only from the agent it was addressed to. Typing tags such as `handoff,from:owner` does nothing | `tests/mcp.test.js` |
| An AI calling tools it should not have | Tools the agent may not use are not even offered. Owner-only tools (backups, bridges, editing agents) are never offered to a bound agent. The list of Secure Vault *names* (never values) is offered only to an agent you have explicitly allowed to see it. Resources and prompts are recorded in the access log like tools, and an agent limited to certain tools does not get the memory-reading ones | `tests/mcp.test.js` |
| Two AIs overwriting each other | Writes take a cross-process lock, re-read the freshest file, and replace it atomically. A writer that was paused so long its lock was taken over notices and redoes its write instead of overwriting the newer file. (The old design lost 200 of 300 concurrent writes; the new one lost 0 of 7,200 in three review runs of 8 processes × 300 writes.) A crash leaves the database intact (200 forced kills in review: none damaged, none lost) | `tests/db.test.js`, `tests/integrity.test.js` |
| Guessing the Secure Vault password | scrypt (memory-hard) key derivation; 5 wrong tries lock it for a minute, on every secrets route, including vaults made by older versions | `tests/server.test.js` |
| Cloud copies read by someone else | Encrypted with your passphrase before upload. With no passphrase the upload is refused, not sent in plain text | `tests/storage-encrypt.test.js` |
| Silent tampering with the access log | Each record includes a hash of the one before; `memvault audit --verify` finds edited records, records removed from the middle, and reordering. It **cannot** detect records removed from the end, or a rewrite of the whole file by someone who can write to it (the hashes are not secret) | `tests/audit.test.js` |
| Accidental or scripted deletion | Deleting several memories, deleting by source or tag, and "delete everything" need an explicit typed confirmation and take a backup first. Deleting one memory can be undone for an hour (while the dashboard server runs). The Antigravity sync used to wipe everything; it now removes only what it wrote | `tests/server.test.js` |
| Deleted text left on disk | Deleting or editing a memory also removes or rewrites its readable Markdown copy, including copies made by earlier versions. Backups made before the deletion still contain it | `tests/mirror.test.js`, `tests/server.test.js` |
| A bad or damaged restore | A backup file is checked (it must open, pass the integrity check and contain MemVault's data) before it can replace the live database; a vault from a newer version is refused instead of being re-labelled | `tests/storage.test.js`, `tests/integrity.test.js` |
| SQL injection | Three prompt and tool inputs used to be pasted into SQL (the last one found in the independent review could read the secrets table); no MCP query is built from strings any more | `tests/mcp.test.js` |
| A program run by a bridge reading your secrets | A bridge is started with a small environment (PATH, HOME, proxy settings and what you list for it), not your whole environment, so the backup passphrase and other keys stay private | `tests/mcp-bridge.test.js` |
| Another account on the same computer reading your dashboard key | `memvault open` starts the browser on a private local file, so the key never appears in a command line | `tests/cli.test.js`, browser tests |

## Details for the curious

**The access key.** A random 256-bit key stored in `~/.memvault/api-token` (mode 0600), deliberately *outside* the vault folder so backups never include it. The dashboard receives it in the URL fragment (`#token=…`), which browsers never send to servers; the page keeps it in `sessionStorage` and removes it from the address bar immediately. `memvault open` reaches the dashboard through a short-lived private page in that same folder. The key is compared in constant time and is never accepted from a web address.

**Secure Vault.** The page hides each value until you press Show, closes the window after a minute, and locks itself after five minutes without use. **There is no password recovery by design.** AES-256-GCM. The key comes from your master password with scrypt (N=32768, r=8, p=1) and a random 16-byte salt per item; a random 12-byte IV per item; the item's id is bound into the authentication tag so a stored blob cannot be swapped onto another label. The password is never stored. Passwords must be at least 10 characters. Items from before 3.0 (static-salt PBKDF2) still open and are upgraded the first time you open them.

**Encrypted backups (`.mvbak`).** AES-256-GCM, scrypt with a fresh salt, the header is authenticated too. Passphrase from `MEMVAULT_BACKUP_PASSPHRASE` or the first line of a file you name (`storage.passphraseFile`); never from the JSON config. The Settings screen writes that file (`~/.memvault/backup-passphrase`, mode 0600, outside the vault, never returned by the server or logged). This protects the cloud copy from the cloud provider; it does not protect against someone who can read your home folder.

**Agents.** Memory is split into spaces: `shared`, `agent:<id>` and `project:<name>`. An agent bound to a profile gets (a) reads of `shared` plus its own space plus any spaces its profile lists, (b) writes to `shared` and its own space, (c) no access to the secrets table unless you allowed it, and even then only the labels, never values, (d) only its allowed tools. Briefings put memory inside a clearly marked data block and tell the AI to treat it as information, not instructions; text that tries to close that block is neutralised.

**Masking.** Detects private keys (including PGP blocks and keys pasted without their closing line), AWS/GitHub/Google/Slack/Stripe/OpenAI/Anthropic keys, tokens from npm, PyPI, SendGrid, GitLab, Hugging Face, Twilio, Telegram and others, Slack and Discord webhook links, Azure and Google refresh keys, JWTs, `Authorization:` headers, `password=`/`API_KEY=`-style assignments (also in JSON and quoted `.env` values, including values with spaces), passwords inside URLs, `curl -u` and `mysql -p`, card numbers (issuer prefix plus Luhn), US SSN, IBAN (mod-97), UK National Insurance, Canadian SIN (Luhn), India's Aadhaar (Verhoeff) and PAN, one-time codes, and (only when the words say so) bank account and passport numbers. Each detector has tests for what it must and must not match, and the patterns are bounded so hostile text cannot make them slow (200 KB of adversarial input takes well under a second). Turn individual detectors off with `security.redactDisable`. A review test of 63 real-world strings found most formats were missed by the first version; those are now covered, but a secret in a format nobody has listed will still get through.

**Audit log.** `audit.log` in the vault folder, one JSON line per event: time, who (an agent id, `owner`, or a tool name), what, and small facts such as counts and tool names. Tools, resources and prompts are all logged. Never note content. A hash chain makes edits, removed middle records and reordering visible. It cannot detect records cut from the end or a whole-file rewrite, and it cannot stop someone with file access from deleting the file, so keep an occasional copy if that matters to you. A half-written last line (a power cut) no longer stops later records from being written.

## What has and has not been checked

A second, independent review (October 2026, an AI-assisted code review that ran the code, with tests for each finding) found and fixed several real problems in version 3.0 before release; they are listed in `CHANGELOG.md` and `docs/review/REVIEW.md`. That review was **not** a professional security audit or a penetration test by a third party, and nothing was tested on Windows or macOS. It did not review the Google Drive upload against a real Google account.

## Reporting a problem

Please report security problems privately through GitHub's **Report a vulnerability** option on the repository's Security tab, or open an issue without exploit details and ask for a private channel. The repository owner must switch on private vulnerability reporting for the first route to work (*Needs verification* before launch). We will acknowledge a report and fix confirmed problems in the latest 3.x release. No response time is promised: this is a one-person project.

## Supported versions

The latest 3.x release. Version 2.x opened the server to your whole network without a key; please upgrade.
