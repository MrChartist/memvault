/**
 * cli-tools.mjs — the everyday commands: setup, open, token, doctor, scrub, agent, audit, mcp-config
 * ═══════════════════════════════════════════════════════════════════════════════
 * Everything here talks to the vault directly (db.mjs is safe for many processes),
 * so none of it needs the server running.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";
import { spawn, spawnSync } from "child_process";
import { fileURLToPath } from "url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OK = "✅", WARN = "⚠️ ", BAD = "❌";
const PKG_NAME = "@mrchartist/memvault";
const SECURITY_URL = "https://github.com/MrChartist/memvault/blob/main/SECURITY.md";
const DOCS_URL = "https://github.com/MrChartist/memvault/blob/main/docs";

/** True when this copy was started by `npx` (it lives in npm's private cache, which npm may clear at any time). */
export const runFromNpx = (dir = HERE) => /[\\/]_npx[\\/]/.test(dir);
/** How to run a MemVault command in the messages we print: `memvault …`, or `npx -y … …` when there is no `memvault` command. */
export const mv = (args, dir = HERE) => `${runFromNpx(dir) ? `npx -y ${PKG_NAME}` : "memvault"} ${args}`;

/**
 * The node program to write into an AI app's config. process.execPath has symlinks resolved, which for
 * Homebrew is a versioned folder that disappears on the next upgrade. Prefer the same program as found
 * on PATH (for example /opt/homebrew/bin/node), which keeps working after an upgrade.
 */
export function stableNodePath({ execPath = process.execPath, envPath = process.env.PATH || "", platform = process.platform } = {}) {
  let real;
  try { real = fs.realpathSync(execPath); } catch { return execPath; }
  const names = platform === "win32" ? ["node.exe"] : ["node"];
  for (const dir of envPath.split(path.delimiter).filter(Boolean)) {
    for (const n of names) {
      const candidate = path.join(dir, n);
      try { if (fs.realpathSync(candidate) === real) return candidate; } catch { /* not here */ }
    }
  }
  return execPath;
}

// ─── tiny argv parser:  --key value  |  --flag  |  positional ───────────────

export function parseArgs(argv) {
  const flags = {};
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) { flags[key] = next; i++; }
      else flags[key] = true;
    } else if (a === "-n" && argv[i + 1]) { flags.n = argv[++i]; }
    else pos.push(a);
  }
  return { flags, pos };
}

const loadAll = async () => ({
  cfg: await import("./config.mjs"),
  dbm: await import("./db.mjs"),
  agents: await import("./agents.mjs"),
  auth: await import("./auth.mjs"),
});

// ─── mcp-config ─────────────────────────────────────────────────────────────

const CLIENT_HINTS = [
  ["Claude Desktop", process.platform === "win32" ? "%APPDATA%\\Claude\\claude_desktop_config.json" : process.platform === "darwin" ? "~/Library/Application Support/Claude/claude_desktop_config.json" : "~/.config/Claude/claude_desktop_config.json"],
  ["Claude Code", "the `claude mcp add …` command shown in the dashboard (Connect an AI app)"],
  ["Cursor", "~/.cursor/mcp.json"],
  ["Antigravity", "~/.gemini/antigravity/mcp_config.json"],
  ["VS Code (Cline / Roo)", "the extension's MCP settings file"],
];

/**
 * Build the `mcpServers` entry for one connection. Absolute paths: works from a clone or a global install.
 * A copy started by npx lives in npm's cache, which can be cleared at any time, so then the entry starts
 * MemVault through npx too (the same way the MCP registry entry in server.json does).
 */
export function mcpEntry({ agent, vaultRoot, dir = HERE, platform = process.platform } = {}) {
  const env = {};
  if (vaultRoot) env.VAULT_ROOT = vaultRoot;
  if (agent) env.MEMVAULT_AGENT = agent;
  const npx = ["-y", PKG_NAME, "mcp"];
  const run = !runFromNpx(dir)
    ? { command: stableNodePath(), args: [path.join(dir, "mcp-server.mjs")] }
    : platform === "win32" ? { command: "cmd", args: ["/c", "npx", ...npx] } // npx is a .cmd file on Windows
    : { command: "npx", args: npx };
  return { ...run, ...(Object.keys(env).length ? { env } : {}) };
}

