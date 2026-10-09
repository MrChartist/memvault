// Regression tests for defects found by the independent pre-launch review.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { execFileSync, spawn } from 'child_process';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'memvault-review-'));
const HOMEDIR = path.join(TMP, 'home');
fs.mkdirSync(HOMEDIR, { recursive: true });
process.env.VAULT_ROOT = path.join(TMP, 'vault');
process.env.HOME = process.env.USERPROFILE = HOMEDIR;

let db, system, git, files, browser, ctx, server, initSqlJs;
beforeAll(async () => {
  db = await import('../db.mjs');
  system = await import('../sync-system.mjs');
  git = await import('../sync-git.mjs');
  files = await import('../sync-files.mjs');
  browser = await import('../sync-browser.mjs');
  ctx = await import('../context-engine.mjs');
  server = await import('../server.mjs');
  initSqlJs = (await import('sql.js')).default;
});
afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));

const quiet = async (fn) => {
  const log = console.log, err = console.error, warn = console.warn;
  console.log = console.error = console.warn = () => {};
  try { return await fn(); } finally { console.log = log; console.error = err; console.warn = warn; }
};
const count = (where = '1=1', params = []) => db.queryOne(`SELECT COUNT(*) AS n FROM items WHERE ${where}`, params).n;

describe('system snapshot never stores process command-line arguments', () => {
  it('lists process names, not their arguments (which often carry passwords and tokens)', async () => {
    if (process.platform === 'win32') return; // Windows path already lists names only
    const child = spawn(process.execPath, ['-e', 'setTimeout(()=>{},60000)', '--', '--password=hunter2-SECRET', '--token=abc-SECRET'], { stdio: 'ignore' });
    try {
      await new Promise((r) => setTimeout(r, 400));
      const out = system.getRunningProcesses();
      expect(out).not.toMatch(/SECRET/);
      expect(out).not.toMatch(/--password|--token/);
      expect(out.length).toBeGreaterThan(20); // still a useful list
    } finally {
      child.kill();
    }
  });
});

describe('sync-git reads large histories', () => {
  it('does not silently return 0 commits when git log output exceeds 1 MiB', () => {
    const repo = path.join(TMP, 'bigrepo');
    fs.mkdirSync(repo, { recursive: true });
    const g = (...a) => execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.com', ...a], { cwd: repo, stdio: 'ignore' });
    g('init', '-q');
    for (let i = 0; i < 3; i++) {
      fs.writeFileSync(path.join(repo, 'f.txt'), String(i));
      fs.writeFileSync(path.join(repo, 'msg.txt'), `commit ${i}\n\n${'x'.repeat(500_000)}\n`);
      g('add', 'f.txt');
      g('commit', '-q', '-F', 'msg.txt');
    }
    expect(git.getGitCommits(repo, 30).length).toBe(3);
  });
});

describe('sync-browser is idempotent when visit counts change', () => {
  const rel = { win32: ['AppData', 'Local', 'Google', 'Chrome', 'User Data'], darwin: ['Library', 'Application Support', 'Google', 'Chrome'], linux: ['.config', 'google-chrome'] }[process.platform];
  const profileDir = path.join(HOMEDIR, ...rel, 'Default');

  async function writeHistory(visitCount) {
    const SQL = await initSqlJs();
    const d = new SQL.Database();
    d.run('CREATE TABLE urls (id INTEGER PRIMARY KEY, url TEXT, title TEXT, visit_count INTEGER, hidden INTEGER)');
    d.run('CREATE TABLE visits (id INTEGER PRIMARY KEY, url INTEGER, visit_time INTEGER)');
    d.run("INSERT INTO urls VALUES (1, 'https://example.com/docs', 'Docs', ?, 0)", [visitCount]);
    const day = (n) => (BigInt(Date.UTC(2026, 0, n)) + 11644473600000n) * 1000n;
    for (const n of [1, 2, 3]) d.run('INSERT INTO visits (url, visit_time) VALUES (1, ?)', [Number(day(n))]);
    fs.mkdirSync(profileDir, { recursive: true });
    fs.writeFileSync(path.join(profileDir, 'History'), Buffer.from(d.export()));
  }

  it('re-running after the page was visited again adds nothing', async () => {
    await writeHistory(3);
    await quiet(() => browser.main(['--chrome']));
    const first = count("source = 'chrome'");
    expect(first).toBe(3);

    await writeHistory(4); // visited once more
    await quiet(() => browser.main(['--chrome']));
    expect(count("source = 'chrome'")).toBe(first);
  });
});

