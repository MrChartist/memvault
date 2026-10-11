import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import crypto from 'crypto';

// The dashboard side of devices: settings, sync now, and signing a phone in with a one-time code.
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'memvault-devsrv-'));
process.env.VAULT_ROOT = path.join(ROOT, 'vault');
process.env.MEMVAULT_TOKEN_FILE = path.join(ROOT, 'home', 'api-token');
delete process.env.MEMVAULT_SYNC_PASSPHRASE;

const TOKEN = 'test-token-' + crypto.randomBytes(8).toString('hex');
let server, port, cfgFile;

function req(method, p, { body, token = TOKEN, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const h = { ...headers };
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

beforeAll(async () => {
  const D = await import('../db.mjs');
  const S = await import('../server.mjs');
  const vdb = D.openVaultDb({ root: process.env.VAULT_ROOT });
  port = await new Promise((res) => { const probe = http.createServer().listen(0, '127.0.0.1', () => { const p = probe.address().port; probe.close(() => res(p)); }); });
  cfgFile = path.join(ROOT, 'rc.json');
  fs.writeFileSync(cfgFile, JSON.stringify({ keep: 'me' }));
  const config = {
    load: () => JSON.parse(fs.readFileSync(cfgFile, 'utf8')),
    save: (c) => fs.writeFileSync(cfgFile, JSON.stringify(c)),
    passphraseFile: path.join(ROOT, 'home', 'backup-passphrase'),
  };
  const app = S.createApp({ vdb, token: TOKEN, port, root: process.env.VAULT_ROOT, config });
  server = await new Promise((res) => { const s = app.listen(port, '127.0.0.1', () => res(s)); });
});
afterAll(() => { server?.close(); fs.rmSync(ROOT, { recursive: true, force: true }); });

describe('devices in the dashboard', () => {
  it('shows this computer, and turning sync on keeps every other setting', async () => {
    const before = await req('GET', '/devices');
    expect(before.status).toBe(200);
    expect(before.json.enabled).toBe(false);
    expect(before.json.device.id).toMatch(/^[a-z0-9]{16}$/);

    const folder = path.join(ROOT, 'Sync folder');
    expect((await req('PUT', '/devices', { body: { folder } })).status).toBe(400); // does not exist yet
    fs.mkdirSync(folder);
    expect((await req('PUT', '/devices', { body: { folder, enabled: true, name: 'Home server' } })).status).toBe(200);
    const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
    expect(cfg.keep).toBe('me');
    expect(cfg.devices).toMatchObject({ enabled: true, folder });
    expect((await req('PUT', '/devices', { body: { anything: 1 } })).status).toBe(400);

    const sync1 = await req('POST', '/devices/sync');
    expect(sync1.json.ok).toBe(false);
    expect(sync1.json.problems.join()).toMatch(/passphrase/);
    expect((await req('PUT', '/devices/passphrase', { body: { passphrase: 'a long passphrase', confirm: 'a long passphrase' } })).status).toBe(200);
    const sync2 = await req('POST', '/devices/sync');
    expect(sync2.json.ok, JSON.stringify(sync2.json)).toBe(true);
    expect(fs.readdirSync(folder).some((f) => f.endsWith('.mvsync'))).toBe(true);
    expect((await req('GET', '/devices')).json.device.name).toBe('Home server');
  });

  it('needs the key, like every other data route', async () => {
    expect((await req('GET', '/devices', { token: null })).status).toBe(401);
    expect((await req('POST', '/devices/pair-code', { token: null, body: {} })).status).toBe(401);
  });
});

describe('signing a phone in', () => {
  it('a one-time code gives the phone its own key, which can be signed out again', async () => {
    const made = await req('POST', '/devices/pair-code', { body: { name: 'iPhone' } });
    expect(made.json.code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);

    const paired = await req('POST', '/pair', { token: null, body: { code: made.json.code } });
    expect(paired.status).toBe(200);
    const phoneKey = paired.json.key;
    expect((await req('GET', '/whoami', { token: phoneKey })).status).toBe(200);
    expect((await req('POST', '/pair', { token: null, body: { code: made.json.code } })).status).toBe(401); // used up

    const listed = (await req('GET', '/devices')).json.phones;
    expect(listed.map((p) => p.name)).toContain('iPhone');
    expect(JSON.stringify(listed)).not.toContain(phoneKey);

    expect((await req('DELETE', `/devices/phones/${paired.json.id}`)).status).toBe(200);
    expect((await req('GET', '/whoami', { token: phoneKey })).status).toBe(401);
  });

  it('a phone can use the vault, but cannot sign in more phones or change passphrases', async () => {
    const made = await req('POST', '/devices/pair-code', { body: { name: 'iPad' } });
    const paired = await req('POST', '/pair', { token: null, body: { code: made.json.code } });
    const phone = paired.json.key;
    const seen = await req('GET', '/devices', { token: phone });
    expect(seen.status).toBe(200);
    expect(seen.json.onPhone).toBe(true); // so the dashboard hides what is refused below
    expect((await req('GET', '/devices')).json.onPhone).toBe(false);
    expect((await req('POST', '/devices/sync', { token: phone, body: {} })).status).toBe(200);

    const refused = [
      ['POST', '/devices/pair-code', { name: 'Second phone' }],
      ['PUT', '/devices', { enabled: false }],
      ['PUT', '/devices/passphrase', { passphrase: 'a new passphrase', confirm: 'a new passphrase' }],
      ['PUT', '/settings/passphrase', { passphrase: 'a new passphrase', confirm: 'a new passphrase' }],
      ['DELETE', `/devices/phones/${paired.json.id}`, undefined],
    ];
    for (const [method, p, body] of refused) {
      const r = await req(method, p, { token: phone, body });
      expect(r.status, `${method} ${p}`).toBe(403);
      expect(r.json.error).toMatch(/on your computer/);
    }
    expect((await req('GET', '/devices')).json.phones.filter((x) => x.name === 'Second phone')).toHaveLength(0);
    expect((await req('GET', '/whoami', { token: phone })).status).toBe(200); // it did not sign itself out either
  });

  it('the Getting started list says which steps are done, needs the key, and tells a phone it is a phone', async () => {
    expect((await req('GET', '/setup', { token: null })).status).toBe(401);
    const r = await req('GET', '/setup');
    expect(r.status).toBe(200);
    expect(r.json.onPhone).toBe(false);
    expect(r.json.steps.map((s) => s.id)).toEqual(['install', 'connect', 'try', 'backup', 'passphrase', 'agents', 'devices', 'phone']);
    expect(r.json.steps.find((s) => s.id === 'install').done).toBe(true);
    expect(r.json.total).toBe(5);

    const made = await req('POST', '/devices/pair-code', { body: { name: 'Checklist phone' } });
    const phone = (await req('POST', '/pair', { token: null, body: { code: made.json.code } })).json.key;
    const onPhone = await req('GET', '/setup', { token: phone });
    expect(onPhone.json.onPhone).toBe(true); // the dashboard hides the list there: the steps are done on a computer
    expect((await req('GET', '/setup')).json.steps.find((s) => s.id === 'phone').done).toBe(true);
  });

  it('wrong codes are limited', async () => {
    let last;
    for (let i = 0; i < 6; i++) last = await req('POST', '/pair', { token: null, body: { code: 'AAAA-AAAA' } });
    expect(last.status).toBe(429);
  });
});
