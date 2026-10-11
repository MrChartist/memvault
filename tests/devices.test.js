import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Three "computers" in one test process: each has its own vault and its own home folder, and they share one
// folder, the way Syncthing, iCloud Drive or a server would share it.
let tmp, shared;
const PASS = 'correct horse battery staple';
let dev;

const { openVaultDb } = await import('../db.mjs');
const sync = await import('../device-sync.mjs');
const keys = await import('../device-keys.mjs');
const { saveAgent, getAgent, deleteAgent, blankProfile } = await import('../agents.mjs');

function computer(name) {
  const home = path.join(tmp, name);
  const root = path.join(home, 'vault');
  fs.mkdirSync(root, { recursive: true });
  const vdb = openVaultDb({ root });
  const identity = sync.renameDevice(name, { dir: home });
  const backups = [];
  const run = (extra = {}) => sync.syncDevices({
    vdb, dir: home, identity, passphrase: PASS,
    settings: { enabled: true, folder: shared, intervalMinutes: 5, passphraseFile: path.join(home, 'pp') },
    security: { redact: true, audit: true },
    backup: () => { backups.push(Date.now()); return { ok: true, location: path.join(root, 'backups', 'b.sqlite') }; },
    ...extra,
  });
  const titles = () => vdb.query("SELECT title FROM items ORDER BY title").map((r) => r.title);
  const add = (title, content = 'text', extra = {}) => vdb.addItems([{ type: 'diary', source: 'manual', title, content, created_at: '2026-10-01T10:00:00.000Z', ...extra }])[0];
  return { name, home, root, vdb, identity, run, titles, add, backups };
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'memvault devices '));
  shared = path.join(tmp, 'shared folder');
  fs.mkdirSync(shared);
  dev = { a: computer('MacBook'), b: computer('Windows PC'), c: computer('Linux VPS') };
});
afterEach(() => {
  for (const d of Object.values(dev)) d.vdb.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('two computers share one memory through a folder', () => {
  it('a note written on one computer appears on the other, and syncing again changes nothing', () => {
    dev.a.add('Prefers short answers');
    const first = dev.a.run();
    expect(first.ok, first.problems.join()).toBe(true);
    expect(first.wrote).toBe(true);
    expect(fs.readdirSync(shared)).toEqual([`memvault-${dev.a.identity.id}.mvsync`]);

    const b = dev.b.run();
    expect(b.ok, b.problems.join()).toBe(true);
    expect(b.added).toBe(1);
    expect(dev.b.titles()).toContain('Prefers short answers');

    expect(dev.b.run().added).toBe(0);
    const again = dev.a.run();
    expect(again.added).toBe(0);
    expect(again.wrote).toBe(false); // nothing changed on A since its last file
  });

  it('the shared file holds no readable text', () => {
    dev.a.add('My dentist is Dr. Rao', 'appointment on Friday');
    dev.a.run();
    const blob = fs.readFileSync(path.join(shared, `memvault-${dev.a.identity.id}.mvsync`));
    expect(blob.includes(Buffer.from('dentist'))).toBe(false);
    expect(blob.includes(Buffer.from('MacBook'))).toBe(false);
  });

  it('an edit travels, keeping the time it was made', () => {
    const id = dev.a.add('Plan', 'old');
    dev.a.run(); dev.b.run();
    dev.b.vdb.run("UPDATE items SET content = 'new' WHERE id = ?", [id]);
    const stamp = dev.b.vdb.query('SELECT updated_at FROM items WHERE id = ?', [id])[0].updated_at;
    expect(stamp).toMatch(/^\d{4}-\d\d-\d\dT/);
    dev.b.run();
    expect(dev.a.run().changed).toBe(1);
    const row = dev.a.vdb.query('SELECT content, updated_at FROM items WHERE id = ?', [id])[0];
    expect(row).toEqual({ content: 'new', updated_at: stamp });
  });

  it('a deletion travels, and the note does not come back from the other computer', () => {
    const id = dev.a.add('Old note');
    dev.a.run(); dev.b.run();
    dev.a.vdb.run('DELETE FROM items WHERE id = ?', [id]);
    dev.a.run();
    expect(dev.b.run().deleted).toBe(1);
    expect(dev.b.titles()).not.toContain('Old note');
    dev.b.run(); dev.a.run();
    expect(dev.a.titles()).not.toContain('Old note');
    const gone = (d) => d.vdb.query("SELECT deleted_at FROM tombstones WHERE kind = 'item' AND id = ?", [id])[0]?.deleted_at;
    expect(gone(dev.b)).toBe(gone(dev.a)); // both agree on when it was deleted
  });

  it('when both computers change the same note, the later change wins on both', () => {
    const id = dev.a.add('Shared plan', 'v0');
    dev.a.run(); dev.b.run();
    dev.a.vdb.run("UPDATE items SET content = 'from A' WHERE id = ?", [id]);
    dev.a.vdb.run("UPDATE items SET updated_at = '2026-10-05T10:00:00.000Z' WHERE id = ?", [id]);
    dev.b.vdb.run("UPDATE items SET content = 'from B' WHERE id = ?", [id]);
    dev.b.vdb.run("UPDATE items SET updated_at = '2026-10-05T11:00:00.000Z' WHERE id = ?", [id]);
    for (let i = 0; i < 2; i++) { dev.a.run(); dev.b.run(); }
    const content = (d) => d.vdb.query('SELECT content FROM items WHERE id = ?', [id])[0]?.content;
    expect(content(dev.a)).toBe('from B');
    expect(content(dev.b)).toBe('from B');
  });

  it('a change made after a deletion elsewhere keeps the note on both computers', () => {
    const id = dev.a.add('Keep me', 'v0');
    dev.a.run(); dev.b.run();
    dev.a.vdb.run('DELETE FROM items WHERE id = ?', [id]);
    dev.a.vdb.run("UPDATE tombstones SET deleted_at = '2026-10-05T10:00:00.000Z' WHERE id = ?", [id]);
    dev.b.vdb.run("UPDATE items SET content = 'edited later' WHERE id = ?", [id]);
    dev.b.vdb.run("UPDATE items SET updated_at = '2026-10-05T12:00:00.000Z' WHERE id = ?", [id]);
    for (let i = 0; i < 2; i++) { dev.a.run(); dev.b.run(); }
    const content = (d) => d.vdb.query('SELECT content FROM items WHERE id = ?', [id])[0]?.content;
    expect(content(dev.a)).toBe('edited later');
    expect(content(dev.b)).toBe('edited later');
  });
});

describe('three computers, and one that is switched off', () => {
  it('notes reach a third computer through the second, even when the first is gone', () => {
    dev.a.add('From the MacBook');
    dev.a.run(); dev.b.run(); dev.b.run();
    fs.rmSync(path.join(shared, `memvault-${dev.a.identity.id}.mvsync`)); // the MacBook is off and its file was never copied here
    dev.c.run();
    expect(dev.c.titles()).toContain('From the MacBook');
  });
});

describe('problems are reported, never half-applied', () => {
  it('a file made with a different passphrase is reported and changes nothing', () => {
    dev.a.add('Secret plan');
    dev.a.run({ passphrase: 'a completely different one' });
    const r = dev.b.run();
    expect(r.ok).toBe(false);
    expect(r.problems.join()).toMatch(/different sync passphrase|still being copied/);
    expect(dev.b.titles()).not.toContain('Secret plan');
  });

  it('a half-copied file is skipped while the good ones still merge, and is read again once whole', () => {
    dev.a.add('From A');
    dev.c.add('From C');
    dev.a.run(); dev.c.run();
    const cFile = path.join(shared, `memvault-${dev.c.identity.id}.mvsync`);
    const whole = fs.readFileSync(cFile);
    fs.writeFileSync(cFile, whole.subarray(0, whole.length >> 1));
    const r = dev.b.run();
    expect(r.ok).toBe(false);
    expect(dev.b.titles()).toContain('From A');
    expect(dev.b.titles()).not.toContain('From C');
    fs.writeFileSync(cFile, whole);
    expect(dev.b.run().ok).toBe(true);
    expect(dev.b.titles()).toContain('From C');
  });

  it('conflict copies made by a sync app are ignored', () => {
    dev.a.add('Real');
    dev.a.run();
    const real = path.join(shared, `memvault-${dev.a.identity.id}.mvsync`);
    fs.copyFileSync(real, path.join(shared, `memvault-${dev.a.identity.id}.sync-conflict-20261011-101010-ABCDEFG.mvsync`));
    fs.copyFileSync(real, path.join(shared, `memvault-${dev.a.identity.id} 2.mvsync`));
    expect(sync.peerFiles(shared, dev.b.identity).length).toBe(1);
  });

  it('many deletions from another computer take a backup first', () => {
    for (let i = 0; i < 30; i++) dev.a.add(`note ${i}`, `n${i}`);
    dev.a.run(); dev.b.run();
    dev.a.vdb.run('DELETE FROM items');
    dev.a.run();
    const r = dev.b.run();
    expect(r.deleted).toBe(30);
    expect(dev.b.backups.length).toBe(1);
  });

  it('a backup that fails stops the deletions', () => {
    for (let i = 0; i < 30; i++) dev.a.add(`note ${i}`, `n${i}`);
    dev.a.run(); dev.b.run();
    dev.a.vdb.run('DELETE FROM items');
    dev.a.run();
    const r = dev.b.run({ backup: () => ({ ok: false, error: 'disk full' }) });
    expect(r.ok).toBe(false);
    expect(r.problems.join()).toMatch(/backup taken first failed/);
    expect(dev.b.titles().length).toBe(30);
  });

  it('what comes in is masked for secrets, like every other write', () => {
    const key = 'ghp_' + 'abcdefghijklmnopqrstuvwxyz0123456789';
    const snap = sync.snapshot(dev.a.vdb, dev.a.identity);
    snap.items.push({ id: 'diary_x1', type: 'diary', source: 'manual', title: 'token', content: `use ${key}`, created_at: '2026-10-02T00:00:00.000Z', scope: 'shared' });
    sync.writeOwnFile(shared, dev.a.identity, sync.encodeSnapshot(snap, PASS));
    dev.b.run();
    const row = dev.b.vdb.query("SELECT content FROM items WHERE id = 'diary_x1'")[0];
    expect(row.content).not.toContain(key);
    expect(row.content).toMatch(/REDACTED/);
  });
});

describe('what is shared, and what stays on each computer', () => {
  it('agents travel, and so does deleting one', () => {
    saveAgent(dev.a.vdb, { ...blankProfile('travel-helper'), name: 'Travel Helper', role: 'Plans trips' });
    dev.a.run(); dev.b.run();
    expect(getAgent(dev.b.vdb, 'travel-helper')?.name).toBe('Travel Helper');
    deleteAgent(dev.a.vdb, 'travel-helper');
    dev.a.run(); dev.b.run();
    expect(getAgent(dev.b.vdb, 'travel-helper')).toBe(null);
  });

  it('the Secure Vault and uploaded files stay on the computer they are on', () => {
    dev.a.vdb.run("INSERT INTO secrets (id, category, label, encrypted, created_at, updated_at) VALUES ('s1','password','bank','x','t','t')");
    dev.a.vdb.addItems([{ type: 'file', source: 'manual', title: 'scan.pdf', file_path: '/tmp/scan.pdf' }]);
    dev.a.run(); dev.b.run();
    expect(dev.b.vdb.query('SELECT COUNT(*) AS n FROM secrets')[0].n).toBe(0);
    expect(dev.b.vdb.query("SELECT COUNT(*) AS n FROM items WHERE type = 'file'")[0].n).toBe(0);
  });

  it('private agent notes keep their space, and an agent\'s own view shows no deletion records', () => {
    dev.a.add('Only for the study buddy', 'x', { scope: 'agent:study-buddy', agent_id: 'study-buddy' });
    const gone = dev.a.add('deleted');
    dev.a.vdb.run('DELETE FROM items WHERE id = ?', [gone]);
    dev.a.run(); dev.b.run();
    expect(dev.b.vdb.query("SELECT scope FROM items WHERE title = 'Only for the study buddy'")[0].scope).toBe('agent:study-buddy');
    const agentView = openVaultDb({ root: dev.b.root, scope: { agentId: 'writer', readScopes: [] } });
    try {
      expect(agentView.query('SELECT COUNT(*) AS n FROM tombstones')[0].n).toBe(0);
      expect(agentView.query("SELECT COUNT(*) AS n FROM items WHERE scope = 'agent:study-buddy'")[0].n).toBe(0);
    } finally { agentView.close(); }
  });

  it('each computer keeps its own identity, outside the vault folder', () => {
    expect(dev.a.identity.id).not.toBe(dev.b.identity.id);
    expect(fs.existsSync(path.join(dev.a.home, 'device.json'))).toBe(true);
    expect(fs.readdirSync(dev.a.root)).not.toContain('device.json');
  });
});

describe('every write path is tracked, so nothing can be missed', () => {
  it('deleting through SQL records a deletion; adding the note back clears it', () => {
    const id = dev.a.add('x');
    dev.a.vdb.run('DELETE FROM items WHERE id = ?', [id]);
    expect(dev.a.vdb.query("SELECT COUNT(*) AS n FROM tombstones WHERE id = ?", [id])[0].n).toBe(1);
    dev.a.add('x'); // same note, same date: same id
    expect(dev.a.vdb.query("SELECT COUNT(*) AS n FROM tombstones WHERE id = ?", [id])[0].n).toBe(0);
  });
  it('a new note has no change time until it is changed', () => {
    const id = dev.a.add('fresh');
    expect(dev.a.vdb.query('SELECT updated_at FROM items WHERE id = ?', [id])[0].updated_at).toBe(null);
    dev.a.vdb.run("UPDATE items SET tags = 'x' WHERE id = ?", [id]);
    expect(dev.a.vdb.query('SELECT updated_at FROM items WHERE id = ?', [id])[0].updated_at).not.toBe(null);
  });
});

describe('phones and tablets', () => {
  const file = () => path.join(tmp, 'keys.json');
  it('a pairing code works once, then the phone has a key of its own that can be signed out', () => {
    const { code } = keys.createPairingCode({ name: 'iPhone', file: file() });
    expect(code).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
    const got = keys.redeemPairingCode(code.toLowerCase(), { file: file() }); // typed in small letters on a phone
    expect(got?.key).toMatch(/^mvd_/);
    expect(keys.redeemPairingCode(code, { file: file() })).toBe(null); // once only
    expect(keys.deviceKeyMatches(got.key, { file: file() })).toBe(got.id);
    expect(keys.deviceKeyMatches('mvd_wrong', { file: file() })).toBe(null);
    expect(JSON.stringify(JSON.parse(fs.readFileSync(file(), 'utf8')))).not.toContain(got.key); // only a hash is kept
    expect(keys.forgetDeviceKey(got.id, { file: file() })).toBe(true);
    expect(keys.deviceKeyMatches(got.key, { file: file() })).toBe(null);
  });
  it('a code expires after 10 minutes', () => {
    const t = Date.now();
    const { code } = keys.createPairingCode({ file: file(), now: t });
    expect(keys.redeemPairingCode(code, { file: file(), now: t + 11 * 60_000 })).toBe(null);
  });
  it('only a private address is accepted for phones', () => {
    let saved = {};
    const io = { load: () => ({}), save: (c) => { saved = c; } };
    expect(keys.addHubAddress('https://my-server.tail1234.ts.net', io)).toEqual({ host: 'my-server.tail1234.ts.net', origin: 'https://my-server.tail1234.ts.net' });
    expect(saved.security.allowedOrigins).toEqual(['https://my-server.tail1234.ts.net']);
    expect(keys.addHubAddress('http://100.101.102.103:7799', io).host).toBe('100.101.102.103:7799');
    expect(() => keys.addHubAddress('http://192.168.1.20:7799', io)).toThrow(/https/);
    expect(() => keys.addHubAddress('https://x.ts.net/dashboard', io)).toThrow(/without a path/);
  });
});