describe('upsert replaces only the same snapshot', () => {
  it('keeps distinct snapshots that share source+title but have a different file_path', () => {
    db.addItems([
      { type: 'worklog', source: 'filesystem', title: '[Files] app', content: 'documents/app v1', file_path: '/docs/app', upsert: true },
      { type: 'worklog', source: 'filesystem', title: '[Files] app', content: 'desktop/app v1', file_path: '/desk/app', upsert: true },
    ]);
    expect(count("source = 'filesystem'")).toBe(2);
    db.addItems([{ type: 'worklog', source: 'filesystem', title: '[Files] app', content: 'documents/app v2', file_path: '/docs/app', upsert: true }]);
    const rows = db.queryAll("SELECT content, file_path FROM items WHERE source = 'filesystem' ORDER BY file_path");
    expect(rows).toEqual([
      { content: 'desktop/app v1', file_path: '/desk/app' },
      { content: 'documents/app v2', file_path: '/docs/app' },
    ]);
  });

  it('sync-files keeps two same-named project folders from different scan roots', async () => {
    db.run("DELETE FROM items WHERE source = 'filesystem'");
    const a = path.join(TMP, 'rootA'), b = path.join(TMP, 'rootB');
    fs.mkdirSync(path.join(a, 'app'), { recursive: true });
    fs.mkdirSync(path.join(b, 'app'), { recursive: true });
    fs.writeFileSync(path.join(a, 'app', 'a.md'), 'x');
    fs.writeFileSync(path.join(b, 'app', 'b.md'), 'x');
    await quiet(() => files.main(['--path', a, '--hours', '1']));
    await quiet(() => files.main(['--path', b, '--hours', '1']));
    expect(count("source = 'filesystem'")).toBe(2);
  });
});

describe('context engine — freshOnly and de-duplication', () => {
  it('filterUnseen marks only the entries it returns as seen', () => {
    ctx.resetSession();
    const rows = Array.from({ length: 25 }, (_, i) => ({ id: `e${i}`, title: `t${i}` }));
    expect(ctx.filterUnseen(rows, 5).map((r) => r.id)).toEqual(['e0', 'e1', 'e2', 'e3', 'e4']);
    expect(ctx.filterUnseen(rows, 5).map((r) => r.id)).toEqual(['e5', 'e6', 'e7', 'e8', 'e9']);
    expect(ctx.getSessionStats().seen).toBe(10);
    ctx.resetSession();
  });

  it('does not collapse different commits from the same repo because they share boilerplate', () => {
    const mk = (subject, n) => git.commitToEntry(
      { hash: 'h' + n, short: 'abc123' + n, author: 'Tester', date: `2026-01-0${n}T00:00:00Z`, subject, body: '' },
      { repoName: 'memvault', repoPath: '/home/me/code/memvault', branch: 'main' }
    );
    const commits = [mk('fix typo in docs', 1), mk('update docs for api', 2), mk('bump lodash version', 3)];
    expect(ctx.deduplicateEntries(commits, 0.55).length).toBe(3);
    expect(ctx.deduplicateEntries(commits, 0.5).length).toBe(3);
  });

  it('still removes true duplicates', () => {
    const a = { title: 'Deploy notes', content: 'steps to deploy the service to production safely' };
    expect(ctx.deduplicateEntries([a, { ...a }, { title: 'Other thing entirely', content: 'unrelated words appear here' }]).length).toBe(2);
  });
});

describe('server start-up errors', () => {
  it('a busy port rejects with EADDRINUSE instead of crashing with a TypeError', async () => {
    const blocker = http.createServer();
    await new Promise((r) => blocker.listen(0, '127.0.0.1', r));
    const port = blocker.address().port;
    try {
      const err = await quiet(() => server.startServer({ port, host: '127.0.0.1' }).then(() => null, (e) => e));
      expect(err).toBeTruthy();
      expect(err.code).toBe('EADDRINUSE');
      expect(err).not.toBeInstanceOf(TypeError);
    } finally {
      await new Promise((r) => blocker.close(r));
    }
  });
});

