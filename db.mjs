/**
 * db.mjs — MemVault shared database layer
 * ═══════════════════════════════════════════════════════════════════════════════
 * ONE memory, MANY writers. The web server, every MCP client process (Claude,
 * Cursor, Antigravity, …) and the sync engines all talk to the same SQLite file.
 *
 * The old pattern — load the whole DB into RAM at startup, then overwrite the
 * whole file on every write — silently lost data whenever two processes wrote
 * at once (3 writers x 100 inserts kept only 100 rows). This module fixes that:
 *
 *   • writes   take a cross-process lock, RELOAD the freshest file, apply the
 *              change, then replace the file atomically (tmp + fsync + rename)
 *   • reads    reload only when the file on disk changed (cheap stat check)
 *   • scoping  a handle bound to an agent reads from a FILTERED in-memory copy,
 *              so isolation is enforced on the data, not trusted to each query
 *
 * Pure JS (sql.js) — no native build step, works on Windows/macOS/Linux.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import fs from "fs";
import path from "path";
import crypto from "crypto";
import initSqlJs from "sql.js";
import { VAULT_ROOT } from "./config.mjs";
import { FileLock } from "./filelock.mjs";
import { retryBusy } from "./retry.mjs";

const SQL = await initSqlJs();

export const SCHEMA_VERSION = 2;
export const DEFAULT_SCOPE = "shared";

const BASE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS items (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,              -- diary | conversation | worklog | file
    source TEXT,
    title TEXT,
    content TEXT,
    file_path TEXT,
    tags TEXT,                       -- comma-separated
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_items_type ON items(type);
  CREATE INDEX IF NOT EXISTS idx_items_created ON items(created_at);

  CREATE TABLE IF NOT EXISTS secrets (
    id TEXT PRIMARY KEY,
    category TEXT NOT NULL,
    label TEXT NOT NULL,
    encrypted TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_secrets_category ON secrets(category);

  CREATE TABLE IF NOT EXISTS agents (
    id TEXT PRIMARY KEY,             -- slug, e.g. "market-analyst"
    name TEXT NOT NULL,
    role TEXT,
    profile TEXT NOT NULL,           -- JSON (see agents.mjs)
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT
  );
`;

// ─── helpers ────────────────────────────────────────────────────────────────

/** Best-effort POSIX permissions; harmless no-op on Windows. */
function tighten(p, mode) {
  try { fs.chmodSync(p, mode); } catch { /* ignore */ }
}

function rows(db, sql, params = []) {
  const stmt = db.prepare(sql);
  try {
    if (params.length) stmt.bind(params);
    const out = [];
    while (stmt.step()) out.push(stmt.getAsObject());
    return out;
  } finally {
    stmt.free();
  }
}

function columnNames(db, table) {
  return rows(db, `PRAGMA table_info(${table})`).map((r) => r.name);
}

/** Create missing tables and bring an older vault up to SCHEMA_VERSION. */
export function migrate(db) {
  db.run(BASE_SCHEMA);

  // A file written by a newer MemVault may have changed shape. Opening it here and stamping our older
  // version on it would hide that, so stop and say what to do.
  const stamped = Number(rows(db, "SELECT value FROM meta WHERE key = 'schema_version'")[0]?.value || 0);
  if (stamped > SCHEMA_VERSION) {
    throw new Error(
      `This vault was made by a newer version of MemVault (data version ${stamped}; this one understands ${SCHEMA_VERSION}). ` +
      "Update MemVault instead of opening it with this older copy. Nothing was changed."
    );
  }

  const cols = columnNames(db, "items");
  if (!cols.includes("agent_id")) db.run("ALTER TABLE items ADD COLUMN agent_id TEXT");
  if (!cols.includes("scope")) {
    db.run(`ALTER TABLE items ADD COLUMN scope TEXT NOT NULL DEFAULT '${DEFAULT_SCOPE}'`);
  }
  db.run("CREATE INDEX IF NOT EXISTS idx_items_scope ON items(scope)");
  db.run("CREATE INDEX IF NOT EXISTS idx_items_agent ON items(agent_id)");

  db.run("INSERT OR IGNORE INTO meta (key,value) VALUES ('vault_id', ?)", [crypto.randomUUID()]);
  db.run("INSERT OR REPLACE INTO meta (key,value) VALUES ('schema_version', ?)", [String(SCHEMA_VERSION)]);
}

