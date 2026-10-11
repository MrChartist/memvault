// Regression tests for the capture-engine hardening: git sync stores each commit once (also after a branch
// switch and after upgrading), every configured git folder is scanned, notes typed with `memvault vault`
// leave no readable copy behind when deleted or edited, and re-running the wizard keeps storage settings.
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath, pathToFileURL } from 'url';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const imp = (f) => import(pathToFileURL(path.join(REPO, f)).href);
const made = [];
const fresh = () => {
  const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-capture-'));
  made.push(HOME);
  const ROOT = path.join(HOME, 'v');
  const env = { ...process.env, HOME, USERPROFILE: HOME, VAULT_ROOT: ROOT, MEMVAULT_TOKEN_FILE: path.join(HOME, 'tok'), MEMVAULT_TOKEN: '', MEMVAULT_AGENT: '' };
  delete env.GIT_SCAN_ROOT;
  const node = (script, args = [], opts = {}) =>
    spawnSync(process.execPath, [path.join(REPO, script), ...args], { env, encoding: 'utf8', cwd: opts.cwd || REPO, input: opts.input, timeout: 60000 });
  const db = async () => (await imp('db.mjs')).openVaultDb({ root: ROOT });
  return { HOME, ROOT, env, node, db };
};
afterAll(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });

const gitRepo = (dir, home) => {
  fs.mkdirSync(dir, { recursive: true });
  const env = { ...process.env, HOME: home, GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' };
  const git = (...a) => {
    const r = spawnSync('git', ['-c', 'commit.gpgsign=false', ...a], { cwd: dir, encoding: 'utf8', env });
    if (r.status !== 0) throw new Error(`git ${a.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
  };
  git('init', '-q', '-b', 'main');
  return git;
};

const gitItems = async (db) => {
  const d = await db();
  const r = d.query("SELECT id, title, content, tags, file_path, created_at FROM items WHERE source = 'git' ORDER BY title");
  d.close?.();
  return r;
};

/** Every Markdown file under the vault whose text contains `needle`. */
const mdWith = (root, needle) => {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { recursive: true })
    .map((n) => path.join(root, String(n)))
    .filter((f) => f.endsWith('.md') && fs.statSync(f).isFile() && fs.readFileSync(f, 'utf8').includes(needle));
};

describe('git sync stores each commit once', () => {
  it('running it again, and again after switching branch, still leaves one item per commit', async () => {
    const { HOME, node, db } = fresh();
    const code = path.join(HOME, 'code');
    const git = gitRepo(path.join(code, 'app'), HOME);
    // An author date with a time-zone offset: git prints "+05:30", the vault stores "...Z".
    spawnSync('git', ['-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty', '-m', 'first commit'], {
      cwd: path.join(code, 'app'),
      env: { ...process.env, HOME, GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com', GIT_AUTHOR_DATE: new Date(Date.now() - 3600_000).toISOString().replace('Z', '+05:30') },
    });
    const sha = git('rev-parse', 'HEAD');
    node('sync-git.mjs', ['--force', '--path', code]);
    node('sync-git.mjs', ['--force', '--path', code]);
    expect((await gitItems(db)).length).toBe(1);

    git('checkout', '-q', '-b', 'feature/other');
    const r = node('sync-git.mjs', ['--force', '--path', code]);
    expect(r.status).toBe(0);
    const rows = await gitItems(db);
    expect(rows.length).toBe(1);
    expect(rows[0].title).toBe('[app] first commit');
    expect(rows[0].file_path).toBe(`commit:${sha}`);

    // A new commit on the new branch is still picked up.
    git('commit', '-q', '--allow-empty', '-m', 'second commit');
    node('sync-git.mjs', ['--force', '--path', code]);
    expect((await gitItems(db)).map((x) => x.title)).toEqual(['[app] first commit', '[app] second commit']);
  }, 120_000);

  it('commits saved by an older version (no commit marker) are not saved again after upgrading', async () => {
    const { HOME, node, db } = fresh();
    const code = path.join(HOME, 'code');
    const repo = path.join(code, 'app');
    const git = gitRepo(repo, HOME);
    spawnSync('git', ['-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty', '-m', 'old commit'], {
      cwd: repo,
      env: { ...process.env, HOME, GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com', GIT_AUTHOR_DATE: new Date(Date.now() - 7200_000).toISOString().replace('Z', '-04:00') },
    });
    const [short, date] = git('log', '-1', '--format=%h%x1f%aI').split('\x1f');
    // What the previous version stored: the branch and folder were part of the text, and nothing named the commit.
    const d = await db();
    d.addItems([{
      type: 'worklog', source: 'git', title: '[app] old commit', tags: 'git,commit,app,main', created_at: date,
      content: [`**Commit**: \`${short}\``, '**Author**: t <t@example.com>', '**Branch**: main', '**Repo**: app', `**Path**: ${repo}`, '', '### Message', 'old commit', ''].join('\n'),
    }]);
    d.close?.();

    git('checkout', '-q', '-b', 'later');
    node('sync-git.mjs', ['--force', '--path', code]);
    node('sync-git.mjs', ['--force', '--path', code]);
    expect((await gitItems(db)).length).toBe(1);
  }, 120_000);

  it('scans every folder listed in gitDirs, and a repository found twice is read once', async () => {
    const { HOME, node, db } = fresh();
    const one = gitRepo(path.join(HOME, 'a', 'one'), HOME);
    one('commit', '-q', '--allow-empty', '-m', 'commit in one');
    const two = gitRepo(path.join(HOME, 'b', 'two'), HOME);
    two('commit', '-q', '--allow-empty', '-m', 'commit in two');
    fs.writeFileSync(path.join(HOME, '.memvaultrc.json'), JSON.stringify({
      sync: { gitEnabled: true, gitDirs: [path.join(HOME, 'a'), '~/b', path.join(HOME, 'a', 'one')] },
    }));
    const r = node('sync-git.mjs');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Found 2 repositories');
    expect((await gitItems(db)).map((x) => x.title)).toEqual(['[one] commit in one', '[two] commit in two']);
  }, 120_000);
});

