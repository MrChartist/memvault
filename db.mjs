/**
 * db.mjs — MemVault database layer (sql.js / SQLite)
 * ═══════════════════════════════════════════════════════════════════════════════
 * ONE module owns the vault database. The web server, the MCP server, the sync
 * engines, the importers and the bridges all go through it.
 *
 * Why this matters: sql.js keeps the whole database in memory and rewrites the
 * whole file on every change. If several processes each held their own copy
 * (web server + MCP server + a sync job), the last one to write would silently
 * erase everyone else's entries. This module prevents that by:
 *
 *   • reloading from disk whenever the file changed since we last saw it,
 *   • taking a cross-process lock around every write (read → change → write),
 *   • writing atomically (temp file + rename) so readers never see a torn file.
 *
 * Reads are lock-free. Writes are serialised across processes.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import fs from "fs";
import path from "path";
import crypto from "crypto";
import initSqlJs from "sql.js";
import { VAULT_ROOT } from "./config.mjs";

export const DB_PATH = path.join(VAULT_ROOT, "db", "index.sqlite");
const LOCK_PATH = `${DB_PATH}.lock`;

export const ITEM_TYPES = ["diary", "conversation", "worklog", "file"];

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS items (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,          -- diary | conversation | worklog | file
    source TEXT,                 -- manual | git | vscode | chatgpt-import | ...
    title TEXT,
    content TEXT,
    file_path TEXT,
    tags TEXT,                   -- comma-separated
    created_at TEXT NOT NULL     -- ISO 8601
  );
  CREATE INDEX IF NOT EXISTS idx_items_type ON items(type);
  CREATE INDEX IF NOT EXISTS idx_items_created ON items(created_at);
  CREATE INDEX IF NOT EXISTS idx_items_source ON items(source);

  CREATE TABLE IF NOT EXISTS secrets (
    id TEXT PRIMARY KEY,
    category TEXT NOT NULL,      -- apikey | password | userid | payment | phone | custom
    label TEXT NOT NULL,         -- plaintext label only (e.g. "OpenAI Key")
    encrypted TEXT NOT NULL,     -- JSON blob, see secrets.mjs
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_secrets_category ON secrets(category);
`;

const SQL = await initSqlJs();
let db = null;
let loadedSig = null;

function fileSig() {
  try {
    const s = fs.statSync(DB_PATH);
    return `${s.mtimeMs}:${s.size}`;
  } catch {
    return null;
  }
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** (Re)load the database from disk, discarding any in-memory state. */
function load() {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  if (db) { try { db.close(); } catch { /* already closed */ } }
  db = fs.existsSync(DB_PATH) ? new SQL.Database(fs.readFileSync(DB_PATH)) : new SQL.Database();
  db.run(SCHEMA);
  dropLegacyFtsTriggers();
  loadedSig = fileSig();
}

/**
 * Early MemVault builds attached FTS5 triggers to `items`. sql.js ships without
 * FTS5, so such a trigger makes every INSERT fail ("no such module: fts5").
 * Search is LIKE-based now; drop only triggers that reference the old FTS table.
 */
function dropLegacyFtsTriggers() {
  try {
    const res = db.exec(
      "SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'items' AND sql LIKE '%items_fts%'"
    );
    for (const [name] of res[0]?.values || []) db.run(`DROP TRIGGER IF EXISTS "${String(name).replace(/"/g, '""')}"`);
  } catch { /* best effort */ }
}

/** Make sure `db` reflects what is on disk right now. */
function ensureFresh(holdingLock = false) {
  if (!db) {
    if (fs.existsSync(DB_PATH)) {
      load();
    } else {
      // First run: create the file under the lock so two processes starting at
      // the same moment cannot overwrite each other's first writes.
      const init = () => { load(); if (!fs.existsSync(DB_PATH)) persist(); };
      if (holdingLock) init(); else withLock(init);
    }
  } else if (fileSig() !== loadedSig) {
    load();
  }
}

