# Removing MemVault

MemVault keeps your memory on your own computer, so removing the program does **not** remove your notes. This page lists everything it leaves, so you can decide what to keep.

## 1. Take your data with you (optional)

- In the dashboard: **Settings → Download everything** saves all your notes in one file.
- Or copy the folder `~/.memvault/data` (on Windows: `C:\Users\<you>\.memvault\data`).

## 2. Disconnect your AI apps

Open each AI app's settings for tools (MCP servers) and remove the entry called `memvault`, or `memvault-` followed by an agent's id (for example `memvault-study-buddy`). Then restart the app. Common places are listed in the dashboard under **Connect an AI app**.

## 3. Stop anything that starts MemVault by itself

Only if you set these up yourself:

- Windows: if you used `setup-windows.mjs`, run `node setup-windows.mjs --remove` from the MemVault folder. It removes the start-up item (`MemVault-Autostart.vbs` in your Startup folder), the scheduled task `MemVault-Periodic-Sync` and the script it ran. You can then delete the empty folder `%LOCALAPPDATA%\MemVault`. If you made your own start-up items (for example from `examples/wsl2`), delete those by hand.
- Linux: stop and remove the service you created from `examples/memvault.service` (and the sync timer, if you added one from [autostart.md](autostart.md)).
- macOS: unload and delete the launchd file you added from [autostart.md](autostart.md) (`launchctl unload ~/Library/LaunchAgents/com.memvault.sync.plist`).

## 4. Remove the program

| How you installed it | Command |
|---|---|
| `npx -y @mrchartist/memvault …` | npx keeps an unpacked copy in its own folder. By default that is `~/.npm/_npx` on macOS and Linux and `%LocalAppData%\npm-cache\_npx` on Windows (`npm config get cache` shows the folder that holds `_npx`). Removing that folder removes the downloaded copy (and any other packages npx downloaded; they are fetched again when needed). `npm cache clean --force` does **not** remove it: it only clears npm's download cache. |
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