describe('`memvault vault` notes leave no readable copy behind', () => {
  const KEY = 'sk-ant-api03-' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0U1v2W3x4Y5z6';

  it('a diary note: the copy holds only the masked text, and goes when the note is deleted', async () => {
    const { ROOT, node, db } = fresh();
    const text = 'dear diary the zebra-quartz-17 plan';
    const r = node('vault.mjs', ['diary', text, KEY]);
    expect(r.status).toBe(0);
    expect(mdWith(ROOT, 'zebra-quartz-17').length).toBe(1); // a readable copy is still written
    expect(mdWith(ROOT, KEY)).toEqual([]);

    // What the dashboard's DELETE /items/:id does.
    const { removeMirrors } = await imp('mirror.mjs');
    const vdb = await db();
    const item = vdb.query("SELECT * FROM items WHERE type = 'diary'")[0];
    expect(item.file_path).toBeNull();
    vdb.run('DELETE FROM items WHERE id = ?', [item.id]);
    removeMirrors(ROOT, [item]);
    vdb.close?.();
    expect(mdWith(ROOT, 'zebra-quartz-17')).toEqual([]);
  }, 60_000);

  it('a diary note: editing it rewrites the copy, so the old words are gone from disk', async () => {
    const { ROOT, node, db } = fresh();
    expect(node('vault.mjs', ['diary', 'first draft walrus-ember-42']).status).toBe(0);
    node('vault.mjs', ['diary', 'another note the same day']);

    // What the dashboard's PATCH /items/:id does.
    const { updateMirror } = await imp('mirror.mjs');
    const vdb = await db();
    const item = vdb.query("SELECT * FROM items WHERE content LIKE '%walrus-ember-42%'")[0];
    vdb.run('UPDATE items SET title = ?, content = ?, tags = ? WHERE id = ?', [item.title, 'rewritten text', item.tags, item.id]);
    expect(updateMirror(ROOT, { ...item, content: 'rewritten text' })).toBe(true);
    vdb.close?.();
    expect(mdWith(ROOT, 'walrus-ember-42')).toEqual([]);
    expect(mdWith(ROOT, 'another note the same day').length).toBe(1);
  }, 60_000);

  it('conversation and worklog notes leave nothing on disk after delete', async () => {
    const { ROOT, node, db } = fresh();
    expect(node('vault.mjs', ['convo', 'chatgpt', 'A chat', 'talked about otter-basalt-9']).status).toBe(0);
    expect(node('vault.mjs', ['worklog', 'A log', 'fixed heron-cobalt-3']).status).toBe(0);
    const { removeMirrors } = await imp('mirror.mjs');
    const vdb = await db();
    const rows = vdb.query("SELECT * FROM items WHERE type IN ('conversation','worklog')");
    expect(rows.length).toBe(2);
    for (const item of rows) { vdb.run('DELETE FROM items WHERE id = ?', [item.id]); removeMirrors(ROOT, [item]); }
    vdb.close?.();
    expect(mdWith(ROOT, 'otter-basalt-9')).toEqual([]);
    expect(mdWith(ROOT, 'heron-cobalt-3')).toEqual([]);
  }, 60_000);
});

describe('re-running the setup wizard', () => {
  it('keeps storage settings it does not ask about (the backup passphrase file among them)', () => {
    const { HOME, node } = fresh();
    const passFile = path.join(HOME, 'backup-pass.txt');
    fs.writeFileSync(path.join(HOME, '.memvaultrc.json'), JSON.stringify({
      vaultRoot: path.join(HOME, 'v'),
      storage: {
        local: { enabled: true, note: 'kept' },
        gdriveFolder: { enabled: false, path: path.join(HOME, 'Drive'), keep: 5 },
        gdriveApi: { enabled: false, clientId: 'id', clientSecret: 's', refreshToken: 'r', folderId: '' },
        keepLocalBackups: 7,
        encryptCloud: true,
        allowPlaintextCloud: false,
        passphraseFile: passFile,
      },
    }));
    expect(node('init.mjs', [], { input: '' }).status).toBe(0);
    const s = JSON.parse(fs.readFileSync(path.join(HOME, '.memvaultrc.json'), 'utf8')).storage;
    expect(s.passphraseFile).toBe(passFile);
    expect(s.encryptCloud).toBe(true);
    expect(s.allowPlaintextCloud).toBe(false);
    expect(s.keepLocalBackups).toBe(7);
    expect(s.local).toEqual({ enabled: true, note: 'kept' });
    expect(s.gdriveFolder).toEqual({ enabled: false, path: path.join(HOME, 'Drive'), keep: 5 });
    expect(s.gdriveApi).toMatchObject({ enabled: false, clientId: 'id', clientSecret: 's', refreshToken: 'r' });
  }, 60_000);
});
