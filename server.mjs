// server.mjs — MemVault API & Web UI server
//
// Secure by default: binds to loopback, requires an API token for every data
// route, refuses foreign Host/Origin headers, redacts secrets on ingest, and
// records writes in a tamper-evident audit log. See SECURITY.md.
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath, pathToFileURL } from "url";
import express from "express";
import multer from "multer";
import { z } from "zod";
import { VAULT_ROOT, PORT, SECURITY_CONFIG, TOKEN_FILE, loadUserConfig, saveUserConfig, buildStorageConfig } from "./config.mjs";
import { openVaultDb } from "./db.mjs";
import { ensureToken, createGuards, createLimiter, isLoopbackHost } from "./auth.mjs";
import { encryptString, decryptString, isLegacyBlob, MIN_PASSPHRASE_LENGTH } from "./crypto-vault.mjs";
import { ingest } from "./ingest.mjs";
import { redact, redactItem } from "./redact.mjs";
import { removeMirrors, removeAllMirrors, updateMirror } from "./mirror.mjs";
import { audit, verifyAudit, tailAudit } from "./audit.mjs";
import {
  AGENT_ID_RE, listAgents, getAgent, saveAgent, deleteAgent, installStarterPack,
  draftProfileFromPrompt, buildBriefing, normalizeProfile, scopesFor, listPacks,
} from "./agents.mjs";
import { listLocalBackups, backupLocal, backupVault, enabledBackends, resolvePassphrase } from "./storage.mjs";
import { spawn } from "child_process";
import { collectDiagnostics } from "./diagnostics.mjs";
import { mcpEntry } from "./cli-tools.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKG_VERSION = JSON.parse(fs.readFileSync(path.join(__dirname, "package.json"), "utf8")).version;

const SCOPE_RE = /^(?:shared|agent:[a-z][a-z0-9-]{1,39}|project:[a-z0-9][a-z0-9._-]{0,59})$/;
const AddSchema = z.object({
  type: z.enum(["diary", "conversation", "worklog", "file"]),
  source: z.string().optional(),
  title: z.string().optional(),
  content: z.string().optional(),
  file_path: z.string().optional(),
  tags: z.string().optional(),
  created_at: z.string().optional(), // ISO
  agent_id: z.string().regex(AGENT_ID_RE).optional(),
  scope: z.string().regex(SCOPE_RE).optional(),
});

// What the owner may change on an existing memory. Scope, agent and type stay as they were.
const EditSchema = z.object({
  title: z.string().max(500).optional(),
  content: z.string().max(1_000_000).optional(),
  tags: z.string().max(1000).optional(),
  pinned: z.boolean().optional(),
}).strict();

// Capture kinds the dashboard may switch, and the config flag each one controls.
const CAPTURE = {
  git:       { flag: "gitEnabled",       sources: ["git"] },
  vscode:    { flag: "vscodeEnabled",    sources: ["vscode"] },
  files:     { flag: "filesEnabled",     sources: ["filesystem"] },
  system:    { flag: "systemEnabled",    sources: ["system"] },
  browser:   { flag: "browserEnabled",   sources: ["chrome", "edge", "brave", "chromium"] },
  clipboard: { flag: "clipboardEnabled", sources: ["clipboard"] },
};
const SettingsSchema = z.object({
  capture: z.object(Object.fromEntries(Object.keys(CAPTURE).map((k) => [k, z.boolean().optional()]))).strict().optional(),
  projects: z.array(z.object({
    name: z.string().trim().min(1).max(60),
    match: z.array(z.string().trim().min(1).max(60)).max(20).default([]),
    tags: z.string().trim().max(200).default(""),
  }).strict()).max(50).optional(),
}).strict();
const PassphraseSchema = z.object({ passphrase: z.string().min(MIN_PASSPHRASE_LENGTH).max(500), confirm: z.string() }).strict();

const ID_RE = /^[A-Za-z0-9_.-]{1,80}$/;
const PINNED_FIRST = "(CASE WHEN (',' || REPLACE(IFNULL(tags,''),' ','') || ',') LIKE '%,pinned,%' THEN 0 ELSE 1 END)";
const TRASH_MAX = 500;
const TRASH_MS = 60 * 60 * 1000;

function withPinned(tags, pinned) {
  const list = String(tags || "").split(",").map((t) => t.trim()).filter((t) => t && t !== "pinned");
  if (pinned) list.push("pinned");
  return list.join(",");
}

const SecretAddSchema = z.object({
  password: z.string().min(1),
  category: z.enum(["apikey", "password", "userid", "payment", "phone", "custom"]),
  label: z.string().min(1),
  fields: z.record(z.string(), z.string()), // Zod v4: key + value schemas required
});

