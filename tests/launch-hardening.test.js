// Regression tests for the launch-hardening fixes: idempotent sync, "~" in paths, retrieval ranking,
// ChatGPT export shards, upload file names and the documented npx command.
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath, pathToFileURL } from 'url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const imp = (f) => import(pathToFileURL(path.join(REPO, f)).href);
const made = [];
const fresh = () => {
  const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-launch-'));
  made.push(HOME);
  const env = { ...process.env, HOME, USERPROFILE: HOME, VAULT_ROOT: path.join(HOME, 'v'), MEMVAULT_TOKEN_FILE: path.join(HOME, 'tok'), MEMVAULT_TOKEN: '', MEMVAULT_AGENT: '' };
  const node = (script, args = [], opts = {}) =>
    spawnSync(process.execPath, [path.join(REPO, script), ...args], { env, encoding: 'utf8', cwd: opts.cwd || REPO, input: opts.input, timeout: 60000 });
  const db = async () => (await imp('db.mjs')).openVaultDb({ root: path.join(HOME, 'v') });
  return { HOME, env, node, db };
};
afterAll(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });

describe('idempotent ingest — the same thing written twice is stored once', () => {
  it('skips an identical item and says so', async () => {
    const { db } = fresh();
    const d = await db();
    // An item that carries its own timestamp (an imported chat, a commit) is identified by what it is.
    const item = { type: 'diary', source: 'manual', title: 'Same', content: 'Same content', created_at: '2024-05-01T10:00:00Z' };
    const first = d.addItems([item]);
    const again = d.addItems([item]);
    expect(first.inserted).toBe(1);
    expect(again.inserted).toBe(0);
    expect(again.duplicates).toBe(1);
    expect(d.query('SELECT COUNT(*) AS n FROM items')[0].n).toBe(1);
  });

  it('keeps items that differ in content, in scope or in agent', async () => {
    const { db } = fresh();
    const d = await db();
    const at = '2024-05-01T10:00:00Z';
    d.addItems([
      { type: 'diary', source: 'manual', title: 'T', content: 'one', created_at: at },
      { type: 'diary', source: 'manual', title: 'T', content: 'two', created_at: at },
      { type: 'diary', source: 'manual', title: 'T', content: 'one', created_at: at, scope: 'agent:ana', agent_id: 'ana' },
    ]);
    expect(d.query('SELECT COUNT(*) AS n FROM items')[0].n).toBe(3);
  });

  it('notes typed without a timestamp are never merged, even when the text is the same', async () => {
    const { db } = fresh();
    const d = await db();
    d.addItems([{ type: 'diary', source: 'manual', title: 'Daily', content: 'same words' }]);
    d.addItems([{ type: 'diary', source: 'manual', title: 'Daily', content: 'same words' }]);
    expect(d.query("SELECT COUNT(*) AS n FROM items WHERE title = 'Daily'")[0].n).toBe(2);
  });

  it('an upsert item replaces its earlier snapshot instead of piling up', async () => {
    const { db } = fresh();
    const d = await db();
    const snap = (content) => ({ type: 'diary', source: 'system', title: 'Machine', content, upsert: true });
    d.addItems([snap('RAM 8 GB')]);
    d.addItems([snap('RAM 16 GB')]);
    d.addItems([snap('RAM 16 GB')]);
    const rows = d.query("SELECT content FROM items WHERE title = 'Machine'");
    expect(rows.map((r) => r.content)).toEqual(['RAM 16 GB']);
  });

  it('an upsert in one agent scope leaves another agent\'s snapshot alone', async () => {
    const { db } = fresh();
    const d = await db();
    d.addItems([{ type: 'diary', source: 'system', title: 'Machine', content: 'a', upsert: true, scope: 'agent:ana', agent_id: 'ana' }]);
    d.addItems([{ type: 'diary', source: 'system', title: 'Machine', content: 'b', upsert: true }]);
    expect(d.query("SELECT COUNT(*) AS n FROM items WHERE title = 'Machine'")[0].n).toBe(2);
  });

  it('the ingest queue reports what was really stored', async () => {
    const { db, HOME } = fresh();
    const d = await db();
    const { createIngestQueue } = await imp('ingest.mjs');
    const run = () => {
      const q = createIngestQueue({ vdb: d, root: path.join(HOME, 'v'), actor: 'test' });
      q.add({ type: 'diary', source: 'git', title: 'Q', content: 'queued once', created_at: '2024-05-01T10:00:00Z' });
      return q.flush();
    };
    expect(run().stored).toBe(1);
    expect(run().stored).toBe(0);
    expect(d.query("SELECT COUNT(*) AS n FROM items WHERE title = 'Q'")[0].n).toBe(1);
  });
});

