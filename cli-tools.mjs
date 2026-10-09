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
import { spawn, spawnSync } from "child_process";
import { fileURLToPath } from "url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OK = "✅", WARN = "⚠️ ", BAD = "❌";

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
  ["Cursor", "~/.cursor/mcp.json"],
  ["Antigravity", "~/.gemini/antigravity/mcp_config.json"],
  ["VS Code (Cline / Roo)", "the extension's MCP settings file"],
];

/** Build the `mcpServers` entry for one connection. Absolute paths: works from a clone or a global install. */
export function mcpEntry({ agent, vaultRoot } = {}) {
  const env = {};
  if (vaultRoot) env.VAULT_ROOT = vaultRoot;
  if (agent) env.MEMVAULT_AGENT = agent;
  return {
    command: process.execPath,
    args: [path.join(HERE, "mcp-server.mjs")],
    ...(Object.keys(env).length ? { env } : {}),
  };
}

export async function cmdMcpConfig(argv) {
  const { flags } = parseArgs(argv);
  const { cfg, dbm, agents } = await loadAll();
  const vaultRoot = cfg.VAULT_ROOT;
  const servers = {};
  if (flags["all-agents"]) {
    const db = dbm.openVaultDb();
    for (const a of agents.listAgents(db)) servers[`memvault-${a.id}`] = mcpEntry({ agent: a.id, vaultRoot });
  } else if (flags.agent) {
    const db = dbm.openVaultDb();
    if (!agents.getAgent(db, flags.agent)) {
      console.error(`${BAD} No agent "${flags.agent}". Run \`memvault agent list\`.`);
      process.exit(1);
    }
    servers[`memvault-${flags.agent}`] = mcpEntry({ agent: flags.agent, vaultRoot });
  } else {
    servers.memvault = mcpEntry({ vaultRoot });
  }
  console.log(JSON.stringify({ mcpServers: servers }, null, 2));
  console.error(`\nPaste the block above into your AI client's MCP config (merge it into "mcpServers"):`);
  for (const [name, where] of CLIENT_HINTS) console.error(`  • ${name.padEnd(22)} ${where}`);
  if (!flags.agent && !flags["all-agents"]) {
    console.error(`\nTip: bind a client to ONE agent so it only sees that agent's memory:\n  memvault mcp-config --agent market-analyst`);
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

async function healthy(url) {
  try {
    const r = await fetch(`${url}/health`, { signal: AbortSignal.timeout(1200) });
    return r.ok;
  } catch {
    return false;
  }
}

function openBrowser(url) {
  const isWSL = process.platform === "linux" && /microsoft/i.test(os.release());
  const cmds = process.platform === "darwin" ? [["open", [url]]]
    : process.platform === "win32" ? [["cmd", ["/c", "start", "", url.replace(/&/g, "^&")]]]
    : isWSL ? [["wslview", [url]], ["cmd.exe", ["/c", "start", "", url]], ["xdg-open", [url]]]
    : [["xdg-open", [url]]];
  for (const [c, a] of cmds) {
    const r = spawnSync(c, a, { stdio: "ignore" });
    if (!r.error && r.status === 0) return true;
  }
  return false;
}

export async function cmdOpen() {
  const { cfg, auth } = await loadAll();
  const base = `http://${cfg.SECURITY_CONFIG.host === "0.0.0.0" ? "127.0.0.1" : cfg.SECURITY_CONFIG.host}:${cfg.PORT}`;
  if (!(await healthy(base))) {
    console.log("Starting MemVault server in the background…");
    spawn(process.execPath, [path.join(HERE, "server.mjs")], { detached: true, stdio: "ignore" }).unref();
    for (let i = 0; i < 25 && !(await healthy(base)); i++) await new Promise((r) => setTimeout(r, 200));
    if (!(await healthy(base))) { console.error(`${BAD} The server did not start. Try \`memvault serve\` to see why.`); process.exit(1); }
  }
  // The token travels in the URL FRAGMENT: browsers never send it to the server or in Referer headers.
  const url = `${base}/#token=${auth.ensureToken()}`;
  if (openBrowser(url)) console.log(`${OK} Opened ${base}`);
  else console.log(`Could not open a browser automatically. Open this link yourself:\n${url}`);
}

// ─── setup ──────────────────────────────────────────────────────────────────

export async function cmdSetup() {
  const { cfg, dbm, agents, auth } = await loadAll();
  const db = dbm.openVaultDb();
  auth.ensureToken();
  const starter = agents.installStarterPack(db);
  console.log(`${OK} Vault ready at ${cfg.VAULT_ROOT}`);
  console.log(`${OK} API token created (${cfg.TOKEN_FILE}) — kept outside the vault, never backed up`);
  console.log(`${OK} Helpers (agents): ${starter.installed.length ? `installed ${starter.installed.join(", ")}` : "already installed"}`);
  console.log(`\nNext steps:`);
  console.log(`  1. memvault mcp-config            → paste into Claude / Cursor / Antigravity`);
  console.log(`     memvault mcp-config --agent study-buddy      (give one app its own helper)`);
  console.log(`  2. memvault open                  → the dashboard`);
  console.log(`  3. memvault doctor                → check your setup`);
  console.log(`  4. memvault scrub                 → preview masking of secrets already in your vault`);
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
  const bad = rows.filter((r) => r.level === "bad").length;
  const warn = rows.filter((r) => r.level === "warn").length;
  console.log(`\n${bad ? `${bad} problem(s)` : "No problems"}${warn ? `, ${warn} warning(s)` : ""}.`);
  console.log("No tool can promise perfect safety — see SECURITY.md for exactly what is and is not protected.");
  process.exit(bad ? 1 : 0);
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
  for (const r of db.query("SELECT id, title, content, tags FROM items")) {
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
    for (const c of changes) tx.run("UPDATE items SET title = ?, content = ?, tags = ? WHERE id = ?", [c.title, c.content, c.tags, c.id]);
  });
  for (const f of files) fs.writeFileSync(f.file, f.text);
  audit({ actor: "owner", action: "scrub", detail: { items: changes.length, files: files.length, backup: path.basename(backup.location) } });
  console.log(`\n${OK} Masked ${changes.length} item(s) and ${files.length} file(s). Backup kept: ${path.basename(backup.location)}`);
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
      if (typeof flags["from-file"] === "string") text = fs.readFileSync(flags["from-file"], "utf8");
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
      const saved = A.saveAgent(db, JSON.parse(fs.readFileSync(pos[0], "utf8")));
      console.log(`${OK} Imported ${saved.id}`);
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
