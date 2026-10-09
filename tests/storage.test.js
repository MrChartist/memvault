import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Point the vault at a throwaway dir BEFORE importing the modules under test.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'memvault-store-'));
process.env.VAULT_ROOT = TMP;
process.env.HOME = process.env.USERPROFILE = path.join(TMP, 'home');

let storage;
let db;
beforeAll(async () => {
  db = await import('../db.mjs');
  storage = await import('../storage.mjs');
  db.addItems([{ type: 'diary', title: 'before backup', content: 'original entry' }]);
});

afterAll(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

describe('storage — backends', () => {
  it('enables local by default and not Drive', () => {
    expect(storage.enabledBackends()).toEqual(['local']);
  });
});

describe('storage — local backup', () => {
  it('creates a timestamped local backup of the DB', async () => {
    const results = await storage.backupVault();
    const local = results.find((r) => r.backend === 'local');
    expect(local.ok).toBe(true);
    expect(fs.existsSync(local.location)).toBe(true);
  });

  it('lists the backup it just created', () => {
    const backups = storage.listLocalBackups();
    expect(backups.length).toBeGreaterThan(0);
    expect(backups[0].name).toMatch(/^index-.*\.sqlite$/);
  });

  it('restores a backup: data written after the backup is rolled back', () => {
    db.addItems([{ type: 'diary', title: 'after backup', content: 'should vanish on restore' }]);
    expect(db.queryAll('SELECT * FROM items').length).toBe(2);

    const [latest] = storage.listLocalBackups();
    expect(storage.restoreLocal(latest.name).ok).toBe(true);

    const titles = db.queryAll('SELECT title FROM items').map((r) => r.title);
    expect(titles).toEqual(['before backup']);
  });

  it('keeps a pre-restore safety snapshot', () => {
    const snaps = fs.readdirSync(path.join(TMP, 'backups')).filter((f) => f.startsWith('pre-restore-'));
    expect(snaps.length).toBeGreaterThan(0);
  });

  it('throws on an unknown backup name', () => {
    expect(() => storage.restoreLocal('index-nope.sqlite')).toThrow(/not found/i);
  });

  it('refuses names that are not plain backup file names (path traversal)', () => {
    for (const evil of ['../../etc/passwd', '..\\..\\secret.sqlite', '/etc/passwd', 'index-../../x.sqlite', 'notes.txt', '']) {
      expect(() => storage.restoreLocal(evil), evil).toThrow(/invalid backup name/i);
    }
  });

  it('refuses to restore a file that is not a SQLite database', () => {
    const bogus = path.join(TMP, 'backups', 'index-bogus.sqlite');
    fs.writeFileSync(bogus, 'this is not a database');
    expect(() => storage.restoreLocal('index-bogus.sqlite')).toThrow(/valid SQLite/i);
    // the live DB is untouched
    expect(db.queryAll('SELECT title FROM items').length).toBe(1);
  });
});

describe('storage — Drive folder mirror', () => {
  it('copies the vault into <folder>/MemVault without lock/temp files', async () => {
    const drive = path.join(TMP, 'drive');
    fs.mkdirSync(drive, { recursive: true });
    fs.writeFileSync(path.join(TMP, 'db', 'index.sqlite.lock'), '');
    fs.writeFileSync(path.join(TMP, 'db', 'x.tmp'), '');

    const results = await storage.backupVault({
      ...(await import('../config.mjs')).STORAGE_CONFIG,
      gdriveFolder: { enabled: true, path: drive },
    });
    const mirror = results.find((r) => r.backend === 'gdriveFolder');
    expect(mirror.ok).toBe(true);
    expect(fs.existsSync(path.join(drive, 'MemVault', 'db', 'index.sqlite'))).toBe(true);
    expect(fs.existsSync(path.join(drive, 'MemVault', 'db', 'index.sqlite.lock'))).toBe(false);
    expect(fs.existsSync(path.join(drive, 'MemVault', 'db', 'x.tmp'))).toBe(false);
    expect(fs.existsSync(path.join(drive, 'MemVault', 'MANIFEST.json'))).toBe(true);
  });
});
