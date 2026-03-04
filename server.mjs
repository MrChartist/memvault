// /mnt/d/AG/Vault/apps/vault/server.mjs
import fs from "fs";
import path from "path";
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

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Vault API running on http://0.0.0.0:${PORT} (WSL2: also try http://127.0.0.1:${PORT} from Windows)`);
  console.log(`VAULT_ROOT=${VAULT_ROOT}`);
});

