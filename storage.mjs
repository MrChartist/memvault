/**
 * storage.mjs — MemVault Storage & Backup Backends
 * ═══════════════════════════════════════════════════════════════════════════════
 * Local-first storage with optional Google Drive backup. The vault always lives
 * on disk; backups are pushed to any enabled backend:
 *
 *   • local        — timestamped copies of the SQLite DB in VAULT_ROOT/backups
 *   • gdriveFolder — mirror the vault tree into a Google Drive for Desktop folder
 *   • gdriveApi    — upload the DB via the Google Drive REST API (OAuth token)
 *
 * No heavy dependencies: the Drive API path uses plain fetch + an OAuth refresh
 * token, so nothing leaves your machine except your own authenticated requests.
 *
 * SAFE BY DEFAULT: anything that leaves this machine (both Drive backends) is
 * encrypted first with AES-256-GCM (key from your passphrase via scrypt). The
 * passphrase comes from MEMVAULT_BACKUP_PASSPHRASE or the file named by
 * storage.passphraseFile. With no passphrase the cloud backends REFUSE to run
 * rather than upload your notes in plain text — unless you explicitly set
 * storage.allowPlaintextCloud: true.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import fs from "fs";
import path from "path";
import { pathToFileURL } from "url";
import { isMain } from "./is-main.mjs";
import { VAULT_ROOT, STORAGE_CONFIG } from "./config.mjs";
import { FileLock } from "./filelock.mjs";
import { encryptBuffer, decryptBuffer, isEncryptedBackup, MIN_PASSPHRASE_LENGTH } from "./crypto-vault.mjs";
import initSqlJs from "sql.js";
import { retryBusy } from "./retry.mjs";

const SQL = await initSqlJs();

const DB_PATH = path.join(VAULT_ROOT, "db", "index.sqlite");
const BACKUP_DIR = path.join(VAULT_ROOT, "backups");

const ensureDir = (p) => fs.mkdirSync(p, { recursive: true });

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

/** Recursively copy a directory tree (Node 16+ has fs.cpSync). */
function copyTree(src, dest) {
  if (!fs.existsSync(src)) return;
  fs.cpSync(src, dest, { recursive: true });
}

// ─── Local backups ──────────────────────────────────────────────────────────

export function listLocalBackups() {
  if (!fs.existsSync(BACKUP_DIR)) return [];
  return fs
    .readdirSync(BACKUP_DIR)
    .filter((f) => f.startsWith("index-") && f.endsWith(".sqlite"))
    .sort()
    .reverse()
    .map((f) => {
      const full = path.join(BACKUP_DIR, f);
      const { size, mtime } = fs.statSync(full);
      return { name: f, path: full, size, modified: mtime.toISOString() };
    });
}

function pruneLocalBackups(keep) {
  if (!keep || keep <= 0) return;
  const backups = listLocalBackups();
  for (const old of backups.slice(keep)) {
    try { fs.unlinkSync(old.path); } catch { /* ignore */ }
  }
}

export function backupLocal() {
  if (!fs.existsSync(DB_PATH)) {
    return { backend: "local", ok: false, error: "No vault database found yet." };
  }
  ensureDir(BACKUP_DIR);
  const name = `index-${stamp()}.sqlite`;
  const dest = path.join(BACKUP_DIR, name);
  fs.copyFileSync(DB_PATH, dest);
  pruneLocalBackups(STORAGE_CONFIG.keepLocalBackups);
  return { backend: "local", ok: true, location: dest };
}

/** Refuse anything that is not a healthy MemVault database, BEFORE it can replace the live one. */
function assertMemVaultDb(bytes) {
  let db;
  try {
    db = new SQL.Database(bytes);
    const ok = db.exec("PRAGMA integrity_check")[0]?.values?.[0]?.[0];
    const hasItems = db.exec("SELECT 1 FROM sqlite_master WHERE type='table' AND name='items'").length > 0;
    if (ok !== "ok" || !hasItems) throw new Error("bad");
  } catch {
    throw new Error("That file is not a MemVault database, or it is damaged, so nothing was restored. Your current vault is unchanged.");
  } finally {
    db?.close();
  }
}

