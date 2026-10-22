/**
 * workspace.mjs — the server workspace: a shell in the browser, PM2 / Docker controls, and a file editor
 * ═══════════════════════════════════════════════════════════════════════════════
 * Off unless you turn it on: anyone holding the dashboard key (or a paired phone's key) gets a shell as the
 * user MemVault runs as. Turn it on in ~/.memvaultrc.json:
 *
 *   "security": { "workspace": { "enabled": true, "root": "/srv/projects" } }
 *
 * Every route here sits behind requireToken (mounted after it in server.mjs). Opening a terminal, starting or
 * stopping a service and saving a file are written to the tamper-evident audit log.
 *
 * The terminal speaks plain HTTP (long-poll reads, POSTed keystrokes), so it passes through the same token
 * check, Host/Origin guards and reverse proxy as every other route, with no WebSocket upgrade path to secure
 * separately. It uses node-pty when that is installed, else `script` (util-linux) for a real terminal on
 * Linux/macOS, else a plain pipe.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";
import { spawn, execFile } from "child_process";
import { isServerViewOnly } from "./device-keys.mjs";

const isWin = process.platform === "win32";

export function workspaceSettings(security = {}) {
  const w = security.workspace || {};
  const envOn = process.env.MEMVAULT_WORKSPACE === "1";
  const fallbackRoot = os.homedir();
  return {
    enabled: envOn || w.enabled === true,
    terminal: w.terminal !== false,
    processes: w.processes !== false,
    files: w.files !== false,
    root: path.resolve(w.root || process.env.MEMVAULT_WORKSPACE_ROOT || fallbackRoot),
    shell: w.shell || (isWin ? "powershell.exe" : process.env.SHELL || "/bin/bash"),
  };
}

const run = (cmd, args, { timeout = 8000, maxBuffer = 8 * 1024 * 1024 } = {}) =>
  new Promise((resolve) => {
    execFile(cmd, args, { timeout, maxBuffer, windowsHide: true }, (err, stdout, stderr) =>
      resolve({ ok: !err, code: err?.code, stdout: String(stdout || ""), stderr: String(stderr || "") }));
  });

// ─── system health ─────────────────────────────────────────────────────────

function cpuTimes() {
  let idle = 0, total = 0;
  for (const c of os.cpus()) {
    for (const v of Object.values(c.times)) total += v;
    idle += c.times.idle;
  }
  return { idle, total };
}

async function cpuPercent(ms = 250) {
  const a = cpuTimes();
  await new Promise((r) => setTimeout(r, ms));
  const b = cpuTimes();
  const total = b.total - a.total;
  return total > 0 ? Math.round((1 - (b.idle - a.idle) / total) * 1000) / 10 : 0;
}

export async function systemStatus(root) {
  const total = os.totalmem(), free = os.freemem();
  let disk = null;
  try {
    const s = fs.statfsSync(fs.existsSync(root) ? root : os.homedir());
    const size = s.blocks * s.bsize, avail = s.bavail * s.bsize;
    disk = { total: size, free: avail, used: size - avail, percent: size ? Math.round(((size - avail) / size) * 1000) / 10 : 0 };
  } catch { /* statfs unsupported */ }
  return {
    hostname: os.hostname(),
    platform: `${os.type()} ${os.release()}`,
    cpu: { percent: await cpuPercent(), cores: os.cpus().length, load: os.loadavg() },
    memory: { total, free, used: total - free, percent: Math.round(((total - free) / total) * 1000) / 10 },
    disk,
    uptime: os.uptime(),
  };
}

// ─── PM2 and Docker ────────────────────────────────────────────────────────

export const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.@:-]{0,127}$/;
const ACTIONS = new Set(["start", "stop", "restart"]);

async function pm2List() {
  const r = await run("pm2", ["jlist"]);
  if (!r.ok) return { available: false, apps: [] };
  try {
    const list = JSON.parse(r.stdout.slice(r.stdout.indexOf("[")));
    return {
      available: true,
      apps: list.map((p) => ({
        kind: "pm2", name: p.name, id: p.pm_id, status: p.pm2_env?.status || "unknown",
        online: p.pm2_env?.status === "online",
        cpu: p.monit?.cpu ?? null, memory: p.monit?.memory ?? null,
        restarts: p.pm2_env?.restart_time ?? 0,
        uptime: p.pm2_env?.pm_uptime ? Date.now() - p.pm2_env.pm_uptime : null,
      })),
    };
  } catch { return { available: true, apps: [], error: "Could not read pm2 output." }; }
}

