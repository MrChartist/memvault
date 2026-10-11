# One memory on all your devices

Use MemVault on several computers, for example a Linux server (VPS), a MacBook and a Windows PC, and open it on your iPhone too. A note saved on one computer appears on the others a few minutes later.

## How it works

- **Every computer keeps its own full copy** of your memory, so your AI apps work even with no internet.
- **The computers keep each other up to date through one shared folder.** Each computer puts one file of its own in it. The file is **encrypted with your sync passphrase**, so whatever stores the folder (Syncthing, iCloud, Dropbox or your server) sees only scrambled data.
- **When two computers changed the same note, the newer change wins** on both. A deletion also travels, and it wins over any older change.
- **A phone or tablet cannot run MemVault, but it can open the dashboard** of a computer that is switched on, through a private address only your own devices can reach. Each phone gets its own key, so you can sign out a lost phone without changing anything else.

```
   MacBook ─┐                         ┌─ Windows PC
            │   shared folder         │
            ├── (encrypted files) ────┤
            │                         │
   Linux VPS┘  ← always on, so it     └─ … any other computer
     │           keeps everyone in step
     └── private address (Tailscale) ── iPhone / iPad: the dashboard in Safari
```

## Choose your setup

| You have | Use | What it means |
|---|---|---|
| A VPS or a computer that is always on | **Syncthing** on every computer, with the VPS as the always-on member | Changes reach every computer even when the others are off at different times. The VPS also serves the dashboard to your phone. **Recommended.** |
| No VPS | **Syncthing** between your computers | Computers update each other directly whenever two of them are on at the same time. No server and no cloud are needed. |
| A cloud folder you already use | **iCloud Drive, Dropbox, OneDrive or Google Drive** | Simplest to set up. The provider stores the encrypted files, never readable text. |