export async function cmdMcpConfig(argv) {
  const { flags } = parseArgs(argv);
  const { cfg, dbm, agents } = await loadAll();
  const vaultRoot = cfg.VAULT_ROOT;
  const servers = {};
  if (flags.agent === true) {
    console.error(`${BAD} Say which agent: ${mv("mcp-config --agent <id>")}   (see ${mv("agent list")})`);
    process.exit(1);
  }
  if (flags["all-agents"]) {
    const db = dbm.openVaultDb();
    for (const a of agents.listAgents(db)) servers[`memvault-${a.id}`] = mcpEntry({ agent: a.id, vaultRoot });
    if (!Object.keys(servers).length) {
      console.error(`${BAD} There are no agents yet. Run ${mv("setup")} first, or add some with ${mv("agent starter")}.`);
      process.exit(1);
    }
  } else if (flags.agent) {
    const db = dbm.openVaultDb();
    if (!agents.getAgent(db, flags.agent)) {
      console.error(`${BAD} No agent "${flags.agent}". Run \`${mv("agent list")}\`.`);
      process.exit(1);
    }
    servers[`memvault-${flags.agent}`] = mcpEntry({ agent: flags.agent, vaultRoot });
  } else {
    servers.memvault = mcpEntry({ vaultRoot });
  }
  console.log(JSON.stringify({ mcpServers: servers }, null, 2));
  console.error(`\nPaste the block above into your AI app's MCP settings file. If the file already has "mcpServers",\ncopy only the entries inside it. Then restart the app.`);
  for (const [name, where] of CLIENT_HINTS) console.error(`  • ${name.padEnd(22)} ${where}`);
  if (runFromNpx()) console.error(`\nThis starts MemVault through npx, so the app needs Node.js on its PATH. For a fixed install:\n  npm install -g ${PKG_NAME}   and then run   memvault mcp-config`);
  else console.error(`\nIf you upgrade Node.js or move the MemVault folder, run this again and paste the new block.`);
  if (!flags.agent && !flags["all-agents"]) {
    console.error(`\nTip: tie an app to ONE agent so it only sees that agent's memory:\n  ${mv("mcp-config --agent study-buddy")}`);
  }
}

// ─── token ──────────────────────────────────────────────────────────────────

export async function cmdToken(argv) {
  const { flags } = parseArgs(argv);
  const { auth, cfg } = await loadAll();
  if (flags.rotate) {
    auth.rotateToken();
    console.log(`${OK} New API token written to ${cfg.TOKEN_FILE}. Restart \`memvault serve\` so it picks it up.`);
    return;
  }
  console.log(auth.ensureToken());
}

// ─── open ───────────────────────────────────────────────────────────────────

/** Is MemVault (and not some other program that happens to use the port) answering at this address? */
export async function healthy(url) {
  try {
    const r = await fetch(`${url}/health`, { signal: AbortSignal.timeout(1200) });
    if (!r.ok) return false;
    const body = await r.json().catch(() => null);
    return body?.name === "memvault";
  } catch {
    return false;
  }
}

/** Something answers on the port, but it is not MemVault: never hand it the dashboard key. */
async function portTakenByOther(url) {
  try { await fetch(url, { signal: AbortSignal.timeout(1200) }); return true; } catch { return false; }
}

/** Open a file or address in the default program (here: the redirect page, so no key is on the command line). */
function openBrowser(target) {
  const isWSL = process.platform === "linux" && /microsoft/i.test(os.release());
  const winPath = () => { const r = spawnSync("wslpath", ["-w", target], { encoding: "utf8" }); return r.status === 0 ? r.stdout.trim() : target; };
  const cmds = process.platform === "darwin" ? [["open", [target]]]
    : process.platform === "win32" ? [["cmd", ["/c", "start", "", target]]]
    : isWSL ? [["wslview", [target]], ["cmd.exe", ["/c", "start", "", winPath()]], ["xdg-open", [target]]]
    : [["xdg-open", [target]]];
  for (const [c, a] of cmds) {
    const r = spawnSync(c, a, { stdio: "ignore" });
    if (!r.error && r.status === 0) return true;
  }
  return false;
}

