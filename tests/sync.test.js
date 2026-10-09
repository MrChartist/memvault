import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'memvault-sync-'));
const BRAIN = path.join(TMP, 'brain');
process.env.VAULT_ROOT = path.join(TMP, 'vault');
process.env.HOME = process.env.USERPROFILE = path.join(TMP, 'home');
process.env.BRAIN_DIR = BRAIN;
fs.mkdirSync(process.env.HOME, { recursive: true });

let db, git, files, clip, vscode, browser, antigravity;
beforeAll(async () => {
  db = await import('../db.mjs');
  git = await import('../sync-git.mjs');
  files = await import('../sync-files.mjs');
  clip = await import('../sync-clipboard.mjs');
  vscode = await import('../sync-vscode.mjs');
  browser = await import('../sync-browser.mjs');
  antigravity = await import('../sync-antigravity.mjs');
});
afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));

const quiet = async (fn) => {
  const log = console.log;
  console.log = () => {};
  try { return await fn(); } finally { console.log = log; }
};
const count = (where = '1=1', params = []) => db.queryOne(`SELECT COUNT(*) AS n FROM items WHERE ${where}`, params).n;

describe('sync-git — parsing', () => {
  it('keeps commits whose subject contains double quotes, newlines or JSON-looking text (these were silently dropped)', () => {
    const FIELD = '\x1f', REC = '\x1e';
    const out = [
      ['a'.repeat(40), 'aaaaaaa', 'Ann', '2026-01-01T10:00:00+05:30', 'fix: handle "quoted" input', 'Body with {"json": true}\nand a second line'],
      ['b'.repeat(40), 'bbbbbbb', 'Bob', '2026-01-02T10:00:00+05:30', 'plain subject', ''],
    ].map((f) => f.join(FIELD) + REC + '\n').join('');
    const commits = git.parseGitLog(out);
    expect(commits.map((c) => c.subject)).toEqual(['fix: handle "quoted" input', 'plain subject']);
    expect(commits[0].body).toContain('second line');
    expect(commits[0].author).toBe('Ann');
  });

  it('commit entries do not depend on the checked-out branch (switching branches must not re-import)', () => {
    const c = { hash: 'h', short: 'abc1234', author: 'A', date: '2026-01-01T00:00:00Z', subject: 's', body: '' };
    const a = git.commitToEntry(c, { repoName: 'r', repoPath: '/x', branch: 'main' });
    const b = git.commitToEntry(c, { repoName: 'r', repoPath: '/x', branch: 'feature' });
    expect(a.content).toBe(b.content);
    expect(a.title).toBe(b.title);
    expect(a.tags).not.toBe(b.tags);
  });

  it('does not store author e-mail addresses', () => {
    const e = git.commitToEntry({ hash: 'h', short: 's', author: 'A', date: '2026-01-01T00:00:00Z', subject: 'x', body: '' }, { repoName: 'r', repoPath: '/x', branch: 'm' });
    expect(e.content).not.toMatch(/@/);
  });
});

describe('sync-git — end to end with a real repository', () => {
  const repo = path.join(TMP, 'projects', 'demo');
  beforeAll(() => {
    fs.mkdirSync(repo, { recursive: true });
    const g = (...a) => execFileSync('git', ['-c', 'user.name=Tester', '-c', 'user.email=t@example.com', ...a], { cwd: repo, stdio: 'ignore' });
    g('init', '-q');
    fs.writeFileSync(path.join(repo, 'a.txt'), '1');
    g('add', '.');
    g('commit', '-q', '-m', 'first "quoted" commit', '-m', 'body line');
    fs.writeFileSync(path.join(repo, 'a.txt'), '2');
    g('commit', '-q', '-am', 'second commit');
    // a dependency folder that must not be scanned
    fs.mkdirSync(path.join(TMP, 'projects', 'node_modules', 'pkg', '.git'), { recursive: true });
  });

  it('finds repos but skips node_modules and dot-directories', () => {
    expect(git.findGitRepos(path.join(TMP, 'projects'))).toEqual([repo]);
  });

  it('imports every commit once, and a second run adds nothing', async () => {
    const run = () => quiet(() => git.main(['--path', path.join(TMP, 'projects'), '--days', '30']));
    const first = await run();
    expect(first.inserted).toBe(2);
    expect(count("source = 'git'")).toBe(2);
    expect(count("title LIKE '%quoted%'")).toBe(1);

    const second = await run();
    expect(second.inserted).toBe(0);
    expect(second.duplicates).toBe(2);
    expect(count("source = 'git'")).toBe(2);
  });

  it('--dry-run writes nothing', async () => {
    const before = count();
    await quiet(() => git.main(['--path', path.join(TMP, 'projects'), '--days', '30', '--dry-run']));
    expect(count()).toBe(before);
  });
});

