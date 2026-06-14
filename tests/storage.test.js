import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Point the vault at a throwaway dir BEFORE importing the module under test.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'memvault-store-'));
process.env.VAULT_ROOT = TMP;

let storage;
beforeAll(async () => {
  // Seed a fake DB so backupLocal has something to copy.
  fs.mkdirSync(path.join(TMP, 'db'), { recursive: true });
  fs.writeFileSync(path.join(TMP, 'db', 'index.sqlite'), 'SQLITE-FAKE');
  storage = await import('../storage.mjs');
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

  it('restores a backup back into the live DB', () => {
    const [latest] = storage.listLocalBackups();
    const res = storage.restoreLocal(latest.name);
    expect(res.ok).toBe(true);
    expect(fs.readFileSync(path.join(TMP, 'db', 'index.sqlite'), 'utf8')).toBe('SQLITE-FAKE');
  });

  it('throws on an unknown backup name', () => {
    expect(() => storage.restoreLocal('nope.sqlite')).toThrow();
  });
});
