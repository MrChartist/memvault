import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { fileURLToPath } from 'url';

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'memvault-db-'));
process.env.VAULT_ROOT = TMP;
process.env.HOME = process.env.USERPROFILE = path.join(TMP, 'home');

let db;
beforeAll(async () => { db = await import('../db.mjs'); });
afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));

const count = () => db.queryOne('SELECT COUNT(*) AS n FROM items').n;

describe('db — addItems', () => {
  it('inserts and returns ids', () => {
    const r = db.addItems([{ type: 'diary', title: 'one', content: 'first' }, { type: 'worklog', title: 'two' }]);
    expect(r.inserted).toBe(2);
    expect(r.ids).toHaveLength(2);
    expect(count()).toBe(2);
  });

  it('is idempotent for entries that carry their own timestamp', () => {
    const e = { type: 'worklog', source: 'git', title: 'commit', content: 'x', created_at: '2026-01-01T10:00:00Z' };
    const before = count();
    expect(db.addItems([e]).inserted).toBe(1);
    const again = db.addItems([e, e]);
    expect(again.inserted).toBe(0);
    expect(again.duplicates).toBe(2);
    expect(count()).toBe(before + 1);
  });

  it('does NOT dedupe entries without a timestamp (two diary notes can be identical)', () => {
    const before = count();
    db.addItems([{ type: 'diary', title: 'same', content: 'same' }]);
    db.addItems([{ type: 'diary', title: 'same', content: 'same' }]);
    expect(count()).toBe(before + 2);
  });

  it('upsert replaces a previous snapshot with the same source+title', () => {
    db.addItems([{ type: 'worklog', source: 'system', title: '[System] Disk', content: 'v1', upsert: true }]);
    db.addItems([{ type: 'worklog', source: 'system', title: '[System] Disk', content: 'v2', upsert: true }]);
    const rows = db.queryAll("SELECT content FROM items WHERE source = 'system'");
    expect(rows).toEqual([{ content: 'v2' }]);
  });

  it('normalises dates and falls back to now for unparseable ones', () => {
    const { ids } = db.addItems([{ type: 'diary', title: 'bad date', created_at: 'not a date' }]);
    const row = db.queryOne('SELECT created_at FROM items WHERE id = ?', [ids[0]]);
    expect(Number.isNaN(new Date(row.created_at).getTime())).toBe(false);
  });

  it('rolls back the whole batch if one entry is invalid', () => {
    const before = count();
    expect(() => db.addItems([{ type: 'diary', title: 'ok' }, { type: 'bogus', title: 'bad' }])).toThrow(/Invalid entry type/);
    expect(count()).toBe(before);
  });

  it('stores quotes and SQL text verbatim', () => {
    const nasty = `Robert'); DROP TABLE items;-- "q"`;
    const { ids } = db.addItems([{ type: 'diary', title: nasty, content: nasty }]);
    expect(db.queryOne('SELECT title FROM items WHERE id = ?', [ids[0]]).title).toBe(nasty);
    expect(count()).toBeGreaterThan(0);
  });
});

describe('db — searchItems', () => {
  beforeAll(() => {
    db.addItems([
      { type: 'diary', title: 'Budget 100% plan', content: 'spend_less' },
      { type: 'diary', title: 'Budget 1000 plan', content: 'spendXless' },
      { type: 'worklog', title: 'Auth rewrite', content: 'sessions and tokens', tags: 'auth', created_at: '2026-03-01T12:00:00Z' },
      { type: 'worklog', title: 'Old thing', content: 'sessions', created_at: '2025-01-01T12:00:00Z' },
    ]);
  });

  it('matches % and _ literally, not as wildcards', () => {
    expect(db.searchItems({ terms: ['100%'] }).map((r) => r.title)).toEqual(['Budget 100% plan']);
    expect(db.searchItems({ terms: ['spend_less'] }).map((r) => r.title)).toEqual(['Budget 100% plan']);
  });

  it('supports any/all matching across terms', () => {
    expect(db.searchItems({ terms: ['auth', 'sessions'], match: 'all' }).map((r) => r.title)).toEqual(['Auth rewrite']);
    expect(db.searchItems({ terms: ['auth', 'old'], match: 'any' }).length).toBe(2);
  });

  it('filters by type and date range', () => {
    expect(db.searchItems({ terms: ['sessions'], type: 'worklog' }).length).toBe(2);
    const r = db.searchItems({ terms: ['sessions'], since: '2026-01-01T00:00:00Z', until: '2026-12-31T00:00:00Z' });
    expect(r.map((x) => x.title)).toEqual(['Auth rewrite']);
  });

  it('clamps absurd limits and returns newest first', () => {
    expect(db.searchItems({ terms: [], limit: 1e9 }).length).toBeGreaterThan(0);
    const dates = db.searchItems({ terms: [], limit: 50 }).map((r) => r.created_at);
    expect([...dates].sort().reverse()).toEqual(dates);
  });

  it('survives SQL metacharacters in terms', () => {
    expect(() => db.searchItems({ terms: [`'; DROP TABLE items; --`, '\\', '%', '_'] })).not.toThrow();
    expect(count()).toBeGreaterThan(0);
  });
});