/**
 * A small page that sends the browser to the dashboard with the key in the address fragment.
 * The browser is started with this file's PATH, not the address, so the key never appears in a command
 * line that another account on the computer can read. The file is private (mode 0600) and old ones are removed.
 */
export function makeOpenPage({ url, dir }) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    for (const f of fs.readdirSync(dir)) {
      if (/^open-[a-f0-9]+\.html$/.test(f) && Date.now() - fs.statSync(path.join(dir, f)).mtimeMs > 10 * 60_000) fs.rmSync(path.join(dir, f), { force: true });
    }
  } catch { /* best effort */ }
  const file = path.join(dir, `open-${crypto.randomBytes(6).toString("hex")}.html`);
  const safe = String(url).replace(/"/g, "%22").replace(/</g, "%3C");
  fs.writeFileSync(
    file,
    `<!doctype html><meta charset="utf-8"><title>Opening MemVault…</title><meta http-equiv="refresh" content="0;url=${safe}">` +
      `<p>Opening MemVault… If nothing happens, <a href="${safe}">click here</a>.</p>`,
    { mode: 0o600 }
  );
  return file;
}

export async function cmdOpen() {
  const { cfg, auth } = await loadAll();
  const base = `http://${cfg.SECURITY_CONFIG.host === "0.0.0.0" ? "127.0.0.1" : cfg.SECURITY_CONFIG.host}:${cfg.PORT}`;
  if (!(await healthy(base)) && (await portTakenByOther(base))) {
    console.error(`${BAD} Another program is using port ${cfg.PORT}, so MemVault cannot start there.\n   Choose another port in ~/.memvaultrc.json ("port": 7800) or close that program, then try again.`);
    process.exit(1);
  }
  if (!(await healthy(base))) {
    console.log("Starting MemVault server in the background…");
    spawn(process.execPath, [path.join(HERE, "server.mjs")], { detached: true, stdio: "ignore" }).unref();
    for (let i = 0; i < 25 && !(await healthy(base)); i++) await new Promise((r) => setTimeout(r, 200));
    if (!(await healthy(base))) { console.error(`${BAD} The server did not start. Try \`${mv("serve")}\` to see why.`); process.exit(1); }
  }
  // The token travels in the URL FRAGMENT: browsers never send it to the server or in Referer headers.
  const url = `${base}/#token=${auth.ensureToken()}`;
  const page = makeOpenPage({ url, dir: path.dirname(cfg.TOKEN_FILE) });
  if (openBrowser(page)) console.log(`${OK} Opened ${base}`);
  else {
    fs.rmSync(page, { force: true }); // not needed: the link is printed instead, so do not leave the key on disk
    console.log(`Could not open a browser automatically. Open this link yourself:\n${url}`);
  }
}

// ─── setup ──────────────────────────────────────────────────────────────────

export async function cmdSetup() {
  const { cfg, dbm, agents, auth } = await loadAll();
  const db = dbm.openVaultDb();
  const hadToken = fs.existsSync(cfg.TOKEN_FILE);
  auth.ensureToken();
  const starter = agents.installStarterPack(db);
  console.log(`${OK} Vault ready at ${cfg.VAULT_ROOT}`);
  console.log(`${OK} Dashboard key ${hadToken ? "already in place" : "created"} (${cfg.TOKEN_FILE}), kept outside the vault and never backed up`);
  console.log(`${OK} Helpers (agents): ${starter.installed.length ? `installed ${starter.installed.join(", ")}` : "already installed"}`);
  const steps = [
    ["mcp-config", "paste into Claude, Cursor or Antigravity"],
    ["mcp-config --agent study-buddy", "give one app its own helper"],
    ["open", "the dashboard"],
    ["doctor", "check your setup"],
  ];
  const width = Math.max(...steps.map(([cmd]) => mv(cmd).length)) + 2;
  console.log(`\nNext steps:`);
  for (const [cmd, what] of steps) console.log(`  ${mv(cmd).padEnd(width)}→ ${what}`);
  if (runFromNpx()) console.log(`\nTip: install it once with  npm install -g ${PKG_NAME}  and the commands become just  memvault …`);
}

