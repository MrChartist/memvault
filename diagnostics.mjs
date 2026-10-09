/**
 * diagnostics.mjs — an honest picture of how safe THIS vault is right now
 * ═══════════════════════════════════════════════════════════════════════════════
 * Used by `memvault doctor` and by the dashboard's Security panel, so both show
 * the same facts. It checks the real configuration and files; nothing is assumed.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import fs from "fs";
import os from "os";
import path from "path";
import * as cfg from "./config.mjs";
import { openVaultDb } from "./db.mjs";
import { listAgents, getAgent } from "./agents.mjs";
import { isLoopbackHost } from "./auth.mjs";
import { verifyAudit } from "./audit.mjs";
import { cloudPolicy, listLocalBackups } from "./storage.mjs";
import { isLegacyBlob } from "./crypto-vault.mjs";
import { redact } from "./redact.mjs";

/** Show paths as ~/… so screenshots and bug reports do not reveal the account name. */
export function tildify(p, home = os.homedir()) {
  const s = String(p);
  return home && (s === home || s.startsWith(home + path.sep)) ? `~${s.slice(home.length)}` : s;
}

const modeOf = (p) => { try { return fs.statSync(p).mode & 0o777; } catch { return null; } };
const isPosix = process.platform !== "win32";

async function serverUp(url) {
  try {
    return (await fetch(`${url}/health`, { signal: AbortSignal.timeout(1200) })).ok;
  } catch {
    return false;
  }
}

/**
 * @param {object}  [o]
 * @param {object}  [o.vdb]         reuse an open handle
 * @param {boolean} [o.deep]        also scan recent items for credential-like text (slower)
 * @param {boolean} [o.checkServer] probe whether the server is running (skip when called BY the server)
 * @returns {Promise<{ rows: Array<{level:"ok"|"warn"|"bad"|"info", title:string, fix:string}>, counts:{bad:number,warn:number} }>}
 */
