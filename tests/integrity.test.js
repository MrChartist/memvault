import { describe, it, expect, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { FileLock } from '../filelock.mjs';
import { openVaultDb } from '../db.mjs';
import { audit, tailAudit, auditPath } from '../audit.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'memvault-int-'));
afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));
const fresh = (n) => fs.mkdtempSync(path.join(TMP, n + '-'));

describe('lock ownership', () => {
  it('a lock that was taken over is not deleted by its old owner', () => {
    const file = path.join(fresh('lk'), 'x.lock');
    const a = new FileLock(file);
    a.acquire();
    fs.unlinkSync(file); // someone judged it stale and removed it ...
    const b = new FileLock(file);
    b.acquire(); // ... and took it
    expect(a.holds()).toBe(false);
    expect(b.holds()).toBe(true);
    a.release(); // must not remove B's lock
    expect(fs.existsSync(file)).toBe(true);
    expect(b.holds()).toBe(true);
    b.release();
    expect(fs.existsSync(file)).toBe(false);
  });
});

describe('lock left empty by a crash', () => {
  it('is taken over after about a second, not after the full 15 s age limit', () => {
    const file = path.join(fresh('empty'), 'x.lock');
    fs.writeFileSync(file, ''); // killed between creating the lock and writing its owner into it
    const old = new Date(Date.now() - 2000);
    fs.utimesSync(file, old, old);
    const t0 = Date.now();
    const l = new FileLock(file);
    l.acquire();
    expect(Date.now() - t0).toBeLessThan(1500);
    expect(l.holds()).toBe(true);
    l.release();
  });
});

describe('a write that outlives its lock is not lost', () => {
  it('both writers\' rows survive when a slow writer\'s lock is taken over', async () => {
    const root = fresh('slow');
    openVaultDb({ root }); // create the file
    const env = { ...process.env, MEMVAULT_LOCK_STALE_MS: '800' };
    const slow = spawn(process.execPath, [path.join(here, 'fixtures', 'slow-writer.mjs'), root, 'SLOW', '2200'], { env, stdio: 'ignore' });
    const exited = new Promise((r) => slow.on('exit', r));
    await new Promise((r) => setTimeout(r, 1300)); // the slow writer's lock is now older than the limit
    const other = spawn(process.execPath, [path.join(here, 'fixtures', 'slow-writer.mjs'), root, 'QUICK', '0'], { env, stdio: 'ignore' });
    await new Promise((r) => other.on('exit', r));
    expect(await exited).toBe(0);
    const titles = openVaultDb({ root }).query('SELECT title FROM items ORDER BY title').map((r) => r.title);
    expect(titles).toEqual(['QUICK', 'SLOW']);
  }, 30000);
});

describe('audit log after an interrupted write', () => {
  it('keeps recording after a half-written last line, on its own line', () => {
    const root = fresh('aud');
    audit({ actor: 'a', action: 'one' }, root);
    fs.appendFileSync(auditPath(root), '{"ts":"2026-01-01T00:0'); // power cut in the middle of a line
    expect(audit({ actor: 'b', action: 'two' }, root)).toBe(true);
    expect(audit({ actor: 'c', action: 'three' }, root)).toBe(true);
    expect(tailAudit(10, {}, root).map((r) => r.action)).toEqual(['one', 'two', 'three']);
  });
});

describe('database file safety', () => {
  it('refuses a vault made by a newer MemVault instead of quietly rewriting its version', () => {
    const root = fresh('new');
    openVaultDb({ root }).run("UPDATE meta SET value = '99' WHERE key = 'schema_version'");
    expect(() => openVaultDb({ root })).toThrow(/newer/i);
  });

  it('cleans up temporary files left by a crashed write, but not a fresh one', () => {
    const root = fresh('tmp');
    const v = openVaultDb({ root });
    const dir = path.join(root, 'db');
    const old = path.join(dir, 'index.sqlite.4242.tmp');
    const young = path.join(dir, 'index.sqlite.4343.tmp');
    fs.writeFileSync(old, 'x'); fs.writeFileSync(young, 'x');
    const longAgo = new Date(Date.now() - 3600_000);
    fs.utimesSync(old, longAgo, longAgo);
    v.close();
    openVaultDb({ root });
    expect(fs.existsSync(old)).toBe(false);
    expect(fs.existsSync(young)).toBe(true);
  });
});
