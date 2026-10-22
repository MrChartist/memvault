import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import crypto from 'crypto';

// The server workspace: off by default, behind the token, confined to its folder, audited.
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'memvault-ws-'));
process.env.VAULT_ROOT = path.join(ROOT, 'vault');
process.env.MEMVAULT_TOKEN_FILE = path.join(ROOT, 'home', 'api-token');
delete process.env.MEMVAULT_WORKSPACE;

const TOKEN = 'test-token-' + crypto.randomBytes(8).toString('hex');
const PROJ = path.join(ROOT, 'proj');
const servers = [];

function req(port, method, p, { body, token = TOKEN } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const h = {};
    if (token) h.authorization = `Bearer ${token}`;
    if (payload) { h['content-type'] = 'application/json'; h['content-length'] = Buffer.byteLength(payload); }
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers: h }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => { let json = null; try { json = JSON.parse(data); } catch { /* not json */ } resolve({ status: res.statusCode, json }); });
    });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

async function boot(security) {
  const D = await import('../db.mjs');
  const S = await import('../server.mjs');
  const vdb = D.openVaultDb({ root: process.env.VAULT_ROOT });
  const port = await new Promise((res) => { const probe = http.createServer().listen(0, '127.0.0.1', () => { const p = probe.address().port; probe.close(() => res(p)); }); });
  const app = S.createApp({ vdb, token: TOKEN, port, root: process.env.VAULT_ROOT, security: { allowedHosts: [], allowedOrigins: [], audit: true, ...security } });
  const server = await new Promise((res) => { const s = app.listen(port, '127.0.0.1', () => res(s)); });
  servers.push({ server, app });
  return port;
}

