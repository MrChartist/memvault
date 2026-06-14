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
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import fs from "fs";
import path from "path";
import { VAULT_ROOT, STORAGE_CONFIG } from "./config.mjs";

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

function backupLocal() {
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

/** Restore the live DB from a named local backup (e.g. "index-...sqlite"). */
export function restoreLocal(backupName) {
  const src = path.join(BACKUP_DIR, backupName);
  if (!fs.existsSync(src)) throw new Error(`Backup not found: ${backupName}`);
  ensureDir(path.dirname(DB_PATH));
  // Safety: snapshot the current DB before overwriting it.
  if (fs.existsSync(DB_PATH)) {
    fs.copyFileSync(DB_PATH, path.join(BACKUP_DIR, `pre-restore-${stamp()}.sqlite`));
  }
  fs.copyFileSync(src, DB_PATH);
  return { ok: true, restored: backupName, into: DB_PATH };
}

// ─── Google Drive: folder mirror ────────────────────────────────────────────
// Mirrors the vault (db + markdown entries) into a locally-synced Drive folder.
// Google Drive for Desktop uploads it to the cloud automatically.

function backupGDriveFolder(cfg) {
  const target = cfg.path;
  if (!target) {
    return { backend: "gdriveFolder", ok: false, error: "storage.gdriveFolder.path is not set." };
  }
  try {
    const dest = path.join(target, "MemVault");
    ensureDir(dest);
    // Mirror the data directories that make up the vault.
    for (const sub of ["db", "entries", "conversations", "worklogs"]) {
      copyTree(path.join(VAULT_ROOT, sub), path.join(dest, sub));
    }
    fs.writeFileSync(
      path.join(dest, "MANIFEST.json"),
      JSON.stringify({ tool: "memvault", mirroredAt: new Date().toISOString(), source: VAULT_ROOT }, null, 2)
    );
    return { backend: "gdriveFolder", ok: true, location: dest };
  } catch (e) {
    return { backend: "gdriveFolder", ok: false, error: e.message };
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

async function backupGDriveApi(cfg) {
  if (!cfg.clientId || !cfg.clientSecret || !cfg.refreshToken) {
    return {
      backend: "gdriveApi",
      ok: false,
      error: "storage.gdriveApi needs clientId, clientSecret and refreshToken.",
    };
  }
  if (!fs.existsSync(DB_PATH)) {
    return { backend: "gdriveApi", ok: false, error: "No vault database found yet." };
  }
  try {
    const buf = fs.readFileSync(DB_PATH);
    const file = await uploadBufferToDrive(buf, `memvault-${stamp()}.sqlite`, cfg);
    return { backend: "gdriveApi", ok: true, location: file.webViewLink || file.id, fileId: file.id };
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

  if (config.gdriveFolder?.enabled) {
    results.push(backupGDriveFolder(config.gdriveFolder));
  }
  if (config.gdriveApi?.enabled) {
    results.push(await backupGDriveApi(config.gdriveApi));
  }
  return results;
}

// ─── CLI ────────────────────────────────────────────────────────────────────

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const cmd = process.argv[2] || "backup";
  if (cmd === "list") {
    const backups = listLocalBackups();
    console.log(`📦 ${backups.length} local backup(s) in ${BACKUP_DIR}:`);
    for (const b of backups) console.log(`  - ${b.name}  (${(b.size / 1024).toFixed(1)} KB, ${b.modified})`);
  } else if (cmd === "restore") {
    const name = process.argv[3];
    if (!name) { console.error("Usage: node storage.mjs restore <backup-name>"); process.exit(1); }
    console.log(JSON.stringify(restoreLocal(name), null, 2));
  } else {
    console.log(`💾 Backing up vault → ${enabledBackends().join(", ")}\n`);
    const results = await backupVault();
    for (const r of results) {
      console.log(r.ok ? `  ✅ ${r.backend}: ${r.location}` : `  ❌ ${r.backend}: ${r.error}`);
    }
    const failed = results.filter((r) => !r.ok);
    process.exit(failed.length && failed.every((f) => f.backend !== "local") ? 0 : failed.length ? 1 : 0);
  }
}
