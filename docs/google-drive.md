# ☁️ Google Drive Backup

MemVault is **local-first**: your vault always lives on disk at `VAULT_ROOT`. On
top of that, you can back it up to Google Drive using either (or both) of two
methods. Local timestamped backups are always kept in `VAULT_ROOT/backups`.

## Your cloud copy is encrypted first

Anything MemVault puts outside your computer is encrypted with **your passphrase**
before it leaves, using AES-256-GCM with a key made by scrypt. Google (or anyone
who gets into your Drive) sees only scrambled bytes.

Set a passphrase of 10 or more characters in your environment:

```bash
# macOS / Linux (add to your shell profile to keep it)
export MEMVAULT_BACKUP_PASSPHRASE="a long phrase only you know"

# Windows (PowerShell, saved for your account)
setx MEMVAULT_BACKUP_PASSPHRASE "a long phrase only you know"
```

or put it on the first line of a file only you can read and point to it with
`"storage": { "passphraseFile": "/path/to/file" }`. It is never read from the JSON
config itself.

**With no passphrase, the cloud backup refuses to run** and tells you why; it does
not upload your notes in plain text. (If you really want plain uploads, set
`storage.allowPlaintextCloud` to `true` and `storage.encryptCloud` to `false`.
Not recommended.)

> **Keep your passphrase safe.** If you lose it, the encrypted copies cannot be
> opened by anyone, including us.

Run a backup any time:

```bash
memvault backup            # or: npm run backup
npm run backup:list        # list local backups
```

From an AI app you can also call the `vault_backup` tool (owner connections only).

---

## Method 1 — Drive folder mirror (easiest)

If you use **Google Drive for Desktop**, point MemVault at your synced folder.
MemVault writes **one encrypted file** (`memvault-<time>.sqlite.mvbak`) and a small
`MANIFEST.json` into a `MemVault/` subfolder, keeps the newest copies, and Drive
uploads it to the cloud. No credentials required.

`~/.memvaultrc.json`:

```json
{
  "storage": {
    "gdriveFolder": {
      "enabled": true,
      "path": "C:/Users/you/My Drive"
    }
  }
}
```

On macOS/Linux the path is typically `~/Google Drive` or
`~/Library/CloudStorage/GoogleDrive-<account>/My Drive`.

---

## Method 2 — Drive REST API (no desktop app)

Upload backups straight to Drive over the API with an OAuth refresh token. Useful
on servers/headless machines. The same encryption rules apply.

### One-time setup

1. In [Google Cloud Console](https://console.cloud.google.com/) create a project
   and enable the **Google Drive API**.
2. Create an **OAuth 2.0 Client ID** (type: *Desktop app*). Note the
   **Client ID** and **Client Secret**.
3. Get a **refresh token** with the `https://www.googleapis.com/auth/drive.file`
   scope (use the [OAuth Playground](https://developers.google.com/oauthplayground/)
   — gear icon → *Use your own OAuth credentials* → authorize Drive API → exchange
   for a refresh token).

### Configure

```json
{
  "storage": {
    "gdriveApi": {
      "enabled": true,
      "clientId": "xxxx.apps.googleusercontent.com",
      "clientSecret": "xxxx",
      "refreshToken": "1//xxxx",
      "folderId": ""
    }
  }
}
```

- `folderId` is optional — leave `""` to upload to *My Drive* root, or paste a
  folder ID from its Drive URL to upload there.
- The `drive.file` scope only lets MemVault see files **it** created — it cannot
  read the rest of your Drive.
- These credentials sit in `~/.memvaultrc.json`, which MemVault keeps readable by
  your account only (mode 0600 on macOS/Linux). Do not share or commit that file.

---

## Auto-backup after sync

When either Drive method is enabled, `npx memvault sync` automatically runs a
backup after capturing data, so your cloud copy stays current.

## Restore

```bash
npm run backup:list                                   # local backups
node storage.mjs restore index-<stamp>.sqlite         # restore a local backup (by name only)
node storage.mjs restore-encrypted memvault-<stamp>.sqlite.mvbak   # restore a cloud copy
```

`restore-encrypted` needs the same `MEMVAULT_BACKUP_PASSPHRASE`. A wrong passphrase
or a damaged file is refused. A safety snapshot of the current vault is taken
before any restore.

Backups contain the database only. Your API key (`~/.memvault/api-token`) is kept
outside the vault on purpose and is never backed up.
