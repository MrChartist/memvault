import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'memvault-server-'));
process.env.VAULT_ROOT = TMP;
process.env.HOME = process.env.USERPROFILE = path.join(TMP, 'home');
fs.mkdirSync(process.env.HOME, { recursive: true });
fs.writeFileSync(
  path.join(process.env.HOME, '.memvaultrc.json'),
  JSON.stringify({ server: { allowedOrigins: ['https://trusted.example'], allowedHosts: ['memvault.internal'] } })
);

let server;
let port;
let security;

/** Raw HTTP so tests can send ANY Host / Origin header (fetch() forbids some). */
function request(method, urlPath, { headers = {}, body, json } = {}) {
  return new Promise((resolve, reject) => {
    const payload = json !== undefined ? JSON.stringify(json) : body;
    // Explicit Content-Length: Node does not frame bodies on DELETE/GET by itself.
    const framing = payload !== undefined ? { 'content-length': Buffer.byteLength(payload) } : {};
    const req = http.request(
      { host: '127.0.0.1', port, method, path: urlPath, agent: false, headers: { ...(json !== undefined ? { 'content-type': 'application/json' } : {}), ...framing, ...headers } },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          let parsed = null;
          try { parsed = JSON.parse(data); } catch { /* not json */ }
          resolve({ status: res.statusCode, headers: res.headers, body: parsed, text: data });
        });
      }
    );
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

beforeAll(async () => {
  security = await import('../security.mjs');
  const { createApp } = await import('../server.mjs');
  server = await new Promise((resolve) => {
    const s = createApp().listen(0, '127.0.0.1', () => resolve(s));
  });
  port = server.address().port;
});
afterAll(async () => {
  await new Promise((r) => server.close(r));
  fs.rmSync(TMP, { recursive: true, force: true });
});