describe('capture engines — running them again does not add copies', () => {
  it('system, files and git snapshots stay at one row per thing over three runs', async () => {
    const { HOME, node, db } = fresh();
    const proj = path.join(HOME, 'proj', 'app');
    fs.mkdirSync(proj, { recursive: true });
    fs.writeFileSync(path.join(proj, 'README.md'), '# app\n');
    fs.writeFileSync(path.join(proj, 'package.json'), '{"name":"app"}\n');
    const git = (...a) => spawnSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', ...a], { cwd: proj, encoding: 'utf8' });
    git('init', '-q');
    git('commit', '-q', '--allow-empty', '-m', 'first commit');
    const counts = [];
    for (let i = 0; i < 3; i++) {
      node('sync-system.mjs', ['--force']);
      node('sync-files.mjs', ['--force', '--path', path.join(HOME, 'proj')]);
      node('sync-git.mjs', ['--force', '--path', path.join(HOME, 'proj')]);
      const d = await db();
      counts.push(JSON.stringify(d.query('SELECT source, COUNT(*) AS n FROM items GROUP BY source ORDER BY source')));
      d.close?.();
    }
    expect(counts[0]).toContain('"source":"system"');
    expect(counts[1]).toBe(counts[0]);
    expect(counts[2]).toBe(counts[0]);
  });
});

describe('"~" and relative paths', () => {
  it('expandTilde only treats a leading ~ as home', async () => {
    const { expandTilde } = await imp('paths.mjs');
    expect(expandTilde('~', '/h')).toBe('/h');
    expect(expandTilde('~/code', '/h')).toBe(path.join('/h', 'code'));
    expect(expandTilde('~other', '/h')).toBe('~other');
    expect(expandTilde('rel/dir', '/h')).toBe('rel/dir');
  });

  it('expandHome (config-file values) puts relative paths under home; resolveUserPath (CLI) under the current folder', async () => {
    const { expandHome, resolveUserPath } = await imp('paths.mjs');
    expect(expandHome('code', '/h')).toBe(path.join('/h', 'code'));
    expect(expandHome('~/code', '/h')).toBe(path.join('/h', 'code'));
    expect(resolveUserPath('~/code', '/h')).toBe(path.join('/h', 'code'));
    expect(resolveUserPath('code', '/h')).toBe(path.resolve('code'));
  });

  it('VAULT_ROOT, vaultRoot and sync folders written with ~ in the settings file are expanded', () => {
    const { HOME, env } = fresh();
    fs.writeFileSync(path.join(HOME, '.memvaultrc.json'), JSON.stringify({
      vaultRoot: '~/my-vault',
      sync: { gitDirs: ['~/code'], filesDirs: ['~/docs'] },
      storage: { gdriveFolder: { enabled: false, path: '~/Drive' } },
    }));
    delete env.VAULT_ROOT;
    const r = spawnSync(process.execPath, ['--input-type=module', '-e',
      `const c = await import(${JSON.stringify(pathToFileURL(path.join(REPO, 'config.mjs')).href)});
       console.log(JSON.stringify({ root: c.VAULT_ROOT, git: c.SYNC_CONFIG.gitDirs, files: c.SYNC_CONFIG.filesDirs, drive: c.STORAGE_CONFIG.gdriveFolder.path }));`],
      { env, encoding: 'utf8', cwd: REPO });
    const out = JSON.parse(r.stdout);
    expect(out).toEqual({
      root: path.join(HOME, 'my-vault'),
      git: [path.join(HOME, 'code')],
      files: [path.join(HOME, 'docs')],
      drive: path.join(HOME, 'Drive'),
    });
  });

  it('VAULT_ROOT=~/x from the environment is expanded', () => {
    const { HOME, env } = fresh();
    env.VAULT_ROOT = '~/from-env';
    const r = spawnSync(process.execPath, ['--input-type=module', '-e',
      `const c = await import(${JSON.stringify(pathToFileURL(path.join(REPO, 'config.mjs')).href)}); console.log(c.VAULT_ROOT);`],
      { env, encoding: 'utf8', cwd: REPO });
    expect(r.stdout.trim()).toBe(path.join(HOME, 'from-env'));
  });

  it('a relative --path means the folder you are standing in, even when that is deep inside HOME', async () => {
    const { HOME, node } = fresh();
    const mkProject = (dir) => {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'README.md'), '# project\n');
      fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"p"}\n');
    };
    const deep = path.join(HOME, 'work', 'clients', 'acme');
    mkProject(path.join(deep, 'site'));
    mkProject(path.join(HOME, 'decoy')); // what a "relative to HOME" reading of "." would pick up instead
    const r = node('sync-files.mjs', ['--force', '--path', '.'], { cwd: deep });
    expect(r.status).toBe(0);
    // Only the 2 files of "site" are scanned; reading "." as HOME would also find the decoy's 2 files.
    expect(r.stdout).toContain('Found 2 recently modified files');
    expect(r.stdout).not.toContain('Found 4 recently modified files');
  });

  it('the setup wizard understands ~ and a "no" to Drive really turns it off', () => {
    const { HOME, node } = fresh();
    fs.writeFileSync(path.join(HOME, '.memvaultrc.json'), JSON.stringify({
      storage: { gdriveApi: { enabled: true, clientId: 'old-id', clientSecret: 's', refreshToken: 'r' } },
    }));
    const answers = ['~/wizard-vault', 'y', 'n', 'n', 'n', 'n', 'n', '~/wizard-code', '', 'n', 'n', 'n'];
    const r = node('init.mjs', [], { input: answers.join('\n') + '\n' });
    expect(r.status).toBe(0);
    const cfg = JSON.parse(fs.readFileSync(path.join(HOME, '.memvaultrc.json'), 'utf8'));
    expect(cfg.vaultRoot).toBe(path.join(HOME, 'wizard-vault'));
    expect(cfg.sync.gitDirs).toEqual([path.join(HOME, 'wizard-code')]);
    expect(cfg.storage.gdriveApi.enabled).toBe(false);
  });
});