// ─── doctor ─────────────────────────────────────────────────────────────────

export async function cmdDoctor() {
  const { collectDiagnostics } = await import("./diagnostics.mjs");
  const { rows } = await collectDiagnostics({ deep: true });
  const icon = { ok: OK, warn: WARN, bad: BAD, info: "ℹ️ " };
  console.log("MemVault doctor\n");
  for (const r of rows) {
    console.log(`${icon[r.level]} ${r.title}`);
    if (r.fix) console.log(`     → ${r.fix}`);
  }
  const n = (k, one, many) => `${k} ${k === 1 ? one : many}`;
  await printSetupSteps(n);
  const bad = rows.filter((r) => r.level === "bad").length;
  const warn = rows.filter((r) => r.level === "warn").length;
  console.log(`\n${bad ? n(bad, "problem", "problems") : "No problems"}${warn ? `, ${n(warn, "warning", "warnings")}` : ""}.`);
  console.log(`No tool can promise perfect safety. What is and is not protected: ${SECURITY_URL}`);
  process.exit(bad ? 1 : 0);
}

/** The same Getting started list as the dashboard, for a computer without a browser (a VPS). */
async function printSetupSteps(n) {
  let s;
  try {
    const { setupStatus } = await import("./setup-status.mjs");
    const { openVaultDb } = await import("./db.mjs");
    s = setupStatus({ vdb: openVaultDb() });
  } catch { return; } // the checks above already report a vault that cannot be opened
  const text = {
    install: [() => "MemVault is installed"],
    connect: [(x) => `AI app connected: ${x.apps.map((a) => a.label).join(", ")}`, "Connect an AI app", `Run ${mv("mcp-config")}, paste the block into your AI app's settings, then restart the app.`],
    try: [(x) => `Your AI apps have saved ${n(x.saved, "memory", "memories")}`, "Ask your AI app to remember something", 'In the app, say: "Remember that I prefer short answers."'],
    backup: [() => "First backup made", "Make a first backup", `Run ${mv("backup")}`],
    passphrase: [() => "Backups are locked with a passphrase", "Lock your backups with a passphrase", "Set it in the dashboard (Settings → Backups), or set MEMVAULT_BACKUP_PASSPHRASE."],
    agents: [(x) => `${x.apps.map((a) => `${a.label} works as ${a.agent}`).join(", ")}`, "Give an app its own helper (optional)", `Run ${mv("mcp-config --agent study-buddy")}`],
    devices: [(x) => `In step with ${n(x.others, "other computer", "other computers")}`, "Use it on your other computers (optional)", `Run ${mv("devices setup")}. Guide: ${DOCS_URL}/devices.md`],
    phone: [(x) => `${n(x.phones, "phone or tablet", "phones or tablets")} signed in`, "Open it on your phone (optional)", `Run ${mv("devices pair")}. Guide: ${DOCS_URL}/devices.md`],
  };
  console.log(`\nGetting started: ${s.done} of ${s.total} steps done`);
  for (const st of s.steps) {
    const [done, todo, how] = text[st.id] || [];
    if (!done) continue;
    console.log(st.done ? `${OK} ${done(st)}` : `⬜ ${todo}`);
    if (!st.done && how) console.log(`     → ${how}`);
  }
}

// ─── scrub: mask secrets already stored ─────────────────────────────────────

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith(".md")) out.push(p);
  }
  return out;
}

