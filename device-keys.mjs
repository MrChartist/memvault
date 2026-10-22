/**
 * device-keys.mjs — phones and tablets that may open this computer's dashboard
 * ═══════════════════════════════════════════════════════════════════════════════
 * A phone cannot run MemVault, but it can open the dashboard of a computer or server that does, through
 * a private address (for example Tailscale). Each phone gets its OWN key, so a lost phone can be signed
 * out without changing anything else:
 *
 *   1. On the computer: `memvault devices pair --name "iPhone"` (or Settings → Add a phone) shows a
 *      one-time code, valid for 10 minutes.
 *   2. On the phone: open the dashboard address, choose "Use a pairing code", type the code.
 *   3. The phone receives a key of its own. Only a hash of it is kept here.
 *
 * Codes are one-time, expire, and wrong guesses are limited by the server. A key works like the
 * dashboard key (full access), so sign out a phone you no longer use: `memvault devices forget <id>`.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import fs from "fs";
import path from "path";
import crypto from "crypto";
import { TOKEN_FILE, loadUserConfig, saveUserConfig } from "./config.mjs";

const PAIR_MINUTES = 10;
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O or 1/I: easy to read and to type on a phone

const keysFile = () => path.join(path.dirname(TOKEN_FILE), "device-keys.json");
const sha = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");
const nowIso = () => new Date().toISOString();

function load(file = keysFile()) {
  try {
    const d = JSON.parse(fs.readFileSync(file, "utf8"));
    return { keys: Array.isArray(d.keys) ? d.keys : [], codes: Array.isArray(d.codes) ? d.codes : [] };
  } catch {
    return { keys: [], codes: [] };
  }
}

function save(data, file = keysFile()) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  try { fs.chmodSync(tmp, 0o600); } catch { /* not POSIX */ }
  fs.renameSync(tmp, file);
}

const cleanName = (n, fallback) => String(n || "").replace(/[\r\n\t<>]+/g, " ").trim().slice(0, 40) || fallback;
const normaliseCode = (c) => String(c || "").toUpperCase().replace(/[^A-Z0-9]/g, "");

/** A one-time code for signing in one phone or tablet. Old and expired codes are dropped. */
export function createPairingCode({ name = "Phone", file = keysFile(), now = Date.now() } = {}) {
  const raw = Array.from(crypto.randomBytes(8), (b) => ALPHABET[b % ALPHABET.length]).join("");
  const data = load(file);
  const expiresAt = now + PAIR_MINUTES * 60_000;
  data.codes = [...data.codes.filter((c) => c.expires_at > now).slice(-4), { hash: sha(raw), name: cleanName(name, "Phone"), expires_at: expiresAt }];
  save(data, file);
  return { code: `${raw.slice(0, 4)}-${raw.slice(4)}`, expiresAt };
}

/** Trade a valid code for a new key (shown once). Returns null for a wrong or expired code. */
export function redeemPairingCode(code, { name, file = keysFile(), now = Date.now() } = {}) {
  const want = sha(normaliseCode(code));
  const data = load(file);
  const hit = data.codes.find((c) => c.expires_at > now && crypto.timingSafeEqual(Buffer.from(c.hash, "hex"), Buffer.from(want, "hex")));
  if (!hit) return null;
  const key = `mvd_${crypto.randomBytes(32).toString("base64url")}`;
  const entry = { id: crypto.randomBytes(4).toString("hex"), name: cleanName(name, hit.name), hash: sha(key), created_at: nowIso(), last_used_at: null };
  data.codes = data.codes.filter((c) => c !== hit && c.expires_at > now);
  data.keys.push(entry);
  save(data, file);
  return { id: entry.id, name: entry.name, key };
}

let cache = { mtime: -1, keys: [] };
const lastWrite = new Map();