describe('server — basic API', () => {
  it('GET /health', async () => {
    const r = await request('GET', '/health');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, vault: TMP });
    expect(r.body.version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('serves the web UI', async () => {
    const r = await request('GET', '/');
    expect(r.status).toBe(200);
    expect(r.text).toContain('<title>MemVault');
  });

  it('POST /add then GET /search and /list', async () => {
    const add = await request('POST', '/add', { json: { type: 'diary', title: 'Hello vault', content: 'first note', tags: 'x' } });
    expect(add.body.ok).toBe(true);
    expect((await request('GET', '/search?q=first%20note')).body.results[0].title).toBe('Hello vault');
    expect((await request('GET', '/list?type=diary')).body.results.length).toBeGreaterThan(0);
  });

  it('validates input', async () => {
    expect((await request('POST', '/add', { json: { type: 'nonsense' } })).status).toBe(400);
    expect((await request('POST', '/add', { json: { type: 'diary', source: 'x'.repeat(500) } })).status).toBe(400);
  });

  it('malformed JSON gives a clean 400, not a stack trace', async () => {
    const r = await request('POST', '/add', { headers: { 'content-type': 'application/json' }, body: '{not json' });
    expect(r.status).toBe(400);
    expect(r.body.ok).toBe(false);
    expect(r.text).not.toMatch(/at .*\.js|node_modules/);
  });

  it('de-duplicates entries that carry a timestamp', async () => {
    const e = { type: 'worklog', source: 'git', title: 'c', content: 'x', created_at: '2026-01-01T00:00:00Z' };
    expect((await request('POST', '/add', { json: e })).body.duplicate).toBe(false);
    expect((await request('POST', '/add', { json: e })).body.duplicate).toBe(true);
  });

  it('POST /add/batch inserts many with one write and enforces the cap', async () => {
    const entries = Array.from({ length: 50 }, (_, i) => ({ type: 'worklog', title: `b${i}`, created_at: `2026-02-01T00:00:${String(i).padStart(2, '0')}Z` }));
    const r = await request('POST', '/add/batch', { json: { entries } });
    expect(r.body).toMatchObject({ ok: true, inserted: 50, duplicates: 0 });
    expect((await request('POST', '/add/batch', { json: { entries } })).body).toMatchObject({ inserted: 0, duplicates: 50 });
    const tooMany = Array.from({ length: 501 }, () => ({ type: 'diary' }));
    expect((await request('POST', '/add/batch', { json: { entries: tooMany } })).status).toBe(400);
    expect((await request('POST', '/add/batch', { json: { entries: [] } })).status).toBe(400);
  });

  it('GET /list tolerates garbage limits', async () => {
    for (const q of ['abc', '-5', '0', '1e9', '']) {
      const r = await request('GET', `/list?limit=${q}`);
      expect(r.status, q).toBe(200);
    }
  });

  it('GET /stats', async () => {
    const r = await request('GET', '/stats');
    expect(r.body.ok).toBe(true);
    expect(r.body.total).toBeGreaterThan(50);
  });

  it('has no /clear endpoint (nothing on an unauthenticated API should wipe the vault)', async () => {
    const before = (await request('GET', '/stats')).body.total;
    expect((await request('POST', '/clear')).status).toBe(404);
    expect((await request('POST', '/reset')).status).toBe(404);
    expect((await request('GET', '/stats')).body.total).toBe(before);
  });
});

describe('server — browser attack surface', () => {
  it('rejects requests whose Host header is not local (DNS rebinding)', async () => {
    for (const host of ['evil.example', 'evil.example:80', '192.168.1.5:7799', '127.0.0.1.evil.example']) {
      const r = await request('GET', '/list', { headers: { host } });
      expect(r.status, host).toBe(403);
    }
  });

  it('accepts localhost, 127.0.0.1, [::1] and configured hosts', async () => {
    for (const host of ['localhost:7799', '127.0.0.1:7799', '[::1]:7799', 'memvault.internal']) {
      expect((await request('GET', '/health', { headers: { host } })).status, host).toBe(200);
    }
  });

  it('rejects cross-origin requests, including "simple" ones that need no preflight', async () => {
    const before = (await request('GET', '/stats')).body.total;
    const r = await request('POST', '/add', {
      headers: { origin: 'https://evil.example', 'content-type': 'text/plain' },
      body: JSON.stringify({ type: 'diary', title: 'planted by a web page' }),
    });
    expect(r.status).toBe(403);
    expect((await request('GET', '/stats')).body.total).toBe(before);
  });

  it('rejects Origin: null (sandboxed iframes, file://)', async () => {
    expect((await request('GET', '/list', { headers: { origin: 'null' } })).status).toBe(403);
  });

  it('refuses cross-origin preflights', async () => {
    const r = await request('OPTIONS', '/add', { headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' } });
    expect(r.status).toBe(403);
    expect(r.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('allows same-origin browser requests', async () => {
    const r = await request('GET', '/list', { headers: { origin: `http://127.0.0.1:${port}`, host: `127.0.0.1:${port}` } });
    expect(r.status).toBe(200);
  });

  it('never sends a wildcard Access-Control-Allow-Origin', async () => {
    const r = await request('GET', '/health');
    expect(r.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('allows a cross-origin caller only if the user explicitly listed it', async () => {
    const r = await request('GET', '/health', { headers: { origin: 'https://trusted.example' } });
    expect(r.status).toBe(200);
    expect(r.headers['access-control-allow-origin']).toBe('https://trusted.example');
  });

  it('blocks cross-site state-changing requests flagged by Sec-Fetch-Site', async () => {
    const r = await request('POST', '/add', { json: { type: 'diary', title: 'x' }, headers: { 'sec-fetch-site': 'cross-site' } });
    expect(r.status).toBe(403);
  });

  it('sets security headers', async () => {
    const r = await request('GET', '/');
    expect(r.headers['content-security-policy']).toContain("default-src 'self'");
    expect(r.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(r.headers['x-frame-options']).toBe('DENY');
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['x-powered-by']).toBeUndefined();
  });

  it('the UI makes no third-party requests', async () => {
    const html = (await request('GET', '/')).text;
    expect(html).not.toMatch(/fonts\.googleapis|fonts\.gstatic|cdn\.|unpkg|jsdelivr/i);
    expect(html).not.toMatch(/(src|href)=["']https?:\/\//i);
  });
});

function multipart(field, filename, content) {
  const boundary = '----memvault' + Math.random().toString(16).slice(2);
  const head = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${field}"; filename="${filename}"\r\nContent-Type: text/plain\r\n\r\n`, 'utf8');
  const body = Buffer.concat([head, Buffer.from(content), Buffer.from(`\r\n--${boundary}--\r\n`)]);
  return { body, headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

describe('server — uploads', () => {
  it('keeps non-ASCII file names intact (multer decodes them as latin1)', async () => {
    const m = multipart('file', 'résumé 日本語.txt', 'hello');
    const r = await request('POST', '/upload', { headers: m.headers, body: m.body });
    expect(r.status).toBe(200);
    const row = (await request('GET', '/search?q=' + encodeURIComponent('résumé'))).body.results[0];
    expect(row.title).toBe('résumé 日本語.txt');
  });

  it('a wrong form field name is a 400, not a 500', async () => {
    const m = multipart('not-file', 'x.txt', 'hello');
    const r = await request('POST', '/upload', { headers: m.headers, body: m.body });
    expect(r.status).toBe(400);
    expect(r.body.ok).toBe(false);
  });

  it('fixFilenameEncoding leaves real Unicode and genuine latin1 names alone', async () => {
    const { fixFilenameEncoding } = await import('../server.mjs');
    expect(fixFilenameEncoding('plain.txt')).toBe('plain.txt');
    expect(fixFilenameEncoding('日本語.txt')).toBe('日本語.txt');
    expect(fixFilenameEncoding('caf\u00e9.txt')).toBe('caf\u00e9.txt'); // lone 0xE9 is invalid UTF-8
    expect(fixFilenameEncoding(Buffer.from('café.txt', 'utf8').toString('latin1'))).toBe('café.txt');
  });
});

describe('server — secrets', () => {
  const pw = 'correct horse battery';

  it('reports whether a master password exists yet (so the UI can ask for it twice)', async () => {
    expect((await request('GET', '/secrets/status')).body).toEqual({ ok: true, initialized: false });
  });

  it('refuses a weak master password on first use', async () => {
    const r = await request('POST', '/secrets/verify', { json: { password: 'short' } });
    expect(r.status).toBe(400);
  });

  it('status flips to initialized once a master password is set', async () => {
    expect((await request('POST', '/secrets/verify', { json: { password: pw } })).body.ok).toBe(true);
    expect((await request('GET', '/secrets/status')).body.initialized).toBe(true);
  });

  it('add → list (labels only) → get → delete', async () => {
    const add = await request('POST', '/secrets/add', { json: { password: pw, category: 'password', label: 'Gmail', fields: { username: 'me', password: 'hunter2' } } });
    expect(add.body.ok).toBe(true);

    const list = await request('GET', '/secrets/list');
    expect(list.body.secrets.map((s) => s.label)).toEqual(['Gmail']);
    expect(list.text).not.toContain('hunter2');

    const get = await request('POST', '/secrets/get', { json: { password: pw, id: add.body.id } });
    expect(get.body.fields).toEqual({ username: 'me', password: 'hunter2' });

    expect((await request('DELETE', `/secrets/delete/${add.body.id}`, { json: { password: pw } })).body.ok).toBe(true);
    expect((await request('GET', '/secrets/list')).body.count).toBe(0);
  });

  it('the sentinel is never listed, readable or deletable', async () => {
    expect((await request('GET', '/secrets/list')).text).not.toContain('__sentinel__');
    expect((await request('POST', '/secrets/get', { json: { password: pw, id: '__sentinel__' } })).status).toBe(404);
  });

  it('stores nothing readable in the database file', async () => {
    await request('POST', '/secrets/add', { json: { password: pw, category: 'apikey', label: 'OpenAI', fields: { key: 'sk-PLAINTEXT-MARKER-12345' } } });
    expect(fs.readFileSync(path.join(TMP, 'db', 'index.sqlite')).includes('sk-PLAINTEXT-MARKER-12345')).toBe(false);
  });

  it('throttles repeated wrong passwords, even for the right password while locked', async () => {
    let last;
    for (let i = 0; i < 8; i++) last = await request('POST', '/secrets/verify', { json: { password: 'wrong password!' } });
    expect(last.status).toBe(429);
    expect(Number(last.headers['retry-after'])).toBeGreaterThan(0);
    expect((await request('POST', '/secrets/verify', { json: { password: pw } })).status).toBe(429);
  });
});

describe('security.mjs — units', () => {
  it('parses Host headers', () => {
    const h = security.hostnameFromHostHeader;
    expect(h('localhost:7799')).toBe('localhost');
    expect(h('LocalHost')).toBe('localhost');
    expect(h('[::1]:7799')).toBe('[::1]');
    expect(h('127.0.0.1')).toBe('127.0.0.1');
    expect(h(undefined)).toBe('');
  });

  it('recognises loopback bind addresses', () => {
    for (const a of ['127.0.0.1', 'localhost', '::1', '127.1.2.3']) expect(security.isLoopbackAddress(a), a).toBe(true);
    for (const a of ['0.0.0.0', '192.168.1.2', '::', 'example.com']) expect(security.isLoopbackAddress(a), a).toBe(false);
  });

  it('attempt limiter: free attempts, exponential back-off, cap, reset on success', () => {
    let t = 0;
    const l = security.createAttemptLimiter({ freeAttempts: 2, baseMs: 1000, maxMs: 5000, now: () => t });
    l.fail(); l.fail();
    expect(l.retryAfterMs()).toBe(0);
    l.fail(); expect(l.retryAfterMs()).toBe(1000);
    t += 1000; l.fail(); expect(l.retryAfterMs()).toBe(2000);
    t += 2000; l.fail(); expect(l.retryAfterMs()).toBe(4000);
    t += 4000; l.fail(); expect(l.retryAfterMs()).toBe(5000); // capped
    l.succeed();
    expect(l.retryAfterMs()).toBe(0);
    l.fail(); l.fail();
    expect(l.retryAfterMs()).toBe(0); // counter was reset
  });
});
