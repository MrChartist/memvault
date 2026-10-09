# Security Policy

MemVault stores personal data (code history, notes, AI conversations, optionally browser history) and an encrypted
password vault, so security reports are taken seriously.

## Reporting a vulnerability

**Please do not open a public issue for security problems.**

Use GitHub's private reporting: **Security → Report a vulnerability** on
<https://github.com/MrChartist/memvault/security/advisories/new>.

Include what you found, how to reproduce it, and the version (`memvault --version`). You will get an acknowledgement
within a few days, and we will keep you informed while a fix is prepared. Please allow reasonable time to release a
fix before disclosing publicly.

## Supported versions

Security fixes are released for the latest minor version on npm.

## Threat model — what MemVault does and does not protect

**Designed to protect against**

| Threat | How |
|---|---|
| A web page you visit reading or changing your vault through `localhost` | The web server only accepts same-origin requests (`Origin` check), rejects foreign `Host` headers (DNS rebinding), sends no CORS headers, and has a strict Content-Security-Policy |
| Other machines on your network | The server binds to `127.0.0.1` by default; MCP uses stdio only |
| Stored cross-site scripting through vault content | The UI escapes every database-sourced value; CSP blocks external scripts, frames and form targets |
| SQL injection through tool arguments | All queries are parameterised; `LIKE` wildcards in user text are escaped |
| Guessing the master password | PBKDF2-SHA256 with 600,000 iterations and a random salt per secret; failed attempts are throttled with exponential back-off |
| A stolen/leaked secrets blob | Secrets are AES-256-GCM encrypted; tampering is detected |
| Credentials in process command lines ending up in the vault | The System engine records executable names only, never command-line arguments |
| Leaking secrets from the clipboard into the vault | The (opt-in) clipboard engine skips text that looks like keys, tokens, private keys, card numbers, or `password=` lines |
| Leaking your environment to third-party MCP servers | Bridges receive only a minimal environment plus their own configured `env` |
| Data loss from concurrent processes | A cross-process lock and atomic writes; engines never delete data they did not create (snapshots are replaced by newer snapshots) |

**Not protected / out of scope**

- **Anyone with access to your user account or disk.** Vault *entries* are stored unencrypted in the SQLite file; only the
  Secure Vault is encrypted. Use full-disk encryption.
- **The local web server has no login.** If you bind it to a non-loopback address (`"host": "0.0.0.0"`) anyone who can reach
  it can read and change your vault. Do not do this on an untrusted network.
- **Google Drive backups contain the unencrypted entries** (secrets stay encrypted). Protect your Drive account.
- **Gemini features** send entry titles/snippets to Google when you configure an API key.
- **MCP bridges run programs you configure** (the presets use `npx -y`, which downloads from npm). Only add bridges you trust.
- **Malicious content inside the vault** (for example text imported from a web page) can end up in an AI client's context.
  As with any tool-fed context, treat it as untrusted.
- A **weak master password** is only as strong as the password; the minimum is 8 characters.

## Hardening checklist for users

- Keep `host` at its default (`127.0.0.1`).
- Enable only the capture engines you need; browser history and clipboard are off by default.
- Keep `~/.memvaultrc.json` private — it may contain API keys. MemVault writes it owner-only (`0600`) on Linux/macOS; on Windows, file permissions are not changed, so rely on your user profile's default access rules.
- Use a long, unique master password for the Secure Vault, and do not forget it: it cannot be recovered.
