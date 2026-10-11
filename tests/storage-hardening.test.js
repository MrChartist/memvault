import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import crypto from 'crypto';

// A throwaway home and vault. config.mjs fixes the path of ~/.memvaultrc.json when it is first
// imported, so everything that reads it is imported below, after these are set.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'memvault-harden-'));
const HOME = path.join(TMP, 'home');
const VAULT = path.join(TMP, 'vault');
fs.mkdirSync(HOME, { recursive: true });
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;
process.env.VAULT_ROOT = VAULT;
process.env.MEMVAULT_TOKEN_FILE = path.join(HOME, '.memvault', 'api-token');

let C, dbm, A, B, S, F;

beforeAll(async () => {
  C = await import('../config.mjs');
  if (!C.CONFIG_FILE.startsWith(HOME)) throw new Error(`refusing to run: config file is ${C.CONFIG_FILE}`);
  dbm = await import('../db.mjs');
  A = await import('../audit.mjs');
  B = await import('../mcp-bridge.mjs');
  S = await import('../server.mjs');
  F = await import('../filelock.mjs');
});

afterAll(() => {
  vi.restoreAllMocks();
  fs.rmSync(TMP, { recursive: true, force: true });
});

const freshRoot = () => fs.mkdtempSync(path.join(TMP, 'v-'));
const errno = (code, msg) => Object.assign(new Error(`${code}: ${msg}`), { code });
const titles = (h) => h.query('SELECT title FROM items ORDER BY title').map((r) => r.title);

// ─── db.mjs ─────────────────────────────────────────────────────────────────

describe('db — a failed reload or publish leaves the handle usable and honest', () => {
  it('a reload that fails once (file briefly busy) does not leave the handle stuck', () => {
    const root = freshRoot();
    const server = dbm.openVaultDb({ root }); // long-lived handle
    const other = dbm.openVaultDb({ root });  // another process writing the same file
    server.query('SELECT 1');
    other.addItem({ type: 'diary', title: 'from another app' });

    const real = fs.readFileSync;
    let once = true;
    const spy = vi.spyOn(fs, 'readFileSync').mockImplementation(function (p, ...a) {
      if (once && String(p).endsWith('index.sqlite')) { once = false; throw errno('EBUSY', 'resource busy or locked'); }
      return real.call(this, p, ...a);
    });
    try {
      expect(() => server.query('SELECT COUNT(*) AS n FROM items')).toThrow(/EBUSY/);
    } finally {
      spy.mockRestore();
    }

    expect(titles(server)).toEqual(['from another app']);
    server.addItem({ type: 'diary', title: 'later' });
    expect(titles(other)).toEqual(['from another app', 'later']);
  });

  it('a file from a newer MemVault refuses every read, then works again once it is put back', () => {
    const root = freshRoot();
    const h = dbm.openVaultDb({ root });
    h.addItem({ type: 'diary', title: 'kept' });
    const file = path.join(root, 'db', 'index.sqlite');
    const good = fs.readFileSync(file);
    dbm.openVaultDb({ root }).run("UPDATE meta SET value = '99' WHERE key = 'schema_version'");
    expect(() => h.query('SELECT 1')).toThrow(/newer/i);
    expect(() => h.query('SELECT 1')).toThrow(/newer/i); // still the real reason, not "database closed"
    fs.writeFileSync(file, good);
    h.invalidate();
    expect(titles(h)).toEqual(['kept']);
  });

  it('a write that never reached the disk (disk full) is not kept in memory or published later', () => {
    const root = freshRoot();
    const h = dbm.openVaultDb({ root });
    h.addItem({ type: 'diary', title: 'first' });

    const real = fs.writeSync;
    const spy = vi.spyOn(fs, 'writeSync').mockImplementation(function (fd, buf, ...a) {
      if (Buffer.isBuffer(buf) && buf.length > 1000) throw errno('ENOSPC', 'no space left on device');
      return real.call(this, fd, buf, ...a);
    });
    try {
      expect(() => h.addItem({ type: 'diary', title: 'FAILED-WRITE' })).toThrow(/ENOSPC/);
    } finally {
      spy.mockRestore();
    }

    expect(titles(h)).toEqual(['first']);
    h.addItem({ type: 'diary', title: 'third' });
    expect(titles(dbm.openVaultDb({ root }))).toEqual(['first', 'third']);
  });
});

