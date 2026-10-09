import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'memvault-secrets-'));
process.env.VAULT_ROOT = TMP;
process.env.HOME = process.env.USERPROFILE = path.join(TMP, 'home');

let secrets;
let db;
beforeAll(async () => {
  secrets = await import('../secrets.mjs');
  db = await import('../db.mjs');
});
afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));

/** The exact format earlier MemVault versions wrote — must keep decrypting. */
function legacyEncrypt(plaintext, password) {
  const key = crypto.pbkdf2Sync(password, 'memvault-salt-v1', 100_000, 32, 'sha256');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return JSON.stringify({ iv: iv.toString('base64'), authTag: cipher.getAuthTag().toString('base64'), ciphertext: ct.toString('base64') });
}

describe('secrets — encryption', () => {
  it('round-trips unicode text', () => {
    const blob = secrets.encrypt('pässwörd 🔐 {"a":1}', 'master-password');
    expect(secrets.decrypt(blob, 'master-password')).toBe('pässwörd 🔐 {"a":1}');
  });

  it('writes the v2 format with a per-secret random salt and fresh IV', () => {
    const a = JSON.parse(secrets.encrypt('same', 'pw-12345678'));
    const b = JSON.parse(secrets.encrypt('same', 'pw-12345678'));
    expect(a.v).toBe(2);
    expect(a.iter).toBeGreaterThanOrEqual(600_000);
    expect(a.salt).not.toBe(b.salt);
    expect(a.iv).not.toBe(b.iv);
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });

  it('rejects the wrong password', () => {
    expect(() => secrets.decrypt(secrets.encrypt('x', 'right-password'), 'wrong-password')).toThrow();
  });

  it('detects tampering (GCM auth tag)', () => {
    const blob = JSON.parse(secrets.encrypt('top secret', 'master-password'));
    const ct = Buffer.from(blob.ciphertext, 'base64');
    ct[0] ^= 0xff;
    blob.ciphertext = ct.toString('base64');
    expect(() => secrets.decrypt(JSON.stringify(blob), 'master-password')).toThrow();
  });

  it('still decrypts secrets written by earlier versions (v1)', () => {
    expect(secrets.decrypt(legacyEncrypt('{"k":"old"}', 'old-password'), 'old-password')).toBe('{"k":"old"}');
  });

  it('refuses unknown formats and absurd KDF parameters', () => {
    expect(() => secrets.decrypt(JSON.stringify({ v: 99 }), 'pw')).toThrow(/Unsupported/);
    const blob = JSON.parse(secrets.encrypt('x', 'master-password'));
    blob.iter = 1; // would make brute force trivial
    expect(() => secrets.decrypt(JSON.stringify(blob), 'master-password')).toThrow(/KDF/);
    blob.iter = 2 ** 31; // would hang the process
    expect(() => secrets.decrypt(JSON.stringify(blob), 'master-password')).toThrow(/KDF/);
  });
});

describe('secrets — master password', () => {
  it('has no master password until first use', () => {
    expect(secrets.hasSentinel()).toBe(false);
  });

  it('rejects empty and too-short passwords on first use without creating one', () => {
    expect(secrets.authenticate('')).toMatchObject({ ok: false, status: 400 });
    expect(secrets.authenticate(undefined)).toMatchObject({ ok: false, status: 400 });
    expect(secrets.authenticate('short')).toMatchObject({ ok: false, status: 400 });
    expect(secrets.hasSentinel()).toBe(false);
  });

  it('first valid password becomes the master password', () => {
    expect(secrets.authenticate('correct horse battery')).toEqual({ ok: true, created: true });
    expect(secrets.hasSentinel()).toBe(true);
  });

  it('afterwards only that password works', () => {
    expect(secrets.authenticate('correct horse battery')).toEqual({ ok: true });
    expect(secrets.authenticate('another password')).toMatchObject({ ok: false, status: 401 });
    expect(secrets.authenticate('short')).toMatchObject({ ok: false, status: 401 });
  });

  it('accepts a legacy (v1) sentinel from an older vault', () => {
    db.run('INSERT OR REPLACE INTO secrets (id,category,label,encrypted,created_at,updated_at) VALUES (?,?,?,?,?,?)', [
      secrets.SENTINEL_ID, 'system', secrets.SENTINEL_ID, legacyEncrypt('memvault-ok', 'legacy-master'), 'x', 'x',
    ]);
    expect(secrets.authenticate('legacy-master')).toEqual({ ok: true });
    expect(secrets.authenticate('correct horse battery')).toMatchObject({ ok: false, status: 401 });
  });
});
