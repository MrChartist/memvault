// /mnt/d/AG/Vault/apps/vault/server.mjs
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
import express from "express";
import multer from "multer";
import { z } from "zod";
import initSqlJs from "sql.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const VAULT_ROOT = process.env.VAULT_ROOT || "/mnt/d/AG/Vault";
const DB_PATH = path.join(VAULT_ROOT, "db", "index.sqlite");
const PORT = Number(process.env.VAULT_PORT || 7799);

const ensureDir = (p) => fs.mkdirSync(p, { recursive: true });

ensureDir(path.join(VAULT_ROOT, "db"));
ensureDir(path.join(VAULT_ROOT, "entries"));
ensureDir(path.join(VAULT_ROOT, "conversations"));
ensureDir(path.join(VAULT_ROOT, "worklogs"));
ensureDir(path.join(VAULT_ROOT, "files"));

const app = express();
app.use(express.json({ limit: "20mb" }));

// CORS — allow browser requests from any local origin
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.header("Access-Control-Allow-Headers", "content-type");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

// Serve the diary web UI
app.use(express.static(path.join(__dirname, "public")));

const upload = multer({
  dest: path.join(VAULT_ROOT, "files"),
  limits: { fileSize: 200 * 1024 * 1024 }, // 200MB
});

function isoDate() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function safeSlug(s) {
  return String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 80) || "item";
}

const Sql = await initSqlJs();
let db;

function loadDb() {
  if (fs.existsSync(DB_PATH)) {
    const filebuf = fs.readFileSync(DB_PATH);
    db = new Sql.Database(filebuf);
  } else {
    db = new Sql.Database();
  }

  db.run(`
    CREATE TABLE IF NOT EXISTS items (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,              -- diary | conversation | worklog | file
      source TEXT,                     -- chatgpt | openclaw | antigravity | manual
      title TEXT,
      content TEXT,
      file_path TEXT,
      tags TEXT,                       -- comma-separated
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_items_type ON items(type);
    CREATE INDEX IF NOT EXISTS idx_items_created ON items(created_at);
  `);

  // Encrypted secrets table — ciphertext never stored in plaintext
  db.run(`
    CREATE TABLE IF NOT EXISTS secrets (
      id TEXT PRIMARY KEY,
      category TEXT NOT NULL,   -- apikey | password | userid | payment | phone | custom
      label TEXT NOT NULL,      -- plaintext label only (e.g. "OpenAI Key")
      encrypted TEXT NOT NULL,  -- JSON: { iv, authTag, ciphertext } — all base64
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_secrets_category ON secrets(category);
  `);

  persistDb();
}

function persistDb() {
  const data = db.export();
  fs.writeFileSync(DB_PATH, Buffer.from(data));
}

loadDb();

const AddSchema = z.object({
  type: z.enum(["diary", "conversation", "worklog", "file"]),
  source: z.string().optional(),
  title: z.string().optional(),
  content: z.string().optional(),
  file_path: z.string().optional(),
  tags: z.string().optional(),
  created_at: z.string().optional(), // ISO
});

app.post("/add", (req, res) => {
  const parsed = AddSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const { type, source, title, content, file_path, tags } = parsed.data;
  const created_at = parsed.data.created_at || new Date().toISOString();
  const id = `${type}_${Date.now()}_${Math.random().toString(16).slice(2)}`;

  db.run(
    `INSERT INTO items (id,type,source,title,content,file_path,tags,created_at)
     VALUES (?,?,?,?,?,?,?,?)`,
    [id, type, source || null, title || null, content || null, file_path || null, tags || null, created_at]
  );
  persistDb();
  res.json({ ok: true, id });
});

app.get("/search", (req, res) => {
  const q = String(req.query.q || "").trim();
  const type = String(req.query.type || "").trim();

  if (!q) return res.json({ ok: true, results: [] });

  const like = `%${q}%`;
  const where = type ? `AND type = ?` : "";
  const stmt = db.prepare(
    `SELECT id,type,source,title,substr(content,1,300) as snippet,file_path,tags,created_at
     FROM items
     WHERE (title LIKE ? OR content LIKE ? OR tags LIKE ?)
     ${where}
     ORDER BY created_at DESC
     LIMIT 50;`
  );

  const rows = [];
  const params = type ? [like, like, like, type] : [like, like, like];
  stmt.bind(params);
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();

  res.json({ ok: true, results: rows });
});

