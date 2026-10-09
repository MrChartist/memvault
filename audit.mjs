/**
 * audit.mjs — tamper-evident access log
 * ═══════════════════════════════════════════════════════════════════════════════
 * When many agents share one memory you need to be able to answer "who touched
 * what, and when?". Every MCP tool call and API write appends one JSON line to
 * <VAULT_ROOT>/audit.log. Each line carries the SHA-256 of the previous line, so
 * editing or deleting an earlier line breaks the chain and `memvault audit
 * --verify` reports exactly where.
 *
 * What is logged: time, actor (agent id / "owner" / "api"), action, and small
 * metadata (tool name, argument NAMES, counts). Never the content of memories.
 *
 * Honest limit: a hash chain proves the log was altered, it cannot stop someone
 * with file access from deleting the whole file. Keep a backup if that matters.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import fs from "fs";
import path from "path";
import crypto from "crypto";
import { VAULT_ROOT } from "./config.mjs";
import { FileLock } from "./filelock.mjs";

const GENESIS = "0".repeat(64);

export function auditPath(root = VAULT_ROOT) {
  return path.join(root, "audit.log");
}

const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");

/** Keep metadata small and free of content. */
function clean(detail) {
  const out = {};
  for (const [k, v] of Object.entries(detail || {})) {
    if (v === undefined || v === null) continue;
    if (typeof v === "string") out[k] = v.length > 120 ? `${v.slice(0, 117)}...` : v;
    else if (typeof v === "number" || typeof v === "boolean") out[k] = v;
    else if (Array.isArray(v)) out[k] = v.slice(0, 20).map((x) => String(x).slice(0, 60));
    else out[k] = String(v).slice(0, 120);
  }
  return out;
}

/** Hash of the last record that can be read. A half-written last line (power cut) is skipped, not fatal. */
function lastHash(file) {
  if (!fs.existsSync(file)) return GENESIS;
  const { size } = fs.statSync(file);
  if (size === 0) return GENESIS;
  const fd = fs.openSync(file, "r");
  try {
    const len = Math.min(size, 65536);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    const lines = buf.toString("utf8").split("\n").filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const h = JSON.parse(lines[i]).hash;
        if (typeof h === "string") return h;
      } catch { /* damaged line: look at the one before */ }
    }
    return GENESIS;
  } finally {
    fs.closeSync(fd);
  }
}

/** True if the file does not end with a new line (an interrupted write). */
function endsMidLine(file) {
  try {
    const { size } = fs.statSync(file);
    if (!size) return false;
    const fd = fs.openSync(file, "r");
    try {
      const b = Buffer.alloc(1);
      fs.readSync(fd, b, 0, 1, size - 1);
      return b[0] !== 10;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
}

/**
 * Append an audit record. Never throws: auditing must not break the tool call.
 * @returns {boolean} whether the record was written
 */
export function audit({ actor = "owner", action, detail = {} }, root = VAULT_ROOT) {
  const file = auditPath(root);
  const lock = new FileLock(`${file}.lock`);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    lock.acquire();
    try {
      const prev = lastHash(file);
      const rec = { ts: new Date().toISOString(), actor, action, detail: clean(detail), prev };
      rec.hash = sha(prev + JSON.stringify({ ts: rec.ts, actor, action, detail: rec.detail }));
      fs.appendFileSync(file, (endsMidLine(file) ? "\n" : "") + JSON.stringify(rec) + "\n", { mode: 0o600 });
    } finally {
      lock.release();
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Verify the hash chain.
 * @returns {{ ok: boolean, entries: number, brokenAtLine?: number, reason?: string }}
 */
export function verifyAudit(root = VAULT_ROOT) {
  const file = auditPath(root);
  if (!fs.existsSync(file)) return { ok: true, entries: 0 };
  const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
  let prev = GENESIS;
  for (let i = 0; i < lines.length; i++) {
    let rec;
    try {
      rec = JSON.parse(lines[i]);
    } catch {
      return { ok: false, entries: lines.length, brokenAtLine: i + 1, reason: "unparseable line" };
    }
    if (rec.prev !== prev) {
      return { ok: false, entries: lines.length, brokenAtLine: i + 1, reason: "chain broken (line removed or reordered)" };
    }
    const expect = sha(prev + JSON.stringify({ ts: rec.ts, actor: rec.actor, action: rec.action, detail: rec.detail }));
    if (rec.hash !== expect) {
      return { ok: false, entries: lines.length, brokenAtLine: i + 1, reason: "record altered" };
    }
    prev = rec.hash;
  }
  return { ok: true, entries: lines.length };
}

/** Most recent records, newest last. Optional filter by actor. */
export function tailAudit(n = 20, { actor } = {}, root = VAULT_ROOT) {
  const file = auditPath(root);
  if (!fs.existsSync(file)) return [];
  const recs = fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean)
    .filter((r) => !actor || r.actor === actor);
  return recs.slice(-n);
}
