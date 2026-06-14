# ☁️ Google Drive Backup

MemVault is **local-first**: your vault always lives on disk at `VAULT_ROOT`. On
top of that, you can back it up to Google Drive using either (or both) of two
methods. Local timestamped backups are always kept in `VAULT_ROOT/backups`.

Run a backup any time:

```bash
npx memvault backup        # or: npm run backup
npm run backup:list        # list local backups
```

From an AI client you can also call the `vault_backup` MCP tool ("back up my
vault to Google Drive").

---

## Method 1 — Drive folder mirror (easiest)

If you use **Google Drive for Desktop**, just point MemVault at your synced
folder. MemVault copies the vault (DB + entries) into a `MemVault/` subfolder and
Drive uploads it to the cloud automatically. No credentials required.

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
on servers/headless machines.

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

---

## Auto-backup after sync

When either Drive method is enabled, `npx memvault sync` automatically runs a
backup after capturing data, so your cloud copy stays current.

## Restore

```bash
npm run backup:list                          # see available backups
node storage.mjs restore index-<stamp>.sqlite # restore the live DB
```

A safety snapshot of the current DB is taken before any restore.