describe('db — getStats', () => {
  it('reports totals per type', () => {
    const s = db.getStats();
    expect(s.total).toBe(count());
    expect(s.byType.map((r) => r.type)).toContain('diary');
    expect(s.secrets).toBe(0);
  });
});

describe('db — several processes sharing one vault (the lost-update bug)', () => {
  it('sees rows written by another process', async () => {
    const before = count();
    const child = path.join(TMP, 'child.mjs');
    fs.writeFileSync(child, `
      import { addItems } from ${JSON.stringify(path.join(ROOT, 'db.mjs'))};
      addItems([{ type: 'diary', title: 'written by a child process' }]);
    `);
    await execFileAsync(process.execPath, [child], { env: { ...process.env, VAULT_ROOT: TMP } });
    expect(count()).toBe(before + 1);
    // ...and our own next write must not erase it
    db.addItems([{ type: 'diary', title: 'written by the test process' }]);
    expect(db.queryAll("SELECT title FROM items WHERE title = 'written by a child process'").length).toBe(1);
  });

  it('loses no writes when many processes write at the same time', async () => {
    const WORKERS = 6;
    const PER_WORKER = 15;
    const script = path.join(TMP, 'writer.mjs');
    fs.writeFileSync(script, `
      import { addItems } from ${JSON.stringify(path.join(ROOT, 'db.mjs'))};
      const id = process.argv[2];
      for (let i = 0; i < ${PER_WORKER}; i++) addItems([{ type: 'worklog', source: 'stress', title: id + '-' + i }]);
    `);
    const before = count();
    await Promise.all(
      Array.from({ length: WORKERS }, (_, w) =>
        execFileAsync(process.execPath, [script, `w${w}`], { env: { ...process.env, VAULT_ROOT: TMP } })
      )
    );
    const rows = db.queryAll("SELECT title FROM items WHERE source = 'stress'");
    expect(rows.length).toBe(WORKERS * PER_WORKER);
    expect(new Set(rows.map((r) => r.title)).size).toBe(WORKERS * PER_WORKER);
    expect(count()).toBe(before + WORKERS * PER_WORKER);
    // and no lock / temp files left behind
    const leftovers = fs.readdirSync(path.join(TMP, 'db')).filter((f) => f !== 'index.sqlite');
    expect(leftovers).toEqual([]);
  }, 60_000);

  it('recovers from a stale lock left by a crashed process', () => {
    const lock = path.join(TMP, 'db', 'index.sqlite.lock');
    fs.writeFileSync(lock, '');
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(lock, old, old);
    const before = count();
    db.addItems([{ type: 'diary', title: 'after stale lock' }]);
    expect(count()).toBe(before + 1);
    expect(fs.existsSync(lock)).toBe(false);
  });
});

describe('db — legacy FTS triggers', () => {
  it('drops old FTS triggers that would make every insert fail', async () => {
    // Simulate a vault created by an early build: a trigger pointing at the (unsupported) FTS table.
    const initSqlJs = (await import('sql.js')).default;
    const SQL = await initSqlJs();
    const file = path.join(TMP, 'db', 'index.sqlite');
    const d = new SQL.Database(fs.readFileSync(file));
    d.run('CREATE TRIGGER items_ai AFTER INSERT ON items BEGIN INSERT INTO items_fts(rowid) VALUES (new.rowid); END;');
    fs.writeFileSync(file, Buffer.from(d.export()));

    const before = count(); // triggers a reload from disk
    expect(() => db.addItems([{ type: 'diary', title: 'insert despite legacy trigger' }])).not.toThrow();
    expect(count()).toBe(before + 1);
  });
});