// ─── filelock.mjs ───────────────────────────────────────────────────────────

describe('filelock — brief EPERM blips while waiting', () => {
  it('two separate blips more than 3 s apart, with ordinary waiting between them, do not end the wait', () => {
    const file = path.join(freshRoot(), 'x.lock');
    // A virtual clock that moves 200 ms per attempt, so the test does not have to wait for real.
    const t0 = Date.now();
    let attempt = 0;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => t0 + attempt * 200);
    const realOpen = fs.openSync;
    const open = vi.spyOn(fs, 'openSync').mockImplementation(function (p, flags, ...a) {
      if (p === file && flags === 'wx') {
        attempt++;
        // Windows "delete pending": the holder is removing its lock file, and creating it fails for a moment.
        if (attempt === 1 || attempt === 22) throw errno('EPERM', 'operation not permitted, open');
        if (attempt < 23) throw errno('EEXIST', 'file already exists, open'); // held by a live writer
      }
      return realOpen.call(this, p, flags, ...a);
    });
    const lock = new F.FileLock(file);
    try {
      expect(() => lock.acquire()).not.toThrow();
      expect(lock.holds()).toBe(true);
    } finally {
      open.mockRestore();
      clock.mockRestore();
      lock.release();
    }
    expect(attempt).toBe(23);
  });

  it('a lasting permission problem still gives up after about 3 s instead of the full timeout', () => {
    const file = path.join(freshRoot(), 'y.lock');
    const t0 = Date.now();
    let attempt = 0;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => t0 + attempt * 200);
    const open = vi.spyOn(fs, 'openSync').mockImplementation(() => { attempt++; throw errno('EPERM', 'operation not permitted, open'); });
    try {
      expect(() => new F.FileLock(file).acquire()).toThrow(/EPERM/);
    } finally {
      open.mockRestore();
      clock.mockRestore();
    }
    expect(attempt).toBeLessThan(20);
  });
});

// ─── config.mjs + its savers ────────────────────────────────────────────────

const SETTINGS = {
  vaultRoot: '~/somewhere',
  ai: { apiKey: 'gemini-key' },
  storage: { gdriveApi: { enabled: true, clientId: 'id', clientSecret: 'secret', refreshToken: 'refresh' } },
  mcpBridges: [{ name: 'keep-me', command: 'x' }],
};
const BROKEN = JSON.stringify(SETTINGS, null, 2).replace('"ai":', '"ai"'); // one missing colon from a hand edit

const writeConfig = (text) => fs.writeFileSync(C.CONFIG_FILE, text);
const readConfig = () => fs.readFileSync(C.CONFIG_FILE, 'utf8');
const leftovers = () => fs.readdirSync(path.dirname(C.CONFIG_FILE)).filter((f) => f.includes('.memvaultrc') && f.endsWith('.tmp'));

