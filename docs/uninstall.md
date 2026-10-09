# Removing MemVault

MemVault keeps your memory on your own computer, so removing the program does **not** remove your notes. This page lists everything it leaves, so you can decide what to keep.

## 1. Take your data with you (optional)

- In the dashboard: **Settings → Download everything** saves all your notes in one file.
- Or copy the folder `~/.memvault/data` (on Windows: `C:\Users\<you>\.memvault\data`).

## 2. Disconnect your AI apps

Open each AI app's settings for tools (MCP servers) and remove the entry called `memvault` or `memvault-<agent name>`. Then restart the app. Common places are listed in the dashboard under **Connect an AI app**.

## 3. Stop anything that starts MemVault by itself

Only if you set these up yourself:

- Windows: delete the shortcut or script in your Startup folder, and the scheduled task `MemVault-Periodic-Sync` (Task Scheduler), and the folder `%LOCALAPPDATA%\MemVault`, if they exist.
- Linux: stop and remove the service you created from `examples/memvault.service`.

## 4. Remove the program

| How you installed it | Command |
|---|---|
| `npx` (no install) | Nothing to remove. `npm cache clean --force` clears the downloaded copy. |
| `npm install -g @mrchartist/memvault` | `npm uninstall -g @mrchartist/memvault` |
| From the source code | Delete the folder you cloned. |

## 5. Remove what MemVault left in your home folder

| File or folder | What it holds |
|---|---|
| `~/.memvault/data` | **Your notes, backups, the activity log and the readable Markdown copies.** Delete only when you are sure. |
| `~/.memvault/api-token` | The dashboard key. |
| `~/.memvault/backup-passphrase` | The backup passphrase, if you set one in Settings. |
| `~/.memvault/open-*.html` | A short-lived page used by `memvault open`. |
| `~/.memvaultrc.json` | Your settings, and any Google Drive credentials you added. |

Copies you sent to **Google Drive** stay there until you delete them. If they are locked with a passphrase, they cannot be opened without it.

Deleting `~/.memvault` removes everything in the first four rows at once.