describe('sync-files', () => {
  it('writes one replaceable snapshot per project instead of piling up', async () => {
    const dir = path.join(TMP, 'docs');
    fs.mkdirSync(path.join(dir, 'proj1'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'proj1', 'notes.md'), 'hi');
    fs.writeFileSync(path.join(dir, 'proj1', 'image.png'), 'x'); // untracked extension
    fs.writeFileSync(path.join(dir, 'top.txt'), 'x');

    await quiet(() => files.main(['--path', dir, '--hours', '1']));
    await quiet(() => files.main(['--path', dir, '--hours', '1']));
    await quiet(() => files.main(['--path', dir, '--hours', '1']));

    const rows = db.queryAll("SELECT title, content FROM items WHERE source = 'filesystem'");
    expect(rows.map((r) => r.title).sort()).toEqual(['[Files] docs', '[Files] proj1']);
    expect(rows.find((r) => r.title === '[Files] proj1').content).toContain('notes.md');
    expect(rows.find((r) => r.title === '[Files] proj1').content).not.toContain('image.png');
  });

  it('accepts a relative --path', async () => {
    const rel = path.relative(process.cwd(), path.join(TMP, 'docs'));
    const r = await quiet(() => files.main(['--path', rel, '--hours', '1', '--dry-run']));
    expect(r.inserted).toBeGreaterThan(0);
  });
});

describe('sync-clipboard — never stores likely secrets', () => {
  const secrets = {
    'AWS key': 'deploy with AKIAIOSFODNN7EXAMPLE now',
    'private key': '-----BEGIN RSA PRIVATE KEY-----\nMIIEow...',
    'GitHub token': 'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
    'OpenAI-style key': 'sk-proj-abcdefghijklmnopqrstuvwxyz',
    'JWT': 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc',
    'password line': 'username: bob\npassword: hunter2hunter2',
    'api_key assignment': 'API_KEY=abcd1234efgh5678',
    'bearer header': 'Authorization: Bearer abcdefghijklmnop123456',
    'card number (Luhn-valid)': 'card 4111 1111 1111 1111 exp 12/29',
    'long random token': 'aZ3kQ9xLm2Vb7Nc4Rt8Yw1Uh6Jd5Pf0Sg',
  };
  for (const [name, text] of Object.entries(secrets)) {
    it(`skips: ${name}`, () => expect(clip.looksSensitive(text)).toBe(true));
  }

  const fine = {
    'sentence': 'Remember to review the pull request before Friday standup.',
    'url': 'https://github.com/MrChartist/memvault/pull/123',
    'code': 'const total = items.reduce((a, b) => a + b.price, 0);',
    'file path': '/home/user/projects/memvault/src/index.mjs',
    'invalid card-like digits': 'order 1234 5678 9012 3456 shipped',
  };
  for (const [name, text] of Object.entries(fine)) {
    it(`keeps: ${name}`, () => expect(clip.looksSensitive(text)).toBe(false));
  }

  it('classifies content', () => {
    expect(clip.classifyContent('https://example.com/page').type).toBe('url');
    expect(clip.classifyContent('const x = 1;\nconst y = 2;').type).toBe('code');
    expect(clip.classifyContent('{"a": 1, "b": 2}').type).toBe('json');
    expect(clip.classifyContent('just some words here for you').type).toBe('text');
  });
});

