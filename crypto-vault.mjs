/**
 * crypto-vault.mjs — encryption for secrets and off-machine backups
 * ═══════════════════════════════════════════════════════════════════════════════
 *  • AES-256-GCM (authenticated) for everything
 *  • Keys derived from a passphrase with scrypt (memory-hard) and a RANDOM salt
 *    per secret / per backup. (v1 used PBKDF2 with one hard-coded salt shared by
 *    every vault; v1 blobs are still readable and are upgraded on first use.)
 *  • Node's built-in crypto only — no third-party crypto dependencies.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import crypto from "crypto";

// scrypt cost: N=2^15, r=8, p=1  → ~32 MiB, tens of ms. maxmem must exceed 128*N*r.
const SCRYPT = { N: 1 << 15, r: 8, p: 1 };
const SCRYPT_MAXMEM = 128 * 1024 * 1024;

export const MIN_PASSPHRASE_LENGTH = 10;

// v1 (legacy) parameters — kept ONLY to read old data.
const V1_SALT = "memvault-salt-v1";
const V1_ITERATIONS = 100_000;

function deriveScrypt(passphrase, salt, params = SCRYPT) {
  return crypto.scryptSync(passphrase, salt, 32, {
    N: params.N, r: params.r, p: params.p, maxmem: SCRYPT_MAXMEM,
  });
}

const b64 = (buf) => Buffer.from(buf).toString("base64");
const unb64 = (s) => Buffer.from(s, "base64");

// ─── strings (secrets) ──────────────────────────────────────────────────────

/**
 * Encrypt text → JSON envelope (v2).
 * @param {string} aad optional context (e.g. the secret's id) bound into the auth tag
 */
export function encryptString(plaintext, passphrase, aad = "") {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = deriveScrypt(passphrase, salt);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  if (aad) cipher.setAAD(Buffer.from(aad, "utf8"));
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return JSON.stringify({
    v: 2,
    kdf: "scrypt",
    ...SCRYPT,
    salt: b64(salt),
    iv: b64(iv),
    authTag: b64(cipher.getAuthTag()),
    ciphertext: b64(ct),
  });
}

/** True for envelopes written by the old static-salt scheme. */
export function isLegacyBlob(blob) {
  try {
    return JSON.parse(blob).v === undefined;
  } catch {
    return false;
  }
}

/** Decrypt a v1 or v2 envelope. Throws on a wrong passphrase or tampering. */
export function decryptString(blob, passphrase, aad = "") {
  const env = JSON.parse(blob);
  let key;
  let useAad = "";
  if (env.v === 2) {
    key = deriveScrypt(passphrase, unb64(env.salt), { N: env.N, r: env.r, p: env.p });
    useAad = aad;
  } else if (env.v === undefined) {
    key = crypto.pbkdf2Sync(passphrase, V1_SALT, V1_ITERATIONS, 32, "sha256");
  } else {
    throw new Error(`Unsupported secret format v${env.v}`);
  }
  const d = crypto.createDecipheriv("aes-256-gcm", key, unb64(env.iv));
  if (useAad) d.setAAD(Buffer.from(useAad, "utf8"));
  d.setAuthTag(unb64(env.authTag));
  return Buffer.concat([d.update(unb64(env.ciphertext)), d.final()]).toString("utf8");
}

// ─── buffers (backups) ──────────────────────────────────────────────────────
// File layout:  "MVBK2" | uint32 headerLen | header JSON | ciphertext | 16-byte tag

const MAGIC = Buffer.from("MVBK2");

export function isEncryptedBackup(buf) {
  return Buffer.isBuffer(buf) && buf.length > MAGIC.length && buf.subarray(0, MAGIC.length).equals(MAGIC);
}

/** Encrypt a backup (e.g. the SQLite file) with a passphrase. */
export function encryptBuffer(plain, passphrase, meta = {}) {
  if (!passphrase || passphrase.length < MIN_PASSPHRASE_LENGTH) {
    throw new Error(`Backup passphrase must be at least ${MIN_PASSPHRASE_LENGTH} characters.`);
  }
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const header = Buffer.from(JSON.stringify({ kdf: "scrypt", ...SCRYPT, salt: b64(salt), iv: b64(iv), meta }));
  const len = Buffer.alloc(4);
  len.writeUInt32BE(header.length);
  const cipher = crypto.createCipheriv("aes-256-gcm", deriveScrypt(passphrase, salt), iv);
  cipher.setAAD(Buffer.concat([MAGIC, len, header])); // header is authenticated too
  const ct = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([MAGIC, len, header, ct, cipher.getAuthTag()]);
}

/** Decrypt a backup produced by encryptBuffer. Throws on wrong passphrase/corruption. */
export function decryptBuffer(blob, passphrase) {
  if (!isEncryptedBackup(blob)) throw new Error("Not a MemVault encrypted backup.");
  const len = blob.readUInt32BE(MAGIC.length);
  const hStart = MAGIC.length + 4;
  const header = blob.subarray(hStart, hStart + len);
  const h = JSON.parse(header.toString("utf8"));
  const tag = blob.subarray(blob.length - 16);
  const ct = blob.subarray(hStart + len, blob.length - 16);
  const d = crypto.createDecipheriv(
    "aes-256-gcm",
    deriveScrypt(passphrase, unb64(h.salt), { N: h.N, r: h.r, p: h.p }),
    unb64(h.iv)
  );
  d.setAAD(Buffer.concat([MAGIC, blob.subarray(MAGIC.length, hStart), header]));
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]);
}

/** Read an encrypted backup's (unauthenticated) metadata without decrypting. */
export function peekBackupMeta(blob) {
  if (!isEncryptedBackup(blob)) return null;
  const len = blob.readUInt32BE(MAGIC.length);
  return JSON.parse(blob.subarray(MAGIC.length + 4, MAGIC.length + 4 + len).toString("utf8")).meta || {};
}
