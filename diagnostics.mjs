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
import { deviceSettings, deviceStatus } from "./device-sync.mjs";
import { listDeviceKeys } from "./device-keys.mjs";
import { isLoopbackHost } from "./auth.mjs";
import { workspaceSettings } from "./workspace.mjs";
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
  // Plain words for people (the dashboard and `memvault doctor` show these as they are): sentence case, real plurals.
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  const db = vdb || openVaultDb();
  const sec = cfg.SECURITY_CONFIG;

  const major = Number(process.versions.node.split(".")[0]);
  add(major >= 20 ? "ok" : "bad", `Node.js ${process.versions.node} (${major >= 20 ? "supported" : "too old"})`, major >= 20 ? "" : "MemVault needs Node.js 20 or newer.");

  const total = db.query("SELECT COUNT(*) AS n FROM items")[0].n;
  add("ok", `Vault folder: ${tildify(cfg.VAULT_ROOT)} (${plural(total, "memory", "memories")}, ${(fs.statSync(db.path).size / 1048576).toFixed(1)} MB)`);
  if (isPosix) {
    for (const [label, p, want] of [["Vault folder", cfg.VAULT_ROOT, 0o700], ["Database file", db.path, 0o600]]) {
      const m = modeOf(p);
      if (m !== null && (m & 0o077) !== 0) add("warn", `${label} can be read by other users on this computer (mode ${m.toString(8)})`, `Run: chmod ${want.toString(8)} "${p}"`);
      else add("ok", `${label} is private to you`);
    }
  } else {
    add("info", "Windows: file permissions follow your user profile. Keep the vault inside your user folder.");
  }

  const tokenPath = cfg.TOKEN_FILE;
  if (!fs.existsSync(tokenPath) && !process.env.MEMVAULT_TOKEN) {
    add("info", "No dashboard key yet. One is made the first time MemVault starts, or when you run memvault setup.");
  } else {
    const m = modeOf(tokenPath);
    if (isPosix && m !== null && (m & 0o077) !== 0) add("warn", `Dashboard key file can be read by other users on this computer (mode ${m.toString(8)})`, `Run: chmod 600 "${tokenPath}"`);
    else add("ok", "Dashboard key is set and private to you");
    if (path.resolve(tokenPath).startsWith(path.resolve(cfg.VAULT_ROOT))) {
      add("warn", "Dashboard key is kept inside the vault folder, so backups would include it", "Set MEMVAULT_TOKEN_FILE to a place outside the vault folder.");
    }
  }

  if (isLoopbackHost(sec.host)) add("ok", `Server only listens on this computer (${sec.host})`);
  else add(sec.allowRemote ? "warn" : "bad", `Server listens on ${sec.host}, so other devices may reach it`, 'Set "security": { "host": "127.0.0.1" } in ~/.memvaultrc.json, unless you really need this.');
  const ws = workspaceSettings(sec);
  if (!ws.enabled) add("ok", "Server workspace (terminal, services, files) is off");
  else {
    const reach = ws.terminal ? "a shell" : "services and files";
    add(isLoopbackHost(sec.host) ? "info" : "warn", `Server workspace is ON: anyone with the dashboard key or a paired phone gets ${reach} as ${os.userInfo().username}`,
      isLoopbackHost(sec.host) ? "" : "Keep the dashboard key private, serve it over HTTPS only, and sign out phones you no longer use.");
    if (!fs.existsSync(ws.root)) add("warn", `Workspace folder ${ws.root} does not exist`, 'Set "security": { "workspace": { "root": "…" } } in ~/.memvaultrc.json.');
  }
  if (checkServer) {
    const base = `http://127.0.0.1:${cfg.PORT}`;
    add("info", (await serverUp(base)) ? `Server is running at ${base}` : "Server is not running. That is fine: only the dashboard needs it.");
  }

  // "ON" / "OFF" stay in capitals here: tests/server.test.js looks for "Secret masking is ON".
  add(sec.redact !== false ? "ok" : "warn", sec.redact !== false ? "Secret masking is ON: passwords and keys are hidden before anything is saved" : "Secret masking is OFF", sec.redact !== false ? "" : 'Remove "redact": false from the security settings.');
  if (sec.audit === false) add("warn", "Audit log is off", 'Remove "audit": false from the security settings.');
  else {
    const v = verifyAudit(cfg.VAULT_ROOT);
    add(v.ok ? "ok" : "bad", v.ok ? `Audit log intact (${plural(v.entries, "record", "records")})` : `Audit log was changed at line ${v.brokenAtLine}: ${v.reason}`, v.ok ? "" : "Someone edited or removed records. Check who can use this computer.");
  }

  const secrets = db.query("SELECT encrypted FROM secrets WHERE id != '__sentinel__'");
  const legacy = secrets.filter((s) => isLegacyBlob(s.encrypted)).length;
  add("ok", secrets.length ? `${plural(secrets.length, "secret", "secrets")} locked in the Secure Vault` : "No secrets in the Secure Vault yet");
  if (legacy) add("warn", `${plural(legacy, "secret still uses", "secrets still use")} the older, weaker lock`, "Open each one once in the dashboard (Secure Vault) and it is upgraded by itself.");

  const st = cfg.STORAGE_CONFIG;
  if (!(st.gdriveFolder?.enabled || st.gdriveApi?.enabled)) {
    add("ok", "No cloud backup is set up, so your data never leaves this computer");
  } else {
    const pol = cloudPolicy(st);
    if (pol.mode === "encrypted") add("ok", "Cloud backups are locked (encrypted) before they are uploaded");
    else if (pol.mode === "plaintext") add("bad", "Cloud backups are uploaded without encryption", "Remove allowPlaintextCloud and set MEMVAULT_BACKUP_PASSPHRASE.");
    else add("bad", "Cloud backup is switched on but blocked", pol.error);
  }
  const backups = listLocalBackups();
  const backupFix = "Run memvault backup, or choose “Back up now” in the dashboard.";
  // "Latest local backup is from today" is what tests/cli.test.js looks for.
  if (!backups.length) add("warn", "No local backup yet", backupFix);
  else {
    const ageDays = (Date.now() - new Date(backups[0].modified).getTime()) / 86400000;
    add(ageDays > 14 ? "warn" : "ok", `Latest local backup is ${ageDays < 1 ? "from today" : `${plural(Math.floor(ageDays), "day", "days")} old`}`, ageDays > 14 ? backupFix : "");
  }

  const list = listAgents(db);
  const nameOf = (a) => a.name || a.id;
  add(list.length ? "ok" : "info", list.length ? `${plural(list.length, "agent", "agents")}: ${list.map(nameOf).join(", ")}` : "No agents yet. Add the starter agents on the Agents screen, or run memvault agent starter.");
  for (const a of list) {
    const p = getAgent(db, a.id);
    if (p?.memory.allowSecrets) add("warn", `Agent “${nameOf(a)}” can see the names of Secure Vault items`, `Turn this off under Agents → Edit, or run memvault agent edit ${a.id}.`);
    if (p?.memory.readScopes.some((s) => s.startsWith("agent:"))) add("warn", `Agent “${nameOf(a)}” can read other agents’ private memories`, "This is meant only for a coordinator agent.");
  }

  // Your other computers and phones (device-sync.mjs, device-keys.mjs)
  const dev = deviceSettings();
  if (!dev.enabled) add("info", "Syncing with your other computers is off");
  else {
    const st = deviceStatus({ vdb: db, settings: dev });
    const others = st.peers.filter((x) => x.inFolder);
    if (!st.passphraseSet) add("bad", "Device sync is on, but there is no sync passphrase", "Run memvault devices passphrase, or set it in Settings → Your devices.");
    else if (!st.folderExists) add("warn", `Device sync is on, but the shared folder is missing: ${st.folder}`, "Start your sync app or connect the drive, or choose another folder in Settings → Your devices.");
    else if (st.last && !st.last.ok) add("warn", `The last device sync had a problem: ${st.last.problems[0] || "unknown"}`, "Run memvault devices to see more.");
    else add("ok", `Syncing with ${plural(others.length, "other computer", "other computers")}${st.last ? `, last ${new Date(st.last.at).toLocaleString()}` : ", not synced yet"}`);
  }
  const phones = listDeviceKeys();
  if (phones.length) add("info", `${plural(phones.length, "phone or tablet", "phones or tablets")} can open this dashboard: ${phones.map((k) => k.name).join(", ")}`, "Sign out the ones you no longer use in Settings → Your devices.");

  if (deep) {
    const sample = db.query("SELECT title, content FROM items ORDER BY created_at DESC LIMIT 2000");
    let hits = 0;
    for (const r of sample) if (redact(`${r.title || ""}\n${r.content || ""}`, { disable: sec.redactDisable }).findings.length) hits++;
    if (hits) add("warn", `${hits} of your latest ${plural(sample.length, "memory", "memories")} ${hits === 1 ? "has" : "have"} password-like text saved before masking was on`, "See them with memvault scrub, then hide them with memvault scrub --apply.");
    else add("ok", "No password-like text found in recent memories");
  }

  return {
    rows,
    counts: { bad: rows.filter((r) => r.level === "bad").length, warn: rows.filter((r) => r.level === "warn").length },
  };
}
