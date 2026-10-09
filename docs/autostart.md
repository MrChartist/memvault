# Start on login and scheduled saving

You do **not** need a background service for your AI apps. They start the MCP server themselves when you open them.

Starting things automatically is only useful if you want to

1. keep the **dashboard** available after you sign in, or
2. run `memvault sync` on a timer, so the capture sources you switched on stay current.

Running sync often is safe. Items that were already saved are skipped, and "current state" notes (computer info, VS Code extensions) are replaced, not added again. Sync only reads the sources you switched on in **Settings → Automatic saving**; with none on, it does nothing.

Replace `/path/to/node` and `/path/to/memvault` below with your own paths. Find them with `which node` (Windows: `where node`) and `npm root -g` (the folder is `@mrchartist/memvault` inside it), or the folder you cloned.

## Windows

From the install folder:

```powershell
node setup-windows.mjs --yes      # add the start-up items
node setup-windows.mjs --remove   # take them away again
```

Without `--yes` it only shows what it would do and changes nothing. With `--yes` it adds a hidden start-up item for the dashboard server, one for the clipboard watcher (it still saves nothing unless clipboard capture is on), and a Scheduled Task `MemVault-Periodic-Sync` that runs every 30 minutes.

## Linux (systemd, per user)

For the dashboard, copy [`examples/memvault.service`](../examples/memvault.service) to `~/.config/systemd/user/` and follow the comments at the top of it.

To run sync every 30 minutes, add two more files in the same folder.

`memvault-sync.service`:

```ini
[Unit]
Description=MemVault sync

[Service]
Type=oneshot
ExecStart=/path/to/node /path/to/memvault/sync-all.mjs
```

`memvault-sync.timer`:

```ini
[Unit]
Description=Run MemVault sync every 30 minutes

[Timer]
OnBootSec=2min
OnUnitActiveSec=30min

[Install]
WantedBy=timers.target
```

```bash
systemctl --user daemon-reload
systemctl --user enable --now memvault.service memvault-sync.timer
```

## macOS (launchd)

`~/Library/LaunchAgents/com.memvault.sync.plist` runs sync every 30 minutes:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.memvault.sync</string>
  <key>ProgramArguments</key>
  <array>
    <string>/path/to/node</string>
    <string>/path/to/memvault/sync-all.mjs</string>
  </array>
  <key>StartInterval</key><integer>1800</integer>
  <key>RunAtLoad</key><true/>
</dict>
</plist>
```

```bash
launchctl load ~/Library/LaunchAgents/com.memvault.sync.plist
```

For the dashboard at login, add a second agent that runs `server.mjs` and set `<key>KeepAlive</key><true/>`.

## Notes

- Keep the dashboard on `127.0.0.1`, which is the default. Every request needs your access key (`memvault token`). See [SECURITY.md](../SECURITY.md).
- `sync-all.mjs` does not run the clipboard watcher, which keeps running; start that with `memvault clipboard`.
- If you chose a Google Drive backup, `sync-all.mjs` also makes a backup after saving.
- To remove everything MemVault added to your computer, see [uninstall.md](uninstall.md).