/** Atomically write the in-memory database to disk. */
function persist() {
  const data = Buffer.from(db.export());
  const tmp = `${DB_PATH}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data, { mode: 0o600 });
  // On Windows a rename can fail transiently if an AV scanner/another reader has
  // the target open; retry briefly.
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(tmp, DB_PATH);
      break;
    } catch (e) {
      if (attempt >= 5 || !["EPERM", "EBUSY", "EACCES"].includes(e.code)) {
        try { fs.unlinkSync(tmp); } catch { /* ignore */ }
        throw e;
      }
      sleep(30 * (attempt + 1));
    }
  }
  loadedSig = fileSig();
}

function withLock(fn) {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const started = Date.now();
  let fd;
  for (;;) {
    try {
      fd = fs.openSync(LOCK_PATH, "wx");
      break;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      try {
        // A lock older than 15s belongs to a process that died mid-write.
        if (Date.now() - fs.statSync(LOCK_PATH).mtimeMs > 15_000) {
          fs.unlinkSync(LOCK_PATH);
          continue;
        }
      } catch { /* lock vanished — retry */ }
      if (Date.now() - started > 8_000) {
        throw new Error(`Timed out waiting for the vault database lock (${LOCK_PATH}). Delete it if no MemVault process is running.`);
      }
      sleep(15);
    }
  }
  try {
    return fn();
  } finally {
    try { fs.closeSync(fd); } catch { /* ignore */ }
    try { fs.unlinkSync(LOCK_PATH); } catch { /* ignore */ }
  }
}

/** Run `fn(db)` as an exclusive read-modify-write and persist the result. */
function write(fn) {
  return withLock(() => {
    ensureFresh(true);
    try {
      const result = fn(db);
      persist();
      return result;
    } catch (e) {
      load(); // throw away any half-applied changes
      throw e;
    }
  });
}

// ─── Public API ─────────────────────────────────────────────────────────────

/** SELECT helper → array of plain objects. */
export function queryAll(sql, params = []) {
  ensureFresh();
  const stmt = db.prepare(sql);
  try {
    if (params.length) stmt.bind(params);
    const rows = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    return rows;
  } finally {
    stmt.free();
  }
}

export function queryOne(sql, params = []) {
  return queryAll(sql, params)[0] || null;
}

/** Execute a single write statement and persist. Returns rows modified. */
export function run(sql, params = []) {
  return write((d) => {
    d.run(sql, params);
    return d.getRowsModified();
  });
}

/** Run several statements atomically with ONE persist. `fn` receives the raw db. */
export function transaction(fn) {
  return write((d) => {
    d.run("BEGIN");
    try {
      const result = fn(d);
      d.run("COMMIT");
      return result;
    } catch (e) {
      try { d.run("ROLLBACK"); } catch { /* ignore */ }
      throw e;
    }
  });
}

/**
 * Replace the live database with the SQLite file at `srcPath` (used by restore).
 * The file is validated first, then swapped in atomically under the write lock.
 */
export function replaceDatabaseFile(srcPath) {
  const buf = fs.readFileSync(srcPath);
  try {
    const probe = new SQL.Database(buf);
    probe.exec("SELECT count(*) FROM sqlite_master");
    probe.close();
  } catch (e) {
    throw new Error(`Not a valid SQLite database (${path.basename(srcPath)}): ${e.message}`);
  }
  withLock(() => {
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
    const tmp = `${DB_PATH}.${process.pid}.restore.tmp`;
    fs.writeFileSync(tmp, buf, { mode: 0o600 });
    fs.renameSync(tmp, DB_PATH);
    load();
  });
}

/** Force the next call to re-read the file (mainly for tests). */
export function reloadDb() {
  withLock(() => load());
}

// ─── Items ──────────────────────────────────────────────────────────────────

function normalizeDate(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

const str = (v, max) => (v == null || v === "" ? null : String(v).slice(0, max));

/**
 * Insert one or more entries with a single database write.
 *
 * Duplicate protection: when an entry carries its own `created_at` (git commits,
 * browser visits, imported chats — anything with a real timestamp) its id is a
 * hash of what it *is*, so re-running a sync or an import is a no-op instead of
 * duplicating every row.
 *
 * Snapshots: set `upsert: true` for "current state" entries (system info, VS Code
 * extensions...). Older entries with the same source+title are replaced, so
 * running a scheduled sync every 30 minutes does not pile up near-identical rows.
 *
 * @param {Array<{type:string,source?:string,title?:string,content?:string,
 *                file_path?:string,tags?:string,created_at?:string,upsert?:boolean}>} entries
 * @returns {{inserted:number, duplicates:number, ids:string[]}}
 */
export function addItems(entries) {
  const list = Array.isArray(entries) ? entries : [entries];
  return transaction((d) => {
    let inserted = 0;
    let duplicates = 0;
    const ids = [];

    for (const e of list) {
      if (!ITEM_TYPES.includes(e.type)) throw new Error(`Invalid entry type: ${e.type}`);

      const source = str(e.source, 200);
      const title = str(e.title, 1000);
      const content = e.content == null ? null : String(e.content);
      const explicitDate = normalizeDate(e.created_at);
      const createdAt = explicitDate || new Date().toISOString();

      let id;
      if (explicitDate) {
        const fingerprint = [e.type, source, title, explicitDate, content].join("\u0000");
        id = `${e.type}_${crypto.createHash("sha1").update(fingerprint).digest("hex").slice(0, 24)}`;
      } else {
        id = `${e.type}_${Date.now()}_${crypto.randomBytes(5).toString("hex")}`;
      }

      if (e.upsert && source && title) {
        d.run("DELETE FROM items WHERE source = ? AND title = ?", [source, title]);
      }

      d.run(
        `INSERT OR IGNORE INTO items (id,type,source,title,content,file_path,tags,created_at)
         VALUES (?,?,?,?,?,?,?,?)`,
        [id, e.type, source, title, content, str(e.file_path, 2000), str(e.tags, 2000), createdAt]
      );
      if (d.getRowsModified() > 0) inserted++;
      else duplicates++;
      ids.push(id);
    }
    return { inserted, duplicates, ids };
  });
}

/**
 * Search entries with LIKE (this sql.js build has no FTS5).
 * `terms` are matched literally against title, content and tags.
 *
 * @param {object} o
 * @param {string[]} o.terms    one or more search terms
 * @param {"any"|"all"} [o.match="any"]  OR vs AND across terms
 * @param {string} [o.type]     restrict to an item type
 * @param {string} [o.since]    only entries with created_at >= this ISO timestamp
 * @param {string} [o.until]    only entries with created_at <  this ISO timestamp
 * @param {number} [o.limit=20]
 * @param {number} [o.snippet=300]  characters of content to return
 */
export function searchItems({ terms, match = "any", type, since, until, limit = 20, snippet = 300 }) {
  const clean = (terms || []).map((t) => String(t).trim()).filter(Boolean);
  const clauses = clean.map(
    () => "(title LIKE ? ESCAPE '\\' OR content LIKE ? ESCAPE '\\' OR tags LIKE ? ESCAPE '\\')"
  );
  const params = clean.flatMap((t) => {
    const like = `%${t.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    return [like, like, like];
  });

  const where = [];
  if (clauses.length) where.push(`(${clauses.join(match === "all" ? " AND " : " OR ")})`);
  if (type) {
    where.push("type = ?");
    params.push(type);
  }
  if (since) {
    where.push("created_at >= ?");
    params.push(since);
  }
  if (until) {
    where.push("created_at < ?");
    params.push(until);
  }

  const safeSnippet = Math.max(1, Math.min(Number(snippet) || 300, 5000));
  const safeLimit = Math.max(1, Math.min(Number(limit) || 20, 500));
  return queryAll(
    `SELECT id, type, source, title, substr(content, 1, ${safeSnippet}) AS snippet, file_path, tags, created_at
     FROM items
     ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
     ORDER BY created_at DESC
     LIMIT ${safeLimit}`,
    params
  );
}

/** Counts per type + secrets, used by the UI and the MCP stats tool. */
export function getStats() {
  const byType = queryAll("SELECT type, COUNT(*) AS count FROM items GROUP BY type ORDER BY count DESC");
  const total = byType.reduce((n, r) => n + r.count, 0);
  const range = queryOne("SELECT MIN(created_at) AS first, MAX(created_at) AS last FROM items");
  const secrets = queryOne("SELECT COUNT(*) AS count FROM secrets WHERE id != '__sentinel__'")?.count || 0;
  return { total, byType, first: range?.first || null, last: range?.last || null, secrets };
}