export async function cmdScrub(argv) {
  const { flags } = parseArgs(argv);
  const { cfg, dbm } = await loadAll();
  const { redactItem } = await import("./redact.mjs");
  const { backupLocal } = await import("./storage.mjs");
  const { audit } = await import("./audit.mjs");
  const db = dbm.openVaultDb();
  const disable = cfg.SECURITY_CONFIG.redactDisable;

  const changes = [];
  const byType = new Map();
  for (const r of db.query("SELECT id, title, content, tags, source FROM items")) {
    const { item, findings } = redactItem(r, { disable });
    if (!findings.length) continue;
    changes.push(item);
    for (const f of findings) byType.set(f.type, (byType.get(f.type) || 0) + f.count);
  }
  const files = [];
  for (const sub of ["entries", "conversations", "worklogs"]) {
    for (const f of walk(path.join(cfg.VAULT_ROOT, sub))) {
      const text = fs.readFileSync(f, "utf8");
      const { item, findings } = redactItem({ content: text }, { disable });
      if (!findings.length) continue;
      files.push({ file: f, text: item.content });
      for (const x of findings) byType.set(x.type, (byType.get(x.type) || 0) + x.count);
    }
  }

  if (!changes.length && !files.length) { console.log(`${OK} Nothing to mask — no credential-like text found.`); return; }
  console.log(`Found credential-like text in ${changes.length} database item(s) and ${files.length} markdown file(s):`);
  for (const [t, n] of [...byType].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(5)} × ${t}`);

  if (!flags.apply) {
    console.log(`\nThis was a preview — nothing changed. Review the types above (a few may be false positives),\nthen run: memvault scrub --apply   (a backup is taken first)`);
    return;
  }
  const backup = backupLocal();
  if (!backup.ok) { console.error(`${BAD} Backup failed (${backup.error}); nothing changed.`); process.exit(1); }
  db.transaction((tx) => {
    for (const c of changes) tx.run("UPDATE items SET title = ?, content = ?, tags = ?, source = ? WHERE id = ?", [c.title, c.content, c.tags, c.source, c.id]);
  });
  // Keep the original Markdown files too, so a scrub can be undone (the database backup does not hold them).
  const filesBackup = path.join(cfg.VAULT_ROOT, "backups", `scrub-files-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  if (files.length) {
    for (const f of files) {
      const dest = path.join(filesBackup, path.relative(cfg.VAULT_ROOT, f.file));
      fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
      fs.copyFileSync(f.file, dest);
    }
  }
  for (const f of files) fs.writeFileSync(f.file, f.text);
  audit({ actor: "owner", action: "scrub", detail: { items: changes.length, files: files.length, backup: path.basename(backup.location) } });
  console.log(`\n${OK} Masked ${changes.length} item(s) and ${files.length} file(s). Backup kept: ${path.basename(backup.location)}`);
  if (files.length) console.log(`The original Markdown files were copied to: ${path.relative(cfg.VAULT_ROOT, filesBackup)}`);
  console.log("Note: older backups and any cloud copies made before this still contain the original text.");
}

// ─── audit ──────────────────────────────────────────────────────────────────

export async function cmdAudit(argv) {
  const { flags } = parseArgs(argv);
  const { verifyAudit, tailAudit } = await import("./audit.mjs");
  const v = verifyAudit();
  console.log(v.ok ? `${OK} Audit chain intact (${v.entries} records)` : `${BAD} Audit chain BROKEN at line ${v.brokenAtLine}: ${v.reason}`);
  if (flags.verify) process.exit(v.ok ? 0 : 1);
  const recs = tailAudit(Number(flags.n) || 20, { actor: typeof flags.actor === "string" ? flags.actor : undefined });
  for (const r of recs) {
    const d = r.detail || {};
    const what = d.tool ? `${r.action}:${d.tool}` : r.action;
    const extra = Object.entries(d).filter(([k]) => k !== "tool").map(([k, x]) => `${k}=${Array.isArray(x) ? x.join("|") : x}`).join(" ");
    console.log(`${r.ts.replace("T", " ").slice(0, 19)}  ${String(r.actor).padEnd(18)} ${what.padEnd(26)} ${extra}`);
  }
  if (!v.ok) process.exit(1);
}

// ─── agent ──────────────────────────────────────────────────────────────────

const summary = (p) => [
  `${p.name}  (${p.id})`,
  p.role && `  Role     ${p.role}`,
  (p.voice.language || p.voice.tone) && `  Voice    ${[p.voice.language, p.voice.tone].filter(Boolean).join(" — ")}`,
  p.rules.always.length && `  Always   ${p.rules.always.length} rule(s)`,
  p.rules.never.length && `  Never    ${p.rules.never.length} rule(s)`,
  (p.brand.handle || p.brand.site) && `  Brand    ${[p.brand.handle, p.brand.site].filter(Boolean).join("  ")}`,
  `  Memory   reads shared + own${p.memory.readScopes.length ? ` + ${p.memory.readScopes.join(", ")}` : ""}; secrets ${p.memory.allowSecrets ? "ALLOWED" : "no"}`,
].filter(Boolean).join("\n");

