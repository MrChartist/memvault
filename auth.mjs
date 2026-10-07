/**
 * auth.mjs — who may talk to the MemVault API
 * ═══════════════════════════════════════════════════════════════════════════════
 * Before: the API listened on 0.0.0.0 with `Access-Control-Allow-Origin: *` and
 * no authentication, so any device on the network — and any web page open in
 * your browser — could read, search or wipe the vault.
 *
 * Now every request to the API must pass three independent checks:
 *   1. Host    — only loopback names (or ones you list). Stops DNS-rebinding.
 *   2. Origin  — a browser page from any other site is refused. No CORS headers
 *                are ever sent, so the browser's own same-origin rule applies.
 *   3. Token   — a 256-bit random bearer token stored in a 0600 file outside the
 *                vault folder. Compared in constant time.
 * The static web UI and /health carry no data and stay public.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import fs from "fs";
import path from "path";
import crypto from "crypto";
import { TOKEN_FILE } from "./config.mjs";

// ─── token storage ──────────────────────────────────────────────────────────

const newToken = () => crypto.randomBytes(32).toString("base64url");

function writeTokenFile(file, token) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, token + "\n", { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch { /* non-POSIX */ }
}

/** The current token, or null if none exists yet. MEMVAULT_TOKEN overrides the file. */
export function loadToken(file = TOKEN_FILE) {
  if (process.env.MEMVAULT_TOKEN) return process.env.MEMVAULT_TOKEN.trim();
  try {
    return fs.readFileSync(file, "utf8").trim() || null;
  } catch {
    return null;
  }
}

/** Load the token, creating one on first use. */
export function ensureToken(file = TOKEN_FILE) {
  const existing = loadToken(file);
  if (existing) return existing;
  const token = newToken();
  writeTokenFile(file, token);
  return token;
}

/** Replace the token. Every client must re-read it afterwards. */
export function rotateToken(file = TOKEN_FILE) {
  const token = newToken();
  writeTokenFile(file, token);
  return token;
}

// ─── client side (sync engines, importers, MCP → API calls) ─────────────────

export function authHeaders(extra = {}, file = TOKEN_FILE) {
  const token = loadToken(file);
  return token ? { ...extra, authorization: `Bearer ${token}` } : { ...extra };
}

/** fetch() that attaches the API token. Drop-in for the old unauthenticated fetch. */
export function apiFetch(url, init = {}) {
  const headers = authHeaders(init.headers || {});
  if (!headers.authorization && /\/health\b/.test(String(url)) === false) {
    throw new Error(
      "MemVault API token not found. Start the server once (`npm start`) to create it, " +
        "or run `memvault token`."
    );
  }
  return fetch(url, { ...init, headers });
}

// ─── server side ────────────────────────────────────────────────────────────

const sha = (s) => crypto.createHash("sha256").update(String(s)).digest();

export function tokenMatches(candidate, token) {
  if (!candidate || !token) return false;
  return crypto.timingSafeEqual(sha(candidate), sha(token));
}

/** Failed-attempt limiter (used for the secrets master password). */
export function createLimiter({ max = 5, windowMs = 60_000, lockMs = 60_000, now = Date.now } = {}) {
  const state = new Map();
  const get = (k) => {
    if (!state.has(k)) state.set(k, { fails: [], lockedUntil: 0 });
    return state.get(k);
  };
  return {
    check(key) {
      const s = get(key);
      const t = now();
      if (s.lockedUntil > t) return { allowed: false, retryAfterSec: Math.ceil((s.lockedUntil - t) / 1000) };
      return { allowed: true, retryAfterSec: 0 };
    },
    fail(key) {
      const s = get(key);
      const t = now();
      s.fails = s.fails.filter((x) => t - x < windowMs);
      s.fails.push(t);
      if (s.fails.length >= max) {
        s.lockedUntil = t + lockMs;
        s.fails = [];
      }
    },
    success(key) {
      state.delete(key);
    },
  };
}

/**
 * Build the guard middleware.
 * @param {object} o
 * @param {number} o.port
 * @param {string} o.token
 * @param {string[]} [o.allowedHosts]
 * @param {string[]} [o.allowedOrigins]
 */
export function createGuards({ port, token, allowedHosts = [], allowedOrigins = [] }) {
  const loopbackHosts = [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`];
  const hosts = new Set([...loopbackHosts, ...allowedHosts].map((h) => h.toLowerCase()));
  const origins = new Set(
    [...loopbackHosts.map((h) => `http://${h}`), ...allowedOrigins].map((o) => o.toLowerCase())
  );

  /** Reject unknown Host headers (DNS rebinding) and foreign browser Origins. */
  const hostAndOrigin = (req, res, next) => {
    const host = String(req.headers.host || "").toLowerCase();
    if (!hosts.has(host)) {
      return res.status(403).json({ ok: false, error: "Host not allowed." });
    }
    const origin = req.headers.origin;
    if (origin && !origins.has(String(origin).toLowerCase())) {
      return res.status(403).json({ ok: false, error: "Origin not allowed." });
    }
    // Never send CORS headers; stray preflights are simply refused.
    if (req.method === "OPTIONS") return res.sendStatus(403);
    next();
  };

  /** Require the bearer token. */
  const requireToken = (req, res, next) => {
    const h = String(req.headers.authorization || "");
    const candidate = h.startsWith("Bearer ") ? h.slice(7).trim() : req.headers["x-memvault-token"];
    if (!tokenMatches(candidate, token)) {
      res.set("WWW-Authenticate", 'Bearer realm="memvault"');
      return res.status(401).json({ ok: false, error: "Missing or invalid API token. Run `memvault token`." });
    }
    next();
  };

  return { hostAndOrigin, requireToken };
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);
export const isLoopbackHost = (h) => LOOPBACK.has(String(h).toLowerCase());