/** Replace the live DB with `bytes`, atomically and under the DB lock. Snapshots the current DB first. */
function installDb(bytes) {
  assertMemVaultDb(bytes);
  ensureDir(path.dirname(DB_PATH));
  ensureDir(BACKUP_DIR);
  const lock = new FileLock(`${DB_PATH}.lock`);
  lock.acquire();
  try {
    if (fs.existsSync(DB_PATH)) {
      fs.copyFileSync(DB_PATH, path.join(BACKUP_DIR, `pre-restore-${stamp()}.sqlite`));
    }
    const tmp = `${DB_PATH}.${process.pid}.restore.tmp`;
    fs.writeFileSync(tmp, bytes, { mode: 0o600 });
    retryBusy(() => fs.renameSync(tmp, DB_PATH));
  } finally {
    lock.release();
  }
}

/** Restore the live DB from a named local backup (e.g. "index-...sqlite"). */
export function restoreLocal(backupName) {
  // Names only — never a path — so a crafted name cannot reach outside the backup folder.
  if (backupName !== path.basename(backupName)) throw new Error("Backup name must not contain a path.");
  const src = path.join(BACKUP_DIR, backupName);
  if (!fs.existsSync(src)) throw new Error(`Backup not found: ${backupName}`);
  installDb(fs.readFileSync(src));
  return { ok: true, restored: backupName, into: DB_PATH };
}

/** Restore from an encrypted .mvbak file (e.g. downloaded back from Google Drive). */
export function restoreEncrypted(file, passphrase = resolvePassphrase()) {
  if (!passphrase) throw new Error("No passphrase: set MEMVAULT_BACKUP_PASSPHRASE or pass one.");
  const blob = fs.readFileSync(file);
  if (!isEncryptedBackup(blob)) throw new Error("That file is not a MemVault encrypted backup.");
  let plain;
  try {
    plain = decryptBuffer(blob, passphrase);
  } catch {
    throw new Error("Could not decrypt — wrong passphrase, or the file is damaged.");
  }
  installDb(plain);
  return { ok: true, restored: path.basename(file), into: DB_PATH };
}

// ─── Cloud encryption policy ────────────────────────────────────────────────

/** Backup passphrase: env var first, then the first line of storage.passphraseFile. Never from the JSON config. */
export function resolvePassphrase(cfg = STORAGE_CONFIG) {
  if (process.env.MEMVAULT_BACKUP_PASSPHRASE) return process.env.MEMVAULT_BACKUP_PASSPHRASE;
  if (cfg.passphraseFile) {
    try {
      return fs.readFileSync(cfg.passphraseFile, "utf8").split(/\r?\n/)[0].trim() || null;
    } catch { /* fall through */ }
  }
  return null;
}

/**
 * Decide how data may leave the machine.
 * @returns {{ mode: "encrypted", passphrase: string } | { mode: "plaintext" } | { mode: "blocked", error: string }}
 */
export function cloudPolicy(cfg = STORAGE_CONFIG) {
  const pass = resolvePassphrase(cfg);
  if (cfg.encryptCloud !== false) {
    if (!pass) {
      if (cfg.allowPlaintextCloud === true) return { mode: "plaintext" };
      return {
        mode: "blocked",
        error:
          "Cloud backup is blocked: no encryption passphrase. Set the MEMVAULT_BACKUP_PASSPHRASE environment " +
          `variable (${MIN_PASSPHRASE_LENGTH}+ characters) so your vault is encrypted before it leaves this machine. ` +
          "(To upload unencrypted anyway, set storage.allowPlaintextCloud: true — not recommended.)",
      };
    }
    if (pass.length < MIN_PASSPHRASE_LENGTH) {
      return { mode: "blocked", error: `Backup passphrase must be at least ${MIN_PASSPHRASE_LENGTH} characters.` };
    }
    return { mode: "encrypted", passphrase: pass };
  }
  return cfg.allowPlaintextCloud === true
    ? { mode: "plaintext" }
    : { mode: "blocked", error: "encryptCloud is off but allowPlaintextCloud is not set; refusing to upload plain text." };
}