describe('search words', () => {
  it('drops question filler but keeps the real subject, and never ends up with nothing', async () => {
    const { searchWords } = await imp('context-engine.mjs');
    expect(searchWords('what did we decide about the pricing plan')).toEqual(expect.arrayContaining(['decide', 'pricing', 'plan']));
    expect(searchWords('what did we decide about the pricing plan')).not.toContain('what');
    expect(searchWords('what is the')).not.toEqual([]);
    expect(searchWords('AI')).toEqual(['ai']);
  });

  it('filterUnseen marks only the entries it returns, so the rest are served on the next call', async () => {
    const { filterUnseen, resetSession } = await imp('context-engine.mjs');
    resetSession();
    const rows = ['a', 'b', 'c', 'd'].map((id) => ({ id }));
    expect(filterUnseen(rows, 2).map((r) => r.id)).toEqual(['a', 'b']);
    expect(filterUnseen(rows, 2).map((r) => r.id)).toEqual(['c', 'd']);
    expect(filterUnseen(rows, 2)).toEqual([]);
    resetSession();
  });
});

describe('MCP context tools', () => {
  it('get_context finds the specific old note even when 400+ newer notes match one common word', async () => {
    const { HOME, env, db } = fresh();
    const d = await db();
    const filler = Array.from({ length: 450 }, (_, i) => ({
      type: 'diary', source: 'manual', title: `Filler ${i}`, content: `Quarterly planning meeting number ${i}`,
      created_at: new Date(Date.UTC(2025, 0, 1, 0, i)).toISOString(),
    }));
    d.addItems(filler);
    d.addItems([{ type: 'diary', source: 'manual', title: 'Pricing decision', content: 'Quarterly pricing meeting: we chose the annual plan', created_at: '2024-01-02T00:00:00Z' }]);
    d.close?.();
    const c = new Client({ name: 'test', version: '1' });
    await c.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(REPO, 'mcp-server.mjs')], env, stderr: 'ignore' }));
    try {
      const out = (await c.callTool({ name: 'vault_get_context', arguments: { topic: 'quarterly pricing meeting annual plan', limit: 3 } })).content.map((x) => x.text).join('\n');
      expect(out).toContain('Pricing decision');
    } finally { await c.close().catch(() => {}); }
    expect(HOME).toBeTruthy();
  }, 60_000);

  it('smart_context with freshOnly serves the next unseen notes on each call', async () => {
    const { env, db } = fresh();
    const d = await db();
    const topics = ['budget approval for the new office', 'hiring plan for two designers', 'launch checklist and rollout dates', 'pricing model for enterprise customers', 'security audit findings to fix', 'documentation rewrite schedule'];
    d.addItems(topics.map((t, i) => ({
      type: 'diary', source: 'manual', title: `Roadmap note ${i}`, content: `Roadmap: ${t}`,
      created_at: new Date(Date.UTC(2025, 0, 1, 0, i)).toISOString(),
    })));
    d.close?.();
    const c = new Client({ name: 'test', version: '1' });
    await c.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(REPO, 'mcp-server.mjs')], env, stderr: 'ignore' }));
    try {
      const ask = async () => (await c.callTool({ name: 'vault_smart_context', arguments: { topic: 'roadmap', limit: 2, freshOnly: true } })).content.map((x) => x.text).join('\n');
      const titles = (t) => [...t.matchAll(/Roadmap note \d/g)].map((m) => m[0]);
      const first = titles(await ask());
      const second = titles(await ask());
      expect(first.length).toBe(2);
      expect(second.length).toBeGreaterThan(0);
      expect(second.some((t) => first.includes(t))).toBe(false);
    } finally { await c.close().catch(() => {}); }
  }, 60_000);
});