app.post("/upload", upload.single("file"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });

  const original = req.file.originalname || "file";
  const dayDir = path.join(VAULT_ROOT, "files", isoDate());
  ensureDir(dayDir);

  const target = path.join(dayDir, `${Date.now()}_${safeSlug(original)}${path.extname(original)}`);
  fs.renameSync(req.file.path, target);

  const id = `file_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  db.run(
    `INSERT INTO items (id,type,source,title,content,file_path,tags,created_at)
     VALUES (?,?,?,?,?,?,?,?)`,
    [id, "file", "manual", original, null, target, null, new Date().toISOString()]
  );
  persistDb();

  res.json({ ok: true, path: target, id });
});

app.get("/health", (req, res) => res.json({ ok: true, vault: VAULT_ROOT, db: DB_PATH }));

// Clear ALL items — used by auto-sync to wipe test/old data
app.post("/clear", (req, res) => {
  try {
    db.run("DELETE FROM items");
    persistDb();
    res.json({ ok: true, message: "All items cleared." });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// List all items (no search filter) — for UI browsing
app.get("/list", (req, res) => {
  const type = String(req.query.type || "").trim();
  const limit = Math.min(Number(req.query.limit || 100), 500);
  const where = type ? `WHERE type = ?` : "";
  const params = type ? [type] : [];
  const stmt = db.prepare(
    `SELECT id,type,source,title,substr(content,1,300) as snippet,file_path,tags,created_at
     FROM items ${where}
     ORDER BY created_at DESC
     LIMIT ${limit};`
  );
  const rows = [];
  if (params.length) stmt.bind(params);
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  res.json({ ok: true, results: rows });
});

// ═══════════════════════════════════════════════════════
//  ENCRYPTED SECRETS
//  AES-256-GCM with PBKDF2 key derivation from master password
// ═══════════════════════════════════════════════════════

const CRYPTO_ITERATIONS = 100_000;
const CRYPTO_KEYLEN = 32;  // 256 bits
const CRYPTO_DIGEST = "sha256";
const CRYPTO_SALT = "memvault-salt-v1"; // static salt is fine (key is per-user password)

/** Derive a 256-bit key from the master password */
function deriveKey(password) {
  return crypto.pbkdf2Sync(password, CRYPTO_SALT, CRYPTO_ITERATIONS, CRYPTO_KEYLEN, CRYPTO_DIGEST);
}

/** Encrypt a plaintext value → base64 JSON blob */
function encrypt(plaintext, password) {
  const key = deriveKey(password);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return JSON.stringify({
    iv: iv.toString("base64"),
    authTag: tag.toString("base64"),
    ciphertext: ct.toString("base64"),
  });
}

/** Decrypt a base64 JSON blob → plaintext (throws on wrong password) */
function decrypt(blob, password) {
  const { iv, authTag, ciphertext } = JSON.parse(blob);
  const key = deriveKey(password);
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(iv, "base64")
  );
  decipher.setAuthTag(Buffer.from(authTag, "base64"));
  const pt = Buffer.concat([
    decipher.update(Buffer.from(ciphertext, "base64")),
    decipher.final(),
  ]);
  return pt.toString("utf8");
}

// A known sentinel value stored encrypted on first use to verify password
const SENTINEL_ID = "__sentinel__";
const SENTINEL_VALUE = "memvault-ok";

/** Return true if any sentinel exists in secrets table */
function hasSentinel() {
  const stmt = db.prepare("SELECT id FROM secrets WHERE id = ?");
  stmt.bind([SENTINEL_ID]);
  const found = stmt.step();
  stmt.free();
  return found;
}

/** Create sentinel (first time a password is used) */
function createSentinel(password) {
  const now = new Date().toISOString();
  db.run(
    "INSERT OR REPLACE INTO secrets (id,category,label,encrypted,created_at,updated_at) VALUES (?,?,?,?,?,?)",
    [SENTINEL_ID, "system", "__sentinel__", encrypt(SENTINEL_VALUE, password), now, now]
  );
  persistDb();
}

/** Verify master password against sentinel */
function verifyPassword(password) {
  if (!hasSentinel()) return true; // first use — any password is accepted
  const stmt = db.prepare("SELECT encrypted FROM secrets WHERE id = ?");
  stmt.bind([SENTINEL_ID]);
  if (!stmt.step()) { stmt.free(); return false; }
  const { encrypted } = stmt.getAsObject();
  stmt.free();
  try {
    return decrypt(encrypted, password) === SENTINEL_VALUE;
  } catch {
    return false;
  }
}

const SecretAddSchema = z.object({
  password: z.string().min(1),
  category: z.enum(["apikey", "password", "userid", "payment", "phone", "custom"]),
  label: z.string().min(1),
  fields: z.record(z.string(), z.string()), // Zod v4: key + value schemas required
});

// POST /secrets/verify — check master password
app.post("/secrets/verify", (req, res) => {
  const { password } = req.body || {};
  if (!password) return res.status(400).json({ ok: false, error: "password required" });
  const ok = verifyPassword(password);
  if (ok && !hasSentinel()) createSentinel(password); // first use — set password
  res.json({ ok });
});

// POST /secrets/add — add an encrypted secret
app.post("/secrets/add", (req, res) => {
  const parsed = SecretAddSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const { password, category, label, fields } = parsed.data;
  if (!verifyPassword(password)) return res.status(401).json({ ok: false, error: "Wrong password" });
  if (!hasSentinel()) createSentinel(password);

  const id = `secret_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
  const now = new Date().toISOString();
  const encrypted = encrypt(JSON.stringify(fields), password);

  db.run(
    "INSERT INTO secrets (id,category,label,encrypted,created_at,updated_at) VALUES (?,?,?,?,?,?)",
    [id, category, label, encrypted, now, now]
  );
  persistDb();
  res.json({ ok: true, id });
});