/** The bytes to send off-machine: an encrypted container of the DB, or the raw DB if plaintext is allowed. */
function cloudPayload(policy) {
  const raw = fs.readFileSync(DB_PATH);
  if (policy.mode === "encrypted") {
    return {
      bytes: encryptBuffer(raw, policy.passphrase, { tool: "memvault", createdAt: new Date().toISOString() }),
      ext: "sqlite.mvbak",
      encrypted: true,
    };
  }
  return { bytes: raw, ext: "sqlite", encrypted: false };
}

// ─── Google Drive: folder mirror ────────────────────────────────────────────
// Mirrors the vault (db + markdown entries) into a locally-synced Drive folder.
// Google Drive for Desktop uploads it to the cloud automatically.

function backupGDriveFolder(cfg, policy) {
  const target = cfg.path;
  if (!target) {
    return { backend: "gdriveFolder", ok: false, error: "storage.gdriveFolder.path is not set." };
  }
  if (policy.mode === "blocked") return { backend: "gdriveFolder", ok: false, error: policy.error };
  if (!fs.existsSync(DB_PATH)) {
    return { backend: "gdriveFolder", ok: false, error: "No vault database found yet." };
  }
  try {
    const dest = path.join(target, "MemVault");
    ensureDir(dest);
    if (policy.mode === "encrypted") {
      // One encrypted file; plaintext notes/markdown are NOT mirrored.
      const { bytes, ext } = cloudPayload(policy);
      const file = path.join(dest, `memvault-${stamp()}.${ext}`);
      fs.writeFileSync(file, bytes, { mode: 0o600 });
      pruneByPrefix(dest, "memvault-", `.${ext}`, cfg.keep ?? STORAGE_CONFIG.keepLocalBackups);
      fs.writeFileSync(
        path.join(dest, "MANIFEST.json"),
        JSON.stringify({ tool: "memvault", encrypted: true, latest: path.basename(file), at: new Date().toISOString() }, null, 2)
      );
      return { backend: "gdriveFolder", ok: true, location: file, encrypted: true };
    }
    // Explicitly-allowed plaintext mirror (legacy behaviour).
    for (const sub of ["db", "entries", "conversations", "worklogs"]) {
      copyTree(path.join(VAULT_ROOT, sub), path.join(dest, sub));
    }
    fs.writeFileSync(
      path.join(dest, "MANIFEST.json"),
      JSON.stringify({ tool: "memvault", encrypted: false, at: new Date().toISOString() }, null, 2)
    );
    return { backend: "gdriveFolder", ok: true, location: dest, encrypted: false, warning: "uploaded WITHOUT encryption" };
  } catch (e) {
    return { backend: "gdriveFolder", ok: false, error: e.message };
  }
}

function pruneByPrefix(dir, prefix, suffix, keep) {
  if (!keep || keep <= 0) return;
  const files = fs.readdirSync(dir).filter((f) => f.startsWith(prefix) && f.endsWith(suffix)).sort().reverse();
  for (const old of files.slice(keep)) {
    try { fs.unlinkSync(path.join(dir, old)); } catch { /* ignore */ }
  }
}

// ─── Google Drive: REST API ─────────────────────────────────────────────────

/** Exchange a long-lived refresh token for a short-lived access token. */
export async function getDriveAccessToken(cfg) {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      refresh_token: cfg.refreshToken,
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) {
    throw new Error(`OAuth token refresh failed (${res.status}): ${await res.text()}`);
  }
  const data = await res.json();
  if (!data.access_token) throw new Error("No access_token in OAuth response.");
  return data.access_token;
}

/** Multipart-upload a buffer to Google Drive and return the file metadata. */
export async function uploadBufferToDrive(buffer, filename, cfg) {
  const accessToken = await getDriveAccessToken(cfg);
  const metadata = {
    name: filename,
    ...(cfg.folderId ? { parents: [cfg.folderId] } : {}),
  };

  const boundary = "memvault-" + Math.random().toString(16).slice(2);
  const body = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
        JSON.stringify(metadata) +
        `\r\n--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`
    ),
    Buffer.from(buffer),
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);

  const res = await fetch(
    "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": `multipart/related; boundary=${boundary}`,
      },
      body,
    }
  );
  if (!res.ok) {
    throw new Error(`Drive upload failed (${res.status}): ${await res.text()}`);
  }
  return res.json();
}