describe('config — a settings file with a mistake is never overwritten', () => {
  it('a missing file is an empty config, for reading and for updating', () => {
    fs.rmSync(C.CONFIG_FILE, { force: true });
    expect(C.loadUserConfig()).toEqual({});
    expect(C.loadUserConfig({ forUpdate: true })).toEqual({});
  });

  it('a broken file still reads as defaults (MemVault starts), but loading it to save refuses and names the file', () => {
    writeConfig(BROKEN);
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(C.loadUserConfig()).toEqual({});
    } finally {
      err.mockRestore();
    }
    expect(() => C.loadUserConfig({ forUpdate: true })).toThrow(C.CONFIG_FILE);
    expect(() => C.loadUserConfig({ forUpdate: true })).toThrow(/JSON mistake/);
    expect(readConfig()).toBe(BROKEN);
  });

  it('bridge add refuses instead of wiping every other setting', () => {
    writeConfig(BROKEN);
    expect(() => B.addPreset('memory')).toThrow(/JSON mistake/);
    expect(readConfig()).toBe(BROKEN);
    writeConfig(JSON.stringify(SETTINGS));
    expect(B.addPreset('memory')).toEqual({ added: true, name: 'memory' });
    const saved = JSON.parse(readConfig());
    expect(saved).toMatchObject({ vaultRoot: SETTINGS.vaultRoot, ai: SETTINGS.ai, storage: SETTINGS.storage });
    expect(saved.mcpBridges.map((b) => b.name)).toEqual(['keep-me', 'memory']);
  });

  it('saves in one step: a disk-full error part-way leaves the old file whole and no temporary file behind', () => {
    const before = JSON.stringify(SETTINGS, null, 2);
    writeConfig(before);
    const huge = { ...SETTINGS, note: 'z'.repeat(5000) };
    const realWFS = fs.writeFileSync;
    const realWS = fs.writeSync;
    const isPayload = (d) => String(d).includes('"note"');
    const a = vi.spyOn(fs, 'writeFileSync').mockImplementation(function (target, data, ...rest) {
      if (isPayload(data)) { realWFS.call(this, target, String(data).slice(0, 100), ...rest); throw errno('ENOSPC', 'no space left on device'); }
      return realWFS.call(this, target, data, ...rest);
    });
    const b = vi.spyOn(fs, 'writeSync').mockImplementation(function (fd, data, ...rest) {
      if (isPayload(data)) { realWS.call(this, fd, String(data).slice(0, 100)); throw errno('ENOSPC', 'no space left on device'); }
      return realWS.call(this, fd, data, ...rest);
    });
    try {
      expect(() => C.saveUserConfig(huge)).toThrow(/ENOSPC/);
    } finally {
      a.mockRestore();
      b.mockRestore();
    }
    expect(readConfig()).toBe(before);
    expect(leftovers()).toEqual([]);
  });

  it.skipIf(process.platform === 'win32')('keeps the saved file private (0600), and a symlinked settings file stays a symlink', () => {
    writeConfig('{}');
    fs.chmodSync(C.CONFIG_FILE, 0o644);
    C.saveUserConfig({ ai: { apiKey: 'k' } });
    expect(fs.statSync(C.CONFIG_FILE).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readConfig())).toEqual({ ai: { apiKey: 'k' } });

    const real = path.join(TMP, 'dotfiles', 'memvaultrc.json');
    fs.mkdirSync(path.dirname(real), { recursive: true });
    fs.writeFileSync(real, '{}');
    fs.rmSync(C.CONFIG_FILE, { force: true });
    fs.symlinkSync(real, C.CONFIG_FILE);
    try {
      C.saveUserConfig({ port: 7800 });
      expect(fs.lstatSync(C.CONFIG_FILE).isSymbolicLink()).toBe(true);
      expect(JSON.parse(fs.readFileSync(real, 'utf8'))).toEqual({ port: 7800 });
    } finally {
      fs.rmSync(C.CONFIG_FILE, { force: true });
    }
    expect(leftovers()).toEqual([]);
  });
});

describe('dashboard settings — a broken settings file is reported, not wiped', () => {
  const TOKEN = 'test-token-' + crypto.randomBytes(8).toString('hex');
  let server, port;

  const req = (method, p, body) => new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const headers = { authorization: `Bearer ${TOKEN}` };
    if (payload) { headers['content-type'] = 'application/json'; headers['content-length'] = Buffer.byteLength(payload); }
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch { /* not json */ }
        resolve({ status: res.statusCode, json });
      });
    });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });

  beforeAll(async () => {
    port = await new Promise((res) => {
      const probe = http.createServer().listen(0, '127.0.0.1', () => { const p = probe.address().port; probe.close(() => res(p)); });
    });
    // No `config` passed: the routes use the real ~/.memvaultrc.json reader and writer (in the throwaway home).
    const app = S.createApp({ vdb: dbm.openVaultDb({ root: VAULT }), token: TOKEN, port, root: VAULT });
    server = await new Promise((res) => { const s = app.listen(port, '127.0.0.1', () => res(s)); });
  });

  afterAll(() => server?.close());

  it('PUT /settings answers with an error naming the file and leaves it untouched', async () => {
    writeConfig(BROKEN);
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect((await req('GET', '/settings')).status).toBe(200); // reading still works, with defaults
      const r = await req('PUT', '/settings', { capture: { git: false } });
      expect(r.status).toBeGreaterThanOrEqual(400);
      expect(r.json.ok).toBe(false);
      expect(r.json.error).toContain(C.CONFIG_FILE);
      expect(r.json.error).toMatch(/JSON mistake/);
    } finally {
      err.mockRestore();
    }
    expect(readConfig()).toBe(BROKEN);
  });

  it('PUT /settings/passphrase refuses before writing anything', async () => {
    writeConfig(BROKEN);
    const passFile = path.join(HOME, '.memvault', 'backup-passphrase');
    fs.rmSync(passFile, { force: true });
    const r = await req('PUT', '/settings/passphrase', { passphrase: 'a long enough phrase', confirm: 'a long enough phrase' });
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(r.json.ok).toBe(false);
    expect(r.json.error).toContain(C.CONFIG_FILE);
    expect(readConfig()).toBe(BROKEN);
    expect(fs.existsSync(passFile)).toBe(false);
  });

  it('once the file is fixed, saving works and keeps every other setting', async () => {
    writeConfig(JSON.stringify(SETTINGS));
    expect((await req('PUT', '/settings', { capture: { git: true } })).status).toBe(200);
    expect((await req('PUT', '/settings/passphrase', { passphrase: 'a long enough phrase', confirm: 'a long enough phrase' })).status).toBe(200);
    const saved = JSON.parse(readConfig());
    expect(saved).toMatchObject({ vaultRoot: SETTINGS.vaultRoot, ai: SETTINGS.ai, mcpBridges: SETTINGS.mcpBridges, sync: { gitEnabled: true } });
    expect(saved.storage.gdriveApi).toEqual(SETTINGS.storage.gdriveApi);
    expect(saved.storage.passphraseFile).toBe(path.join(HOME, '.memvault', 'backup-passphrase'));
  });
});

