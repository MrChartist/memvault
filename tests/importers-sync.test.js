// Proposed regression tests for importers + capture engines (each failing test = a finding in REPORT.md). Copy to tests/.
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'fs'; import os from 'os'; import path from 'path';
import { spawnSync, execSync } from 'child_process';
import { fileURLToPath } from 'url';
const here = path.dirname(fileURLToPath(import.meta.url)); const REPO = path.join(here, '..');
const KEY = 'sk-ant-api03-' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0U1v2W3x4Y5z6';
let HOME, ROOT, W;
beforeEach(() => { HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-imp-')); ROOT = path.join(HOME, 'v'); W = path.join(HOME, 'in'); fs.mkdirSync(W); });
const env = () => ({ ...process.env, HOME, USERPROFILE: HOME, VAULT_ROOT: ROOT, MEMVAULT_TOKEN_FILE: path.join(HOME, 'tok') });
const node = (script, ...args) => spawnSync(process.execPath, [path.join(REPO, script), ...args], { env: env(), encoding: 'utf8', cwd: REPO, timeout: 60000 });
async function items() {
  const { openVaultDb } = await import(path.join(REPO, 'db.mjs'));
  const db = openVaultDb({ root: ROOT }); const r = db.query('SELECT source,title,content,created_at FROM items ORDER BY rowid'); db.close?.(); return r;
}
const wr = (n, o) => { const p = path.join(W, n); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(o)); return p; };
const m = (role, t, ts, parts) => ({ author: { role }, create_time: ts, content: { content_type: 'text', parts: parts || [t] } });

describe('ChatGPT importer', () => {
  const tree = { // ChatGPT mapping tree shape (importer parser + recalled export fields)
    root: { message: null, parent: null, children: ['u1'] },
    u1: { message: m('user', 'hello ' + KEY, 1700000000), parent: 'root', children: ['a1', 'a1b'] },
    a1: { message: m('assistant', 'DISCARDED', 1700000010), parent: 'u1', children: [] },
    a1b: { message: m('assistant', 'KEPT', 1700000020), parent: 'u1', children: [] },
  };
  const conv = [{ title: 'T', create_time: 1700000000, mapping: tree, current_node: 'a1b' }];
  it('masks secrets and audits', async () => {
    node('import-chatgpt.mjs', wr('c.json', conv));
    const r = await items(); expect(r.length).toBe(1); expect(r[0].content).not.toContain(KEY);
    expect(fs.readFileSync(path.join(ROOT, 'audit.log'), 'utf8')).not.toContain(KEY);
  });
  it('TST-1 keeps the conversation date', async () => {
    node('import-chatgpt.mjs', wr('c.json', conv));
    expect((await items())[0].created_at.slice(0, 10)).toBe('2023-11-14');
  });
  it('TST-2 re-import does not duplicate', async () => {
    const p = wr('c.json', conv); node('import-chatgpt.mjs', p); node('import-chatgpt.mjs', p);
    expect((await items()).length).toBe(1);
  });
  it('TST-3 omits regenerated (non-current) branch', async () => {
    node('import-chatgpt.mjs', wr('c.json', conv)); const c = (await items())[0].content;
    expect(c).toContain('KEPT'); expect(c).not.toContain('DISCARDED');
  });
  it('TST-6 one null element does not lose the valid conversations', async () => {
    node('import-chatgpt.mjs', wr('c.json', [conv[0], null, { ...conv[0], title: 'Second one', create_time: 1700000500 }]));
    expect((await items()).length).toBeGreaterThanOrEqual(2);
  });
});
describe('Claude importer', () => {
  it('TST-7 uses content[] when text is empty', async () => {
    node('import-claude.mjs', wr('c.json', [{ name: 'n', created_at: '2024-05-01T10:00:00Z', chat_messages: [
      { sender: 'human', text: 'q', created_at: 'x' }, { sender: 'assistant', text: '', content: [{ type: 'text', text: 'ANSWER-IN-BLOCKS' }] }] }]));
    expect((await items())[0].content).toContain('ANSWER-IN-BLOCKS');
  });
  it('TST-1 keeps date', async () => {
    node('import-claude.mjs', wr('c.json', [{ name: 'n', created_at: '2024-05-01T10:00:00Z', chat_messages: [{ sender: 'human', text: 'hello there' }] }]));
    expect((await items())[0].created_at.slice(0, 10)).toBe('2024-05-01');
  });
});
describe('Gemini importer (Takeout shape recalled from memory)', () => {
  it('TST-8 stores the answer and strips the "Prompted " prefix', async () => {
    node('import-gemini.mjs', wr('MyActivity.json', [{ header: 'Gemini Apps', title: 'Prompted What is the capital of France?', time: '2024-03-01T09:00:00Z', products: ['Gemini Apps'], safeHtmlItem: [{ html: '<p>Paris is the capital.</p>' }] }]));
    const c = (await items())[0].content; expect(c).toContain('Paris'); expect(c).not.toMatch(/### .*User\nPrompted/);
  });
  it('does not store header-only junk', async () => {
    node('import-gemini.mjs', wr('MyActivity.json', [{ header: 'Gemini Apps', time: '2024-03-06T09:00:00Z', products: ['Gemini Apps'] }]));
    expect((await items()).length).toBe(0);
  });
});
describe('import-all', () => {
  it('TST-9 imports a Claude export that sits beside a Takeout folder', async () => {
    wr('conversations.json', [{ name: 'n', chat_messages: [{ sender: 'human', text: 'claude hello there' }] }]);
    wr('Takeout/My Activity/Gemini Apps/MyActivity.json', [{ header: 'Gemini Apps', title: 'Prompted hello gemini how are you', time: '2024-03-01T09:00:00Z', products: ['Gemini Apps'] }]);
    node('import-all.mjs', W);
    expect((await items()).some((i) => i.source === 'claude-import')).toBe(true);
  });
});
describe('capture engines', () => {
  it('TST-11 sync-browser runs, keeps no query strings or local pages, and does not repeat itself', async () => {
    const d = path.join(HOME, '.config', 'chromium', 'Default'); fs.mkdirSync(d, { recursive: true });
    const bm = (name, url) => ({ type: 'url', name, url, date_added: '13300000000000000' });
    fs.writeFileSync(path.join(d, 'Bookmarks'), JSON.stringify({ roots: { b: { name: 'B', type: 'folder', children: [
      bm('Reset', 'https://example.com/a/reset?token=abc&email=bob@example.com&q=my+secret+search#frag'),
      bm('Dev server', 'http://localhost:3000/admin'), bm('Router', 'http://192.168.1.1/settings'), bm('Extension', 'chrome://settings'),
    ] } } }));
    const r = node('sync-browser.mjs', '--force'); expect(r.stdout + r.stderr).not.toMatch(/ReferenceError/);
    node('sync-browser.mjs', '--force'); // a second run adds nothing
    const rows = await items();
    expect(rows).toHaveLength(1);
    expect(rows[0].content).toContain('https://example.com/a/reset');
    expect(rows[0].content).not.toMatch(/bob@example|my\+secret|token=|#frag|localhost|192\.168/);
  });
  it('TST-18 sync-git captures commits (incl. ones with double quotes)', async () => {
    const repo = path.join(HOME, 'proj'); fs.mkdirSync(repo);
    const g = (c) => execSync(c, { cwd: repo, stdio: 'pipe', env: { ...process.env, HOME } });
    g('git init -q && git config user.email a@b.c && git config user.name T && echo a>a && git add a');
    g('git commit -q -m "plain commit"'); g('echo b>b && git add b && git commit -q -m \'fix the "login" page\'');
    node('sync-git.mjs', '--force', '--path', repo); const r = await items();
    expect(r.length).toBeGreaterThanOrEqual(2);
  });
  it('TST-12 engines are inert with default config when run directly', async () => {
    fs.mkdirSync(path.join(HOME, 'Documents')); fs.writeFileSync(path.join(HOME, 'Documents', 'secret-plan.md'), 'x');
    node('sync-files.mjs'); node('sync-system.mjs'); node('sync-git.mjs'); node('sync-vscode.mjs'); node('sync-browser.mjs');
    expect((await items()).length).toBe(0);
  });
  it('TST-15 sync-system keeps to basic facts: no host name, no addresses, no running programs or their command lines', async () => {
    node('sync-system.mjs', '--force');
    const all = (await items()).map((i) => `${i.title}\n${i.content}`).join('\n');
    expect(all.length).toBeGreaterThan(50); // it did capture something
    expect(all).not.toContain(os.hostname());
    expect(all).not.toMatch(/\b(?:\d{1,3}\.){3}\d{1,3}\b/); // no IPv4 addresses
    expect(all).not.toMatch(/Running Processes|Top Processes|Network/i);
  });
  it('TST-17 sync-antigravity does not delete earlier items when the brain dir is missing', async () => {
    const { ingest } = await import(path.join(REPO, 'ingest.mjs'));
    // seed through a child process so the module-level VAULT_ROOT is the isolated one
    spawnSync(process.execPath, ['--input-type=module', '-e', `import {ingest} from ${JSON.stringify(path.join(REPO, 'ingest.mjs'))}; ingest({type:'worklog',source:'antigravity',title:'old',content:'c',tags:'antigravity,conv:abcd1234'});`], { env: env() });
    node('sync-antigravity.mjs'); expect((await items()).length).toBe(1);
  });
});