/** The id of the phone this key belongs to, or null. Constant-time over every stored key. */
export function deviceKeyMatches(candidate, { file = keysFile() } = {}) {
  if (typeof candidate !== "string" || !candidate.startsWith("mvd_")) return null;
  let mtime;
  try { mtime = fs.statSync(file).mtimeMs; } catch { return null; }
  if (mtime !== cache.mtime) cache = { mtime, keys: load(file).keys };
  const want = Buffer.from(sha(candidate), "hex");
  let found = null;
  for (const k of cache.keys) if (crypto.timingSafeEqual(Buffer.from(k.hash, "hex"), want)) found = k;
  if (found && Date.now() - (lastWrite.get(found.id) || 0) > 10 * 60_000) {
    lastWrite.set(found.id, Date.now()); // "last used" is kept roughly, not on every request
    try {
      const data = load(file);
      const k = data.keys.find((x) => x.id === found.id);
      if (k) { k.last_used_at = nowIso(); save(data, file); }
    } catch { /* not important enough to fail a request */ }
  }
  return found ? found.id : null;
}

export function listDeviceKeys({ file = keysFile() } = {}) {
  return load(file).keys.map(({ id, name, created_at, last_used_at, server_view_only }) => ({ id, name, created_at, last_used_at, server_view_only: server_view_only === true }));
}

/**
 * "View only" on the Server, Terminal and Files tabs (workspace.mjs): that device sees health, services, logs
 * and files, but cannot open a terminal, start or stop a service, or save a file. Set by the owner.
 */
export function setServerViewOnly(id, viewOnly, { file = keysFile() } = {}) {
  const data = load(file);
  const k = data.keys.find((x) => x.id === id);
  if (!k) return false;
  k.server_view_only = viewOnly === true;
  save(data, file);
  cache = { mtime: -1, keys: [] };
  return true;
}

export function isServerViewOnly(id, { file = keysFile() } = {}) {
  if (!id) return false;
  let mtime;
  try { mtime = fs.statSync(file).mtimeMs; } catch { return false; }
  if (mtime !== cache.mtime) cache = { mtime, keys: load(file).keys };
  return cache.keys.find((k) => k.id === id)?.server_view_only === true;
}

export function forgetDeviceKey(id, { file = keysFile() } = {}) {
  const data = load(file);
  const before = data.keys.length;
  data.keys = data.keys.filter((k) => k.id !== id);
  if (data.keys.length === before) return false;
  save(data, file);
  cache = { mtime: -1, keys: [] };
  return true;
}

// ─── the private address phones use ─────────────────────────────────────────

const TAILSCALE_IP = /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}$/; // 100.64.0.0/10

/**
 * Let the dashboard answer at a private address as well as on this computer: https://<name> (for example
 * `tailscale serve` in front of MemVault, which itself keeps listening on 127.0.0.1 only), or plain http on
 * a Tailscale address, which Tailscale already encrypts. Anything else is refused.
 */
export function addHubAddress(address, { load: loadCfg = () => loadUserConfig({ forUpdate: true }), save: saveCfg = saveUserConfig } = {}) {
  let url;
  try { url = new URL(String(address).trim()); } catch { throw new Error(`"${address}" is not a web address. Example: https://my-server.tail1234.ts.net`); }
  const secure = url.protocol === "https:";
  if (!secure && !(url.protocol === "http:" && TAILSCALE_IP.test(url.hostname))) {
    throw new Error("Use an https:// address (for example from `tailscale serve`), or http:// with a Tailscale 100.x address. A plain http address on another network would send your key unencrypted.");
  }
  if (url.pathname !== "/" || url.search || url.hash) throw new Error("Give only the address, without a path: https://my-server.tail1234.ts.net");
  const cfg = loadCfg();
  const sec = { ...(cfg.security || {}) };
  sec.allowedHosts = [...new Set([...(sec.allowedHosts || []), url.host.toLowerCase()])];
  sec.allowedOrigins = [...new Set([...(sec.allowedOrigins || []), url.origin.toLowerCase()])];
  cfg.security = sec;
  saveCfg(cfg);
  return { host: url.host.toLowerCase(), origin: url.origin.toLowerCase() };
}
