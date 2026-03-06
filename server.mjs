import fs from "fs";
import path from "path";
import crypto from "crypto";
import { exec } from "child_process";
import { fileURLToPath } from "url";
import express from "express";
import multer from "multer";
import { z } from "zod";
import { DatabaseSync } from "node:sqlite";
import os from "os";
import TelegramBot from "node-telegram-bot-api";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const VAULT_ROOT = process.env.VAULT_ROOT || path.join(os.homedir(), ".memvault");
const DB_PATH = path.join(VAULT_ROOT, "db", "index.sqlite");
const PORT = Number(process.env.VAULT_PORT || 7800);
const OLLAMA_URL = process.env.OLLAMA_URL || "http://localhost:11434";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "qwen3.5:9b"; // adjust as per user's preference

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
  res.header("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
  res.header("Access-Control-Allow-Headers", "content-type,authorization");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// API Routes take precedence
app.use((req, res, next) => {
  next();
});

// API for static documentation
app.get("/api/docs", (req, res) => {
  const docsDir = path.join(__dirname, "docs");
  if (!fs.existsSync(docsDir)) return res.json({ ok: true, docs: [] });
  try {
    const files = fs.readdirSync(docsDir).filter(f => f.endsWith(".md"));
    const docs = files.map(f => {
      const content = fs.readFileSync(path.join(docsDir, f), "utf-8");
      const firstLine = content.split('\n')[0];
      const title = firstLine.startsWith('# ') ? firstLine.replace('# ', '').trim() : f.replace('.md', '');
      return { file: f, title };
    });
    res.json({ ok: true, docs });
  } catch (e) {
    res.status(500).json({ error: "Failed to read documents." });
  }
});

app.get("/api/docs/:name", (req, res) => {
  const docsDir = path.join(__dirname, "docs");
  const filePath = path.normalize(path.join(docsDir, req.params.name));

  if (!fs.existsSync(filePath) || !filePath.startsWith(path.normalize(docsDir))) {
    return res.status(404).json({ error: "Document not found." });
  }
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    res.json({ ok: true, content });
  } catch (e) {
    res.status(500).json({ error: "Failed to read document content." });
  }
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

const db = new DatabaseSync(DB_PATH);

function initDb() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects_meta (
      id TEXT PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      color TEXT,
      icon TEXT,
      description TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS items (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      project TEXT,
      source TEXT,
      title TEXT,
      content TEXT,
      file_path TEXT,
      tags TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_items_type ON items(type);
    CREATE INDEX IF NOT EXISTS idx_items_project ON items(project);
    CREATE INDEX IF NOT EXISTS idx_items_created ON items(created_at);

    CREATE VIRTUAL TABLE IF NOT EXISTS items_fts USING fts5(
      title, content, tags, project, content='items', content_rowid='rowid'
    );

    CREATE TRIGGER IF NOT EXISTS items_ai AFTER INSERT ON items BEGIN
      INSERT INTO items_fts(rowid, title, content, tags, project) VALUES (new.rowid, new.title, new.content, new.tags, new.project);
    END;
    CREATE TRIGGER IF NOT EXISTS items_ad AFTER DELETE ON items BEGIN
      INSERT INTO items_fts(items_fts, rowid, title, content, tags, project) VALUES('delete', old.rowid, old.title, old.content, old.tags, old.project);
    END;
    CREATE TRIGGER IF NOT EXISTS items_au AFTER UPDATE ON items BEGIN
      INSERT INTO items_fts(items_fts, rowid, title, content, tags, project) VALUES('delete', old.rowid, old.title, old.content, old.tags, old.project);
      INSERT INTO items_fts(rowid, title, content, tags, project) VALUES (new.rowid, new.title, new.content, new.tags, new.project);
    END;

    CREATE TABLE IF NOT EXISTS secrets (
      id TEXT PRIMARY KEY,
      category TEXT NOT NULL,
      label TEXT NOT NULL,
      encrypted TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_secrets_category ON secrets(category);
  `);

  const ftsCount = db.prepare("SELECT count(*) as c FROM items_fts").get().c;
  const itemsCount = db.prepare("SELECT count(*) as c FROM items").get().c;
  if (ftsCount === 0 && itemsCount > 0) {
    db.exec(`INSERT INTO items_fts(rowid, title, content, tags, project) SELECT rowid, title, content, tags, project FROM items`);
  }

  // Schema migration helper: Add 'project' if it's missing in existing database.
  try {
    db.exec("ALTER TABLE items ADD COLUMN project TEXT");
    console.log("🛠️  Database migrated: Added 'project' column.");
  } catch (e) { }
}

initDb();

const AddSchema = z.object({
  type: z.enum(["diary", "conversation", "worklog", "file"]),
  source: z.string().optional(),
  project: z.string().optional(),
  title: z.string().optional(),
  content: z.string().optional(),
  file_path: z.string().optional(),
  tags: z.string().optional(),
  created_at: z.string().optional(), // ISO
});

app.post("/add", (req, res) => {
  const parsed = AddSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const { type, source, project, title, content, file_path, tags } = parsed.data;
  const created_at = parsed.data.created_at || new Date().toISOString();
  const id = `${type}_${Date.now()}_${Math.random().toString(16).slice(2)}`;

  db.prepare(
    `INSERT INTO items (id,type,project,source,title,content,file_path,tags,created_at) VALUES (?,?,?,?,?,?,?,?,?)`
  ).run(id, type, project || null, source || null, title || null, content || null, file_path || null, tags || null, created_at);

  res.json({ ok: true, id });
});

app.get("/search", (req, res) => {
  const q = String(req.query.q || "").trim();
  const type = String(req.query.type || "").trim();
  const project = String(req.query.project || "").trim();
  const source = String(req.query.source || "").trim();
  if (!q) return res.status(400).json({ error: "Missing search query" });

  const safeQ = q.replace(/["'*]/g, "") + "*";

  const params = [safeQ];
  if (type) params.push(type);
  if (project) params.push(project);

  let sourceFilter = "";
  if (source) {
    if (source === 'browser') {
      sourceFilter = "AND i.source IN ('browser', 'chrome', 'edge')";
    } else {
      sourceFilter = "AND i.source = ?";
      params.push(source);
    }
  }

  console.log(`🔍 [SEARCH] q="${q}" type="${type}" project="${project}" source="${source}"`);
  const stmt = db.prepare(`
     SELECT i.id, i.type, i.project, i.source, i.title, i.content, substr(i.content,1,300) as snippet, i.file_path, i.tags, i.created_at
     FROM items_fts f
     JOIN items i ON f.rowid = i.rowid
     WHERE f MATCH ?
     ${type ? "AND i.type = ?" : ""}
     ${project ? "AND i.project = ?" : ""}
     ${sourceFilter}
     ORDER BY i.created_at DESC
     LIMIT 50;
  `);
  const results = stmt.all(...params);
  console.log(`   ✅ Found ${results.length} results`);
  res.json({ results });
});

app.post("/upload", upload.single("file"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });

  const original = req.file.originalname || "file";
  const dayDir = path.join(VAULT_ROOT, "files", isoDate());
  ensureDir(dayDir);

  const target = path.join(dayDir, `${Date.now()}_${safeSlug(original)}${path.extname(original)}`);
  fs.renameSync(req.file.path, target);

  const id = `file_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  db.prepare(
    `INSERT INTO items (id,type,source,title,content,file_path,tags,created_at)
     VALUES (?,?,?,?,?,?,?,?)`
  ).run(id, "file", "manual", original, null, target, null, new Date().toISOString());

  res.json({ ok: true, path: target, id });
});

app.get("/health", (req, res) => res.json({ ok: true, vault: VAULT_ROOT, db: DB_PATH }));

// Clear ALL items — used by auto-sync to wipe test/old data
app.post("/clear", (req, res) => {
  try {
    db.exec("DELETE FROM items");
    res.json({ ok: true, message: "All items cleared." });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/projects", (req, res) => {
  const meta = db.prepare("SELECT * FROM projects_meta").all();
  const counts = db.prepare(`
    SELECT project, count(*) as count
    FROM items
    WHERE project IS NOT NULL
    GROUP BY project
  `).all();

  const results = counts.map(c => {
    const m = meta.find(m => m.name === c.project);
    return {
      project: c.project,
      count: c.count,
      color: m?.color || null,
      icon: m?.icon || null,
      description: m?.description || null
    };
  });

  res.json({ ok: true, results });
});

app.post("/projects/meta", (req, res) => {
  const { name, color, icon, description } = req.body;
  if (!name) return res.status(400).json({ error: "Project name is required" });

  const id = `proj_${Date.now()}`;
  db.prepare(`
    INSERT INTO projects_meta (id, name, color, icon, description, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET
      color = excluded.color,
      icon = excluded.icon,
      description = excluded.description
  `).run(id, name, color || null, icon || null, description || null, new Date().toISOString());

  res.json({ ok: true });
});

app.post("/projects/:name/summarize", async (req, res) => {
  const { name } = req.params;

  // 1. Fetch recent entries for this project
  const items = db.prepare(`SELECT title, type, source, substr(content,1,500) as snippet FROM items WHERE project = ? ORDER BY created_at DESC LIMIT 30`).all(name);
  if (!items || items.length === 0) {
    return res.status(400).json({ error: "No entries found for this project to summarize." });
  }

  // 2. Prepare Context Context
  const contextText = items.map(i => `[Type: ${i.type}, Source: ${i.source}] ${i.title || 'Untitled'}: ${i.snippet || ''}`).join('\n\n');
  const prompt = `You are an AI organizing my personal knowledge vault.
Analyze the following recent log entries for my project "${name}".
Respond with a concise, high-level structural description and summary of this project (maximum 2-3 sentences).
Do not output any markdown formatting, headers, or explanations. Just give me the pure text summary.

<entries>
${contextText}
</entries>`;

  // 3. Ask Ollama
  try {
    const oRes = await fetch(`${OLLAMA_URL}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        prompt: prompt,
        stream: false
      })
    });

    if (!oRes.ok) throw new Error(`Ollama returned ${oRes.status}`);
    const oData = await oRes.json();
    const summary = (oData.response || "").trim();

    if (!summary) throw new Error("Ollama returned an empty summary.");

    // 4. Update the Database
    const id = `proj_${Date.now()}`;
    db.prepare(`
      INSERT INTO projects_meta (id, name, description, created_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET
        description = excluded.description
    `).run(id, name, summary, new Date().toISOString());

    res.json({ ok: true, summary });
  } catch (err) {
    console.error("Local AI Summarization Error:", err.message);
    res.status(500).json({ error: `AI summarization failed: ${err.message}` });
  }
});

app.get("/list", (req, res) => {
  const type = String(req.query.type || "").trim();
  const project = String(req.query.project || "").trim();
  const source = String(req.query.source || "").trim();
  const date = String(req.query.date || "").trim(); // YYYY-MM-DD
  const limit = Math.min(Number(req.query.limit || 100), 500);

  let whereParts = [];
  const params = [];

  if (type) {
    whereParts.push("type = ?");
    params.push(type);
  }
  if (project) {
    whereParts.push("project = ?");
    params.push(project);
  }
  if (source) {
    if (source === 'browser') {
      whereParts.push("source IN ('browser', 'chrome', 'edge')");
    } else {
      whereParts.push("source = ?");
      params.push(source);
    }
  }
  if (date) {
    whereParts.push("created_at LIKE ?");
    params.push(`${date}%`);
  }

  const where = whereParts.length ? "WHERE " + whereParts.map(p => `i.${p}`).join(" AND ") : "";
  console.log(`📋 [LIST] type="${type}" project="${project}" source="${source}" where="${where}"`);
  params.push(limit);

  const stmt = db.prepare(
    `SELECT i.id, i.type, i.project, i.source, i.title, i.content, substr(i.content,1,300) as snippet, 
            i.file_path, i.tags, i.created_at, p.color as project_color, p.icon as project_icon
     FROM items i
     LEFT JOIN projects_meta p ON i.project = p.name
     ${where}
     ORDER BY i.created_at DESC
     LIMIT ?;`
  );
  res.json({ ok: true, results: stmt.all(...params) });
});

app.get("/activity", (req, res) => {
  // Get counts per day for the last 365 days for the calendar
  const stmt = db.prepare(`
    SELECT strftime('%Y-%m-%d', created_at) as date, count(*) as count
    FROM items
    WHERE created_at > date('now', '-1 year')
    GROUP BY date
    ORDER BY date ASC
  `);
  res.json({ ok: true, results: stmt.all() });
});

app.delete("/entries/:id", (req, res) => {
  const { id } = req.params;
  db.prepare("DELETE FROM items WHERE id = ?").run(id);
  res.json({ ok: true });
});

app.put("/entries/:id", (req, res) => {
  const { id } = req.params;
  const { title, content, project, tags } = req.body;

  db.prepare(`
    UPDATE items 
    SET title = COALESCE(?, title),
        content = COALESCE(?, content),
        project = COALESCE(?, project),
        tags = COALESCE(?, tags)
    WHERE id = ?
  `).run(title, content, project, tags, id);

  res.json({ ok: true });
});

app.post("/clear", (req, res) => {
  try {
    const { source } = req.body || {};
    if (source === "browser") {
      db.prepare("DELETE FROM items WHERE source IN ('browser', 'chrome', 'edge')").run();
      console.log("🗑️ Cleared all browser entries.");
    } else if (source) {
      db.prepare("DELETE FROM items WHERE source = ?").run(source);
      console.log(`🗑️ Cleared entries for source: ${source}`);
    } else {
      db.prepare("DELETE FROM items").run();
      db.prepare("DELETE FROM projects_meta").run();
      console.log("🗑️ Cleared ALL vault data.");
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/reset", (req, res) => {
  try {
    db.exec(`
      DROP TABLE IF EXISTS items;
      DROP TABLE IF EXISTS projects_meta;
      DROP TABLE IF EXISTS items_fts;
    `);
    initDb();
    console.log("♻️ Vault Database has been reset.");
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete("/projects/meta/:name", (req, res) => {
  const { name } = req.params;
  db.prepare("DELETE FROM projects_meta WHERE name = ?").run(name);
  // Optionally: Set items belonging to this project to NULL or 'Archive'
  // db.prepare("UPDATE items SET project = NULL WHERE project = ?").run(name);
  res.json({ ok: true });
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

function hasSentinel() {
  const row = db.prepare("SELECT id FROM secrets WHERE id = ?").get(SENTINEL_ID);
  return !!row;
}

function createSentinel(password) {
  const now = new Date().toISOString();
  db.prepare(
    "INSERT OR REPLACE INTO secrets (id,category,label,encrypted,created_at,updated_at) VALUES (?,?,?,?,?,?)"
  ).run(SENTINEL_ID, "system", "__sentinel__", encrypt(SENTINEL_VALUE, password), now, now);
}

function verifyPassword(password) {
  if (!hasSentinel()) return true; // first use
  const row = db.prepare("SELECT encrypted FROM secrets WHERE id = ?").get(SENTINEL_ID);
  if (!row) return false;
  try {
    return decrypt(row.encrypted, password) === SENTINEL_VALUE;
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

  db.prepare(
    "INSERT INTO secrets (id,category,label,encrypted,created_at,updated_at) VALUES (?,?,?,?,?,?)"
  ).run(id, category, label, encrypted, now, now);

  res.json({ ok: true, id });
});

// POST /secrets/get — decrypt and return a secret
app.post("/secrets/get", (req, res) => {
  const { password, id } = req.body || {};
  if (!password || !id) return res.status(400).json({ error: "password and id required" });
  if (!verifyPassword(password)) return res.status(401).json({ ok: false, error: "Wrong password" });

  const row = db.prepare("SELECT * FROM secrets WHERE id = ? AND id != ?").get(id, SENTINEL_ID);
  if (!row) return res.status(404).json({ error: "Not found" });

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
  const rows = stmt.all(...params);
  res.json({ ok: true, count: rows.length, secrets: rows });
});

// DELETE /secrets/delete — remove a secret
app.delete("/secrets/delete/:id", (req, res) => {
  const { password } = req.body || {};
  if (!password) return res.status(400).json({ error: "password required" });
  if (!verifyPassword(password)) return res.status(401).json({ ok: false, error: "Wrong password" });

  db.prepare("DELETE FROM secrets WHERE id = ? AND id != ?").run(req.params.id, SENTINEL_ID);
  res.json({ ok: true });
});

// ═══════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════
//  TELEGRAM BOT INTEGRATION
// ═══════════════════════════════════════════════════════

const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TG_USER_ID = process.env.TELEGRAM_USER_ID; // Only allow this ID to log

if (TG_TOKEN) {
  const bot = new TelegramBot(TG_TOKEN, { polling: true });
  let userProject = ""; // Session-based project choice

  console.log("🤖 Telegram Vault Bot online.");

  bot.on("message", async (msg) => {
    const fromId = String(msg.from.id);
    if (TG_USER_ID && fromId !== String(TG_USER_ID)) {
      console.warn(`⚠️ Unauthorized access attempt from ${fromId}`);
      return;
    }

    const text = msg.text || "";
    if (text.startsWith("/start")) {
      bot.sendMessage(msg.chat.id, "Welcome to MemVault Bot! 🚀\n- Send any text to log it as a Diary entry.\n- Use `/project <name>` to set the current context.\n- Use `/status` to see current settings.");
      return;
    }

    if (text.startsWith("/project ")) {
      userProject = text.replace("/project ", "").trim();
      bot.sendMessage(msg.chat.id, `📁 Project set to: *${userProject}*`, { parse_mode: "Markdown" });
      return;
    }

    if (text === "/status") {
      bot.sendMessage(msg.chat.id, `📊 Vault Status:\n- Current Project: ${userProject || "None"}\n- Server: Online`);
      return;
    }

    // Default: Log as diary entry
    try {
      const id = `tg_${Date.now()}`;
      const title = `Telegram Log · ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
      db.prepare(
        `INSERT INTO items (id,type,project,source,title,content,created_at) VALUES (?,?,?,?,?,?,?)`
      ).run(id, "diary", userProject || null, "telegram", title, text, new Date().toISOString());

      bot.sendMessage(msg.chat.id, `✅ Logged to ${userProject || "Vault"}!`);
    } catch (e) {
      bot.sendMessage(msg.chat.id, `❌ Failed to log: ${e.message}`);
    }
  });

  bot.on("polling_error", (error) => {
    console.error("🤖 Telegram Bot Polling Error:", error.code);
  });
}

// ═══════════════════════════════════════════════════════

let syncActive = false;
async function runAutoSync() {
  if (syncActive) return;
  syncActive = true;
  console.log("🔄 Triggering background sync...");

  const scripts = [
    "sync-browser.mjs",
    "sync-antigravity.mjs",
    "github-sync.mjs",
    "sync-docs.mjs"
  ];

  for (const script of scripts) {
    const scriptPath = path.join(__dirname, script);
    if (!fs.existsSync(scriptPath)) continue;

    console.log(`   🔸 Running ${script}...`);
    await new Promise((resolve) => {
      exec(`node "${scriptPath}"`, (err, stdout, stderr) => {
        if (err) {
          console.error(`   ❌ ${script} failed:`, stderr || err.message);
        } else {
          console.log(`   ✅ ${script} complete.`);
        }
        resolve();
      });
    });
  }
  syncActive = false;
  console.log("🏁 All background sync tasks finished.");
}

// Watch antigravity logs for aggressive instant sync
const isWsl = process.env.WSL_DISTRO_NAME !== undefined;
setInterval(runAutoSync, 1000 * 60 * 15); // Auto-sync every 15 minutes
setTimeout(runAutoSync, 10000); // 10 seconds after startup

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Vault API running on http://0.0.0.0:${PORT} (or locally via http://127.0.0.1:${PORT})`);
  console.log(`VAULT_ROOT=${VAULT_ROOT}`);
});
