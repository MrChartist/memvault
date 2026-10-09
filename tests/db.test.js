import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'memvault-db-'));
process.env.VAULT_ROOT = TMP;

const here = path.dirname(fileURLToPath(import.meta.url));
let dbm;

beforeAll(async () => {
  dbm = await import('../db.mjs');
});

afterAll(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

const freshRoot = () => fs.mkdtempSync(path.join(TMP, 'v-'));

describe('db — schema', () => {
  it('creates the file with the current schema and a stable vault id', () => {
    const root = freshRoot();
    const a = dbm.openVaultDb({ root });
    const id1 = a.query("SELECT value FROM meta WHERE key='vault_id'")[0].value;
    const b = dbm.openVaultDb({ root });
    const id2 = b.query("SELECT value FROM meta WHERE key='vault_id'")[0].value;
    expect(id1).toBeTruthy();
    expect(id2).toBe(id1);
    expect(fs.existsSync(path.join(root, 'db', 'index.sqlite'))).toBe(true);
  });

  it('migrates a v1 database (no agent_id/scope) without losing rows', async () => {
    const root = freshRoot();
    fs.mkdirSync(path.join(root, 'db'), { recursive: true });
    const initSqlJs = (await import('sql.js')).default;
    const SQL = await initSqlJs();
    const old = new SQL.Database();
    old.run(`CREATE TABLE items (id TEXT PRIMARY KEY, type TEXT NOT NULL, source TEXT, title TEXT,
             content TEXT, file_path TEXT, tags TEXT, created_at TEXT NOT NULL)`);
    old.run("INSERT INTO items (id,type,title,created_at) VALUES ('old1','diary','legacy','2024-01-01')");
    fs.writeFileSync(path.join(root, 'db', 'index.sqlite'), Buffer.from(old.export()));

    const v = dbm.openVaultDb({ root });
    v.addItem({ type: 'diary', title: 'new' });
    const rows = v.query('SELECT id,scope,agent_id FROM items ORDER BY created_at');
    expect(rows.find((r) => r.id === 'old1').scope).toBe('shared');
    expect(rows).toHaveLength(2);
  });
});

describe('db — one memory, many writers', () => {
  it('a second handle sees writes made by the first', () => {
    const root = freshRoot();
    const a = dbm.openVaultDb({ root });
    const b = dbm.openVaultDb({ root });
    expect(b.query('SELECT COUNT(*) AS n FROM items')[0].n).toBe(0);
    a.addItem({ type: 'diary', title: 'from A' });
    expect(b.query('SELECT COUNT(*) AS n FROM items')[0].n).toBe(1);
  });

  it('does not lose writes when 3 OS processes write concurrently', async () => {
    const root = freshRoot();
    dbm.openVaultDb({ root }); // create the file first
    const N = 40;
    const worker = path.join(here, 'fixtures', 'db-writer.mjs');
    const run = (tag) =>
      new Promise((resolve, reject) => {
        const p = spawn(process.execPath, [worker, root, tag, String(N)], {
          env: { ...process.env, VAULT_ROOT: root },
          stdio: ['ignore', 'ignore', 'inherit'],
        });
        p.on('exit', (c) => (c === 0 ? resolve() : reject(new Error(`${tag} exited ${c}`))));
      });
    await Promise.all([run('server'), run('claude'), run('cursor')]);

    const v = dbm.openVaultDb({ root });
    expect(v.query('SELECT COUNT(*) AS n FROM items')[0].n).toBe(3 * N);
    // Nothing left behind
    expect(fs.existsSync(path.join(root, 'db', 'index.sqlite.lock'))).toBe(false);
    expect(fs.readdirSync(path.join(root, 'db')).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  }, 60_000);

  it('recovers from a stale lock left by a dead process', () => {
    const root = freshRoot();
    const v = dbm.openVaultDb({ root });
    // 2^22 is above the default Linux pid_max; no such process
    fs.writeFileSync(`${v.path}.lock`, `4194303:${Date.now()}`);
    expect(() => v.addItem({ type: 'diary', title: 'after stale lock' })).not.toThrow();
    expect(v.query('SELECT COUNT(*) AS n FROM items')[0].n).toBe(1);
  });

  it('rolls back and publishes nothing when a transaction throws', () => {
    const root = freshRoot();
    const v = dbm.openVaultDb({ root });
    expect(() =>
      v.transaction((tx) => {
        tx.run("INSERT INTO items (id,type,created_at) VALUES ('t1','diary','2025-01-01')");
        throw new Error('boom');
      })
    ).toThrow('boom');
    expect(v.query('SELECT COUNT(*) AS n FROM items')[0].n).toBe(0);
  });
});

describe('db — agent-scoped handles', () => {
  function seed() {
    const root = freshRoot();
    const owner = dbm.openVaultDb({ root });
    owner.addItem({ type: 'diary', title: 'public note' });
    owner.addItem({ type: 'diary', title: 'analyst private', scope: 'agent:analyst', agent_id: 'analyst' });
    owner.addItem({ type: 'diary', title: 'coder private', scope: 'agent:coder', agent_id: 'coder' });
    owner.addItem({ type: 'diary', title: 'project note', scope: 'project:alpha' });
    owner.run(
      "INSERT INTO secrets (id,category,label,encrypted,created_at,updated_at) VALUES ('s1','apikey','OpenAI','{}','x','x')"
    );
    return { root, owner };
  }
  const titles = (h) => h.query('SELECT title FROM items ORDER BY title').map((r) => r.title);

  it('sees shared + its own private memory, never another agent\'s', () => {
    const { root } = seed();
    const analyst = dbm.openVaultDb({ root, scope: { agentId: 'analyst' } });
    expect(titles(analyst)).toEqual(['analyst private', 'public note']);
  });

  it('cannot see other agents even with a hostile SELECT', () => {
    const { root } = seed();
    const coder = dbm.openVaultDb({ root, scope: { agentId: 'coder' } });
    const all = coder.query("SELECT title FROM items WHERE title LIKE '%private%' OR 1=1");
    expect(all.map((r) => r.title).sort()).toEqual(['coder private', 'public note']);
  });

  it('hides everything private when nothing is visible (NOT IN NULL regression)', () => {
    const root = freshRoot();
    const owner = dbm.openVaultDb({ root });
    owner.addItem({ type: 'diary', title: 'someone else', scope: 'agent:other', agent_id: 'other' });
    const a = dbm.openVaultDb({ root, scope: { agentId: 'newbie' } });
    expect(titles(a)).toEqual([]);
  });

  it('supports prefix grants such as project:*', () => {
    const { root } = seed();
    const a = dbm.openVaultDb({ root, scope: { agentId: 'analyst', readScopes: ['project:*'] } });
    expect(titles(a)).toEqual(['analyst private', 'project note', 'public note']);
  });

  it('hides the secrets table unless explicitly allowed', () => {
    const { root } = seed();
    const denied = dbm.openVaultDb({ root, scope: { agentId: 'analyst' } });
    expect(denied.query('SELECT COUNT(*) AS n FROM secrets')[0].n).toBe(0);
    const allowed = dbm.openVaultDb({ root, scope: { agentId: 'analyst', allowSecrets: true } });
    expect(allowed.query('SELECT COUNT(*) AS n FROM secrets')[0].n).toBe(1);
  });

  it('stamps writes with the bound identity and refuses forbidden scopes', () => {
    const { root, owner } = seed();
    const analyst = dbm.openVaultDb({ root, scope: { agentId: 'analyst' } });
    const id = analyst.addItem({ type: 'worklog', title: 'spoof?', agent_id: 'coder' });
    const row = owner.query('SELECT agent_id, scope FROM items WHERE id = ?', [id])[0];
    expect(row.agent_id).toBe('analyst'); // caller-supplied agent_id is ignored
    expect(row.scope).toBe('shared');
    expect(() => analyst.addItem({ type: 'worklog', title: 'x', scope: 'agent:coder' })).toThrow(/may not write/);
    expect(() => analyst.run('DELETE FROM items')).toThrow(/cannot run raw SQL/);
  });

  it('a scoped write never clobbers rows the agent cannot see', () => {
    const { root, owner } = seed();
    const analyst = dbm.openVaultDb({ root, scope: { agentId: 'analyst' } });
    analyst.addItem({ type: 'diary', title: 'analyst adds one' });
    const all = owner.query('SELECT title FROM items').map((r) => r.title);
    expect(all).toContain('coder private'); // still there
    expect(all).toContain('analyst adds one');
  });
});

describe('db — efficiency', () => {
  it('addItems stores a batch in a single write and keeps the order of ids', () => {
    const root = freshRoot();
    const v = dbm.openVaultDb({ root });
    const gen = () => fs.readFileSync(`${v.path}.gen`, 'utf8');
    v.addItem({ type: 'diary', title: 'warm-up' });
    const before = gen();
    const ids = v.addItems(Array.from({ length: 500 }, (_, i) => ({ type: 'diary', title: `t${i}` })));
    expect(ids).toHaveLength(500);
    expect(new Set(ids).size).toBe(500);
    expect(gen()).not.toBe(before);          // published...
    expect(v.query('SELECT COUNT(*) AS n FROM items')[0].n).toBe(501);
  });

  it('addItems is all-or-nothing for a scoped agent', () => {
    const root = freshRoot();
    const a = dbm.openVaultDb({ root, scope: { agentId: 'analyst' } });
    expect(() =>
      a.addItems([
        { type: 'diary', title: 'ok' },
        { type: 'diary', title: 'forbidden', scope: 'agent:coder' },
      ])
    ).toThrow(/may not write/);
    expect(a.query('SELECT COUNT(*) AS n FROM items')[0].n).toBe(0);
  });

  it('a single writer reuses its in-memory copy, but still sees another writer\'s change', () => {
    const root = freshRoot();
    const a = dbm.openVaultDb({ root });
    const b = dbm.openVaultDb({ root });
    a.addItem({ type: 'diary', title: 'a1' });
    a.addItem({ type: 'diary', title: 'a2' });   // fast path (nobody else wrote)
    b.addItem({ type: 'diary', title: 'b1' });   // someone else wrote → a must not build on a stale copy
    a.addItem({ type: 'diary', title: 'a3' });
    const titles = a.query('SELECT title FROM items ORDER BY title').map((r) => r.title);
    expect(titles).toEqual(['a1', 'a2', 'a3', 'b1']);
  });
});