// POST /secrets/get — decrypt and return a secret
app.post("/secrets/get", (req, res) => {
  const { password, id } = req.body || {};
  if (!password || !id) return res.status(400).json({ error: "password and id required" });
  if (!verifyPassword(password)) return res.status(401).json({ ok: false, error: "Wrong password" });

  const stmt = db.prepare("SELECT * FROM secrets WHERE id = ? AND id != ?");
  stmt.bind([id, SENTINEL_ID]);
  if (!stmt.step()) { stmt.free(); return res.status(404).json({ error: "Not found" }); }
  const row = stmt.getAsObject();
  stmt.free();

  try {
    const fields = JSON.parse(decrypt(row.encrypted, password));
    res.json({ ok: true, id: row.id, category: row.category, label: row.label, fields, created_at: row.created_at });
  } catch {
    res.status(401).json({ ok: false, error: "Decryption failed — wrong password?" });
  }
});

// GET /secrets/list — list labels/categories only (no decryption)
app.get("/secrets/list", (req, res) => {
  const cat = String(req.query.category || "").trim();
  const where = cat ? "WHERE category = ? AND id != ?" : "WHERE id != ?";
  const params = cat ? [cat, SENTINEL_ID] : [SENTINEL_ID];
  const stmt = db.prepare(
    `SELECT id, category, label, created_at, updated_at FROM secrets ${where} ORDER BY category, label`
  );
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  res.json({ ok: true, count: rows.length, secrets: rows });
});

// DELETE /secrets/delete — remove a secret
app.delete("/secrets/delete/:id", (req, res) => {
  const { password } = req.body || {};
  if (!password) return res.status(400).json({ error: "password required" });
  if (!verifyPassword(password)) return res.status(401).json({ ok: false, error: "Wrong password" });

  db.run("DELETE FROM secrets WHERE id = ? AND id != ?", [req.params.id, SENTINEL_ID]);
  persistDb();
  res.json({ ok: true });
});

// ═══════════════════════════════════════════════════════

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Vault API running on http://0.0.0.0:${PORT} (WSL2: also try http://127.0.0.1:${PORT} from Windows)`);
  console.log(`VAULT_ROOT=${VAULT_ROOT}`);
});