async function dockerList() {
  const r = await run("docker", ["ps", "-a", "--format", "{{json .}}"]);
  if (!r.ok) return { available: false, containers: [] };
  const containers = r.stdout.split("\n").filter(Boolean).map((line) => {
    try {
      const c = JSON.parse(line);
      return { kind: "docker", name: c.Names, id: c.ID, image: c.Image, status: c.Status, state: c.State, online: c.State === "running", ports: c.Ports };
    } catch { return null; }
  }).filter(Boolean);
  return { available: true, containers };
}

export async function listProcesses() {
  const [pm2, docker] = await Promise.all([pm2List(), dockerList()]);
  return { pm2, docker };
}

async function controlProcess(kind, action, name) {
  const r = kind === "pm2" ? await run("pm2", [action, name], { timeout: 30_000 }) : await run("docker", [action, name], { timeout: 60_000 });
  return { ok: r.ok, output: (r.stdout + r.stderr).slice(-4000) };
}

async function processLogs(kind, name, lines) {
  const r = kind === "pm2"
    ? await run("pm2", ["logs", name, "--lines", String(lines), "--nostream", "--raw"], { timeout: 10_000 })
    : await run("docker", ["logs", "--tail", String(lines), name], { timeout: 10_000 });
  return { ok: r.ok, lines: (r.stdout + (r.stderr ? `\n${r.stderr}` : "")).split("\n").slice(-lines) };
}

// ─── files ─────────────────────────────────────────────────────────────────

export const MAX_READ = 1024 * 1024;

const modeString = (st) => {
  const t = st.isDirectory() ? "d" : st.isSymbolicLink() ? "l" : "-";
  const m = st.mode;
  const bits = "rwxrwxrwx".split("").map((c, i) => (m & (1 << (8 - i)) ? c : "-")).join("");
  return t + bits;
};

/** Resolve a path the browser sent, refusing anything (symlinks included) that ends up outside root. */
export function safePath(root, p, { mustExist = true } = {}) {
  const realRoot = fs.realpathSync(root);
  const abs = path.resolve(realRoot, String(p || "."));
  let real;
  if (mustExist) real = fs.realpathSync(abs);
  else real = path.join(fs.realpathSync(path.dirname(abs)), path.basename(abs));
  const rel = path.relative(realRoot, real);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    const e = new Error("That path is outside the workspace folder.");
    e.status = 403;
    throw e;
  }
  return { abs: real, rel: rel || ".", realRoot };
}

export function listDir(root, p) {
  const { abs, rel } = safePath(root, p);
  const entries = [];
  for (const d of fs.readdirSync(abs, { withFileTypes: true }).slice(0, 5000)) {
    try {
      const full = path.join(abs, d.name);
      const lst = fs.lstatSync(full);
      let isDir = lst.isDirectory();
      if (lst.isSymbolicLink()) { try { isDir = fs.statSync(full).isDirectory(); } catch { /* dangling */ } }
      entries.push({ name: d.name, dir: isDir, link: lst.isSymbolicLink(), size: lst.size, mode: modeString(lst), mtime: lst.mtimeMs });
    } catch { /* vanished while listing */ }
  }
  entries.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
  return { path: rel, entries };
}

export function readText(root, p) {
  const { abs, rel } = safePath(root, p);
  const st = fs.statSync(abs);
  if (!st.isFile()) throw Object.assign(new Error("That is not a file."), { status: 400 });
  if (st.size > MAX_READ) throw Object.assign(new Error(`That file is too large to edit here (over ${MAX_READ / 1024} KB).`), { status: 413 });
  const buf = fs.readFileSync(abs);
  if (buf.subarray(0, 8192).includes(0)) throw Object.assign(new Error("That looks like a binary file, so it cannot be edited here."), { status: 415 });
  return { path: rel, content: buf.toString("utf8"), size: st.size, mtime: st.mtimeMs };
}

