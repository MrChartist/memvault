/**
 * machines.mjs — control other MemVault machines from this dashboard
 * ═══════════════════════════════════════════════════════════════════════════════
 * Every MemVault can link other MemVaults (a VPS, a work laptop) and show their Server, Terminal and
 * Files tabs here. A phone opens any one dashboard and, through it, reaches every machine linked to it.
 *
 *   1. On the machine to control: turn on the workspace (docs/workspace.md) and make a pairing code
 *      (`memvault devices pair --name "Laptop"`, or Settings → Add a phone).
 *   2. Here: Server tab → Machines → Add, with its address and the code.
 *   3. This machine trades the code for a key of its own (the same /pair a phone uses) and keeps it in
 *      ~/.memvault/machines.json (mode 0600), never in the browser. The other machine can sign it out
 *      like any phone.
 *
 * The browser only ever talks to this server (the CSP stays connect-src 'self'); this server relays
 * the workspace routes, and only those, to the linked machine with that machine's key. Both sides
 * write the actions to their audit logs.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import fs from "fs";
import path from "path";
import crypto from "crypto";
import { TOKEN_FILE } from "./config.mjs";

const machinesFile = () => path.join(path.dirname(TOKEN_FILE), "machines.json");
const RELAY_PREFIXES = ["/api/workspace", "/api/term/", "/api/system/", "/api/fs/"];

function load(file = machinesFile()) {
  try {
    const d = JSON.parse(fs.readFileSync(file, "utf8"));
    return Array.isArray(d.machines) ? d.machines : [];
  } catch { return []; }
}

function save(machines, file = machinesFile()) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ machines }, null, 2), { mode: 0o600 });
  try { fs.chmodSync(tmp, 0o600); } catch { /* not POSIX */ }
  fs.renameSync(tmp, file);
}

const cleanName = (n) => String(n || "").replace(/[\r\n\t<>]+/g, " ").trim().slice(0, 40) || "Machine";

/** https anywhere; plain http only to this computer or a private (LAN / Tailscale) address. */
export function normaliseUrl(u) {
  let url;
  try { url = new URL(String(u || "").trim()); } catch { throw Object.assign(new Error("That address is not valid. Use https://…"), { status: 400 }); }
  const h = url.hostname.replace(/^\[|\]$/g, "");
  const privateHost = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|::1$|fd)/.test(h) || h.endsWith(".ts.net");
  if (url.protocol !== "https:" && !(url.protocol === "http:" && privateHost)) {
    throw Object.assign(new Error("Use an https:// address (plain http only on this computer or a private network)."), { status: 400 });
  }
  if (url.username || url.password) throw Object.assign(new Error("Leave the user name and password out of the address."), { status: 400 });
  return url.origin;
}

export const listMachines = ({ file } = {}) => load(file).map(({ key, ...m }) => m);
export const getMachine = (id, file) => load(file).find((m) => m.id === id) || null;

/** Link a machine: trade its one-time pairing code for a key of our own. */
export async function addMachine({ name, url, code, deviceName = "MemVault", fetchImpl = fetch, file } = {}) {
  const origin = normaliseUrl(url);
  const r = await fetchImpl(`${origin}/pair`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: String(code || ""), name: deviceName }), signal: AbortSignal.timeout(15_000),
  }).catch((e) => { throw Object.assign(new Error(`Could not reach ${origin}: ${e.message}`), { status: 502 }); });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || !data.key) throw Object.assign(new Error(data.error || `${origin} refused the code.`), { status: r.status === 429 ? 429 : 400 });
  const machines = load(file);
  const m = { id: crypto.randomBytes(6).toString("hex"), name: cleanName(name), url: origin, key: data.key, deviceId: data.id, addedAt: new Date().toISOString() };
  save([...machines.filter((x) => x.url !== origin), m], file);
  const { key, ...pub } = m;
  return pub;
}

export function removeMachine(id, { file } = {}) {
  const machines = load(file);
  if (!machines.some((m) => m.id === id)) return false;
  save(machines.filter((m) => m.id !== id), file);
  return true;
}