export async function collectDiagnostics({ vdb, deep = false, checkServer = true } = {}) {
  const rows = [];
  const add = (level, title, fix = "") => rows.push({ level, title, fix });
  const db = vdb || openVaultDb();
  const sec = cfg.SECURITY_CONFIG;

  const major = Number(process.versions.node.split(".")[0]);
  add(major >= 20 ? "ok" : "bad", `Node.js ${process.versions.node}`, major >= 20 ? "" : "MemVault needs Node 20 or newer.");

  const total = db.query("SELECT COUNT(*) AS n FROM items")[0].n;
  add("ok", `Vault: ${tildify(cfg.VAULT_ROOT)} — ${total} items, ${(fs.statSync(db.path).size / 1048576).toFixed(1)} MB`);
  if (isPosix) {
    for (const [label, p, want] of [["vault folder", cfg.VAULT_ROOT, 0o700], ["database", db.path, 0o600]]) {
      const m = modeOf(p);
      if (m !== null && (m & 0o077) !== 0) add("warn", `${label} is readable by other users (mode ${m.toString(8)})`, `chmod ${want.toString(8)} "${p}"`);
      else add("ok", `${label} permissions are private`);
    }
  } else {
    add("info", "Windows: file permissions follow your user profile. Keep the vault inside your user folder.");
  }

  const tokenPath = cfg.TOKEN_FILE;
  if (!fs.existsSync(tokenPath) && !process.env.MEMVAULT_TOKEN) {
    add("info", "No API token yet (created the first time the server or `memvault setup` runs)");
  } else {
    const m = modeOf(tokenPath);
    if (isPosix && m !== null && (m & 0o077) !== 0) add("warn", `API token file is readable by other users (mode ${m.toString(8)})`, `chmod 600 "${tokenPath}"`);
    else add("ok", "API token present and private");
    if (path.resolve(tokenPath).startsWith(path.resolve(cfg.VAULT_ROOT))) {
      add("warn", "API token is stored inside the vault folder, so backups would include it", "set MEMVAULT_TOKEN_FILE to a path outside the vault");
    }
  }

  if (isLoopbackHost(sec.host)) add("ok", `Server binds to ${sec.host} (this machine only)`);
  else add(sec.allowRemote ? "warn" : "bad", `Server is set to listen on ${sec.host}`, 'set "security": { "host": "127.0.0.1" } in ~/.memvaultrc.json unless you truly need this');
  if (checkServer) {
    const base = `http://127.0.0.1:${cfg.PORT}`;
    add("info", (await serverUp(base)) ? `Server is running at ${base}` : "Server is not running (fine — only the dashboard needs it)");
  }

  add(sec.redact !== false ? "ok" : "warn", sec.redact !== false ? "Secret masking is ON" : "Secret masking is OFF", sec.redact !== false ? "" : 'remove "redact": false from the security config');
  if (sec.audit === false) add("warn", "Audit log is OFF", 'remove "audit": false from the security config');
  else {
    const v = verifyAudit(cfg.VAULT_ROOT);
    add(v.ok ? "ok" : "bad", v.ok ? `Audit log intact (${v.entries} records)` : `Audit log was altered at line ${v.brokenAtLine}: ${v.reason}`, v.ok ? "" : "Investigate — someone edited or removed records.");
  }

  const secrets = db.query("SELECT encrypted FROM secrets WHERE id != '__sentinel__'");
  const legacy = secrets.filter((s) => isLegacyBlob(s.encrypted)).length;
  add("ok", `${secrets.length} encrypted secret(s)`);
  if (legacy) add("warn", `${legacy} secret(s) still use the old static-salt encryption`, "open each once in the dashboard (Secure Vault) and it upgrades automatically");

  const st = cfg.STORAGE_CONFIG;
  if (!(st.gdriveFolder?.enabled || st.gdriveApi?.enabled)) {
    add("ok", "No cloud backup configured — your data never leaves this machine");
  } else {
    const pol = cloudPolicy(st);
    if (pol.mode === "encrypted") add("ok", "Cloud backups are encrypted before upload");
    else if (pol.mode === "plaintext") add("bad", "Cloud backups are uploaded WITHOUT encryption", "unset allowPlaintextCloud and set MEMVAULT_BACKUP_PASSPHRASE");
    else add("bad", "Cloud backup is enabled but blocked", pol.error);
  }
  const backups = listLocalBackups();
  if (!backups.length) add("warn", "No local backup yet", "run `memvault backup`");
  else {
    const ageDays = (Date.now() - new Date(backups[0].modified).getTime()) / 86400000;
    add(ageDays > 14 ? "warn" : "ok", `Latest local backup is ${ageDays < 1 ? "from today" : `${Math.floor(ageDays)} day(s) old`}`, ageDays > 14 ? "run `memvault backup`" : "");
  }

  const list = listAgents(db);
  add(list.length ? "ok" : "info", list.length ? `${list.length} agent profile(s): ${list.map((a) => a.id).join(", ")}` : "No agent profiles yet (try `memvault agent starter`)");
  for (const a of list) {
    const p = getAgent(db, a.id);
    if (p?.memory.allowSecrets) add("warn", `Agent "${a.id}" can read the secrets table`, `memvault agent edit ${a.id}`);
    if (p?.memory.readScopes.some((s) => s.startsWith("agent:"))) add("warn", `Agent "${a.id}" can read other agents' private memory`, "intended for coordinators only");
  }

  if (deep) {
    const sample = db.query("SELECT title, content FROM items ORDER BY created_at DESC LIMIT 2000");
    let hits = 0;
    for (const r of sample) if (redact(`${r.title || ""}\n${r.content || ""}`, { disable: sec.redactDisable }).findings.length) hits++;
    if (hits) add("warn", `${hits} of your latest ${sample.length} items contain credential-like text stored before masking`, "preview with `memvault scrub`, then `memvault scrub --apply`");
    else add("ok", "No credential-like text found in recent items");
  }

  return {
    rows,
    counts: { bad: rows.filter((r) => r.level === "bad").length, warn: rows.filter((r) => r.level === "warn").length },
  };
}