let off, on;
beforeAll(async () => {
  fs.mkdirSync(path.join(PROJ, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(PROJ, 'app.env'), 'PORT=1\n', { mode: 0o640 });
  fs.writeFileSync(path.join(PROJ, 'blob.bin'), Buffer.from([0, 1, 2]));
  fs.writeFileSync(path.join(ROOT, 'outside.txt'), 'secret');
  try { fs.symlinkSync(path.join(ROOT, 'outside.txt'), path.join(PROJ, 'link')); } catch { /* no symlinks */ }
  off = await boot({});
  on = await boot({ workspace: { enabled: true, root: PROJ } });
});
afterAll(() => { for (const { server, app } of servers) { app.locals.terminals?.closeAll(); server.close(); } });

describe('workspace', () => {
  it('is off unless turned on', async () => {
    expect((await req(off, 'GET', '/api/workspace')).json.enabled).toBe(false);
    expect((await req(off, 'GET', '/api/fs/list')).status).toBe(404);
    expect((await req(off, 'POST', '/api/term/open', { body: {} })).status).toBe(404);
  });

  it('needs the key for every route', async () => {
    for (const [m, p] of [['GET', '/api/workspace'], ['GET', '/api/system/status'], ['GET', '/api/fs/list'], ['POST', '/api/term/open'], ['POST', '/api/system/process/restart']]) {
      expect((await req(on, m, p, { token: null, body: m === 'POST' ? {} : undefined })).status).toBe(401);
    }
  });

  it('reports system health', async () => {
    const r = await req(on, 'GET', '/api/system/status');
    expect(r.json.ok).toBe(true);
    expect(r.json.memory.total).toBeGreaterThan(0);
    expect(typeof r.json.cpu.percent).toBe('number');
  });

  it('lists, reads and atomically writes files inside the root only', async () => {
    const l = await req(on, 'GET', '/api/fs/list?path=.');
    expect(l.json.entries.map((e) => e.name)).toEqual(expect.arrayContaining(['sub', 'app.env']));
    expect(l.json.entries[0].dir).toBe(true);
    const r = await req(on, 'GET', '/api/fs/read?path=app.env');
    expect(r.json.content).toBe('PORT=1\n');
    const w = await req(on, 'POST', '/api/fs/write', { body: { path: 'app.env', content: 'PORT=2\n', mtime: r.json.mtime } });
    expect(w.status).toBe(200);
    expect(fs.readFileSync(path.join(PROJ, 'app.env'), 'utf8')).toBe('PORT=2\n');
    if (process.platform !== 'win32') expect(fs.statSync(path.join(PROJ, 'app.env')).mode & 0o777).toBe(0o640);
    expect(fs.readdirSync(PROJ).some((f) => f.endsWith('.tmp'))).toBe(false);
    // a stale copy is refused rather than overwriting someone else's change
    expect((await req(on, 'POST', '/api/fs/write', { body: { path: 'app.env', content: 'x', mtime: r.json.mtime } })).status).toBe(409);
    expect((await req(on, 'GET', '/api/fs/read?path=blob.bin')).status).toBe(415);
    expect((await req(on, 'GET', '/api/fs/read?path=../outside.txt')).status).toBe(403);
    expect((await req(on, 'POST', '/api/fs/write', { body: { path: '../evil.txt', content: 'x' } })).status).toBe(403);
    if (fs.existsSync(path.join(PROJ, 'link'))) expect((await req(on, 'GET', '/api/fs/read?path=link')).status).toBe(403);
    const log = fs.readFileSync(path.join(process.env.VAULT_ROOT, 'audit.log'), 'utf8');
    expect(log).toContain('"file-write"');
  });

  it('refuses bad service names and actions', async () => {
    expect((await req(on, 'POST', '/api/system/process/delete', { body: { name: 'x' } })).status).toBe(400);
    expect((await req(on, 'POST', '/api/system/process/restart', { body: { name: 'x; rm -rf /' } })).status).toBe(400);
    expect((await req(on, 'POST', '/api/system/process/restart', { body: { name: '--all' } })).status).toBe(400);
  });

  it.skipIf(process.platform === 'win32')('runs a shell over HTTP', async () => {
    const o = await req(on, 'POST', '/api/term/open', { body: { cols: 80, rows: 24 } });
    expect(o.status).toBe(200);
    await req(on, 'POST', `/api/term/${o.json.id}/write`, { body: { data: 'echo ws-$((20+22))\n' } });
    let seq = 0, out = '';
    for (let i = 0; i < 20 && !out.includes('ws-42'); i++) {
      const r = await req(on, 'GET', `/api/term/${o.json.id}/read?since=${seq}`);
      seq = r.json.seq; out += r.json.data;
    }
    expect(out).toContain('ws-42');
    expect((await req(on, 'POST', `/api/term/${o.json.id}/close`)).status).toBe(200);
    expect((await req(on, 'GET', `/api/term/${o.json.id}/read`)).status).toBe(404);
    expect(fs.readFileSync(path.join(process.env.VAULT_ROOT, 'audit.log'), 'utf8')).toContain('"terminal-open"');
  }, 30_000);

  it('lets the owner make a device view only for the server', async () => {
    const K = await import('../device-keys.mjs');
    const { code } = K.createPairingCode({ name: 'Phone' });
    const { id, key } = K.redeemPairingCode(code);
    expect((await req(on, 'GET', '/api/fs/read?path=app.env', { token: key })).status).toBe(200);
    expect((await req(on, 'PUT', `/devices/phones/${id}`, { token: key, body: { serverViewOnly: true } })).status).toBe(403); // not from the phone itself
    expect((await req(on, 'PUT', `/devices/phones/${id}`, { body: { serverViewOnly: true } })).status).toBe(200);
    expect((await req(on, 'GET', '/api/workspace', { token: key })).json.viewOnly).toBe(true);
    expect((await req(on, 'GET', '/api/fs/read?path=app.env', { token: key })).status).toBe(200); // looking is fine
    expect((await req(on, 'GET', '/api/system/status', { token: key })).status).toBe(200);
    expect((await req(on, 'POST', '/api/fs/write', { token: key, body: { path: 'app.env', content: 'x' } })).status).toBe(403);
    expect((await req(on, 'POST', '/api/term/open', { token: key, body: {} })).status).toBe(403);
    expect((await req(on, 'POST', '/api/system/process/restart', { token: key, body: { name: 'web' } })).status).toBe(403);
    expect((await req(on, 'GET', '/api/workspace')).json.viewOnly).toBe(false); // the owner key is never view only
    expect((await req(on, 'PUT', `/devices/phones/${id}`, { body: { serverViewOnly: false } })).status).toBe(200);
    expect((await req(on, 'GET', '/api/workspace', { token: key })).json.viewOnly).toBe(false);
  });
});
