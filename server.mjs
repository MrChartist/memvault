// server.mjs — MemVault API & Web UI server
//
// Listens on 127.0.0.1 only by default and has no login of its own: see
// security.mjs and SECURITY.md before exposing it to any network.
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
import express from "express";
import multer from "multer";
import { z } from "zod";
import { VAULT_ROOT, PORT, HOST, SERVER_CONFIG } from "./config.mjs";
import { DB_PATH, ITEM_TYPES, addItems, searchItems, queryAll, queryOne, run, getStats } from "./db.mjs";
import { SENTINEL_ID, authenticate, decrypt, encrypt, hasSentinel } from "./secrets.mjs";
import { createSecurityMiddleware, createAttemptLimiter, isLoopbackAddress } from "./security.mjs";
import { isMainModule, isoDate, clampInt, getVersion } from "./util.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const ensureDir = (p) => fs.mkdirSync(p, { recursive: true });

function safeSlug(s) {
  return String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 80) || "item";
}

/** multer decodes multipart file names as latin1; recover the UTF-8 original ("résumé 日本語.txt"). */
export function fixFilenameEncoding(name) {
  if (/[^\x00-\xFF]/.test(name)) return name; // already real Unicode
  const decoded = Buffer.from(name, "latin1").toString("utf8");
  return decoded.includes("\uFFFD") ? name : decoded; // genuine latin1 names stay as they are
}

const EntrySchema = z.object({
  type: z.enum(ITEM_TYPES),
  source: z.string().max(200).optional(),
  title: z.string().max(1000).optional(),
  content: z.string().max(5_000_000).optional(),
  file_path: z.string().max(2000).optional(),
  tags: z.string().max(2000).optional(),
  created_at: z.string().max(64).optional(), // ISO; unparseable values fall back to "now"
  upsert: z.boolean().optional(),
});
const MAX_BATCH = 500;
const BatchSchema = z.object({ entries: z.array(EntrySchema).min(1).max(MAX_BATCH) });

const SecretAddSchema = z.object({
  password: z.string().min(1),
  category: z.enum(["apikey", "password", "userid", "payment", "phone", "custom"]),
  label: z.string().min(1).max(200),
  fields: z
    .record(z.string().max(100), z.string().max(20_000))
    .refine((o) => Object.keys(o).length > 0 && Object.keys(o).length <= 50, "1–50 fields required"),
});

