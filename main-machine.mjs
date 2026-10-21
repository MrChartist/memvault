/**
 * main-machine.mjs — one machine (usually the VPS) is the main one, and everything stays up to date on it
 * ═══════════════════════════════════════════════════════════════════════════════
 * Device sync (device-sync.mjs) needs a folder all computers share. With a main machine, that machine IS the
 * shared folder: it keeps it in ~/.memvault/main-folder and serves it to its linked machines over the
 * dashboard API, so no Syncthing / Dropbox is needed, and the main machine always holds everyone's latest
 * memories (it merges each upload at once).
 *
 *   On the VPS:       "devices": { "enabled": true, "main": "this" }          (Settings → Main machine)
 *   On each computer: link the VPS (machines.mjs), then make it the main one  (Server → Make main)
 *                     → "devices": { "enabled": true, "main": "<machine id>" }
 *
 * The files stay encrypted with the sync passphrase (the same on every machine). A computer may only replace
 * the file it uploaded first; it can read the others (it needs them to merge).
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import fs from "fs";
import path from "path";
import crypto from "crypto";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { TOKEN_FILE } from "./config.mjs";
import { FILE_RE, MAX_FILE_BYTES, ownFile, writeOwnFile, syncDevices, deviceIdentity, deviceSettings } from "./device-sync.mjs";
import { getMachine } from "./machines.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const homeDir = () => path.dirname(TOKEN_FILE);
const ownersFile = (dir) => path.join(dir, "main-owners.json");
const readJson = (f, fb) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return fb; } };
const err = (status, message) => Object.assign(new Error(message), { status });

// ─── the main machine's side ───────────────────────────────────────────────

function listFolder(folder) {
  let names = [];
  try { names = fs.readdirSync(folder); } catch { return []; }
  return names.filter((n) => FILE_RE.test(n)).flatMap((name) => {
    try {
      const st = fs.lstatSync(path.join(folder, name));
      return st.isFile() ? [{ name, size: st.size, mtime: Math.round(st.mtimeMs) }] : [];
    } catch { return []; }
  });
}

/** Merge new uploads into the main machine's own vault soon, in a separate process (like the timer does). */
let mergeTimer = null;
function mergeSoon() {
  clearTimeout(mergeTimer);
  mergeTimer = setTimeout(() => {
    try { spawn(process.execPath, [path.join(__dirname, "device-sync.mjs"), "sync", "--quiet"], { stdio: "ignore", env: process.env, windowsHide: true }).unref(); } catch { /* next timer */ }
  }, 3000);
  mergeTimer.unref?.();
}

export function mountMain(app, { log = () => {}, express, settings = () => deviceSettings(), dir = homeDir(), ownerOnly, updateSettings }) {
  const actorOf = (req) => req.deviceKeyId || "owner";
  const guard = (req, res, next) => {
    const s = settings();
    if (s.main !== "this") return res.status(404).json({ ok: false, error: "This machine is not the main machine." });
    req.mainFolder = s.folder;
    next();
  };
  const name = (req) => {
    if (!FILE_RE.test(req.params.name)) throw err(400, "Not a MemVault sync file name.");
    return req.params.name;
  };

  app.get("/api/main", (_req, res) => {
    const s = settings();
    const m = s.main && s.main !== "this" ? getMachine(s.main) : null;
    res.json({ ok: true, main: s.main || "", isMain: s.main === "this", machine: m ? { id: m.id, name: m.name, url: m.url } : null, enabled: s.enabled });
  });

  // Choose the main machine: "this", a linked machine's id, or "" for none. Done with the dashboard key.
  app.put("/api/main", ownerOnly, (req, res) => {
    const main = String(req.body?.main ?? "");
    if (main && main !== "this" && !getMachine(main)) return res.status(400).json({ ok: false, error: "Link that machine first." });
    try { updateSettings(main ? { main, enabled: true } : { main: "" }); } catch (e) { return res.status(400).json({ ok: false, error: e.message }); }
    log("main-machine", { main: main || "none" });
    res.json({ ok: true, main });
  });

  app.get("/api/main/files", guard, (req, res) => res.json({ ok: true, files: listFolder(req.mainFolder) }));

  app.get("/api/main/files/:name", guard, (req, res) => {
    try {
      const file = path.join(req.mainFolder, name(req));
      const st = fs.lstatSync(file);
      if (!st.isFile()) throw err(404, "Not found.");
      res.set("x-mtime", String(Math.round(st.mtimeMs))).type("application/octet-stream").send(fs.readFileSync(file));
    } catch (e) { res.status(e.status || (e.code === "ENOENT" ? 404 : 500)).json({ ok: false, error: e.code === "ENOENT" ? "Not found." : e.message }); }
  });

  app.put("/api/main/files/:name", guard, express.raw({ type: "application/octet-stream", limit: MAX_FILE_BYTES }), (req, res) => {
    try {
      const n = name(req);
      if (!Buffer.isBuffer(req.body) || !req.body.length) throw err(400, "Send the file as application/octet-stream.");
      const id = FILE_RE.exec(n)[1];
      if (id === deviceIdentity({ dir }).id) throw err(403, "That is the main machine's own file.");
      // The first machine to upload a file owns it: another key cannot overwrite (or erase) its memories.
      const owners = readJson(ownersFile(dir), {});
      if (owners[n] && owners[n] !== actorOf(req)) throw err(403, "Another machine owns that file.");
      writeOwnFile(req.mainFolder, { id }, req.body);
      if (!owners[n]) { owners[n] = actorOf(req); fs.writeFileSync(ownersFile(dir), JSON.stringify(owners, null, 2), { mode: 0o600 }); }
      log("main-upload", { file: n, size: req.body.length }, req.deviceKeyId ? `device:${req.deviceKeyId}` : "owner");
      mergeSoon();
      res.json({ ok: true });
    } catch (e) { res.status(e.status || 500).json({ ok: false, error: e.message }); }
  });
}

