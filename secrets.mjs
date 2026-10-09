/**
 * secrets.mjs — encryption for the Secure Vault
 * ═══════════════════════════════════════════════════════════════════════════════
 * AES-256-GCM with a key derived from the master password via PBKDF2-SHA256.
 *
 * Blob formats (stored as JSON in secrets.encrypted):
 *   v1 (legacy)  { iv, authTag, ciphertext }
 *                key = PBKDF2(password, static salt "memvault-salt-v1", 100k iters)
 *   v2 (current) { v:2, iter, salt, iv, authTag, ciphertext }
 *                key = PBKDF2(password, random 16-byte salt per blob, 600k iters)
 *
 * New data is always written as v2. v1 blobs written by earlier versions still
 * decrypt, so existing vaults keep working.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import crypto from "crypto";
import { queryOne, run } from "./db.mjs";

const KEYLEN = 32;
const DIGEST = "sha256";
const V1_SALT = "memvault-salt-v1";
const V1_ITER = 100_000;
const V2_ITER = 600_000; // OWASP guidance for PBKDF2-HMAC-SHA256

export const MIN_PASSWORD_LENGTH = 8;
export const SENTINEL_ID = "__sentinel__";
const SENTINEL_VALUE = "memvault-ok";

const deriveKey = (password, salt, iter) => crypto.pbkdf2Sync(password, salt, iter, KEYLEN, DIGEST);

/** Encrypt plaintext → JSON string blob (v2). */
export function encrypt(plaintext, password) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", deriveKey(password, salt, V2_ITER), iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return JSON.stringify({
    v: 2,
    iter: V2_ITER,
    salt: salt.toString("base64"),
    iv: iv.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
    ciphertext: ct.toString("base64"),
  });
}

/** Decrypt a v1 or v2 blob. Throws if the password is wrong or the blob was tampered with. */
export function decrypt(blob, password) {
  const o = JSON.parse(blob);
  let key;
  if (o.v === 2) {
    if (!Number.isInteger(o.iter) || o.iter < V1_ITER || o.iter > 5_000_000) throw new Error("Unsupported KDF parameters");
    key = deriveKey(password, Buffer.from(o.salt, "base64"), o.iter);
  } else if (o.v === undefined) {
    key = deriveKey(password, V1_SALT, V1_ITER);
  } else {
    throw new Error(`Unsupported secret format v${o.v}`);
  }
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(o.iv, "base64"));
  decipher.setAuthTag(Buffer.from(o.authTag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(o.ciphertext, "base64")), decipher.final()]).toString("utf8");
}

// ─── Master password handling ───────────────────────────────────────────────

export function hasSentinel() {
  return !!queryOne("SELECT id FROM secrets WHERE id = ?", [SENTINEL_ID]);
}

function createSentinel(password) {
  const now = new Date().toISOString();
  run(
    "INSERT OR REPLACE INTO secrets (id,category,label,encrypted,created_at,updated_at) VALUES (?,?,?,?,?,?)",
    [SENTINEL_ID, "system", SENTINEL_ID, encrypt(SENTINEL_VALUE, password), now, now]
  );
}

/**
 * Check the master password.
 *  • First use (no sentinel yet): the password you give becomes the master password.
 *  • Afterwards: it must decrypt the sentinel.
 *
 * @returns {{ok:true, created?:boolean} | {ok:false, status:number, error:string}}
 */
export function authenticate(password) {
  if (typeof password !== "string" || !password) {
    return { ok: false, status: 400, error: "password required" };
  }
  const row = queryOne("SELECT encrypted FROM secrets WHERE id = ?", [SENTINEL_ID]);
  if (!row) {
    if (password.length < MIN_PASSWORD_LENGTH) {
      return { ok: false, status: 400, error: `Master password must be at least ${MIN_PASSWORD_LENGTH} characters` };
    }
    createSentinel(password);
    return { ok: true, created: true };
  }
  try {
    if (decrypt(row.encrypted, password) === SENTINEL_VALUE) return { ok: true };
  } catch { /* wrong password */ }
  return { ok: false, status: 401, error: "Wrong password" };
}