export function createApp() {
  ["entries", "conversations", "worklogs", "files"].forEach((d) => ensureDir(path.join(VAULT_ROOT, d)));

  const app = express();
  app.disable("x-powered-by");
  app.use(createSecurityMiddleware({ bindHost: HOST, ...SERVER_CONFIG }));
  app.use(express.json({ limit: "25mb" }));
  app.use(express.static(path.join(__dirname, "public")));

  const upload = multer({
    dest: path.join(VAULT_ROOT, "files"),
    limits: { fileSize: 200 * 1024 * 1024 }, // 200MB
  });

  // ── Entries ───────────────────────────────────────────────────────────────

  app.get("/health", (req, res) =>
    res.json({ ok: true, version: getVersion(), vault: VAULT_ROOT, db: DB_PATH })
  );

  app.post("/add", (req, res) => {
    const parsed = EntrySchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });
    const { inserted, ids } = addItems([parsed.data]);
    res.json({ ok: true, id: ids[0], duplicate: inserted === 0 });
  });

  // Many entries, one database write. Used by importers and sync engines.
  app.post("/add/batch", (req, res) => {
    const parsed = BatchSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });
    res.json({ ok: true, ...addItems(parsed.data.entries) });
  });

  app.get("/search", (req, res) => {
    const q = String(req.query.q || "").trim();
    const type = ITEM_TYPES.includes(String(req.query.type)) ? String(req.query.type) : undefined;
    if (!q) return res.json({ ok: true, results: [] });
    res.json({ ok: true, results: searchItems({ terms: [q], type, limit: clampInt(req.query.limit, 1, 200, 50) }) });
  });

  // List entries (no search filter) — for UI browsing
  app.get("/list", (req, res) => {
    const type = ITEM_TYPES.includes(String(req.query.type)) ? String(req.query.type) : undefined;
    res.json({ ok: true, results: searchItems({ terms: [], type, limit: clampInt(req.query.limit, 1, 500, 100) }) });
  });

  app.get("/stats", (req, res) => res.json({ ok: true, ...getStats() }));

  app.post("/upload", upload.single("file"), (req, res) => {
    if (!req.file) return res.status(400).json({ ok: false, error: "No file uploaded" });

    const original = path.basename(fixFilenameEncoding(req.file.originalname || "file"));
    const ext = path.extname(original).replace(/[^.a-zA-Z0-9]/g, "").slice(0, 16);
    const dayDir = path.join(VAULT_ROOT, "files", isoDate());
    ensureDir(dayDir);

    const target = path.join(dayDir, `${Date.now()}_${safeSlug(path.basename(original, path.extname(original)))}${ext}`);
    fs.renameSync(req.file.path, target);

    const { ids } = addItems([{ type: "file", source: "manual", title: original, file_path: target }]);
    res.json({ ok: true, path: target, id: ids[0] });
  });

  // ── Encrypted secrets ─────────────────────────────────────────────────────
  // AES-256-GCM, PBKDF2 key from the master password (see secrets.mjs).

  const limiter = createAttemptLimiter();

  /** Throttle + verify the master password. Sends the error response itself. */
  function requirePassword(password, res) {
    const wait = limiter.retryAfterMs();
    if (wait > 0) {
      const secs = Math.ceil(wait / 1000);
      res.set("Retry-After", String(secs));
      res.status(429).json({ ok: false, error: `Too many failed attempts. Try again in ${secs}s.` });
      return false;
    }
    const auth = authenticate(password);
    if (!auth.ok) {
      if (auth.status === 401) limiter.fail();
      res.status(auth.status).json({ ok: false, error: auth.error });
      return false;
    }
    limiter.succeed();
    return true;
  }

  // Has a master password been set yet? (lets the UI ask for it twice the first time)
  app.get("/secrets/status", (req, res) => res.json({ ok: true, initialized: hasSentinel() }));

  app.post("/secrets/verify", (req, res) => {
    const { password } = req.body || {};
    if (!requirePassword(password, res)) return;
    res.json({ ok: true });
  });

  app.post("/secrets/add", (req, res) => {
    const parsed = SecretAddSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });
    const { password, category, label, fields } = parsed.data;
    if (!requirePassword(password, res)) return;

    const id = `secret_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
    const now = new Date().toISOString();
    run(
      "INSERT INTO secrets (id,category,label,encrypted,created_at,updated_at) VALUES (?,?,?,?,?,?)",
      [id, category, label, encrypt(JSON.stringify(fields), password), now, now]
    );
    res.json({ ok: true, id });
  });

  app.post("/secrets/get", (req, res) => {
    const { password, id } = req.body || {};
    if (typeof id !== "string" || !id) return res.status(400).json({ ok: false, error: "password and id required" });
    if (!requirePassword(password, res)) return;

    const row = queryOne("SELECT * FROM secrets WHERE id = ? AND id != ?", [id, SENTINEL_ID]);
    if (!row) return res.status(404).json({ ok: false, error: "Not found" });
    try {
      const fields = JSON.parse(decrypt(row.encrypted, password));
      res.json({ ok: true, id: row.id, category: row.category, label: row.label, fields, created_at: row.created_at });
    } catch {
      res.status(500).json({ ok: false, error: "Could not decrypt this secret (corrupted data?)" });
    }
  });

  // List labels/categories only (no decryption)
  app.get("/secrets/list", (req, res) => {
    const cat = String(req.query.category || "").trim();
    const rows = cat
      ? queryAll("SELECT id, category, label, created_at, updated_at FROM secrets WHERE category = ? AND id != ? ORDER BY category, label", [cat, SENTINEL_ID])
      : queryAll("SELECT id, category, label, created_at, updated_at FROM secrets WHERE id != ? ORDER BY category, label", [SENTINEL_ID]);
    res.json({ ok: true, count: rows.length, secrets: rows });
  });

  app.delete("/secrets/delete/:id", (req, res) => {
    const { password } = req.body || {};
    if (!requirePassword(password, res)) return;
    run("DELETE FROM secrets WHERE id = ? AND id != ?", [req.params.id, SENTINEL_ID]);
    res.json({ ok: true });
  });

  // ── Storage / backup (local + Google Drive) ───────────────────────────────

  app.post("/backup", async (req, res) => {
    try {
      const { backupVault, enabledBackends } = await import("./storage.mjs");
      const results = await backupVault();
      res.json({ ok: true, backends: enabledBackends(), results });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.get("/backups", async (req, res) => {
    try {
      const { listLocalBackups } = await import("./storage.mjs");
      res.json({ ok: true, backups: listLocalBackups() });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // ── MCP bridges (connections to other AI MCP servers) ─────────────────────

  app.get("/bridges", async (req, res) => {
    try {
      const { enabledBridges } = await import("./mcp-bridge.mjs");
      const bridges = enabledBridges().map((b) => ({
        name: b.name,
        command: `${b.command} ${(b.args || []).join(" ")}`.trim(),
        importTool: b.importTool || null,
      }));
      res.json({ ok: true, bridges });
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
      res.json({ ok: true, results });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // ── Errors ────────────────────────────────────────────────────────────────

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err.status || err.statusCode || (err.name === "MulterError" ? 400 : 500);
    if (status >= 500) console.error(`[MemVault] ${req.method} ${req.path}:`, err);
    res.status(status).json({ ok: false, error: status >= 500 ? "Internal server error" : err.message });
  });

  return app;
}

export function startServer({ port = PORT, host = HOST } = {}) {
  const app = createApp();
  return new Promise((resolve, reject) => {
    // Events, not the listen() callback: Express 5 hands start-up errors (EADDRINUSE,
    // bad host...) to that callback, where `server.address()` is still null.
    const server = app.listen(port, host);
    server.once("error", (e) => {
      if (e.code === "EADDRINUSE") {
        console.error(`❌ Port ${port} is already in use. Is MemVault already running? Set "port" in ~/.memvaultrc.json or VAULT_PORT to change it.`);
      } else {
        console.error(`❌ Could not start the server on ${host}:${port}: ${e.message}`);
      }
      reject(e);
    });
    server.once("listening", () => {
      const shown = host === "0.0.0.0" || host === "::" ? "localhost" : host;
      console.log(`MemVault running on http://${shown}:${server.address().port}`);
      console.log(`VAULT_ROOT=${VAULT_ROOT}`);
      if (!isLoopbackAddress(host)) {
        console.warn(
          `\n⚠️  Listening on ${host}: anyone who can reach this address can read and change your vault.\n` +
          `   MemVault has no login. Keep it on 127.0.0.1 unless the network is fully trusted.\n`
        );
      }
      resolve(server);
    });
  });
}

if (isMainModule(import.meta.url)) {
  startServer().catch(() => process.exit(1));
}
