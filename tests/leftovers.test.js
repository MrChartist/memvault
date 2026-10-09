// Regression tests for the last open review findings: INT-8 (scrub keeps the Markdown originals),
// SEC-11 (odd dates are not stored), TST-10 (Perplexity source links carry no query token).
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const fresh = () => {
  const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-left-'));
  const env = { ...process.env, HOME, USERPROFILE: HOME, VAULT_ROOT: path.join(HOME, 'v'), MEMVAULT_TOKEN_FILE: path.join(HOME, 'tok'), MEMVAULT_TOKEN: '', MEMVAULT_AGENT: '' };
  const node = (script, ...args) => spawnSync(process.execPath, [path.join(REPO, script), ...args], { env, encoding: 'utf8', cwd: REPO, timeout: 60000 });
  return { HOME, env, node };
};

describe('SEC-11 dates', () => {
  it('keeps real dates and drops nonsense, future and pre-web dates', async () => {
    const { cleanDate } = await import('../ingest.mjs');
    expect(cleanDate('2024-05-01T10:00:00Z')).toBe('2024-05-01T10:00:00.000Z');
    for (const bad of ['not a date', '0001-01-01', '1969-12-31', '2999-01-01', '', null, undefined, '9'.repeat(30)]) expect(cleanDate(bad)).toBeUndefined();
  });
});

describe('INT-8 scrub keeps the Markdown originals', () => {
  it('copies each file it changes before changing it', () => {
    const { HOME, node } = fresh();
    node('cli.mjs', 'setup');
    const dir = path.join(HOME, 'v', 'entries'); fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'note.md');
    const key = 'sk-ant-api03-' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0U1v2W3x4Y5z6';
    fs.writeFileSync(file, `my key is ${key}\n`);
    const r = node('cli.mjs', 'scrub', '--apply');
    expect(r.status).toBe(0);
    expect(fs.readFileSync(file, 'utf8')).not.toContain(key);
    const root = path.join(HOME, 'v', 'backups');
    const kept = fs.readdirSync(root).filter((d) => d.startsWith('scrub-files-'));
    expect(kept.length).toBe(1);
    expect(fs.readFileSync(path.join(root, kept[0], 'entries', 'note.md'), 'utf8')).toContain(key);
  });
});

describe('TST-10 Perplexity source links', () => {
  it('keeps the address but not the query or fragment', async () => {
    const { HOME, node } = fresh();
    const f = path.join(HOME, 'p.json');
    fs.writeFileSync(f, JSON.stringify([{ title: 'q', messages: [{ role: 'user', content: 'what is the answer to this question' }, { role: 'assistant', content: 'The answer is forty two, as widely documented.' }], search_results: [{ title: 'Doc', url: 'https://example.com/a?session=abc123&email=bob@example.com#frag' }] }]));
    node('import-perplexity.mjs', f);
    const { openVaultDb } = await import('../db.mjs');
    const rows = openVaultDb({ root: path.join(HOME, 'v') }).query('SELECT content FROM items');
    expect(rows.length).toBe(1);
    expect(rows[0].content).toContain('https://example.com/a');
    expect(rows[0].content).not.toMatch(/session=|bob@example|#frag/);
  });
});