function editInEditor(initial) {
  const tmp = path.join(os.tmpdir(), `memvault-agent-${process.pid}.json`);
  fs.writeFileSync(tmp, initial, { mode: 0o600 });
  const editor = process.env.VISUAL || process.env.EDITOR || (process.platform === "win32" ? "notepad" : "nano");
  const r = spawnSync(editor, [tmp], { stdio: "inherit", shell: process.platform === "win32" });
  const out = fs.readFileSync(tmp, "utf8");
  fs.rmSync(tmp, { force: true });
  if (r.error) throw new Error(`Could not start editor "${editor}" (set $EDITOR).`);
  return out;
}

export async function cmdAgent(argv) {
  const [sub, ...rest] = argv;
  const { flags, pos } = parseArgs(rest);
  const { dbm, agents: A } = await loadAll();
  const db = dbm.openVaultDb();
  const need = (id) => {
    const p = id && A.getAgent(db, id);
    if (!p) { console.error(`${BAD} No agent "${id || ""}". Run \`memvault agent list\`.`); process.exit(1); }
    return p;
  };

  switch (sub) {
    case "list": case undefined: {
      const list = A.listAgents(db);
      if (!list.length) return console.log("No agents yet. Try `memvault agent starter`, or `memvault agent create --name \"My Agent\" --from-file prompt.txt --save`.");
      for (const a of list) console.log(`${a.id.padEnd(18)} ${a.name.padEnd(22)} ${String(a.memories).padStart(4)} memories   ${a.role}`);
      return;
    }
    case "show": return console.log(JSON.stringify(need(pos[0]), null, 2));
    case "brief": {
      const p = need(pos[0]);
      const scoped = dbm.openVaultDb({ scope: A.scopesFor(p) });
      return console.log(A.buildBriefing(scoped, p, { task: typeof flags.task === "string" ? flags.task : "" }));
    }
    case "packs": {
      for (const p of A.listPacks()) {
        console.log(`${p.id}${p.id === A.DEFAULT_PACK ? "  (default)" : ""} — ${p.title}\n   ${p.description}\n   Agents: ${p.agents.map((a) => a.id).join(", ")}\n`);
      }
      console.log("Install one with:  memvault agent starter --pack <name>     (or --pack all)");
      return;
    }
    case "starter": {
      try {
        const r = A.installStarterPack(db, { pack: typeof flags.pack === "string" ? flags.pack : A.DEFAULT_PACK, overwrite: !!flags.overwrite });
        console.log(`${OK} Installed: ${r.installed.join(", ") || "none"}${r.skipped.length ? `\n   Kept existing: ${r.skipped.join(", ")} (use --overwrite to reset)` : ""}`);
      } catch (e) { console.error(`${BAD} ${e.message}`); process.exit(1); }
      return;
    }
    case "create": {
      let text = typeof flags["from-prompt"] === "string" ? flags["from-prompt"] : null;
      if (typeof flags["from-file"] === "string") {
        try { text = fs.readFileSync(flags["from-file"], "utf8"); }
        catch (e) { console.error(`${BAD} Could not read "${flags["from-file"]}": ${e.code === "ENOENT" ? "no such file" : e.message}`); process.exit(1); }
      }
      if (!text) { console.error(`${BAD} Give the description with --from-prompt "…" or --from-file prompt.txt`); process.exit(1); }
      const { profile, notes } = A.draftProfileFromPrompt(text, { name: typeof flags.name === "string" ? flags.name : undefined, id: typeof flags.id === "string" ? flags.id : undefined });
      console.log(summary(profile));
      console.log("\nNotes:\n" + notes.map((n) => `  • ${n}`).join("\n"));
      if (flags.save) {
        A.saveAgent(db, profile);
        console.log(`\n${OK} Saved. Review or refine it with: memvault agent edit ${profile.id}`);
      } else {
        console.log(`\nDraft only — nothing saved. Re-run with --save to store it.`);
      }
      return;
    }
    case "edit": {
      const p = need(pos[0]);
      const edited = editInEditor(JSON.stringify(p, null, 2) + "\n");
      try {
        const saved = A.saveAgent(db, { ...JSON.parse(edited), id: p.id });
        console.log(`${OK} Saved ${saved.id}`);
      } catch (e) {
        console.error(`${BAD} Not saved: ${e.message}`);
        process.exit(1);
      }
      return;
    }
    case "export": {
      const p = need(pos[0]);
      const json = JSON.stringify(p, null, 2) + "\n";
      if (pos[1]) { fs.writeFileSync(pos[1], json); console.log(`${OK} Wrote ${pos[1]}`); } else process.stdout.write(json);
      return;
    }
    case "import": {
      if (!pos[0]) { console.error(`${BAD} Usage: memvault agent import <file.json>`); process.exit(1); }
      let profile;
      try { profile = JSON.parse(fs.readFileSync(pos[0], "utf8")); }
      catch (e) {
        console.error(`${BAD} Could not import "${pos[0]}": ${e.code === "ENOENT" ? "no such file" : e instanceof SyntaxError ? "it is not a valid JSON file" : e.message}`);
        process.exit(1);
      }
      try { console.log(`${OK} Imported ${A.saveAgent(db, profile).id}`); }
      catch (e) { console.error(`${BAD} Not imported: ${e.message}`); process.exit(1); }
      return;
    }
    case "delete": {
      const p = need(pos[0]);
      if (!flags.yes) { console.error(`This removes agent "${p.id}"${flags.purge ? " AND its private memories" : ""}. Re-run with --yes to confirm.`); process.exit(1); }
      if (flags.purge) {
        const { backupLocal } = await import("./storage.mjs");
        const b = backupLocal();
        console.log(b.ok ? `Backup: ${path.basename(b.location)}` : `${WARN} Backup failed: ${b.error}`);
      }
      A.deleteAgent(db, p.id, { purge: !!flags.purge });
      console.log(`${OK} Deleted ${p.id}`);
      return;
    }
    default:
      console.error(`Usage: memvault agent <list|show|brief|create|edit|export|import|delete|starter|packs> …`);
      process.exit(1);
  }
}

