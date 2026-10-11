import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// The Getting started list: it must tick itself from what is really there, and the record of which AI apps
// connected must hold nothing but what the app says about itself.
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'memvault-setup-'));
process.env.VAULT_ROOT = path.join(ROOT, 'vault');
process.env.MEMVAULT_TOKEN_FILE = path.join(ROOT, 'home', 'api-token');
delete process.env.MEMVAULT_BACKUP_PASSPHRASE;

const { openVaultDb } = await import('../db.mjs');
const { recordApp, listApps, appLabel } = await import('../connected-apps.mjs');
const { setupStatus } = await import('../setup-status.mjs');
const { backupLocal } = await import('../storage.mjs');

const home = path.join(ROOT, 'home');
let vdb;
const step = (s, id) => s.steps.find((x) => x.id === id);

beforeEach(() => {
  fs.rmSync(path.join(home, 'apps'), { recursive: true, force: true });
  vdb = openVaultDb({ root: process.env.VAULT_ROOT });
  vdb.run('DELETE FROM items');
});
afterEach(() => { delete process.env.MEMVAULT_BACKUP_PASSPHRASE; });

describe('which AI apps connected', () => {
  it('keeps one small record per app (and per agent), with only its name, version and times', () => {
    recordApp({ name: 'claude-ai', version: '1.2.3', dir: home, now: new Date('2026-10-01T10:00:00Z') });
    recordApp({ name: 'claude-ai', version: '1.2.4', dir: home, now: new Date('2026-10-02T10:00:00Z') });
    recordApp({ name: 'cursor-vscode', version: '0.9', agent: 'study-buddy', dir: home, now: new Date('2026-10-03T10:00:00Z') });
    const apps = listApps({ dir: home });
    expect(apps.map((a) => a.label)).toEqual(['Cursor', 'Claude Desktop']); // most recent first
    expect(apps[1]).toMatchObject({ version: '1.2.4', first_seen: '2026-10-01T10:00:00.000Z', last_seen: '2026-10-02T10:00:00.000Z', agent: null });
    expect(apps[0].agent).toBe('study-buddy');
    expect(fs.readdirSync(path.join(home, 'apps')).sort()).toEqual(['claude-ai.json', 'cursor-vscode--study-buddy.json']);
  });

  it('an app cannot choose where its record goes, or put control characters on the screen', () => {
    recordApp({ name: '../../evil\u001b[31m\nname', version: 'x'.repeat(500), dir: home });
    const files = fs.readdirSync(path.join(home, 'apps'));
    expect(files).toEqual(['evil-31m-name.json']);
    const [a] = listApps({ dir: home });
    expect(a.name).not.toMatch(/[\u0000-\u001f]/);
    expect(a.version.length).toBeLessThanOrEqual(40);
  });

  it('an app with no name is still counted, and an unknown name is shown as it is', () => {
    recordApp({ dir: home });
    recordApp({ name: 'My Own Client', dir: home });
    expect(listApps({ dir: home }).map((a) => a.label).sort()).toEqual(['An AI app', 'My Own Client']);
    expect(appLabel('Visual Studio Code')).toBe('VS Code');
  });

  it('a damaged record is skipped, and a folder that cannot be written does not throw', () => {
    fs.mkdirSync(path.join(home, 'apps'), { recursive: true });
    fs.writeFileSync(path.join(home, 'apps', 'broken.json'), '{ not json');
    expect(listApps({ dir: home })).toEqual([]);
    const file = path.join(ROOT, 'a-file');
    fs.writeFileSync(file, 'x');
    expect(recordApp({ name: 'x', dir: file })).toBe(null);
  });
});

describe('the Getting started list', () => {
  it('a new vault: only "install" is done', () => {
    const s = setupStatus({ vdb, userConfig: {}, dir: home });
    expect(s.steps.filter((x) => x.done).map((x) => x.id)).toEqual(['install']); // (the backup test comes later)
    expect(s.total).toBe(5);
    expect(s.steps.filter((x) => x.optional).map((x) => x.id)).toEqual(['agents', 'devices', 'phone']);
  });

  it('ticks itself: an app connects, an AI saves a memory, a backup is made, a passphrase is set', () => {
    recordApp({ name: 'claude-ai', dir: home });
    vdb.run("INSERT INTO items (id, type, source, title, content, created_at) VALUES ('n1', 'diary', 'manual', 'typed by me', 'x', '2026-10-01T00:00:00Z')");
    let s = setupStatus({ vdb, userConfig: {}, dir: home });
    expect(step(s, 'connect')).toMatchObject({ done: true, apps: [{ label: 'Claude Desktop' }] });
    expect(step(s, 'try').done).toBe(false); // a note typed in the dashboard does not prove the AI app works

    vdb.run("INSERT INTO items (id, type, source, title, content, created_at) VALUES ('a1', 'diary', 'ai-memory', 'from Claude', 'x', '2026-10-01T00:00:00Z')");
    expect(backupLocal().ok).toBe(true);
    process.env.MEMVAULT_BACKUP_PASSPHRASE = 'a long enough passphrase';
    s = setupStatus({ vdb, userConfig: {}, dir: home });
    expect(step(s, 'try')).toMatchObject({ done: true, saved: 1 });
    expect(step(s, 'backup').done).toBe(true);
    expect(step(s, 'passphrase').done).toBe(true);
    expect(s.done).toBe(s.total);
  });

  it('the passphrase also counts when it is in the private file Settings writes', () => {
    const file = path.join(home, 'backup-passphrase');
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(file, '\n');
    expect(step(setupStatus({ vdb, userConfig: { storage: { passphraseFile: file } }, dir: home }), 'passphrase').done).toBe(false);
    fs.writeFileSync(file, 'a long enough passphrase\n');
    expect(step(setupStatus({ vdb, userConfig: { storage: { passphraseFile: file } }, dir: home }), 'passphrase').done).toBe(true);
  });

  it('"give an app its own helper" is done once an app connects tied to an agent', () => {
    recordApp({ name: 'claude-ai', dir: home });
    expect(step(setupStatus({ vdb, userConfig: {}, dir: home }), 'agents').done).toBe(false);
    recordApp({ name: 'cursor-vscode', agent: 'writer', dir: home });
    expect(step(setupStatus({ vdb, userConfig: {}, dir: home }), 'agents')).toMatchObject({ done: true, apps: [{ label: 'Cursor', agent: 'writer' }] });
  });

  it('device sync switched on but with no other computer seen is not done yet', () => {
    const folder = path.join(ROOT, 'shared');
    fs.mkdirSync(folder, { recursive: true });
    const s = setupStatus({ vdb, userConfig: { devices: { enabled: true, folder } }, dir: home });
    expect(step(s, 'devices')).toMatchObject({ done: false, enabled: true, others: 0 });
  });
});
