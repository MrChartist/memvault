# Server workspace: terminal, services and files

On a server (for example a VPS behind Nginx), the dashboard can also show three extra tabs:

- **Server** — CPU, memory, disk and uptime, plus every PM2 app and Docker container with 🟢 Online / 🔴 Stopped, CPU and memory, and one-tap **Restart**, **Stop** / **Start** and **Logs**.
- **Terminal** — a real shell (`bash` on Linux, `powershell.exe` on Windows) in the browser, with Esc, Tab, Ctrl+C, ↑, ↓ and Clear buttons for phones and tablets.
- **Files** — browse a folder (default `/opt/projects`), open a text file in an editor with line numbers, and save it (Ctrl+S / ⌘S works too).

## It is off until you turn it on

Anyone holding the dashboard key, or a phone paired with `memvault devices pair`, gets a shell as the user MemVault runs as. So it is off by default. To turn it on, add to `~/.memvaultrc.json` and restart MemVault:

```json
{
  "security": {
    "workspace": { "enabled": true, "root": "/opt/projects" }
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
2. **On the dashboard you use:** open **Server**, choose **Link a machine**, and enter a name, its address (for example `https://memvault.187-127-156-46.sslip.io`) and the code.
3. Pick the machine in the **Machine** list above the Server, Terminal and Files tabs. Everything on those tabs now runs on that machine. The choice is remembered in this browser.

**From a phone:** a phone cannot run MemVault itself, so it opens one MemVault's dashboard: pair it once (`memvault devices pair --name "iPhone"`, then "Use a pairing code" on the phone). It can then use that machine and every machine linked to it. If the VPS is the one the phone opens, link your other machines to the VPS. A computer at home is only reachable from the VPS if it has an address the VPS can reach, for example with Tailscale (`tailscale serve`); a VPS is reachable from everywhere.

How it is protected:

- The browser only talks to the dashboard it opened (the CSP stays `connect-src 'self'`). That server relays **only** the workspace routes (`/api/workspace`, `/api/term/*`, `/api/system/*`, `/api/fs/*`) to the linked machine; memories, the Secure Vault and settings of the other machine cannot be reached this way.
- The other machine's key is kept on the server in `~/.memvault/machines.json` (mode 0600), never in the browser. On the other machine it shows up as a paired device, so you can sign it out there with `memvault devices forget <id>`.
- Linking and unlinking need the dashboard key: a paired phone can use linked machines but cannot link new ones.
- Addresses must be `https://` (plain `http://` only to this computer or a private / Tailscale address). Redirects are refused.
- Both machines write the action to their audit logs: `machine-relay` here, and the terminal, service or file action (with the linking device) there.