describe('keyword extraction', () => {
  it('drops question/stop words, keeps the meaningful ones', () => {
    expect(ctx.extractKeywords('what did I decide about the database schema')).toEqual(['decide', 'database', 'schema']);
    expect(ctx.extractKeywords('How do I deploy?')).toEqual(['deploy']);
  });
  it('keeps symbolic short tokens and falls back to the literal phrase when nothing survives', () => {
    expect(ctx.extractKeywords('c++ (parens')).toEqual(['c++', 'parens']);
    expect(ctx.extractKeywords('C#')).toEqual(['c#']);
    expect(ctx.extractKeywords('Go')).toEqual(['Go']);
    expect(ctx.extractKeywords('the')).toEqual(['the']);
    expect(ctx.extractKeywords('   ')).toEqual([]);
  });
});

describe('searchItems orderBy "matches"', () => {
  it('ranks an old entry that matches every term above recent ones matching a single common word', () => {
    db.addItems([
      { type: 'worklog', title: 'old specific', content: 'alpha beta gamma together', created_at: '2020-01-01T00:00:00Z' },
      ...Array.from({ length: 5 }, (_, i) => ({ type: 'diary', title: `recent ${i}`, content: 'only alpha here', created_at: `2026-02-0${i + 1}T00:00:00Z` })),
    ]);
    const byRecency = db.searchItems({ terms: ['alpha', 'beta', 'gamma'], limit: 3 });
    expect(byRecency.map((r) => r.title)).not.toContain('old specific');
    const byMatches = db.searchItems({ terms: ['alpha', 'beta', 'gamma'], orderBy: 'matches', limit: 3 });
    expect(byMatches[0].title).toBe('old specific');
  });
  it('treats % and _ in terms literally when ranking', () => {
    expect(() => db.searchItems({ terms: ['100%', 'a_b'], orderBy: 'matches' })).not.toThrow();
  });
});

describe('importers handle newer export shapes', () => {
  it('ChatGPT: numbered shards conversations-000.json, conversations-001.json', async () => {
    const chatgpt = await import('../import-chatgpt.mjs');
    const dir = path.join(TMP, 'chatgpt-shards');
    fs.mkdirSync(dir, { recursive: true });
    const conv = (title, t) => ({ title, create_time: t, mapping: { a: { message: { author: { role: 'user' }, create_time: t, content: { parts: [`question for ${title}`] } } } } });
    fs.writeFileSync(path.join(dir, 'conversations-000.json'), JSON.stringify([conv('Shard one', 1700000001)]));
    fs.writeFileSync(path.join(dir, 'conversations-001.json'), JSON.stringify([conv('Shard two', 1700000002)]));
    expect(chatgpt.findConversationFiles(dir).map((f) => path.basename(f))).toEqual(['conversations-000.json', 'conversations-001.json']);
    const r = await quiet(() => chatgpt.importChatGPT(dir));
    expect(r.imported).toBe(2);

    const all = await import('../import-all.mjs');
    const detected = await quiet(() => all.importAll(dir)); // second time: detected as ChatGPT, all duplicates
    expect(Object.keys(detected)).toEqual(['chatgpt']);
    expect(detected.chatgpt.imported).toBe(0);
  });

  it('Gemini: reads the answer from safeHtmlItem and strips the "Prompted" prefix', async () => {
    const { formatGeminiActivity, htmlToText } = await import('../import-gemini.mjs');
    const f = formatGeminiActivity({ title: 'Prompted explain MCP simply', time: '2026-03-03T03:03:03Z', products: ['Gemini Apps'], safeHtmlItem: [{ html: '<p>MCP is a protocol.</p><p>It connects tools &amp; data.</p>' }] });
    expect(f.content).toContain('explain MCP simply');
    expect(f.content).not.toContain('Prompted');
    expect(f.content).toContain('MCP is a protocol.');
    expect(f.content).toContain('tools & data.');
    expect(htmlToText('<b>x</b><br>y')).toBe('x\ny');
  });
});

describe('database lock recovery', () => {
  it('breaks a lock left by a crashed process once it is stale (and quickly, not after a long wait)', () => {
    const lock = path.join(HOMEDIR, '..', 'vault', 'db', 'index.sqlite.lock');
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    fs.writeFileSync(lock, '');
    const old = new Date(Date.now() - 11_000);
    fs.utimesSync(lock, old, old);
    const t0 = Date.now();
    db.addItems([{ type: 'diary', title: 'after an 11s-old orphan lock' }]);
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(fs.existsSync(lock)).toBe(false);
  });
});