describe('sync-vscode', () => {
  it('converts file URIs to real paths (the leading "/" used to be dropped on Linux/macOS)', () => {
    if (process.platform !== 'win32') {
      expect(vscode.uriToPath('file:///home/me/my%20project')).toBe('/home/me/my project');
    }
    expect(vscode.uriToPath('/already/a/path')).toBe('/already/a/path');
    expect(vscode.uriToPath('vscode-remote://ssh-remote+box/srv/app')).toContain('ssh-remote');
    expect(vscode.uriToPath(undefined)).toBeNull();
  });

  it('reads recent projects from the storage shapes VS Code has used', () => {
    const dir = path.join(TMP, 'vsc');
    fs.mkdirSync(dir, { recursive: true });
    const storage = path.join(dir, 'storage.json');
    const target = path.join(TMP, 'some-project');
    fs.writeFileSync(storage, JSON.stringify({
      backupWorkspaces: { folders: [{ folderUri: `file://${target.startsWith('/') ? '' : '/'}${target}` }] },
      profileAssociations: { workspaces: { [`file://${target.startsWith('/') ? '' : '/'}${target}`]: '__default__profile__' } },
    }));
    const projects = vscode.getRecentProjects({ legacyStorage: storage, storage: path.join(dir, 'missing.json') });
    expect(projects.length).toBe(1); // de-duplicated across shapes
    expect(projects[0].name).toBe('some-project');
  });

  it('lists installed extensions', () => {
    const ext = path.join(TMP, 'extensions', 'pub.cool-1.0.0');
    fs.mkdirSync(ext, { recursive: true });
    fs.writeFileSync(path.join(ext, 'package.json'), JSON.stringify({ displayName: 'Cool', publisher: 'pub', version: '1.0.0' }));
    expect(vscode.getInstalledExtensions(path.join(TMP, 'extensions'))).toEqual([
      { id: 'pub.cool-1.0.0', name: 'Cool', publisher: 'pub', version: '1.0.0', categories: '' },
    ]);
  });
});

describe('sync-browser', () => {
  it('skips internal pages and local dev servers (the old patterns never matched real URLs)', () => {
    for (const url of ['chrome://settings', 'edge://flags', 'about:blank', 'http://localhost:3000/app', 'http://127.0.0.1:7799/', 'file:///etc/hosts', 'chrome-extension://abc/page.html']) {
      expect(browser.shouldSkip(url, []), url).toBe(true);
    }
    for (const url of ['https://example.com/', 'https://localhost.example.com/']) {
      expect(browser.shouldSkip(url, []), url).toBe(false);
    }
  });

  it('honours user-excluded domains including subdomains', () => {
    expect(browser.shouldSkip('https://secure.bank.example/login', ['bank.example'])).toBe(true);
    expect(browser.shouldSkip('https://notbank.example/', ['bank.example'])).toBe(false);
  });

  it('converts Chrome timestamps', () => {
    expect(browser.chromeTimeToISO('13300000000000000')).toBe(new Date((13300000000000000 / 1000) - 11644473600000).toISOString());
  });

  it('finds a Chromium profile under a given home directory on this OS', () => {
    const home = path.join(TMP, 'fakehome');
    const rel = { win32: ['AppData', 'Local', 'Google', 'Chrome', 'User Data'], darwin: ['Library', 'Application Support', 'Google', 'Chrome'], linux: ['.config', 'google-chrome'] }[process.platform] || ['.config', 'google-chrome'];
    fs.mkdirSync(path.join(home, ...rel, 'Default'), { recursive: true });
    fs.writeFileSync(path.join(home, ...rel, 'Default', 'History'), '');
    const found = browser.findProfiles(['chrome'], [home]);
    expect(found.map((p) => p.name)).toEqual(['Chrome']);
    expect(browser.findProfiles(['edge'], [home])).toEqual([]);
  });
});

describe('sync-antigravity — must never delete anything', () => {
  it('leaves existing vault data untouched (it used to wipe the whole vault first)', async () => {
    db.addItems([{ type: 'diary', title: 'precious hand-written note', content: 'do not delete me' }]);
    const before = count();

    // no brain directory at all → polite no-op, nothing removed
    await quiet(() => antigravity.main([]));
    expect(count()).toBe(before);

    // with a brain directory → adds, never removes
    const conv = path.join(BRAIN, '123e4567-e89b-12d3-a456-426614174000');
    fs.mkdirSync(conv, { recursive: true });
    fs.writeFileSync(path.join(conv, 'task.md'), '# Task\n- [ ] ship it');
    await quiet(() => antigravity.main([]));
    await quiet(() => antigravity.main([])); // idempotent
    expect(count("source = 'antigravity'")).toBe(1);
    expect(count("title = 'precious hand-written note'")).toBe(1);
    expect(count()).toBe(before + 1);
  });
});
