# 🚀 Autostart & scheduled sync

MemVault does not need a background service for AI clients: they launch the MCP server themselves. Autostart
is only useful if you want to

1. keep the **web UI** available at login, and/or
2. run `sync` on a schedule so your vault stays current.

Sync is safe to run as often as you like — entries that were already captured are skipped, and snapshot
entries (system info, VS Code extensions, ...) are replaced in place.

Replace `/path/to/node` and `/path/to/memvault` below with your own paths
(`which node`, and the folder where you cloned the repo or `npm root -g`/@mrchartist/memvault for a global install).

---

## Windows

From the install folder (works for a git clone or a global npm install):

```powershell
node setup-windows.mjs            # install
node setup-windows.mjs --remove   # uninstall
```

This puts a hidden launcher in your Startup folder (web UI, plus the clipboard daemon if you enabled it) and
creates a Scheduled Task, `MemVault-Periodic-Sync`, that runs `sync` every 30 minutes.

---

## Linux (systemd, per-user)

`~/.config/systemd/user/memvault.service`:

```ini
[Unit]
Description=MemVault web UI

[Service]
ExecStart=/path/to/node /path/to/memvault/server.mjs
Restart=on-failure

[Install]
WantedBy=default.target
```

`~/.config/systemd/user/memvault-sync.service`:

```ini
[Unit]
Description=MemVault sync

[Service]
Type=oneshot
ExecStart=/path/to/node /path/to/memvault/sync-all.mjs
```

`~/.config/systemd/user/memvault-sync.timer`:

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

---

## macOS (launchd)

`~/Library/LaunchAgents/com.memvault.sync.plist` — runs `sync` every 30 minutes:

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

For the web UI at login, add a second agent with `server.mjs` as the program and `<key>KeepAlive</key><true/>`.

---

## Notes

- Keep the web UI on `127.0.0.1` (the default). It has no login — see [SECURITY.md](../SECURITY.md).
- If a sync run fails, `sync-all.mjs` exits with a non-zero status, so schedulers can report it.
- Under WSL, run MemVault inside WSL and it will also find Windows-side browser profiles and Antigravity data.