// ─── profile ────────────────────────────────────────────────────────────────

export async function cmdProfile(argv) {
  const [sub = "show", ...rest] = argv;
  const { flags, pos } = parseArgs(rest);
  const { dbm } = await loadAll();
  const P = await import("./profile.mjs");
  const db = dbm.openVaultDb();
  const fail = (msg) => { console.error(`${BAD} ${msg}`); process.exit(1); };
  const run = (fn) => { try { return fn(); } catch (e) { return fail(e.message); } };

  switch (sub) {
    case "show": {
      const facts = P.listFacts(db, { facets: typeof flags.facet === "string" ? flags.facet.split(",").map((s) => s.trim()) : undefined });
      if (flags.json) return console.log(JSON.stringify(P.exportProfile(db), null, 2));
      if (!facts.length) return console.log("Your profile is empty. Add a fact:  memvault profile set preferences writing-tone \"short, formal, plain\"\nOr learn from your notes:  memvault profile learn");
      let facet = null;
      for (const f of facts) {
        if (f.facet !== facet) { facet = f.facet; console.log(`\n${facet.toUpperCase()}`); }
        console.log(`  ${f.key}: ${f.value}${f.confidence === "high" ? "" : `   (${f.confidence}, ${f.source})`}`);
      }
      const pending = P.listSuggestions(db).length;
      if (pending) console.log(`\n${WARN} ${pending} suggestion(s) from your AI apps are waiting:  memvault profile review`);
      return;
    }
    case "facets":
      for (const [k, v] of Object.entries(P.FACETS)) console.log(`${k.padEnd(14)} ${v}`);
      return console.log("\nNot kept on purpose: health, money, ID numbers, passwords, other people's details, beliefs.");
    case "set": {
      const [facet, key, ...value] = pos;
      if (!facet || !key || !value.length) return fail('Usage: memvault profile set <facet> <key> "<value>"   (see: memvault profile facets)');
      const r = run(() => P.setFact(db, { facet, key, value: value.join(" "), source: "manual", confidence: typeof flags.confidence === "string" ? flags.confidence : "high" }));
      return console.log(r.changed ? `${OK} Saved ${r.fact.facet}/${r.fact.key}` : "Already up to date.");
    }
    case "remove": {
      const [facet, key] = pos;
      if (!facet || !key) return fail("Usage: memvault profile remove <facet> <key>");
      return console.log(run(() => P.removeFact(db, facet, key)) ? `${OK} Removed` : "No such fact.");
    }
    case "learn": {
      const r = P.learnFromVault(db, { apply: !!flags.apply });
      if (!r.facts.length) return console.log("Nothing to learn yet: the vault needs more notes (about 30) from the kinds of source MemVault learns from. Device scans, the browser and the clipboard are never used.");
      for (const f of r.facts) console.log(`${f.facet}/${f.key}\n   ${f.value}`);
      if (!flags.apply) return console.log(`\nThis was a preview. Nothing was saved. To save these:  memvault profile learn --apply`);
      console.log(`\n${OK} ${r.written} saved, ${r.unchanged} already up to date${r.skippedManual.length ? `, ${r.skippedManual.length} left alone because you set them yourself` : ""}.`);
      return;
    }
    case "review": {
      const list = P.listSuggestions(db);
      if (!list.length) return console.log("No suggestions are waiting.");
      for (const s of list) {
        console.log(`${s.id}\n   ${s.facet}/${s.key}: ${s.value}\n   from: ${s.proposedBy || "an AI app"}${s.reason ? `   because: ${s.reason}` : ""}`);
      }
      return console.log("\nAccept one:  memvault profile accept <id>      Reject:  memvault profile reject <id>      (or: accept all / reject all)");
    }
    case "accept": case "reject": {
      const target = pos[0];
      if (!target) return fail(`Usage: memvault profile ${sub} <id|all>`);
      const ids = target === "all" ? P.listSuggestions(db).map((s) => s.id) : [target];
      let n = 0;
      for (const id of ids) {
        if (sub === "accept") { run(() => P.acceptSuggestion(db, id)); n++; }
        else if (P.rejectSuggestion(db, id)) n++;
      }
      return console.log(`${OK} ${n} ${sub === "accept" ? "accepted" : "rejected"}`);
    }
    case "export": {
      const json = JSON.stringify(P.exportProfile(db), null, 2);
      if (pos[0]) { fs.writeFileSync(pos[0], json, { mode: 0o600 }); return console.log(`${OK} Wrote ${pos[0]}`); }
      return console.log(json);
    }
    case "import": {
      if (!pos[0]) return fail("Usage: memvault profile import <file.json>");
      const data = run(() => JSON.parse(fs.readFileSync(pos[0], "utf8")));
      const r = run(() => P.importProfile(db, data));
      console.log(`${OK} ${r.added} added, ${r.changed} changed, ${r.unchanged} unchanged`);
      for (const x of r.rejected) console.log(`${WARN} skipped ${x.facet}/${x.key}: ${x.reason}`);
      return;
    }
    case "prompt": {
      const text = typeof flags.file === "string" ? fs.readFileSync(flags.file, "utf8") : pos.join(" ");
      if (!text.trim()) return fail('Usage: memvault profile prompt "<what you want to ask>"   (or --file dictated.txt)');
      const facets = typeof flags.facets === "string" ? flags.facets.split(",").map((s) => s.trim()) : undefined;
      return console.log(P.buildPrompt(P.listFacts(db), text, { facets }));
    }
    case "clear": {
      if (!flags.yes) return fail("This deletes your whole profile and waiting suggestions. Re-run with --yes to confirm.");
      return console.log(`${OK} Removed ${P.clearProfile(db)} item(s)`);
    }
    default:
      return fail("Usage: memvault profile <show|facets|set|remove|learn|review|accept|reject|export|import|prompt|clear> …");
  }
}