async function backupGDriveApi(cfg, policy) {
  if (!cfg.clientId || !cfg.clientSecret || !cfg.refreshToken) {
    return {
      backend: "gdriveApi",
      ok: false,
      error: "storage.gdriveApi needs clientId, clientSecret and refreshToken.",
    };
  }
  if (policy.mode === "blocked") return { backend: "gdriveApi", ok: false, error: policy.error };
  if (!fs.existsSync(DB_PATH)) {
    return { backend: "gdriveApi", ok: false, error: "No vault database found yet." };
  }
  try {
    const { bytes, ext, encrypted } = cloudPayload(policy);
    const file = await uploadBufferToDrive(bytes, `memvault-${stamp()}.${ext}`, cfg);
    return {
      backend: "gdriveApi", ok: true, location: file.webViewLink || file.id, fileId: file.id, encrypted,
      ...(encrypted ? {} : { warning: "uploaded WITHOUT encryption" }),
    };
  } catch (e) {
    return { backend: "gdriveApi", ok: false, error: e.message };
  }
}

// ─── Orchestration ──────────────────────────────────────────────────────────

/** Which backends are currently enabled. */
export function enabledBackends(config = STORAGE_CONFIG) {
  const list = ["local"];
  if (config.gdriveFolder?.enabled) list.push("gdriveFolder");
  if (config.gdriveApi?.enabled) list.push("gdriveApi");
  return list;
}

/**
 * Back up the vault to every enabled backend.
 * Returns an array of per-backend results; never throws.
 */
export async function backupVault(config = STORAGE_CONFIG) {
  const results = [];
  results.push(backupLocal());

  const cloud = config.gdriveFolder?.enabled || config.gdriveApi?.enabled;
  const policy = cloud ? cloudPolicy(config) : null;

  if (config.gdriveFolder?.enabled) {
    results.push(backupGDriveFolder(config.gdriveFolder, policy));
  }
  if (config.gdriveApi?.enabled) {
    results.push(await backupGDriveApi(config.gdriveApi, policy));
  }
  return results;
}

// ─── CLI ────────────────────────────────────────────────────────────────────

if (isMain(import.meta.url)) {
  const cmd = process.argv[2] || "backup";
  if (cmd === "list") {
    const backups = listLocalBackups();
    console.log(`📦 ${backups.length} local backup(s) in ${BACKUP_DIR}:`);
    for (const b of backups) console.log(`  - ${b.name}  (${(b.size / 1024).toFixed(1)} KB, ${b.modified})`);
  } else if (cmd === "restore-encrypted") {
    const file = process.argv[3];
    if (!file) { console.error("Usage: node storage.mjs restore-encrypted <file.mvbak>  (needs MEMVAULT_BACKUP_PASSPHRASE)"); process.exit(1); }
    try { console.log(JSON.stringify(restoreEncrypted(file), null, 2)); }
    catch (e) { console.error(`❌ ${e.message}`); process.exit(1); }
  } else if (cmd === "restore") {
    const name = process.argv[3];
    if (!name) { console.error("Usage: node storage.mjs restore <backup-name>"); process.exit(1); }
    console.log(JSON.stringify(restoreLocal(name), null, 2));
  } else {
    console.log(`💾 Backing up vault → ${enabledBackends().join(", ")}\n`);
    const results = await backupVault();
    for (const r of results) {
      console.log(r.ok
        ? `  ✅ ${r.backend}: ${r.location}${r.encrypted === true ? "  🔒 encrypted" : r.warning ? `  ⚠️  ${r.warning}` : ""}`
        : `  ❌ ${r.backend}: ${r.error}`);
    }
    const failed = results.filter((r) => !r.ok);
    process.exit(failed.length && failed.every((f) => f.backend !== "local") ? 0 : failed.length ? 1 : 0);
  }
}