// ─── audit.mjs ──────────────────────────────────────────────────────────────

describe('audit — a half-written last line (crash, power cut)', () => {
  it('is cut off before the next record, so the log keeps verifying', () => {
    const root = freshRoot();
    A.audit({ actor: 'a', action: 'one' }, root);
    fs.appendFileSync(A.auditPath(root), '{"ts":"2026-01-01T00:0');
    expect(A.audit({ actor: 'b', action: 'two' }, root)).toBe(true);
    expect(A.audit({ actor: 'c', action: 'three' }, root)).toBe(true);
    expect(A.verifyAudit(root)).toEqual({ ok: true, entries: 3 });
    const text = fs.readFileSync(A.auditPath(root), 'utf8');
    expect(text).not.toContain('2026-01-01T00:0');
    expect(text.split('\n').filter(Boolean)).toHaveLength(3);
  });

  it('is cut off even when it is the only thing in the file', () => {
    const root = freshRoot();
    fs.writeFileSync(A.auditPath(root), '{"ts":"20');
    A.audit({ actor: 'a', action: 'one' }, root);
    expect(A.verifyAudit(root)).toEqual({ ok: true, entries: 1 });
  });

  it('a whole record that only lost its line break is kept, not cut', () => {
    const root = freshRoot();
    A.audit({ actor: 'a', action: 'one' }, root);
    const f = A.auditPath(root);
    fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace(/\n$/, ''));
    A.audit({ actor: 'b', action: 'two' }, root);
    expect(A.verifyAudit(root)).toEqual({ ok: true, entries: 2 });
    expect(A.tailAudit(10, {}, root).map((r) => r.action)).toEqual(['one', 'two']);
  });

  it('verifyAudit reports a torn FINAL line as an interrupted write, not tampering', () => {
    const root = freshRoot();
    A.audit({ actor: 'a', action: 'one' }, root);
    A.audit({ actor: 'b', action: 'two' }, root);
    fs.appendFileSync(A.auditPath(root), '{"ts":"2026-01-01T00:0');
    const v = A.verifyAudit(root);
    expect(v).toMatchObject({ ok: true, entries: 2 });
    expect(v.torn).toMatch(/line 3/);
    expect(v.brokenAtLine).toBeUndefined();
  });

  it('a garbled line in the MIDDLE is still a failure', () => {
    const root = freshRoot();
    A.audit({ actor: 'a', action: 'one' }, root);
    fs.appendFileSync(A.auditPath(root), 'not a record\n');
    A.audit({ actor: 'b', action: 'two' }, root);
    expect(A.verifyAudit(root)).toMatchObject({ ok: false, brokenAtLine: 2, reason: 'unparseable line' });
  });

  it('a garbled last line that ends with a line break was not left by a crash, so it is still a failure', () => {
    const root = freshRoot();
    A.audit({ actor: 'a', action: 'one' }, root);
    fs.appendFileSync(A.auditPath(root), 'not a record\n');
    expect(A.verifyAudit(root)).toMatchObject({ ok: false, brokenAtLine: 2, reason: 'unparseable line' });
  });
});