/** Write next to the target, then rename over it: a crash never leaves half a file. */
export function writeText(root, p, content, expectedMtime) {
  const { abs, rel } = safePath(root, p, { mustExist: false });
  let mode = 0o644;
  if (fs.existsSync(abs)) {
    const st = fs.statSync(abs);
    if (!st.isFile()) throw Object.assign(new Error("That is not a file."), { status: 400 });
    if (expectedMtime && Math.abs(st.mtimeMs - expectedMtime) > 1) {
      throw Object.assign(new Error("The file changed on the server since you opened it. Reload it before saving."), { status: 409 });
    }
    mode = st.mode & 0o7777;
  }
  const tmp = `${abs}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, content, { mode });
  try { fs.renameSync(tmp, abs); } catch (e) { fs.rmSync(tmp, { force: true }); throw e; }
  const st = fs.statSync(abs);
  return { path: rel, size: st.size, mtime: st.mtimeMs };
}

// ─── terminal sessions ─────────────────────────────────────────────────────

const MAX_SESSIONS = 6;
const IDLE_MS = 30 * 60_000;
const KEEP_BYTES = 256 * 1024;

let ptyModule; // undefined: not tried yet; null: not installed
async function loadPty() {
  if (ptyModule === undefined) {
    try { ptyModule = (await import("node-pty")).default; } catch { ptyModule = null; }
  }
  return ptyModule;
}

function hasScript() {
  if (isWin) return false;
  for (const d of ["/usr/bin", "/bin", "/usr/local/bin"]) if (fs.existsSync(path.join(d, "script"))) return true;
  return false;
}

export function createTerminals({ shell, cwd, now = Date.now } = {}) {
  const sessions = new Map();

  const reap = setInterval(() => {
    for (const s of sessions.values()) if (now() - s.lastSeen > IDLE_MS) s.kill();
  }, 60_000);
  reap.unref?.();

  async function open({ owner, cols = 80, rows = 24 }) {
    const mine = [...sessions.values()].filter((s) => s.owner === owner);
    if (sessions.size >= MAX_SESSIONS) {
      const oldest = mine.sort((a, b) => a.lastSeen - b.lastSeen)[0];
      if (!oldest) throw Object.assign(new Error("Too many terminals are open. Close one first."), { status: 429 });
      oldest.kill();
    }
    cols = Math.max(20, Math.min(500, Number(cols) || 80));
    rows = Math.max(5, Math.min(200, Number(rows) || 24));
    const env = { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor" };
    delete env.MEMVAULT_TOKEN; // the shell does not inherit the dashboard key
    const workDir = fs.existsSync(cwd) ? cwd : os.homedir();

    const s = {
      id: crypto.randomBytes(12).toString("base64url"), owner, chunks: [], seq: 0, dropped: 0, bytes: 0,
      exited: false, exitCode: null, lastSeen: now(), waiters: new Set(), mode: "pipe",
    };
    const push = (data) => {
      const text = typeof data === "string" ? data : data.toString("utf8");
      if (!text) return;
      s.chunks.push(text); s.seq++; s.bytes += text.length;
      while (s.bytes > KEEP_BYTES && s.chunks.length > 1) { s.bytes -= s.chunks.shift().length; s.dropped++; }
      for (const w of s.waiters) w();
    };
    const onExit = (code) => {
      s.exited = true; s.exitCode = code ?? null;
      for (const w of s.waiters) w();
      setTimeout(() => sessions.delete(s.id), 60_000).unref?.();
    };

    const pty = await loadPty();
    if (pty) {
      const p = pty.spawn(shell, isWin ? [] : ["-l"], { name: "xterm-256color", cols, rows, cwd: workDir, env });
      s.mode = "pty";
      p.onData(push);
      p.onExit(({ exitCode }) => onExit(exitCode));
      s.write = (d) => p.write(d);
      s.resize = (c, r) => { try { p.resize(c, r); } catch { /* exited */ } };
      s.kill = () => { try { p.kill(); } catch { /* gone */ } sessions.delete(s.id); };
    } else {
      let child;
      if (hasScript()) {
        // `script` gives the shell a real terminal (prompt, colours, job control, full-screen programs).
        const q = (x) => `'${String(x).replace(/'/g, "'\\''")}'`;
        const inner = `stty cols ${cols} rows ${rows} 2>/dev/null; exec ${q(shell)} -il`;
        const args = process.platform === "darwin" ? ["-q", "/dev/null", "/bin/sh", "-c", inner] : ["-qfec", inner, "/dev/null"];
        child = spawn("script", args, { cwd: workDir, env, stdio: "pipe" });
        s.mode = "script";
      } else {
        child = spawn(shell, isWin ? ["-NoLogo"] : ["-i"], { cwd: workDir, env, stdio: "pipe", windowsHide: true });
      }
      child.stdout.on("data", push);
      child.stderr.on("data", push);
      child.on("exit", onExit);
      child.on("error", (e) => { push(`\r\n[could not start the shell: ${e.message}]\r\n`); onExit(-1); });
      s.write = (d) => { if (!child.stdin.destroyed) child.stdin.write(d); };
      // Without node-pty the size is fixed when the shell starts; the dashboard reopens to change it.
      s.resize = () => {};
      s.kill = () => { try { child.kill("SIGHUP"); } catch { /* gone */ } sessions.delete(s.id); };
    }
    sessions.set(s.id, s);
    return s;
  }

  const get = (id, owner) => {
    const s = sessions.get(id);
    if (!s || s.owner !== owner) throw Object.assign(new Error("That terminal has closed. Open a new one."), { status: 404 });
    s.lastSeen = now();
    return s;
  };

  /** Everything after `since`, waiting up to `waitMs` for something new. */
  async function read(id, owner, since, waitMs = 25_000) {
    const s = get(id, owner);
    since = Number(since) || 0;
    if (s.seq <= since && !s.exited) {
      await new Promise((resolve) => {
        const done = () => { clearTimeout(t); s.waiters.delete(done); resolve(); };
        const t = setTimeout(done, waitMs);
        s.waiters.add(done);
      });
    }
    const first = s.dropped; // seq number of chunks[0] is first + 1
    const from = Math.max(since, first);
    return { data: s.chunks.slice(from - first).join(""), seq: s.seq, exited: s.exited, exitCode: s.exitCode, mode: s.mode };
  }

  const list = (owner) => [...sessions.values()].filter((s) => s.owner === owner).map((s) => ({ id: s.id, mode: s.mode, exited: s.exited }));
  const closeAll = () => { for (const s of [...sessions.values()]) s.kill(); clearInterval(reap); };

  return { open, get, read, list, closeAll };
}