/** Forward one workspace request to a linked machine. Returns { status, body } (body is JSON text). */
export async function relay(id, { method, subpath, query = "", body, fetchImpl = fetch, file } = {}) {
  const m = getMachine(id, file);
  if (!m) throw Object.assign(new Error("That machine is not linked any more."), { status: 404 });
  if (!RELAY_PREFIXES.some((p) => subpath === p.replace(/\/$/, "") || subpath.startsWith(p)) || subpath.includes("..")) {
    throw Object.assign(new Error("Only the server, terminal and files routes can be used on another machine."), { status: 403 });
  }
  const headers = { authorization: `Bearer ${m.key}` };
  if (body !== undefined) headers["content-type"] = "application/json";
  let r;
  try {
    r = await fetchImpl(`${m.url}${subpath}${query}`, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: "error", signal: AbortSignal.timeout(60_000),
    });
  } catch (e) {
    throw Object.assign(new Error(`${m.name} did not answer (${e.cause?.code || e.message}).`), { status: 502 });
  }
  const text = await r.text();
  if (r.status === 401) return { status: 502, body: JSON.stringify({ ok: false, error: `${m.name} no longer accepts this machine's key. Remove it and link it again.` }) };
  return { status: r.status, body: text || "{}", machine: m };
}

/** Is each linked machine reachable, which version, and does it still accept our key? Checked in parallel. */
export async function machineStatus({ fetchImpl = fetch, file } = {}) {
  return Promise.all(load(file).map(async (m) => {
    const out = { id: m.id, online: false, version: null, keyOk: null, workspace: null, viewOnly: null };
    try {
      const h = await fetchImpl(`${m.url}/health`, { redirect: "error", signal: AbortSignal.timeout(5000) });
      const d = await h.json().catch(() => ({}));
      out.online = h.ok && d.name === "memvault";
      out.version = typeof d.version === "string" ? d.version.slice(0, 20) : null;
      if (out.online) {
        const w = await fetchImpl(`${m.url}/api/workspace`, { headers: { authorization: `Bearer ${m.key}` }, redirect: "error", signal: AbortSignal.timeout(5000) });
        out.keyOk = w.status !== 401;
        if (w.ok) { const wd = await w.json(); out.workspace = wd.enabled === true; out.viewOnly = wd.viewOnly === true; }
      }
    } catch { /* offline */ }
    return out;
  }));
}

export function mountMachines(app, { log = () => {}, ownerOnly }) {
  const fail = (res, e) => res.status(e.status && e.status < 600 ? e.status : 500).json({ ok: false, error: e.message });
  const actorOf = (req) => (req.deviceKeyId ? `device:${req.deviceKeyId}` : "owner");

  app.get("/api/machines", (_req, res) => res.json({ ok: true, machines: listMachines() }));
  app.get("/api/machines/status", async (_req, res) => res.json({ ok: true, status: await machineStatus() }));
  // Linking and unlinking is done with the dashboard key, like pairing a phone: a stolen phone cannot link more.
  app.post("/api/machines", ownerOnly, async (req, res) => {
    try {
      const m = await addMachine({ name: req.body?.name, url: req.body?.url, code: req.body?.code, deviceName: `MemVault (${(await import("os")).hostname()})`.slice(0, 40) });
      log("machine-linked", { id: m.id, name: m.name, url: m.url });
      res.json({ ok: true, machine: m });
    } catch (e) { fail(res, e); }
  });
  app.delete("/api/machines/:id", ownerOnly, (req, res) => {
    if (!removeMachine(req.params.id)) return res.status(404).json({ ok: false, error: "Not found" });
    log("machine-unlinked", { id: req.params.id });
    res.json({ ok: true });
  });
  app.all("/api/machines/:id/relay/*rest", async (req, res) => {
    try {
      const subpath = "/" + [].concat(req.params.rest).join("/");
      const qi = req.originalUrl.indexOf("?");
      const r = await relay(req.params.id, {
        method: req.method, subpath, query: qi >= 0 ? req.originalUrl.slice(qi) : "",
        body: req.method === "GET" || req.method === "HEAD" ? undefined : req.body ?? {},
      });
      // Reads (and the terminal's long-poll) are not logged; anything that changes the other machine is.
      if (req.method !== "GET" && !/\/(write|resize)$/.test(subpath)) log("machine-relay", { machine: r.machine.name, method: req.method, path: subpath }, actorOf(req));
      res.status(r.status).type("application/json").send(r.body);
    } catch (e) { fail(res, e); }
  });
}
