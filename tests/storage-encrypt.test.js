import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'memvault-enc-'));
process.env.VAULT_ROOT = path.join(TMP, 'vault');
const DRIVE = path.join(TMP, 'drive');
const PASS = 'a long backup passphrase 123';
const SECRET_MARKER = 'TOP-SECRET-DIARY-LINE';

let storage, crypto, D;
beforeAll(async () => {
  D = await import('../db.mjs');
  storage = await import('../storage.mjs');
  crypto = await import('../crypto-vault.mjs');
  D.openVaultDb({ root: process.env.VAULT_ROOT }).addItem({ type: 'diary', title: 'x', content: SECRET_MARKER });
  fs.mkdirSync(DRIVE, { recursive: true });
});
afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));
beforeEach(() => { delete process.env.MEMVAULT_BACKUP_PASSPHRASE; });

const base = (extra = {}) => ({
  local: { enabled: true }, keepLocalBackups: 5, encryptCloud: true, allowPlaintextCloud: false, passphraseFile: '',
  gdriveFolder: { enabled: true, path: DRIVE },
  gdriveApi: { enabled: false },
  ...extra,
});

describe('cloud backup policy', () => {
  it('BLOCKS cloud upload when there is no passphrase (fails closed)', async () => {
    const results = await storage.backupVault(base());
    const drive = results.find((r) => r.backend === 'gdriveFolder');
    expect(drive.ok).toBe(false);
    expect(drive.error).toMatch(/MEMVAULT_BACKUP_PASSPHRASE/);
    expect(fs.readdirSync(DRIVE)).toEqual([]); // nothing was written
    expect(results.find((r) => r.backend === 'local').ok).toBe(true); // local backup still works
  });

  it('rejects a weak passphrase', () => {
    process.env.MEMVAULT_BACKUP_PASSPHRASE = 'short';
    expect(storage.cloudPolicy(base()).mode).toBe('blocked');
  });

  it('encrypts what it puts in the Drive folder — no plaintext marker anywhere', async () => {
    process.env.MEMVAULT_BACKUP_PASSPHRASE = PASS;
    const results = await storage.backupVault(base());
    const drive = results.find((r) => r.backend === 'gdriveFolder');
    expect(drive).toMatchObject({ ok: true, encrypted: true });
    const files = fs.readdirSync(path.join(DRIVE, 'MemVault'));
    expect(files.some((f) => f.endsWith('.sqlite.mvbak'))).toBe(true);
    for (const f of files) {
      const bytes = fs.readFileSync(path.join(DRIVE, 'MemVault', f));
      expect(bytes.includes(Buffer.from(SECRET_MARKER))).toBe(false);
    }
    // the manifest must not reveal the local vault path
    const manifest = fs.readFileSync(path.join(DRIVE, 'MemVault', 'MANIFEST.json'), 'utf8');
    expect(manifest).not.toContain(TMP);
    expect(JSON.parse(manifest).encrypted).toBe(true);
  });

  it('the encrypted backup restores with the passphrase, and not without it', async () => {
    process.env.MEMVAULT_BACKUP_PASSPHRASE = PASS;
    const dir = path.join(DRIVE, 'MemVault');
    const file = path.join(dir, fs.readdirSync(dir).find((f) => f.endsWith('.mvbak')));
    // wreck the live vault, then restore
    D.openVaultDb({ root: process.env.VAULT_ROOT }).run('DELETE FROM items');
    expect(() => storage.restoreEncrypted(file, 'wrong passphrase value')).toThrow(/Could not decrypt/);
    expect(storage.restoreEncrypted(file, PASS).ok).toBe(true);
    const rows = D.openVaultDb({ root: process.env.VAULT_ROOT }).query('SELECT content FROM items');
    expect(rows.map((r) => r.content)).toContain(SECRET_MARKER);
    // a pre-restore snapshot was kept
    expect(fs.readdirSync(path.join(process.env.VAULT_ROOT, 'backups')).some((f) => f.startsWith('pre-restore-'))).toBe(true);
  });

  it('plaintext only happens when explicitly allowed, and is flagged', async () => {
    const results = await storage.backupVault(base({ allowPlaintextCloud: true, encryptCloud: false, gdriveFolder: { enabled: true, path: path.join(TMP, 'drive2') } }));
    const drive = results.find((r) => r.backend === 'gdriveFolder');
    expect(drive.ok).toBe(true);
    expect(drive.encrypted).toBe(false);
    expect(drive.warning).toMatch(/WITHOUT encryption/);
    expect(fs.readFileSync(path.join(TMP, 'drive2', 'MemVault', 'MANIFEST.json'), 'utf8')).not.toContain(TMP);
  });

  it('turning encryption off is not enough on its own', () => {
    expect(storage.cloudPolicy(base({ encryptCloud: false })).mode).toBe('blocked');
  });

  it('reads the passphrase from a file when no env var is set', () => {
    const f = path.join(TMP, 'pass.txt');
    fs.writeFileSync(f, PASS + '\nignored second line\n');
    expect(storage.cloudPolicy(base({ passphraseFile: f }))).toMatchObject({ mode: 'encrypted', passphrase: PASS });
  });
});

describe('restoreLocal', () => {
  it('only accepts backup NAMES, never paths', () => {
    expect(() => storage.restoreLocal('../../etc/passwd')).toThrow(/must not contain a path/);
    expect(() => storage.restoreLocal('..\\..\\x')).toThrow();
  });
});