// ─── a machine that syncs through the main one ─────────────────────────────

async function call(m, p, init = {}, fetchImpl = fetch) {
  let r;
  try {
    r = await fetchImpl(`${m.url}${p}`, { ...init, headers: { authorization: `Bearer ${m.key}`, ...(init.headers || {}) }, redirect: "error", signal: AbortSignal.timeout(120_000) });
  } catch (e) { throw new Error(`${m.name} did not answer (${e.cause?.code || e.message}).`); }
  if (r.status === 401) throw new Error(`${m.name} no longer accepts this machine's key. Link it again.`);
  if (!r.ok) { const d = await r.json().catch(() => ({})); throw new Error(`${m.name}: ${d.error || `HTTP ${r.status}`}`); }
  return r;
}

/**
 * Pull the main machine's files into a private copy, sync against that copy as if it were the shared folder,
 * then push this machine's file back up. The merge itself is device-sync.mjs, unchanged.
 */
export async function syncThroughMain({ vdb, settings, dir = homeDir(), fetchImpl = fetch, machinesFile, ...rest }) {
  const fail = (msg) => ({ at: new Date().toISOString(), ok: false, added: 0, changed: 0, deleted: 0, agents: 0, peers: [], problems: [msg], wrote: false });
  const m = getMachine(settings.main, machinesFile);
  if (!m) return fail("The main machine is not linked any more. Link it again, or choose another main machine.");
  const identity = deviceIdentity({ dir });
  const cache = settings.folder;
  fs.mkdirSync(cache, { recursive: true, mode: 0o700 });
  const mine = path.basename(ownFile(cache, identity));
  try {
    const { files } = await (await call(m, "/api/main/files", {}, fetchImpl)).json();
    const remote = new Map(files.filter((f) => FILE_RE.test(f.name)).map((f) => [f.name, f]));
    for (const f of remote.values()) {
      if (f.name === mine) continue;
      const local = path.join(cache, f.name);
      let st = null;
      try { st = fs.lstatSync(local); } catch { /* not here yet */ }
      if (st && st.size === f.size && Math.round(st.mtimeMs) === f.mtime) continue; // unchanged
      const buf = Buffer.from(await (await call(m, `/api/main/files/${f.name}`, {}, fetchImpl)).arrayBuffer());
      writeOwnFile(cache, { id: FILE_RE.exec(f.name)[1] }, buf);
      const t = new Date(f.mtime);
      fs.utimesSync(local, t, t); // same size + time next run → not downloaded or merged again
    }
    for (const n of fs.readdirSync(cache)) if (FILE_RE.test(n) && n !== mine && !remote.has(n)) fs.rmSync(path.join(cache, n), { force: true });

    const report = syncDevices({ vdb, settings, dir, identity, ...rest });
    const own = path.join(cache, mine);
    const up = remote.get(mine);
    if (fs.existsSync(own) && (report.wrote || !up || up.size !== fs.statSync(own).size)) {
      await call(m, `/api/main/files/${mine}`, { method: "PUT", headers: { "content-type": "application/octet-stream" }, body: fs.readFileSync(own) }, fetchImpl);
      report.uploaded = true;
    }
    report.main = m.name;
    return report;
  } catch (e) {
    return fail(e.message);
  }
}

/** One sync, whichever way this machine is set up. */
export async function runDeviceSync(opts) {
  const settings = opts.settings || deviceSettings();
  if (settings.main && settings.main !== "this") return syncThroughMain({ ...opts, settings });
  return syncDevices({ ...opts, settings });
}

export const newUploadName = () => `memvault-${crypto.randomBytes(8).toString("hex")}.mvsync`; // tests