describe('ChatGPT export shards', () => {
  const conv = (title, ts) => ({
    title, create_time: ts, current_node: 'a1',
    mapping: {
      root: { message: null, parent: null, children: ['u1'] },
      u1: { message: { author: { role: 'user' }, create_time: ts, content: { content_type: 'text', parts: [`question for ${title}`] } }, parent: 'root', children: ['a1'] },
      a1: { message: { author: { role: 'assistant' }, create_time: ts + 5, content: { content_type: 'text', parts: [`answer for ${title}`] } }, parent: 'u1', children: [] },
    },
  });

  it('reads every conversations-NNN.json file in an unzipped export folder', async () => {
    const { HOME, node, db } = fresh();
    const dir = path.join(HOME, 'export');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'conversations-000.json'), JSON.stringify([conv('Alpha shard', 1700000000)]));
    fs.writeFileSync(path.join(dir, 'conversations-001.json'), JSON.stringify([conv('Beta shard', 1700001000)]));
    const { findConversationFiles } = await imp('import-chatgpt.mjs');
    expect(findConversationFiles(dir).map((f) => path.basename(f))).toEqual(['conversations-000.json', 'conversations-001.json']);
    const r = node('import-chatgpt.mjs', [dir]);
    expect(r.status).toBe(0);
    const d = await db();
    const titles = d.query("SELECT title FROM items ORDER BY title").map((x) => x.title).join('|');
    expect(titles).toMatch(/Alpha shard/);
    expect(titles).toMatch(/Beta shard/);
  });

  it('still reads a single conversations.json, alone or inside the folder', async () => {
    const { HOME } = fresh();
    const { findConversationFiles } = await imp('import-chatgpt.mjs');
    const dir = path.join(HOME, 'single');
    fs.mkdirSync(dir);
    const f = path.join(dir, 'conversations.json');
    fs.writeFileSync(f, '[]');
    expect(findConversationFiles(dir)).toEqual([f]);
    expect(findConversationFiles(f)).toEqual([f]);
    expect(findConversationFiles(path.join(HOME))).toEqual([]);
  });
});

describe('uploaded file names', () => {
  it('recovers UTF-8 names that multer decoded as latin1, and leaves genuine latin1 names alone', async () => {
    const { fixFilenameEncoding } = await imp('server.mjs');
    const mangled = Buffer.from('résumé 日本語.txt', 'utf8').toString('latin1');
    expect(fixFilenameEncoding(mangled)).toBe('résumé 日本語.txt');
    expect(fixFilenameEncoding('plain.txt')).toBe('plain.txt');
    expect(fixFilenameEncoding('日本語.txt')).toBe('日本語.txt');
    expect(fixFilenameEncoding('caf\xe9.txt')).toBe('caf\xe9.txt');
  });
});

describe('the documented npx command', () => {
  it('the docs never tell people to run the bare "npx memvault" (a different package)', () => {
    const bad = [];
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (['node_modules', '.git', 'tests'].includes(e.name)) continue;
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.(md|json|mjs|html)$/.test(e.name) && /npx\s+(-y\s+)?memvault(\s|$|")/.test(fs.readFileSync(p, 'utf8'))) bad.push(path.relative(REPO, p));
      }
    };
    walk(REPO);
    expect(bad).toEqual([]);
  });
});
