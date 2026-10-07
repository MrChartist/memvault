import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import crypto from 'crypto';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'memvault-srv-'));
process.env.VAULT_ROOT = ROOT;
process.env.MEMVAULT_TOKEN_FILE = path.join(ROOT, 'token');

const TOKEN = 'test-token-' + crypto.randomBytes(8).toString('hex');
let server, port, S, D;

/** Raw HTTP so tests can control Host / Origin headers exactly (fetch will not). */
function req(method, p, { headers = {}, body, token = TOKEN, host } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const h = { ...headers };
    if (token) h.authorization = `Bearer ${token}`;
    if (payload) { h['content-type'] = 'application/json'; h['content-length'] = Buffer.byteLength(payload); }
    if (host) h.host = host;
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers: h }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch { /* not json */ }
        resolve({ status: res.statusCode, headers: res.headers, json, text: data });
      });
    });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

beforeAll(async () => {
  D = await import('../db.mjs');
  S = await import('../server.mjs');
  const vdb = D.openVaultDb({ root: ROOT });
  // pick a free port first so the Host allow-list matches it
  port = await new Promise((res) => {
    const probe = http.createServer().listen(0, '127.0.0.1', () => { const p = probe.address().port; probe.close(() => res(p)); });
  });
  const app = S.createApp({ vdb, token: TOKEN, port, root: ROOT });
  server = await new Promise((res) => { const s = app.listen(port, '127.0.0.1', () => res(s)); });
});

afterAll(() => {
  server?.close();
  fs.rmSync(ROOT, { recursive: true, force: true });
});