// ─── routes ────────────────────────────────────────────────────────────────

/**
 * Mount the workspace routes. Call after requireToken. `log(action, detail, actor)` writes the audit log.
 */
export function mountWorkspace(app, { security = {}, log = () => {}, express, viewOnly = isServerViewOnly }) {
  const ws = workspaceSettings(security);
  // A device set to "view only" by the owner may look, never act.
  const canAct = (req, res, next) => (viewOnly(req.deviceKeyId)
    ? res.status(403).json({ ok: false, error: "This device is set to view only for the server. Change it on your computer (Settings → Your devices)." })
    : next());
  const actorOf = (req) => (req.deviceKeyId ? `device:${req.deviceKeyId}` : "owner");
  const fail = (res, e) => res.status(e.status && e.status < 600 ? e.status : e.code === "ENOENT" ? 404 : e.code === "EACCES" ? 403 : 500)
    .json({ ok: false, error: e.code === "ENOENT" ? "Not found." : e.code === "EACCES" ? "Permission denied." : e.message });
  const off = (what) => (_req, res) => res.status(404).json({ ok: false, error: `The server ${what} is turned off. Set security.workspace.enabled in ~/.memvaultrc.json.` });

  app.get("/api/workspace", (req, res) => res.json({
    ok: true, enabled: ws.enabled, viewOnly: viewOnly(req.deviceKeyId), terminal: ws.enabled && ws.terminal, processes: ws.enabled && ws.processes,
    files: ws.enabled && ws.files, root: ws.enabled ? ws.root : null, platform: process.platform,
  }));
  if (!ws.enabled) {
    app.use(["/api/term", "/api/system", "/api/fs"], off("workspace"));
    return null;
  }

  // ── terminal ──
  const terms = createTerminals({ shell: ws.shell, cwd: ws.root });
  if (ws.terminal) {
    const body = express.json({ limit: "256kb" });
    app.post("/api/term/open", canAct, body, async (req, res) => {
      try {
        const s = await terms.open({ owner: actorOf(req), cols: req.body?.cols, rows: req.body?.rows });
        log("terminal-open", { id: s.id, mode: s.mode, shell: ws.shell }, actorOf(req));
        res.json({ ok: true, id: s.id, mode: s.mode });
      } catch (e) { fail(res, e); }
    });
    app.get("/api/term/:id/read", async (req, res) => {
      try { res.json({ ok: true, ...(await terms.read(req.params.id, actorOf(req), req.query.since)) }); } catch (e) { fail(res, e); }
    });
    app.post("/api/term/:id/write", canAct, body, (req, res) => {
      try { terms.get(req.params.id, actorOf(req)).write(String(req.body?.data ?? "")); res.json({ ok: true }); } catch (e) { fail(res, e); }
    });
    app.post("/api/term/:id/resize", body, (req, res) => {
      try {
        const c = Math.max(20, Math.min(500, Number(req.body?.cols) || 80)), r = Math.max(5, Math.min(200, Number(req.body?.rows) || 24));
        terms.get(req.params.id, actorOf(req)).resize(c, r);
        res.json({ ok: true });
      } catch (e) { fail(res, e); }
    });
    app.post("/api/term/:id/close", (req, res) => {
      try { terms.get(req.params.id, actorOf(req)).kill(); log("terminal-close", { id: req.params.id }, actorOf(req)); res.json({ ok: true }); } catch (e) { fail(res, e); }
    });
  } else app.use("/api/term", off("terminal"));

  // ── system + processes ──
  app.get("/api/system/status", async (_req, res) => {
    try { res.json({ ok: true, ...(await systemStatus(ws.root)) }); } catch (e) { fail(res, e); }
  });
  if (ws.processes) {
    app.get("/api/system/processes", async (_req, res) => {
      try { res.json({ ok: true, ...(await listProcesses()) }); } catch (e) { fail(res, e); }
    });
    app.post("/api/system/process/:action", canAct, async (req, res) => {
      const { action } = req.params;
      const kind = req.body?.kind === "docker" ? "docker" : "pm2";
      const name = String(req.body?.name || "");
      if (!ACTIONS.has(action)) return res.status(400).json({ ok: false, error: "Use start, stop or restart." });
      if (!NAME_RE.test(name)) return res.status(400).json({ ok: false, error: "That service name is not valid." });
      const r = await controlProcess(kind, action, name);
      log(`process-${action}`, { kind, name, ok: r.ok }, actorOf(req));
      res.status(r.ok ? 200 : 502).json({ ok: r.ok, output: r.output, ...(r.ok ? {} : { error: `Could not ${action} ${name}.` }) });
    });
    app.get("/api/system/process/:name/logs", async (req, res) => {
      const name = String(req.params.name || "");
      if (!NAME_RE.test(name)) return res.status(400).json({ ok: false, error: "That service name is not valid." });
      const lines = Math.max(10, Math.min(2000, Number(req.query.lines) || 200));
      res.json(await processLogs(req.query.kind === "docker" ? "docker" : "pm2", name, lines));
    });
  } else app.use("/api/system/process", off("process controls"));

  // ── files ──
  if (ws.files) {
    app.get("/api/fs/list", (req, res) => {
      try { res.json({ ok: true, root: ws.root, ...listDir(ws.root, req.query.path) }); } catch (e) { fail(res, e); }
    });
    app.get("/api/fs/read", (req, res) => {
      try { res.json({ ok: true, ...readText(ws.root, req.query.path) }); } catch (e) { fail(res, e); }
    });
    app.post("/api/fs/write", canAct, express.json({ limit: "2mb" }), (req, res) => {
      try {
        const { path: p, content, mtime } = req.body || {};
        if (typeof p !== "string" || !p || typeof content !== "string") return res.status(400).json({ ok: false, error: "Send a path and the file's text." });
        const out = writeText(ws.root, p, content, Number(mtime) || 0);
        log("file-write", { path: out.path, size: out.size }, actorOf(req));
        res.json({ ok: true, ...out });
      } catch (e) { fail(res, e); }
    });
  } else app.use("/api/fs", off("file editor"));

  return terms;
}
