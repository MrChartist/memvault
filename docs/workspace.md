# Server workspace: terminal, services and files

On a server (for example a VPS behind Nginx), the dashboard can also show three extra tabs:

- **Server** — CPU, memory, disk and uptime, plus every PM2 app and Docker container with 🟢 Online / 🔴 Stopped, CPU and memory, and one-tap **Restart**, **Stop** / **Start** and **Logs**.
- **Terminal** — a real shell (`bash` on Linux, `powershell.exe` on Windows) in the browser, with Esc, Tab, Ctrl+C, ↑, ↓ and Clear buttons for phones and tablets.
- **Files** — browse a folder (default: your home folder), open a text file in an editor with line numbers, and save it (Ctrl+S / ⌘S works too).

## It is off until you turn it on

Anyone holding the dashboard key, or a phone paired with `memvault devices pair`, gets a shell as the user MemVault runs as. So it is off by default. To turn it on, add to `~/.memvaultrc.json` and restart MemVault:

```json
{
  "security": {
    "workspace": { "enabled": true, "root": "/srv/projects" }
  }
}
```

Optional keys: `"terminal": false`, `"processes": false` or `"files": false` turn one part off; `"shell"` picks the shell. `MEMVAULT_WORKSPACE=1` and `MEMVAULT_WORKSPACE_ROOT` do the same from the environment. `memvault doctor` says whether it is on.

## How it is protected

- Every route (`/api/term/*`, `/api/system/*`, `/api/fs/*`) is behind the same key check, Host and Origin checks as the rest of the API. There is no separate WebSocket to secure: the terminal is plain HTTP (long-poll reads of 25 seconds, keystrokes POSTed), so it works through any reverse proxy with its default timeouts.
- A terminal belongs to the key that opened it: a phone cannot read another device's session. Idle terminals close after 30 minutes. The shell does not inherit `MEMVAULT_TOKEN`.
- Files stay inside `root`: `..` and symlinks that point outside it are refused. Files over 1 MB and binary files are not opened. Saving writes a `.tmp` file next to the original and renames it over it, keeping its permissions, and refuses if the file changed on the server since you opened it.
- Service names are checked (`letters, digits, _ . @ : -`, not starting with `-`) and passed to `pm2` / `docker` as arguments, never through a shell.
- Opening and closing a terminal, every start / stop / restart, and every saved file are written to the tamper-evident audit log, with the device that did it (**Security → Who used your memory**).
- The page keeps its strict Content-Security-Policy. xterm.js is shipped in `public/vendor/xterm/`; a small shim there hands xterm's styles to the browser as constructable stylesheets, so `style-src 'self'` never needs `'unsafe-inline'`.

## A real terminal

On Linux and macOS the shell runs under `script` (part of util-linux, installed almost everywhere), so prompts, colours, `htop`, `vim` and `nano` work. For resizing with the window, install `node-pty` next to MemVault (`npm install node-pty`); it is used automatically when present. Without either, the terminal falls back to a plain pipe (fine for commands, no full-screen programs).

## Control your other machines from one place

Every MemVault can link other MemVaults and use their Server, Terminal and Files tabs. Install MemVault on each machine you want to control (a VPS, a work computer), then link them to the one you open most:

1. **On the machine to control** (for example the VPS): turn the workspace on (above), then run `memvault devices pair --name "My laptop"`. It shows a one-time code, valid for 10 minutes.
2. **On the dashboard you use:** open **Server**, choose **Link a machine**, and enter a name, its address (for example `https://memvault.example.com`) and the code.
3. Pick the machine in the **Machine** list above the Server, Terminal and Files tabs. Everything on those tabs now runs on that machine. The choice is remembered in this browser.

**From a phone:** a phone cannot run MemVault itself, so it opens one MemVault's dashboard: pair it once (`memvault devices pair --name "iPhone"`, then "Use a pairing code" on the phone). It can then use that machine and every machine linked to it. If the VPS is the one the phone opens, link your other machines to the VPS. A computer at home is only reachable from the VPS if it has an address the VPS can reach, for example with Tailscale (`tailscale serve`); a VPS is reachable from everywhere.

How it is protected:

- The browser only talks to the dashboard it opened (the CSP stays `connect-src 'self'`). That server relays **only** the workspace routes (`/api/workspace`, `/api/term/*`, `/api/system/*`, `/api/fs/*`) to the linked machine; memories, the Secure Vault and settings of the other machine cannot be reached this way.
- The other machine's key is kept on the server in `~/.memvault/machines.json` (mode 0600), never in the browser. On the other machine it shows up as a paired device, so you can sign it out there with `memvault devices forget <id>`.
- Linking and unlinking need the dashboard key: a paired phone can use linked machines but cannot link new ones.
- Addresses must be `https://` (plain `http://` only to this computer or a private / Tailscale address). Redirects are refused.
- Both machines write the action to their audit logs: `machine-relay` here, and the terminal, service or file action (with the linking device) there.

## One main machine (for example your VPS)

Make one machine the **main machine** and everything runs from it and stays up to date on it:

- **Memories sync through it.** No Syncthing or Dropbox needed: the main machine keeps the shared sync folder itself (`~/.memvault/main-folder`) and serves it to its linked machines. Each upload is merged on the main machine right away, so it always holds everyone's latest memories. Other machines sync with it every few minutes (Settings → Your devices → Sync now for at once).
- **Dashboards open on it.** On every machine where it is the main one, the Server, Terminal and Files tabs open on it (★ in the Machine list) until you pick another machine in that browser.

Set it up once:

1. On the VPS: Settings → Your devices → set the sync passphrase. Then on the Server tab choose **This machine** and **Make main** (or set `"devices": { "enabled": true, "main": "this" }`). Run `memvault devices pair --name "Laptop"`.
2. On each computer: set the **same** sync passphrase, then Server → **Link a machine** with the VPS address and the code. "Make it my main machine" is ticked for you.
3. Phones: pair the phone with the VPS (`memvault devices pair --name "iPhone"`). The phone then sees everything on the VPS and every machine linked to it.

Security: the sync files stay encrypted with your sync passphrase on the way and on the main machine. A machine can only replace the file it uploaded first (`~/.memvault/main-owners.json`), so a stolen phone key cannot overwrite a laptop's memories. Choosing the main machine needs the dashboard key, not a phone key. Uploads are written to the main machine's audit log (`main-upload`).

## Seeing at a glance, and view-only devices

- **Status in the Machine list:** each linked machine shows `online · v3.0.0`, `offline`, or `needs linking again` (its key was signed out there). The main machine's line says when it last synced and why a sync failed (most often: the sync passphrase is not the same on both machines). **Sync now** syncs at once.
- **View only:** in Settings → Your devices, any phone, tablet or linked machine can be set to **Server: view only**. It still sees health, services, logs and files, but it cannot open a terminal, start, stop or restart a service, or save a file; the server refuses those requests, not just the page. Only the dashboard key can change this, and each change is in the audit log (`device-access`). A good default for a phone you carry everywhere: view only, and do changes from your computer.