// ─── the handle ─────────────────────────────────────────────────────────────

/**
 * Open the vault database.
 *
 * @param {object}   [opts]
 * @param {string}   [opts.root]     vault root (default: config VAULT_ROOT)
 * @param {object}   [opts.scope]    bind this handle to an agent. Omit for owner access.
 * @param {string}   opts.scope.agentId
 * @param {string[]} [opts.scope.readScopes]   extra scopes readable (exact or "prefix*"); "shared" is always readable
 * @param {string[]} [opts.scope.writeScopes]  scopes this agent may write; defaults to shared + its own
 * @param {boolean}  [opts.scope.allowSecrets] expose the encrypted secrets table (default false)
 */
export function openVaultDb({ root = VAULT_ROOT, scope = null } = {}) {
  const dir = path.join(root, "db");
  const dbPath = path.join(dir, "index.sqlite");
  fs.mkdirSync(dir, { recursive: true });
  tighten(root, 0o700);
  tighten(dir, 0o700);

  // Temporary files from a write that crashed halfway are never needed again; a recent one may belong to a live writer.
  try {
    for (const f of fs.readdirSync(dir)) {
      if (!/^index\.sqlite\.\d+(?:\.restore)?\.tmp$/.test(f)) continue;
      const full = path.join(dir, f);
      if (Date.now() - fs.statSync(full).mtimeMs > 10 * 60_000) fs.rmSync(full, { force: true });
    }
  } catch { /* best effort */ }

  const lock = new FileLock(`${dbPath}.lock`);
  const scoped = !!scope;
  const ownScope = scoped ? `agent:${scope.agentId}` : null;
  const readScopes = scoped ? [DEFAULT_SCOPE, ownScope, ...(scope.readScopes || [])] : null;
  const writeScopes = scoped ? scope.writeScopes || [DEFAULT_SCOPE, ownScope] : null;

  let read = null; // in-memory copy used for reads (filtered when scoped)
  let sig = null;  // signature of the file `read` was built from

  // A random id rewritten on every publish. File stat alone can repeat (inode
  // numbers get reused, sizes are page-aligned), and a repeat on the WRITE path
  // would mean building on a stale copy — i.e. a lost write.
  const genPath = `${dbPath}.gen`;
  const readGen = () => {
    try { return fs.readFileSync(genPath, "utf8"); } catch { return ""; }
  };

  const signature = () => {
    try {
      const s = fs.statSync(dbPath);
      return `${readGen()}|${s.ino}:${s.size}:${s.mtimeMs}`;
    } catch {
      return null;
    }
  };

  const loadFull = () => {
    const db = fs.existsSync(dbPath) ? new SQL.Database(fs.readFileSync(dbPath)) : new SQL.Database();
    migrate(db);
    return db;
  };

  const persist = (db) => {
    const buf = Buffer.from(db.export());
    const tmp = `${dbPath}.${process.pid}.tmp`;
    const fd = fs.openSync(tmp, "w", 0o600);
    try {
      fs.writeSync(fd, buf);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    retryBusy(() => fs.renameSync(tmp, dbPath)); // a scanner or sync client may hold the file for a moment
    fs.writeFileSync(genPath, crypto.randomBytes(8).toString("hex"), { mode: 0o600 });
    tighten(dbPath, 0o600);
  };

  const scopeMatches = (s) =>
    readScopes.some((p) => (p.endsWith("*") ? s.startsWith(p.slice(0, -1)) : s === p));

  /** Remove everything this agent is not allowed to see from an in-memory copy. */
  const applyScope = (db) => {
    const visible = rows(db, "SELECT DISTINCT scope FROM items")
      .map((r) => r.scope)
      .filter(scopeMatches);
    if (visible.length === 0) {
      // NOT IN (NULL) is NULL for every row and would delete nothing — a leak.
      db.run("DELETE FROM items");
    } else {
      const marks = visible.map(() => "?").join(",");
      db.run(`DELETE FROM items WHERE scope NOT IN (${marks})`, visible);
    }
    if (!scope.allowSecrets) db.run("DELETE FROM secrets");
    return db;
  };

  const build = (full) => (scoped ? applyScope(full) : full);

  const refresh = () => {
    const now = signature();
    if (read && now === sig) return;
    if (read) read.close();
    if (!now) {
      // First run: create the file with the current schema, under the lock.
      lock.acquire();
      try {
        if (!signature()) persist(loadFull());
      } finally {
        lock.release();
      }
    }
    sig = signature();
    read = build(loadFull());
  };

  /**
   * Run `fn(db)` on the freshest full copy, then publish the result atomically.
   * When nobody else has written since we last loaded (the common, single-writer
   * case) the copy we already hold IS the freshest — skip the full re-parse.
   */
  const writeOnce = (fn) => {
    lock.acquire();
    try {
      const reuse = !scoped && read !== null && sig !== null && sig === signature();
      const fresh = reuse ? read : loadFull(); // never a stale RAM copy
      let result;
      try {
        fresh.run("BEGIN");
        result = fn(fresh);
        fresh.run("COMMIT");
      } catch (e) {
        try { fresh.run("ROLLBACK"); } catch { /* ignore */ }
        if (!reuse) fresh.close();
        throw e;
      }
      // If this process was paused so long that another writer took the lock over, our copy is out of date:
      // publishing it now would erase their write. Throw it away and start again from the file on disk.
      if (!lock.holds()) {
        if (reuse) { read.close(); read = null; sig = null; } else fresh.close();
        const lost = new Error("MemVault: the database lock was taken over during a write; retrying.");
        lost.code = "LOCK_LOST";
        throw lost;
      }
      persist(fresh);
      if (reuse) {
        sig = signature();
      } else {
        fresh.close();
        sig = null; // rebuild the read copy from what we just wrote
      }
      return result;
    } finally {
      lock.release();
    }
  };

  const write = (fn) => {
    for (let attempt = 0; ; attempt++) {
      try {
        return writeOnce(fn);
      } catch (e) {
        if (e.code !== "LOCK_LOST" || attempt >= 3) throw e;
      }
    }
  };

  refresh();

  const handle = {
    path: dbPath,
    root,
    scoped,
    agentId: scoped ? scope.agentId : null,
    readScopes,
    writeScopes,

    /** SELECT rows (objects). Sees other processes' writes. */
    query(sql, params = []) {
      refresh();
      return rows(read, sql, params);
    },

    /** Raw write — owner handles only. */
    run(sql, params = []) {
      if (scoped) throw new Error("Agent-scoped handles cannot run raw SQL; use addItem().");
      return write((db) => db.run(sql, params));
    },

    /** Several writes in one atomic, serialised step — owner handles only. */
    transaction(fn) {
      if (scoped) throw new Error("Agent-scoped handles cannot run transactions.");
      return write((db) => fn({ run: (s, p = []) => db.run(s, p), query: (s, p = []) => rows(db, s, p) }));
    },

    /** Insert one memory item, enforcing the handle's write scope. Returns the new id. */
    addItem(item) {
      return handle.addItems([item])[0];
    },

    /**
     * Insert many items in ONE locked, atomic write (one DB rewrite, not N).
     * Importers and sync engines should always use this. All-or-nothing: if any
     * item is refused, none are stored. Returns the new ids in order.
     */
    addItems(items) {
      const prepared = items.map((it) => {
        let finalScope = it.scope || DEFAULT_SCOPE;
        let finalAgent = it.agent_id || null;
        if (scoped) {
          finalAgent = scope.agentId; // identity comes from the binding, never from the caller
          if (!writeScopes.includes(finalScope)) {
            throw new Error(`Agent "${scope.agentId}" may not write to scope "${finalScope}".`);
          }
        }
        return [
          `${it.type}_${Date.now()}_${crypto.randomBytes(5).toString("hex")}`,
          it.type, it.source ?? null, it.title ?? null, it.content ?? null, it.file_path ?? null,
          it.tags ?? null, it.created_at || new Date().toISOString(), finalAgent, finalScope,
        ];
      });
      write((db) => {
        for (const row of prepared) {
          db.run(
            `INSERT INTO items (id,type,source,title,content,file_path,tags,created_at,agent_id,scope)
             VALUES (?,?,?,?,?,?,?,?,?,?)`,
            row
          );
        }
      });
      return prepared.map((r) => r[0]);
    },

    /** Re-read from disk on next access (e.g. after restoring a backup). */
    invalidate() { sig = null; },

    close() {
      if (read) read.close();
      read = null;
    },
  };

  return handle;
}

// ─── process-wide default handle ────────────────────────────────────────────

let shared = null;

/** The handle for this process: owner access unless `scope` is passed on first call. */
export function getVaultDb(opts) {
  if (!shared) shared = openVaultDb(opts);
  return shared;
}