[Syncthing](https://syncthing.net) is free and open source. It copies a folder directly between your own devices, with no account. MemVault does not install it or depend on it: any tool that keeps a folder the same on several computers works.

> **Never put the vault itself in a shared folder.** Share only the sync folder you create below. The vault (`~/.memvault/data`) must stay on each computer's own disk, because its locking does not work on cloud-synced or network drives.

## Step 1: install MemVault on each computer

Follow [Get started](../README.md#get-started) on each computer: the Linux VPS, the Mac and the Windows PC. Run `memvault setup` on each one.

## Step 2: make the shared folder

Create an empty folder that will be shared, for example `MemVault Sync`, and set up your sharing tool:

- **Syncthing:**
  1. Install it on every computer. On a VPS you can use the package from your Linux distribution and run it as a service.
  2. Add the folder on one computer and share it with the others.
  3. On a VPS without a screen, open Syncthing's web page through an SSH tunnel: `ssh -L 8384:127.0.0.1:8384 you@your-vps`, then visit `http://127.0.0.1:8384` on your own computer.
- **iCloud Drive:** use a folder inside iCloud Drive.
  - Mac: `~/Library/Mobile Documents/com~apple~CloudDocs/MemVault Sync`
  - Windows (with iCloud for Windows): `C:\Users\<you>\iCloudDrive\MemVault Sync`
- **Dropbox, OneDrive or Google Drive (desktop app):** use a folder inside the synced folder, for example `~/Dropbox/MemVault Sync`.

The path can be different on each computer. What matters is that the folder has the same contents everywhere.

## Step 3: switch on syncing on each computer

In the dashboard, open **Settings → Your devices**. Or use the terminal:

```bash
memvault devices setup --folder "~/Sync/MemVault Sync" --name "MacBook"
memvault devices passphrase
```

1. **Use the same sync passphrase on every computer.** Use at least 10 characters, and write it down somewhere safe. **It cannot be recovered.** A computer with a different passphrase cannot read the others' files.
2. Give each computer a name you will recognise ("MacBook", "Windows PC", "VPS").
3. Repeat on the other computers.

To check the result, run `memvault devices`. It shows this computer, the last sync, and every other computer it has seen, with how many memories each one had.

## How often it syncs

- **Every 5 minutes** while the dashboard server or any AI app with MemVault is open. You can change the interval with `"devices": { "intervalMinutes": 10 }` in `~/.memvaultrc.json`.
- **Any time you like:** `memvault devices sync`, or **Sync now** in Settings.
- **When you run `memvault sync`**, for example from the timer in [autostart](autostart.md).

On the VPS, keep MemVault running so that it serves the phone and syncs even when nobody is signed in. Use [examples/memvault.service](../examples/memvault.service) and run `loginctl enable-linger $USER` once, so the service keeps running after you log out.

## Your iPhone or iPad

The phone opens the dashboard of an always-on computer (the VPS, or a Mac that stays on) through [Tailscale](https://tailscale.com). Tailscale is a private network between your own devices and is free for personal use. Nothing is put on the open internet, and MemVault keeps listening on `127.0.0.1` only.

1. **Install Tailscale** on the VPS (or the always-on Mac) and on the iPhone, and sign in to the same account on both.
2. **On the VPS, give MemVault a private https address:**
   ```bash
   tailscale serve --bg 7799
   ```
   Tailscale prints an address like `https://my-vps.tail1234.ts.net`. *Needs verification for your Tailscale version:* the options of `tailscale serve` have changed between versions, so check `tailscale serve --help` if this exact command is refused.
3. **Tell MemVault to accept that address:**
   ```bash
   memvault devices hub --address https://my-vps.tail1234.ts.net
   ```
   Then restart the dashboard server (`systemctl --user restart memvault`, or stop and start `memvault serve`).
4. **Make a one-time code** on the VPS: `memvault devices pair --name "iPhone"`. You can also make one in the dashboard under **Settings → Your devices → Add a phone or tablet**. The code works once, for 10 minutes.
5. **On the iPhone,** open the address in Safari, choose **Use a pairing code**, and type the code. The phone stays signed in. Use Safari's **Share → Add to Home Screen** to open it like an app.

To sign out a lost or old phone, go to **Settings → Your devices** and choose **Sign out**, or run `memvault devices keys`, then `memvault devices forget <id>`.

**Claude on the iPhone** cannot read MemVault yet. That would need the vault on a public internet address with a login, and its requests would pass through Anthropic's servers. It is a bigger security change and is listed on the [roadmap](../ROADMAP.md). For now, the iPhone uses the dashboard: read, search, write and correct notes.

## What is shared, and what stays on each computer

| Shared between your computers | Stays on each computer |
|---|---|
| Notes, conversations and work logs, in every memory space (shared, agent-private, project) | The **Secure Vault**. Each computer has its own, locked with its own master password |
| Agents (their job, rules and memory limits), and deleting an agent | Uploaded files (the note about the file is not shared either) |
| Edits and deletions | The access log: each computer records who used *its* memory, and every sync appears in it as `device-sync` |
| | Settings, the dashboard key, phone keys, and the readable Markdown copies (they are made where a note was written) |

## When the same note changes in two places

- **The newer change wins on every computer.** "Newer" uses each computer's clock, so keep the clocks right (all systems set them automatically by default).
- **A deletion wins over older changes.** A change made after the deletion wins over the deletion, and the note comes back everywhere.
- **Many deletions at once take a backup first.** If a sync would delete more than 20 memories and more than a tenth of them (for example after "delete everything" on another computer), this computer makes a local backup before it applies them. If that backup fails, nothing is deleted.

## Safety

- **The sync passphrase protects everything in the shared folder.** Anyone who has both the folder and the passphrase can read your memories and add to them, so keep the passphrase private.
- **Each computer writes only its own file.** The sharing tool never has two versions of one file to choose between. Copies that a sync app makes when it is unsure ("conflict copies") are ignored.
- **What comes in is treated like any other write.** It is masked for secrets, saved in one step, and recorded in the access log.
- **The same limits still apply.** What an AI app reads from MemVault is sent to that AI's company, on every computer. See [SECURITY.md](../SECURITY.md).

## If something is wrong

| You see | What to do |
|---|---|
| "cannot be opened: a different sync passphrase, or the file is still being copied" | Wait a minute and sync again. If it stays, the other computer uses a different passphrase: run `memvault devices passphrase` on it. |
| "The shared folder … does not exist" | Start your sync app, or check that the drive is connected. |
| "Another sync is running on this computer" | Try again in a minute. |
| A computer you no longer use is still listed | Delete its `memvault-….mvsync` file from the shared folder. Its notes stay on the others. |
| You restored a backup on one computer | On the next sync, the newer changes from your other computers come back, and deletions made after the backup are applied again. |

## Limits

- **Each computer's file holds its whole memory** (compressed and encrypted), so the folder needs room for one copy per computer. MemVault is designed for a few tens of thousands of notes.
- **"Newest wins" depends on the clocks.** Two changes made within the same second on two computers are settled the same way everywhere, but not always in the order you made them.
- **This is new.** It has automated tests for edits, deletions, conflicts, three computers and damaged files. It has not yet been used by people on Windows and macOS. Please [report anything odd](https://github.com/MrChartist/memvault/issues).