describe('server — who may talk to it', () => {
  it('serves the UI shell and a minimal /health without a token', async () => {
    const ui = await req('GET', '/', { token: null });
    expect(ui.status).toBe(200);
    const h = await req('GET', '/health', { token: null });
    expect(h.json).toMatchObject({ ok: true, name: 'memvault' });
    expect(JSON.stringify(h.json)).not.toContain(ROOT); // no filesystem paths
  });

  it('rejects data routes with no token or a wrong token', async () => {
    for (const p of ['/list', '/search?q=x', '/agents', '/secrets/list', '/audit']) {
      expect((await req('GET', p, { token: null })).status).toBe(401);
      expect((await req('GET', p, { token: 'wrong' })).status).toBe(401);
    }
    expect((await req('POST', '/clear', { token: null, body: { confirm: 'DELETE ALL' } })).status).toBe(401);
  });

  it('accepts the right token', async () => {
    expect((await req('GET', '/list')).status).toBe(200);
  });

  it('blocks DNS-rebinding: a foreign Host header is refused even with a valid token', async () => {
    const r = await req('GET', '/list', { host: 'evil.example.com' });
    expect(r.status).toBe(403);
  });

  it('blocks cross-site browser requests: a foreign Origin is refused even with a valid token', async () => {
    const r = await req('GET', '/list', { headers: { origin: 'https://evil.example.com' } });
    expect(r.status).toBe(403);
    const ok = await req('GET', '/list', { headers: { origin: `http://127.0.0.1:${port}` } });
    expect(ok.status).toBe(200);
  });

  it('never sends CORS headers, and refuses preflights', async () => {
    const pre = await req('OPTIONS', '/list', { headers: { origin: 'https://evil.example.com', 'access-control-request-method': 'GET' } });
    expect(pre.status).toBe(403);
    const normal = await req('GET', '/list');
    expect(normal.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('sends hardening headers', async () => {
    const r = await req('GET', '/', { token: null });
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['x-frame-options']).toBe('DENY');
    const csp = r.headers['content-security-policy'];
    expect(csp).toMatch(/frame-ancestors 'none'/);
    expect(csp).not.toMatch(/unsafe-inline/);     // no inline script or style
    expect(csp).not.toMatch(/https?:\/\//);        // no third-party origins at all
  });

  it('says so and exits non-zero when the port is already taken (it used to claim success)', async () => {
    const busy = http.createServer();
    await new Promise((r) => busy.listen(0, '127.0.0.1', r));
    const busyPort = busy.address().port;
    const exits = [];
    const exit = vi.spyOn(process, 'exit').mockImplementation((c) => { exits.push(c); });
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const second = S.start({ app: S.createApp({ vdb: D.openVaultDb({ root: ROOT }), token: TOKEN, port: busyPort, root: ROOT }), port: busyPort, host: '127.0.0.1' });
    await new Promise((r) => setTimeout(r, 300));
    const printed = log.mock.calls.flat().join('\n');
    const errored = err.mock.calls.flat().join('\n');
    exit.mockRestore(); err.mockRestore(); log.mockRestore();
    second.close(); busy.close();
    expect(exits).toEqual([1]);
    expect(errored).toMatch(/already in use/);
    expect(printed).not.toMatch(/API & dashboard on/);
  });

  it('refuses to start on a non-loopback address unless allowRemote is set', () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => S.start({ app: { listen: () => {} }, host: '0.0.0.0', port: 1 })).toThrow('exit');
    expect(err.mock.calls.join('\n')).toMatch(/Refusing to listen/);
    exit.mockRestore();
    err.mockRestore();
  });
});

describe('server — adding and finding memory', () => {
  it('masks secrets on /add and says so', async () => {
    const r = await req('POST', '/add', { body: { type: 'diary', title: 'ci', content: 'DB_PASSWORD=correcthorsebattery' } });
    expect(r.status).toBe(200);
    expect(r.json.redacted).toEqual([{ type: 'secret-assignment', count: 1 }]);
    const s = await req('GET', '/search?q=DB_PASSWORD');
    expect(s.text).not.toContain('correcthorsebattery');
  });

  it('/add-many stores a batch in one call and validates every item', async () => {
    const items = Array.from({ length: 50 }, (_, i) => ({ type: 'conversation', source: 'bulk', title: `bulk ${i}`, content: 'x' }));
    const r = await req('POST', '/add-many', { body: { items } });
    expect(r.json.ids).toHaveLength(50);
    const bad = await req('POST', '/add-many', { body: { items: [{ type: 'diary' }, { type: 'nope' }] } });
    expect(bad.status).toBe(400);
  });

  it('rejects malformed scopes and agent ids', async () => {
    expect((await req('POST', '/add', { body: { type: 'diary', scope: 'everything' } })).status).toBe(400);
    expect((await req('POST', '/add', { body: { type: 'diary', agent_id: 'Bad Id' } })).status).toBe(400);
  });

  it('/upload goes through the same door: the file name is masked and the write is audited', async () => {
    const boundary = 'mvtest' + crypto.randomBytes(6).toString('hex');
    const name = 'deploy ghp_abcdefghijklmnopqrstuvwxyz0123456789.txt';
    const body = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: text/plain\r\n\r\n` +
      `hello\r\n--${boundary}--\r\n`
    );
    const r = await new Promise((resolve, reject) => {
      const q = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/upload', headers: {
        authorization: `Bearer ${TOKEN}`, 'content-type': `multipart/form-data; boundary=${boundary}`, 'content-length': body.length,
      } }, (res) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(d) })); });
      q.on('error', reject);
      q.end(body);
    });
    expect(r.status).toBe(200);
    const row = D.openVaultDb({ root: ROOT }).query('SELECT title, file_path FROM items WHERE id = ?', [r.json.id])[0];
    expect(row.title).not.toContain('ghp_abc');
    expect(row.title).toContain('REDACTED');
    expect(row.file_path).not.toMatch(/abcdefghijklmnop/); // not in the name on disk either
    expect(fs.readFileSync(row.file_path, 'utf8')).toBe('hello');
    const { tailAudit } = await import('../audit.mjs');
    const adds = tailAudit(50, {}, ROOT).filter((x) => x.action === 'add' && x.detail.type === 'file');
    expect(adds.length).toBeGreaterThan(0);
    expect(JSON.stringify(tailAudit(500, {}, ROOT))).not.toContain('ghp_abc');
  });

  it('"view as agent" filters search and list to what that agent may see', async () => {
    await req('PUT', '/agents/ana', { body: { name: 'Ana' } });
    await req('PUT', '/agents/bob', { body: { name: 'Bob' } });
    await req('POST', '/add', { body: { type: 'diary', title: 'ana-private-note', agent_id: 'ana', scope: 'agent:ana' } });
    await req('POST', '/add', { body: { type: 'diary', title: 'shared-note-for-all' } });
    const asBob = await req('GET', '/search?q=note&agent=bob');
    const titles = asBob.json.results.map((r) => r.title);
    expect(titles).toContain('shared-note-for-all');
    expect(titles).not.toContain('ana-private-note');
    const asAna = await req('GET', '/list?agent=ana');
    expect(asAna.json.results.map((r) => r.title)).toContain('ana-private-note');
    expect((await req('GET', '/list?agent=ghost')).status).toBe(404);
  });
});

describe('server — /clear can no longer silently wipe the vault', () => {
  async function seed() {
    await req('POST', '/add-many', {
      body: {
        items: [
          { type: 'worklog', source: 'antigravity', title: 'synced', tags: 'antigravity,conv:abcd1234' },
          { type: 'worklog', source: 'antigravity', title: 'hand-written', tags: 'worklog' },
          { type: 'diary', source: 'manual', title: 'my diary', tags: 'diary' },
        ],
      },
    });
  }
  const count = async () => (await req('GET', '/list?limit=500')).json.results.length;

  it('refuses without the confirmation phrase and deletes nothing', async () => {
    await seed();
    const before = await count();
    const r = await req('POST', '/clear', { body: {} });
    expect(r.status).toBe(400);
    expect(r.json.error).toMatch(/DELETE ALL/);
    expect(await count()).toBe(before);
  });

  it('a scoped clear removes only matching items, and takes a backup first', async () => {
    const r = await req('POST', '/clear', { body: { confirm: 'DELETE', source: 'antigravity', tagPrefix: 'conv:' } });
    expect(r.status).toBe(200);
    expect(r.json.deleted).toBe(1);
    expect(r.json.backup).toMatch(/^index-.*\.sqlite$/);
    const titles = (await req('GET', '/list?limit=500')).json.results.map((x) => x.title);
    expect(titles).not.toContain('synced');
    expect(titles).toContain('hand-written');
    expect(titles).toContain('my diary');
  });

  it('a full wipe needs the stronger phrase, and is recoverable from the backup', async () => {
    expect((await req('POST', '/clear', { body: { confirm: 'DELETE' } })).status).toBe(400); // wrong phrase for a full wipe
    const r = await req('POST', '/clear', { body: { confirm: 'DELETE ALL' } });
    expect(r.status).toBe(200);
    expect(await count()).toBe(0);
    // The pre-wipe backup really contains the data we just deleted.
    const initSqlJs = (await import('sql.js')).default;
    const SQL = await initSqlJs();
    const backup = new SQL.Database(fs.readFileSync(path.join(ROOT, 'backups', r.json.backup)));
    const n = backup.exec('SELECT COUNT(*) FROM items')[0].values[0][0];
    expect(n).toBeGreaterThan(50); // the 50 bulk items + seeds were all there
    expect(backup.exec("SELECT COUNT(*) FROM items WHERE title = 'my diary'")[0].values[0][0]).toBe(1);
  });
});

describe('server — secrets', () => {
  const PW = 'correct horse battery';
  let id;

  it('insists on a real master password the first time', async () => {
    const r = await req('POST', '/secrets/add', { body: { password: 'short', category: 'apikey', label: 'x', fields: { k: 'v' } } });
    expect(r.status).toBe(400);
    expect(r.json.error).toMatch(/at least 10/);
  });

  it('stores encrypted (v2) and round-trips', async () => {
    const add = await req('POST', '/secrets/add', { body: { password: PW, category: 'apikey', label: 'OpenAI', fields: { key: 'sk-test-123' } } });
    expect(add.status).toBe(200);
    id = add.json.id;
    const raw = D.openVaultDb({ root: ROOT }).query('SELECT encrypted FROM secrets WHERE id = ?', [id])[0].encrypted;
    expect(raw).not.toContain('sk-test-123');
    expect(JSON.parse(raw).v).toBe(2);
    const get = await req('POST', '/secrets/get', { body: { password: PW, id } });
    expect(get.json.fields).toEqual({ key: 'sk-test-123' });
  });

  it('lists labels only', async () => {
    const r = await req('GET', '/secrets/list');
    expect(r.json.secrets[0]).toMatchObject({ label: 'OpenAI', category: 'apikey' });
    expect(r.text).not.toMatch(/encrypted|sk-test-123|ciphertext/);
  });

  it('upgrades an old v1 secret to v2 the first time it is opened', async () => {
    const key = crypto.pbkdf2Sync(PW, 'memvault-salt-v1', 100_000, 32, 'sha256');
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', key, iv);
    const ct = Buffer.concat([c.update(JSON.stringify({ user: 'rohit' }), 'utf8'), c.final()]);
    const legacy = JSON.stringify({ iv: iv.toString('base64'), authTag: c.getAuthTag().toString('base64'), ciphertext: ct.toString('base64') });
    D.openVaultDb({ root: ROOT }).run(
      "INSERT INTO secrets (id,category,label,encrypted,created_at,updated_at) VALUES ('legacy1','userid','Old','" + legacy + "','x','x')"
    );
    const get = await req('POST', '/secrets/get', { body: { password: PW, id: 'legacy1' } });
    expect(get.json.fields).toEqual({ user: 'rohit' });
    const after = D.openVaultDb({ root: ROOT }).query("SELECT encrypted FROM secrets WHERE id='legacy1'")[0].encrypted;
    expect(JSON.parse(after).v).toBe(2);
    expect((await req('POST', '/secrets/get', { body: { password: PW, id: 'legacy1' } })).json.fields).toEqual({ user: 'rohit' });
  });

  it('locks out after repeated wrong passwords, even for the right one, then reports when to retry', async () => {
    for (let i = 0; i < 5; i++) {
      expect((await req('POST', '/secrets/get', { body: { password: 'wrong-wrong-wrong', id } })).status).toBe(401);
    }
    const locked = await req('POST', '/secrets/get', { body: { password: PW, id } });
    expect(locked.status).toBe(429);
    expect(Number(locked.headers['retry-after'])).toBeGreaterThan(0);
  });
});

describe('server — agents and audit', () => {
  it('lists packs, installs the default one, a named one, and refuses an unknown one', async () => {
    const packs = await req('GET', '/agents/packs');
    expect(packs.json.packs.map((p) => p.id)).toEqual(['general', 'markets']);
    const def = await req('POST', '/agents/starter', { body: {} });
    expect(def.json.installed).toContain('assistant');
    expect(def.json.installed).not.toContain('market-analyst');
    const markets = await req('POST', '/agents/starter', { body: { pack: 'markets' } });
    expect(markets.json.installed).toContain('market-analyst');
    expect((await req('POST', '/agents/starter', { body: { pack: 'nope' } })).status).toBe(400);
  });

  it('serves an activation briefing built from the profile', async () => {
    const b = await req('GET', '/agents/market-analyst/brief?task=nifty');
    expect(b.json.briefing).toMatch(/You are acting as: Market Analyst/);
  });

  it('drafts a profile from a prompt without saving it', async () => {
    const r = await req('POST', '/agents/draft', { body: { prompt: 'You are a patient maths tutor. Never give the final answer first.', name: 'Tutor' } });
    expect(r.json.profile.role).toMatch(/^A patient maths tutor/);
    expect((await req('GET', '/agents/tutor')).status).toBe(404);
  });

  it('rejects an invalid profile with a readable message', async () => {
    const r = await req('PUT', '/agents/bad', { body: { name: 'x', memory: { readScopes: ['everything'] } } });
    expect(r.status).toBe(400);
    expect(r.json.error).toMatch(/readScopes/);
  });

  it('delete with purge backs up first and removes only that agent\'s private memory', async () => {
    await req('PUT', '/agents/temp', { body: { name: 'Temp' } });
    await req('POST', '/add', { body: { type: 'diary', title: 'temp-private', agent_id: 'temp', scope: 'agent:temp' } });
    const r = await req('DELETE', '/agents/temp?purge=1');
    expect(r.json.ok).toBe(true);
    expect(r.json.backup).toMatch(/^index-/);
    expect((await req('GET', '/list?limit=500')).json.results.map((x) => x.title)).not.toContain('temp-private');
  });

  it('exposes a verifiable audit trail that never contains content', async () => {
    const a = await req('GET', '/audit?limit=200');
    expect(a.json.chain.ok).toBe(true);
    expect(a.json.recent.some((r) => r.action === 'clear')).toBe(true);
    expect(a.text).not.toMatch(/correcthorsebattery|sk-test-123/);
  });
});


describe('server — stats, status and client config', () => {
  it('/stats aggregates in one call', async () => {
    await req('POST', '/add', { body: { type: 'diary', title: 'stat me' } });
    await req('POST', '/add', { body: { type: 'worklog', title: 'and me', agent_id: 'ana', scope: 'agent:ana' } });
    const r = await req('GET', '/stats');
    expect(r.json.total).toBeGreaterThanOrEqual(2);
    expect(r.json.byType.diary).toBeGreaterThanOrEqual(1);
    expect(r.json.privateItems).toBeGreaterThanOrEqual(1);
    expect(r.json.byAgent.find((a) => a.agent_id === 'ana').n).toBeGreaterThanOrEqual(1);
  });

  it('/status reports the real posture (loopback, masking on, audit intact)', async () => {
    const r = await req('GET', '/status?deep=1');
    expect(r.json.ok).toBe(true);
    const titles = r.json.rows.map((x) => x.title).join('\n');
    expect(titles).toMatch(/Secret masking is ON/);
    expect(titles).toMatch(/Audit log intact/);
    expect(r.json.counts.bad).toBe(0);
  });

  it('/agents/:id/mcp-config returns config bound to that agent, 404 for unknown', async () => {
    const r = await req('GET', '/agents/market-analyst/mcp-config');
    const entry = r.json.config.mcpServers['memvault-market-analyst'];
    expect(entry.env.MEMVAULT_AGENT).toBe('market-analyst');
    expect(entry.args[0]).toMatch(/mcp-server\.mjs$/);
    expect((await req('GET', '/agents/ghost/mcp-config')).status).toBe(404);
  });
});

describe('diagnostics', () => {
  it('shows paths as ~/… so the account name is not revealed', async () => {
    const { tildify } = await import('../diagnostics.mjs');
    expect(tildify('/home/alice/.memvault/data', '/home/alice')).toBe('~/.memvault/data');
    expect(tildify('/home/alice', '/home/alice')).toBe('~');
    expect(tildify('/home/alicia/x', '/home/alice')).toBe('/home/alicia/x'); // not a prefix match on a longer name
    expect(tildify('/srv/vault', '/home/alice')).toBe('/srv/vault');
  });
});

describe('server — errors', () => {
  it('returns clean JSON for malformed bodies, never a stack trace', async () => {
    const r = await new Promise((resolve) => {
      const q = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/add', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' } },
        (res) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => resolve({ status: res.statusCode, text: d })); });
      q.write('{not json'); q.end();
    });
    expect(r.status).toBe(400);
    expect(r.text).not.toMatch(/at .*\.js|node_modules/);
  });
});