const SENTINEL_ID = "__sentinel__";
const SENTINEL_VALUE = "memvault-ok";

const ITEM_COLS = "id,type,source,title,substr(content,1,300) as snippet,file_path,tags,created_at,agent_id,scope";

function isoDate() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function safeSlug(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "").slice(0, 80) || "item";
}

const escapeLike = (s) => String(s).replace(/[\\%_]/g, "\\$&");

/** SQL fragment limiting rows to what `profile` may see ("view as this agent"). */
function visibilityClause(profile) {
  const s = scopesFor(profile);
  const scopes = ["shared", `agent:${profile.id}`, ...s.readScopes];
  const parts = [];
  const params = [];
  for (const sc of scopes) {
    if (sc.endsWith("*")) {
      parts.push("scope LIKE ? ESCAPE '\\'");
      params.push(`${escapeLike(sc.slice(0, -1))}%`);
    } else {
      parts.push("scope = ?");
      params.push(sc);
    }
  }
  return { sql: `(${parts.join(" OR ")})`, params };
}

/**
 * Build the Express app. Nothing here listens or touches the network, so tests
 * can drive it on an ephemeral port.
 */
export function createApp({
  vdb = openVaultDb(),
  token = ensureToken(),
  port = PORT,
  root = VAULT_ROOT,
  security = SECURITY_CONFIG,
  // Where the dashboard reads and writes ~/.memvaultrc.json (replaceable in tests).
  config = { load: loadUserConfig, save: saveUserConfig, passphraseFile: path.join(path.dirname(TOKEN_FILE), "backup-passphrase") },
} = {}) {
  const ensureDir = (p) => fs.mkdirSync(p, { recursive: true });
  for (const d of ["entries", "conversations", "worklogs", "files"]) ensureDir(path.join(root, d));

  const app = express();
  app.disable("x-powered-by");

  const { hostAndOrigin, requireToken } = createGuards({
    port, token, allowedHosts: security.allowedHosts, allowedOrigins: security.allowedOrigins,
  });

  // 1. Every request: Host + Origin checks. No CORS headers are ever sent.
  app.use(hostAndOrigin);
  app.use((req, res, next) => {
    res.set({
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "no-referrer",
      "Cross-Origin-Resource-Policy": "same-origin",
      // Strict: no inline script or style, nothing from any other origin.
      "Content-Security-Policy":
        "default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; " +
        "connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    });
    next();
  });

  // 2. Public, data-free: the web UI shell and a minimal health probe.
  app.use(express.static(path.join(__dirname, "public")));
  app.get("/health", (_req, res) => res.json({ ok: true, name: "memvault", version: PKG_VERSION }));

  // 3. Everything below needs the API token.
  app.use(requireToken);
  app.use(express.json({ limit: "20mb" }));

  const upload = multer({ dest: path.join(root, "files"), limits: { fileSize: 200 * 1024 * 1024 } });
  const log = (action, detail, actor = "owner") => {
    if (security.audit !== false) audit({ actor, action, detail }, root);
  };

  // ── items ────────────────────────────────────────────────────────────────

  app.post("/add", (req, res) => {
    const parsed = AddSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
    try {
      const { ids, redacted } = ingest(parsed.data, { vdb, security, root, actor: parsed.data.agent_id || "api" });
      res.json({ ok: true, id: ids[0], redacted });
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message });
    }
  });

  // Many items, ONE database write. Importers and bulk clients should use this.
  app.post("/add-many", (req, res) => {
    const parsed = z.object({ items: z.array(AddSchema).min(1).max(1000) }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
    try {
      const { ids, redacted } = ingest(parsed.data.items, { vdb, security, root, actor: "api" });
      res.json({ ok: true, ids, redacted });
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message });
    }
  });

  function itemQuery(req, { search }) {
    const type = String(req.query.type || "").trim();
    const agent = String(req.query.agent || "").trim();
    const where = [];
    const params = [];
    if (search) {
      const like = `%${search}%`;
      where.push("(title LIKE ? OR content LIKE ? OR tags LIKE ?)");
      params.push(like, like, like);
    }
    if (type) { where.push("type = ?"); params.push(type); }
    if (agent) {
      const profile = getAgent(vdb, agent);
      if (!profile) return { error: `Unknown agent: ${agent}` };
      const v = visibilityClause(profile);
      where.push(v.sql);
      params.push(...v.params);
    }
    return { where: where.length ? `WHERE ${where.join(" AND ")}` : "", params };
  }

  // One aggregate query — the dashboard used to fetch three 500-row lists just to count.
  app.get("/stats", (_req, res) => {
    const byType = Object.fromEntries(vdb.query("SELECT type, COUNT(*) AS n FROM items GROUP BY type").map((r) => [r.type, r.n]));
    const byAgent = vdb.query("SELECT agent_id, COUNT(*) AS n FROM items WHERE agent_id IS NOT NULL GROUP BY agent_id");
    const total = Object.values(byType).reduce((a, b) => a + b, 0);
    const privateItems = vdb.query("SELECT COUNT(*) AS n FROM items WHERE scope != 'shared'")[0].n;
    const secrets = vdb.query("SELECT COUNT(*) AS n FROM secrets WHERE id != ?", [SENTINEL_ID])[0].n;
    const last = vdb.query("SELECT MAX(created_at) AS t FROM items")[0].t;
    res.json({ ok: true, total, byType, byAgent, privateItems, secrets, agents: listAgents(vdb).length, lastEntry: last });
  });

  app.get("/status", async (req, res) => {
    try {
      const d = await collectDiagnostics({ vdb, deep: req.query.deep === "1", checkServer: false });
      res.json({ ok: true, version: PKG_VERSION, host: security.host, port, ...d });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.get("/search", (req, res) => {
    const q = String(req.query.q || "").trim();
    if (!q) return res.json({ ok: true, results: [] });
    const f = itemQuery(req, { search: q });
    if (f.error) return res.status(404).json({ ok: false, error: f.error });
    const results = vdb.query(
      `SELECT ${ITEM_COLS} FROM items ${f.where} ORDER BY ${PINNED_FIRST}, created_at DESC LIMIT 50`, f.params
    );
    res.json({ ok: true, results });
  });

  app.get("/list", (req, res) => {
    const limit = Math.max(1, Math.min(Number(req.query.limit || 100), 500));
    const f = itemQuery(req, {});
    if (f.error) return res.status(404).json({ ok: false, error: f.error });
    const results = vdb.query(
      `SELECT ${ITEM_COLS} FROM items ${f.where} ORDER BY ${PINNED_FIRST}, created_at DESC LIMIT ${limit}`, f.params
    );
    res.json({ ok: true, results });
  });

  // ── one memory at a time: read, edit, pin, delete (with undo), export ─────

  // Deleted items wait here (this process only) so a mistake can be undone for an hour.
  // They are not written anywhere, so "delete" really removes them from the vault file.
  const trash = new Map();
  const trashPut = (row) => {
    const now = Date.now();
    for (const [k, v] of trash) if (now - v.at > TRASH_MS) trash.delete(k);
    trash.set(row.id, { row, at: now });
    while (trash.size > TRASH_MAX) trash.delete(trash.keys().next().value);
  };
  const getItem = (id) => (ID_RE.test(id) ? vdb.query("SELECT * FROM items WHERE id = ?", [id])[0] : undefined);
  const COLS = ["id", "type", "source", "title", "content", "file_path", "tags", "created_at", "agent_id", "scope"];
  const reinsert = (row) => vdb.run(`INSERT OR IGNORE INTO items (${COLS.join(",")}) VALUES (${COLS.map(() => "?").join(",")})`, COLS.map((c) => row[c] ?? null));

  app.get("/items/:id", (req, res) => {
    const item = getItem(req.params.id);
    if (!item) return res.status(404).json({ ok: false, error: "That memory was not found. It may have been deleted." });
    res.json({ ok: true, item });
  });

  app.patch("/items/:id", (req, res) => {
    const parsed = EditSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ ok: false, error: "Only the title, text, tags and pin can be changed." });
    const item = getItem(req.params.id);
    if (!item) return res.status(404).json({ ok: false, error: "That memory was not found. It may have been deleted." });
    const { pinned, ...fields } = parsed.data;
    const next = { title: item.title, content: item.content, tags: item.tags, ...fields };
    if (pinned !== undefined) next.tags = withPinned(next.tags, pinned);
    const r = security.redact === false ? { item: next, findings: [] } : redactItem(next, { disable: security.redactDisable });
    try {
      vdb.run("UPDATE items SET title = ?, content = ?, tags = ? WHERE id = ?", [r.item.title, r.item.content, r.item.tags, item.id]);
    } catch (e) {
      return res.status(500).json({ ok: false, error: e.message });
    }
    updateMirror(root, { ...item, ...r.item });
    log("edit", { id: item.id, fields: Object.keys(fields).concat(pinned === undefined ? [] : ["pinned"]), redacted: r.findings.map((f) => `${f.count}x ${f.type}`) });
    res.json({ ok: true, redacted: r.findings, item: { ...item, ...r.item } });
  });

  app.delete("/items/:id", (req, res) => {
    const item = getItem(req.params.id);
    if (!item) return res.status(404).json({ ok: false, error: "That memory was not found. It may have been deleted." });
    trashPut(item);
    vdb.run("DELETE FROM items WHERE id = ?", [item.id]);
    removeMirrors(root, [item]);
    log("delete", { id: item.id, count: 1 });
    res.json({ ok: true, undoable: true });
  });

  app.post("/items/:id/restore", (req, res) => {
    const held = trash.get(req.params.id);
    if (!held) return res.status(404).json({ ok: false, error: "Nothing to restore. Undo is only kept for an hour, and only until the dashboard server restarts." });
    reinsert(held.row);
    trash.delete(req.params.id);
    log("restore", { id: req.params.id, count: 1 });
    res.json({ ok: true });
  });

  // Several at once: needs the phrase "DELETE <n>" and takes a backup first.
  app.post("/items/delete-many", (req, res) => {
    const ids = Array.isArray(req.body?.ids) ? [...new Set(req.body.ids.map(String).filter((x) => ID_RE.test(x)))].slice(0, 5000) : [];
    if (!ids.length) return res.status(400).json({ ok: false, error: "Choose at least one memory." });
    const phrase = `DELETE ${ids.length}`;
    if (req.body.confirm !== phrase) {
      return res.status(400).json({ ok: false, error: `Refusing to delete without confirmation. Send {"confirm":"${phrase}"}.`, wouldDelete: ids.length });
    }
    const rows = ids.map(getItem).filter(Boolean);
    const backup = backupLocal();
    if (!backup.ok && rows.length) return res.status(500).json({ ok: false, error: `Backup failed, nothing deleted: ${backup.error}` });
    rows.forEach(trashPut);
    vdb.transaction((tx) => { for (const r of rows) tx.run("DELETE FROM items WHERE id = ?", [r.id]); });
    removeMirrors(root, rows);
    log("delete", { count: rows.length, backup: backup.location ? path.basename(backup.location) : null });
    res.json({ ok: true, deleted: rows.length, backup: backup.location ? path.basename(backup.location) : null });
  });

  app.post("/items/restore-many", (req, res) => {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(String) : [];
    const held = ids.map((id) => trash.get(id)).filter(Boolean);
    vdb.transaction((tx) => {
      for (const h of held) tx.run(`INSERT OR IGNORE INTO items (${COLS.join(",")}) VALUES (${COLS.map(() => "?").join(",")})`, COLS.map((c) => h.row[c] ?? null));
    });
    for (const h of held) trash.delete(h.row.id);
    log("restore", { count: held.length });
    res.json({ ok: true, restored: held.length });
  });

  // Everything you wrote, as one JSON file you own. The Secure Vault's encrypted items are not included.
  app.get("/export", (_req, res) => {
    const items = vdb.query("SELECT * FROM items ORDER BY created_at");
    log("export", { count: items.length });
    res.set("Content-Disposition", `attachment; filename="memvault-export-${isoDate()}.json"`);
    res.json({ memvault: PKG_VERSION, exportedAt: new Date().toISOString(), count: items.length, items });
  });

  app.post("/upload", upload.single("file"), (req, res) => {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });
    const original = req.file.originalname || "file";
    const dayDir = path.join(root, "files", isoDate());
    ensureDir(dayDir);
    // The stored copy is named from the MASKED name, so a secret in a file name never reaches the disk path.
    const name = security.redact === false ? original : redact(original, { disable: security.redactDisable }).text;
    const ext = path.extname(name).toLowerCase().replace(/[^a-z0-9.]/g, "").slice(0, 12);
    const target = path.join(dayDir, `${Date.now()}_${safeSlug(path.basename(name, path.extname(name)))}${ext}`);
    fs.renameSync(req.file.path, target);
    try {
      // The same door as every other write: mask, one atomic write, audit.
      const { ids } = ingest({ type: "file", source: "manual", title: original, file_path: target }, { vdb, security, root, actor: "owner" });
      res.json({ ok: true, path: target, id: ids[0] });
    } catch (e) {
      fs.rmSync(target, { force: true });
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  /**
   * Delete items. Always needs an explicit confirmation phrase and always takes
   * a local backup first, so a mistake or a buggy script is recoverable.
   *   { confirm:"DELETE",     source?, tagPrefix? }   → only matching items
   *   { confirm:"DELETE ALL" }                         → everything
   */
  app.post("/clear", (req, res) => {
    const { confirm, source, tagPrefix } = req.body || {};
    const scoped = Boolean(source || tagPrefix);
    const phrase = scoped ? "DELETE" : "DELETE ALL";
    if (confirm !== phrase) {
      return res.status(400).json({
        ok: false,
        error: `Refusing to delete without confirmation. Send {"confirm":"${phrase}"}.`,
        wouldDelete: scoped ? "matching items only" : "EVERY item in the vault",
      });
    }
    try {
      const where = [];
      const params = [];
      if (source) { where.push("source = ?"); params.push(String(source)); }
      if (tagPrefix) {
        where.push("(',' || REPLACE(IFNULL(tags,''),' ','') ) LIKE ? ESCAPE '\\'");
        params.push(`%,${escapeLike(String(tagPrefix))}%`);
      }
      const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
      const n = vdb.query(`SELECT COUNT(*) AS n FROM items ${clause}`, params)[0].n;
      const backup = backupLocal();
      if (!backup.ok && n > 0) {
        return res.status(500).json({ ok: false, error: `Backup failed, nothing deleted: ${backup.error}` });
      }
      const doomed = scoped ? vdb.query(`SELECT id, title, created_at FROM items ${clause}`, params) : null;
      vdb.run(`DELETE FROM items ${clause}`, params);
      if (scoped) removeMirrors(root, doomed); else removeAllMirrors(root); // the readable copies go too
      log("clear", { scoped, source, tagPrefix, deleted: n, backup: backup.location ? path.basename(backup.location) : null });
      res.json({ ok: true, deleted: n, backup: backup.location ? path.basename(backup.location) : null });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── encrypted secrets ────────────────────────────────────────────────────
  // AES-256-GCM, key from a master password via scrypt with a random per-secret
  // salt. Old (v1, static-salt) secrets still open and are upgraded on first use.

  const limiter = createLimiter({ max: 5, windowMs: 60_000, lockMs: 60_000 });

  const sentinelRow = () => vdb.query("SELECT encrypted FROM secrets WHERE id = ?", [SENTINEL_ID])[0] || null;
  const hasSentinel = () => !!sentinelRow();

  const createSentinel = (password) => {
    const now = new Date().toISOString();
    vdb.run(
      "INSERT OR REPLACE INTO secrets (id,category,label,encrypted,created_at,updated_at) VALUES (?,?,?,?,?,?)",
      [SENTINEL_ID, "system", "__sentinel__", encryptString(SENTINEL_VALUE, password, SENTINEL_ID), now, now]
    );
  };

  const firstSecret = () => vdb.query("SELECT id, encrypted FROM secrets WHERE id != ? LIMIT 1", [SENTINEL_ID])[0] || null;

  /** true / false. A brand-new vault (no sentinel, no secrets) accepts the first password and sets it. */
  const verifyPassword = (password) => {
    const row = sentinelRow();
    if (!row) {
      // Secrets exist but there is no check row (a vault from an older version): prove the password on a real secret.
      const s = firstSecret();
      if (!s) return true;
      try {
        decryptString(s.encrypted, password, s.id);
        createSentinel(password);
        return true;
      } catch {
        return false;
      }
    }
    try {
      const ok = decryptString(row.encrypted, password, SENTINEL_ID) === SENTINEL_VALUE;
      if (ok && isLegacyBlob(row.encrypted)) createSentinel(password); // upgrade to v2
      return ok;
    } catch {
      return false;
    }
  };

  /** Shared gate for every secrets route: lockout → policy → password. Returns true if the caller may proceed. */
  function gate(req, res, { password, creating = false }) {
    const lock = limiter.check("secrets");
    if (!lock.allowed) {
      res.set("Retry-After", String(lock.retryAfterSec));
      res.status(429).json({ ok: false, error: `Too many wrong passwords. Try again in ${lock.retryAfterSec}s.` });
      return false;
    }
    if (!hasSentinel() && !firstSecret()) {
      if (creating && String(password).length < MIN_PASSPHRASE_LENGTH) {
        res.status(400).json({ ok: false, error: `Choose a master password of at least ${MIN_PASSPHRASE_LENGTH} characters.` });
        return false;
      }
      return true;
    }
    if (!verifyPassword(password)) {
      limiter.fail("secrets");
      log("secrets-denied", {});
      res.status(401).json({ ok: false, error: "Wrong password" });
      return false;
    }
    limiter.success("secrets");
    return true;
  }

  app.post("/secrets/verify", (req, res) => {
    const { password } = req.body || {};
    if (!password) return res.status(400).json({ ok: false, error: "password required" });
    const first = !hasSentinel() && !firstSecret();
    if (!gate(req, res, { password, creating: true })) return;
    if (first) createSentinel(password);
    res.json({ ok: true });
  });

  app.post("/secrets/add", (req, res) => {
    const parsed = SecretAddSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
    const { password, category, label, fields } = parsed.data;
    if (!gate(req, res, { password, creating: true })) return;
    if (!hasSentinel()) createSentinel(password); // reached only for a brand-new vault, or after the password was proven above

    const id = `secret_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
    const now = new Date().toISOString();
    vdb.run(
      "INSERT INTO secrets (id,category,label,encrypted,created_at,updated_at) VALUES (?,?,?,?,?,?)",
      [id, category, label, encryptString(JSON.stringify(fields), password, id), now, now]
    );
    log("secret-add", { id, category });
    res.json({ ok: true, id });
  });

  app.post("/secrets/get", (req, res) => {
    const { password, id } = req.body || {};
    if (!password || !id) return res.status(400).json({ error: "password and id required" });
    if (!gate(req, res, { password })) return;

    const row = vdb.query("SELECT * FROM secrets WHERE id = ? AND id != ?", [id, SENTINEL_ID])[0];
    if (!row) return res.status(404).json({ error: "Not found" });
    try {
      const fields = JSON.parse(decryptString(row.encrypted, password, row.id));
      if (isLegacyBlob(row.encrypted)) {
        vdb.run("UPDATE secrets SET encrypted = ?, updated_at = ? WHERE id = ?",
          [encryptString(JSON.stringify(fields), password, row.id), new Date().toISOString(), row.id]);
      }
      log("secret-get", { id: row.id, category: row.category });
      res.json({ ok: true, id: row.id, category: row.category, label: row.label, fields, created_at: row.created_at });
    } catch {
      res.status(401).json({ ok: false, error: "Decryption failed — wrong password?" });
    }
  });

  // Labels and categories only — nothing is decrypted.
  app.get("/secrets/list", (req, res) => {
    const cat = String(req.query.category || "").trim();
    const rows = vdb.query(
      `SELECT id, category, label, created_at, updated_at FROM secrets
       WHERE id != ? ${cat ? "AND category = ?" : ""} ORDER BY category, label`,
      cat ? [SENTINEL_ID, cat] : [SENTINEL_ID]
    );
    res.json({ ok: true, count: rows.length, secrets: rows });
  });

  app.delete("/secrets/delete/:id", (req, res) => {
    const { password } = req.body || {};
    if (!password) return res.status(400).json({ error: "password required" });
    if (!gate(req, res, { password })) return;
    vdb.run("DELETE FROM secrets WHERE id = ? AND id != ?", [req.params.id, SENTINEL_ID]);
    log("secret-delete", { id: req.params.id });
    res.json({ ok: true });
  });

  // ── agents ───────────────────────────────────────────────────────────────

  app.get("/agents", (_req, res) => res.json({ ok: true, agents: listAgents(vdb) }));

  app.get("/agents/packs", (_req, res) => res.json({ ok: true, packs: listPacks() }));

  app.post("/agents/starter", (req, res) => {
    try {
      const result = installStarterPack(vdb, { pack: String(req.body?.pack || "general"), overwrite: req.body?.overwrite === true });
      log("agent-starter", { pack: req.body?.pack || "general", installed: result.installed });
      res.json({ ok: true, ...result });
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message });
    }
  });

  // Draft only — nothing is saved until the owner reviews it and PUTs it.
  app.post("/agents/draft", (req, res) => {
    const { prompt, name, id } = req.body || {};
    if (!prompt || typeof prompt !== "string") return res.status(400).json({ ok: false, error: "prompt (text) required" });
    try {
      res.json({ ok: true, ...draftProfileFromPrompt(prompt.slice(0, 20000), { name, id }) });
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message });
    }
  });

  app.post("/agents/import", (req, res) => {
    try {
      const profile = saveAgent(vdb, req.body);
      log("agent-save", { id: profile.id });
      res.json({ ok: true, agent: profile });
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message });
    }
  });

  app.get("/agents/:id", (req, res) => {
    const agent = getAgent(vdb, req.params.id);
    if (!agent) return res.status(404).json({ ok: false, error: "Not found" });
    res.json({ ok: true, agent });
  });

  app.put("/agents/:id", (req, res) => {
    try {
      const profile = saveAgent(vdb, { ...req.body, id: req.params.id });
      log("agent-save", { id: profile.id });
      res.json({ ok: true, agent: profile });
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message });
    }
  });

  app.delete("/agents/:id", (req, res) => {
    const purge = req.query.purge === "1" || req.query.purge === "true";
    if (!getAgent(vdb, req.params.id)) return res.status(404).json({ ok: false, error: "Not found" });
    const backup = purge ? backupLocal() : null; // purge deletes private memories — keep a way back
    deleteAgent(vdb, req.params.id, { purge });
    log("agent-delete", { id: req.params.id, purge });
    res.json({ ok: true, backup: backup?.location ? path.basename(backup.location) : null });
  });

  // Ready-to-paste MCP client config for the owner (full access). Per-agent versions: /agents/:id/mcp-config
  app.get("/mcp-config", (_req, res) => {
    res.json({ ok: true, config: { mcpServers: { memvault: mcpEntry({ vaultRoot: root }) } } });
  });

  // Ready-to-paste MCP client config that binds a client to this agent.
  app.get("/agents/:id/mcp-config", (req, res) => {
    if (!getAgent(vdb, req.params.id)) return res.status(404).json({ ok: false, error: "Not found" });
    res.json({ ok: true, config: { mcpServers: { [`memvault-${req.params.id}`]: mcpEntry({ agent: req.params.id, vaultRoot: root }) } } });
  });

  // The activation text, built from exactly what this agent is allowed to see.
  app.get("/agents/:id/brief", (req, res) => {
    const profile = getAgent(vdb, req.params.id);
    if (!profile) return res.status(404).json({ ok: false, error: "Not found" });
    const scoped = openVaultDb({ root, scope: scopesFor(profile) });
    try {
      res.json({ ok: true, briefing: buildBriefing(scoped, profile, { task: String(req.query.task || "") }) });
    } finally {
      scoped.close();
    }
  });

  // ── settings (what used to need the terminal or a JSON file) ──────────────

  // Lets the dashboard check a typed key without reading any data.
  app.get("/whoami", (_req, res) => res.json({ ok: true }));

  const passphraseState = (uc) => {
    if (process.env.MEMVAULT_BACKUP_PASSPHRASE) return { set: true, via: "env" };
    const f = uc.storage?.passphraseFile;
    if (f) { try { if (fs.readFileSync(f, "utf8").split(/\r?\n/)[0].trim()) return { set: true, via: "file" }; } catch { /* missing file */ } }
    return { set: false, via: null };
  };

  app.get("/settings", (_req, res) => {
    const uc = config.load();
    const st = buildStorageConfig(uc);
    const seen = Object.fromEntries(vdb.query("SELECT source, COUNT(*) AS n, MAX(created_at) AS last FROM items GROUP BY source").map((r) => [r.source, r]));
    const capture = Object.fromEntries(Object.entries(CAPTURE).map(([k, c]) => {
      const rows = c.sources.map((x) => seen[x]).filter(Boolean);
      return [k, { on: uc.sync?.[c.flag] === true, saved: rows.reduce((a, r) => a + r.n, 0), last: rows.map((r) => r.last).sort().pop() || null }];
    }));
    res.json({
      ok: true,
      capture,
      projects: Array.isArray(uc.projects) ? uc.projects : [],
      backup: {
        passphrase: passphraseState(uc),
        cloud: { folder: !!st.gdriveFolder.enabled, api: !!st.gdriveApi.enabled },
        keep: st.keepLocalBackups,
      },
    });
  });

  app.put("/settings", (req, res) => {
    const parsed = SettingsSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ ok: false, error: "Those settings are not allowed. Only automatic saving and projects can be changed here." });
    const uc = config.load();
    const changed = [];
    if (parsed.data.capture) {
      uc.sync = { ...(uc.sync || {}) };
      for (const [k, on] of Object.entries(parsed.data.capture)) {
        if (on === undefined) continue;
        uc.sync[CAPTURE[k].flag] = on;
        changed.push(`${k}:${on ? "on" : "off"}`);
      }
    }
    if (parsed.data.projects) { uc.projects = parsed.data.projects; changed.push("projects"); }
    config.save(uc);
    log("settings", { changed });
    res.json({ ok: true, note: "Saved. Projects apply to new notes the next time MemVault restarts." });
  });

  // The passphrase goes to a private file OUTSIDE the vault (so backups never contain it); it is never returned or logged.
  app.put("/settings/passphrase", (req, res) => {
    const parsed = PassphraseSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ ok: false, error: `Use at least ${MIN_PASSPHRASE_LENGTH} characters.` });
    if (parsed.data.passphrase !== parsed.data.confirm) return res.status(400).json({ ok: false, error: "The two passphrases are not the same." });
    const file = config.passphraseFile;
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, parsed.data.passphrase + "\n", { mode: 0o600 });
    try { fs.chmodSync(file, 0o600); } catch { /* not POSIX */ }
    const uc = config.load();
    uc.storage = { ...(uc.storage || {}), passphraseFile: file };
    config.save(uc);
    log("settings", { changed: ["backup-passphrase"] });
    res.json({ ok: true });
  });

  // One round of every switched-on capture engine (the clipboard watcher runs separately, by design).
  app.post("/sync/run", async (_req, res) => {
    const uc = config.load();
    const ran = Object.entries(CAPTURE).filter(([k, c]) => k !== "clipboard" && uc.sync?.[c.flag] === true).map(([k]) => k);
    if (!ran.length) return res.json({ ok: true, ran: [], note: "Nothing is switched on yet." });
    const code = await new Promise((resolve) => {
      const cp = spawn(process.execPath, [path.join(__dirname, "sync-all.mjs")], { stdio: "ignore", env: process.env });
      const timer = setTimeout(() => { cp.kill(); resolve("timeout"); }, 120_000);
      cp.on("exit", (c) => { clearTimeout(timer); resolve(c); });
      cp.on("error", () => { clearTimeout(timer); resolve("error"); });
    });
    log("sync", { ran, exit: String(code) });
    res.json({ ok: code === 0, ran, note: code === 0 ? "Done." : "It did not finish. Run `memvault sync` in a terminal to see why." });
  });

  // ── audit ────────────────────────────────────────────────────────────────

  app.get("/audit", (req, res) => {
    const n = Math.max(1, Math.min(Number(req.query.limit || 50), 500));
    res.json({ ok: true, chain: verifyAudit(root), recent: tailAudit(n, { actor: req.query.actor || undefined }, root) });
  });

  // ── storage / backup (local + Google Drive) ──────────────────────────────

  app.post("/backup", async (_req, res) => {
    try {
      const fresh = buildStorageConfig(config.load()); // so a passphrase set a minute ago already counts
      const results = await backupVault(fresh);
      log("backup", { backends: enabledBackends(fresh), ok: results.every((r) => r.ok) });
      res.json({ ok: true, backends: enabledBackends(fresh), results });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.get("/backups", (_req, res) => {
    try {
      res.json({ ok: true, backups: listLocalBackups() });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // ── MCP bridges (connections to other AI MCP servers) ────────────────────

  app.get("/bridges", async (_req, res) => {
    try {
      const { enabledBridges } = await import("./mcp-bridge.mjs");
      res.json({
        ok: true,
        bridges: enabledBridges().map((b) => ({
          name: b.name,
          command: `${b.command} ${(b.args || []).join(" ")}`.trim(),
          importTool: b.importTool || null,
        })),
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.post("/bridges/sync", async (req, res) => {
    try {
      const { enabledBridges, syncBridge } = await import("./mcp-bridge.mjs");
      const { name } = req.body || {};
      const targets = name ? enabledBridges().filter((b) => b.name === name) : enabledBridges();
      const results = [];
      for (const b of targets) {
        try { results.push(await syncBridge(b)); }
        catch (e) { results.push({ name: b.name, ingested: 0, errors: [e.message] }); }
      }
      log("bridge-sync", { bridges: targets.map((b) => b.name) });
      res.json({ ok: true, results });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // JSON body errors etc. → clean JSON, never a stack trace.
  app.use((err, _req, res, _next) => {
    const status = err.status && err.status >= 400 && err.status < 600 ? err.status : 500;
    res.status(status).json({ ok: false, error: status === 500 ? "Internal error" : err.message });
  });

  return app;
}

/** Start listening. Refuses a non-loopback bind unless explicitly allowed. */
export function start({ app = createApp(), port = PORT, host = SECURITY_CONFIG.host } = {}) {
  if (!isLoopbackHost(host) && SECURITY_CONFIG.allowRemote !== true) {
    console.error(
      `\n❌ Refusing to listen on "${host}": that exposes your vault beyond this machine.\n` +
        `   MemVault binds to 127.0.0.1 by default. If you really need it (e.g. WSL2 port-proxy),\n` +
        `   set "security": { "host": "${host}", "allowRemote": true } in ~/.memvaultrc.json.\n` +
        `   The API token, Host and Origin checks stay active either way.\n`
    );
    process.exit(1);
  }
  return app.listen(port, host, (err) => {
    // Express 5 hands listen errors to this callback; ignoring them would print "running" for a server that never started.
    if (err) {
      console.error(
        err.code === "EADDRINUSE"
          ? `\n❌ Port ${port} is already in use — is MemVault already running? (open it with \`memvault open\`, or set a different "port" in ~/.memvaultrc.json)\n`
          : `\n❌ Could not start the server: ${err.message}\n`
      );
      process.exit(1);
      return;
    }
    console.log(`MemVault ${PKG_VERSION} — API & dashboard on http://${host}:${port}`);
    console.log(`VAULT_ROOT=${VAULT_ROOT}`);
    console.log(`Run \`memvault open\` to open the dashboard (it passes your API token for you).`);
    if (!isLoopbackHost(host)) console.warn(`⚠️  Listening on ${host} (allowRemote). Keep your API token private.`);
  });
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) start();
