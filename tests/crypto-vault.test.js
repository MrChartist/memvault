import { describe, it, expect } from 'vitest';
import crypto from 'crypto';
import {
  encryptString, decryptString, isLegacyBlob,
  encryptBuffer, decryptBuffer, isEncryptedBackup, peekBackupMeta,
} from '../crypto-vault.mjs';

const PW = 'correct horse battery staple';

/** Build a blob exactly the way v1 (server.mjs before this change) did. */
function legacyEncrypt(plaintext, password) {
  const key = crypto.pbkdf2Sync(password, 'memvault-salt-v1', 100_000, 32, 'sha256');
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(plaintext, 'utf8'), c.final()]);
  return JSON.stringify({
    iv: iv.toString('base64'),
    authTag: c.getAuthTag().toString('base64'),
    ciphertext: ct.toString('base64'),
  });
}

describe('crypto — secret strings', () => {
  it('round-trips v2', () => {
    const blob = encryptString('{"key":"sk-123"}', PW, 'secret_1');
    expect(JSON.parse(blob).v).toBe(2);
    expect(decryptString(blob, PW, 'secret_1')).toBe('{"key":"sk-123"}');
  });

  it('uses a fresh random salt and IV every time', () => {
    const a = JSON.parse(encryptString('same', PW));
    const b = JSON.parse(encryptString('same', PW));
    expect(a.salt).not.toBe(b.salt);
    expect(a.iv).not.toBe(b.iv);
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });

  it('rejects a wrong passphrase', () => {
    expect(() => decryptString(encryptString('x', PW), 'wrong passphrase!!')).toThrow();
  });

  it('binds the ciphertext to its context (blob swapped to another record fails)', () => {
    const blob = encryptString('x', PW, 'secret_A');
    expect(() => decryptString(blob, PW, 'secret_B')).toThrow();
  });

  it('detects tampering', () => {
    const env = JSON.parse(encryptString('hello world', PW));
    const raw = Buffer.from(env.ciphertext, 'base64');
    raw[0] ^= 0xff;
    env.ciphertext = raw.toString('base64');
    expect(() => decryptString(JSON.stringify(env), PW)).toThrow();
  });

  it('still decrypts legacy v1 blobs, and flags them for upgrade', () => {
    const old = legacyEncrypt('{"user":"rohit"}', PW);
    expect(isLegacyBlob(old)).toBe(true);
    expect(decryptString(old, PW)).toBe('{"user":"rohit"}');
    expect(isLegacyBlob(encryptString('x', PW))).toBe(false);
  });

  it('refuses unknown future formats instead of guessing', () => {
    const env = { ...JSON.parse(encryptString('x', PW)), v: 99 };
    expect(() => decryptString(JSON.stringify(env), PW)).toThrow(/Unsupported/);
  });
});

describe('crypto — backups', () => {
  const data = crypto.randomBytes(100_000);

  it('round-trips a binary backup and hides the plaintext', () => {
    const enc = encryptBuffer(data, PW, { vault: 'abc' });
    expect(isEncryptedBackup(enc)).toBe(true);
    expect(enc.includes(data.subarray(0, 64))).toBe(false);
    expect(decryptBuffer(enc, PW).equals(data)).toBe(true);
    expect(peekBackupMeta(enc)).toEqual({ vault: 'abc' });
  });

  it('rejects the wrong passphrase and any bit-flip (body or header)', () => {
    const enc = encryptBuffer(data, PW);
    expect(() => decryptBuffer(enc, 'not the passphrase')).toThrow();

    const body = Buffer.from(enc);
    body[body.length - 40] ^= 1;
    expect(() => decryptBuffer(body, PW)).toThrow();

    const hdr = Buffer.from(enc);
    hdr[12] ^= 1; // inside the JSON header
    expect(() => decryptBuffer(hdr, PW)).toThrow();
  });

  it('refuses weak passphrases and non-backups', () => {
    expect(() => encryptBuffer(data, 'short')).toThrow(/at least/);
    expect(() => decryptBuffer(Buffer.from('plain sqlite bytes'), PW)).toThrow(/Not a MemVault/);
  });
});
