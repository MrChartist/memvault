import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'memvault-machines-'));
process.env.MEMVAULT_TOKEN_FILE = path.join(ROOT, 'home', 'api-token');
const M = await import('../machines.mjs');
const file = path.join(ROOT, 'machines.json');

const fakeFetch = (calls) => async (url, init) => {
  calls.push({ url, init });
  if (url.endsWith('/pair')) {
    const good = JSON.parse(init.body).code === 'GOOD';
    return new Response(JSON.stringify(good ? { ok: true, key: 'k-1', id: 'd1' } : { ok: false, error: 'wrong code' }), { status: good ? 200 : 401 });
  }
  return new Response(JSON.stringify({ ok: true, auth: init.headers.authorization }), { status: 200 });
};

describe('machines', () => {
  it('accepts https anywhere and http only on private networks', () => {
    expect(M.normaliseUrl('https://memvault.example.com/x')).toBe('https://memvault.example.com');
    expect(M.normaliseUrl('http://127.0.0.1:3000')).toBe('http://127.0.0.1:3000');
    expect(M.normaliseUrl('http://100.101.1.2:3000')).toBe('http://100.101.1.2:3000');
    expect(() => M.normaliseUrl('http://example.com')).toThrow();
    expect(() => M.normaliseUrl('https://u:p@example.com')).toThrow();
    expect(() => M.normaliseUrl('file:///etc/passwd')).toThrow();
  });

  it('links with a pairing code, keeps the key private, and relays only workspace routes', async () => {
    const calls = [];
    await expect(M.addMachine({ url: 'https://vps.example.com', code: 'BAD', fetchImpl: fakeFetch(calls), file })).rejects.toThrow(/wrong code/);
    const m = await M.addMachine({ name: 'VPS', url: 'https://vps.example.com', code: 'GOOD', fetchImpl: fakeFetch(calls), file });
    expect(m.key).toBeUndefined();
    expect(M.listMachines({ file })[0]).not.toHaveProperty('key');
    if (process.platform !== 'win32') expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    const r = await M.relay(m.id, { method: 'GET', subpath: '/api/system/status', fetchImpl: fakeFetch(calls), file });
    expect(JSON.parse(r.body).auth).toBe('Bearer k-1');
    expect(calls.at(-1).url).toBe('https://vps.example.com/api/system/status');
    for (const p of ['/export', '/secrets/get', '/api/fs/../../export', '/api/machines']) {
      await expect(M.relay(m.id, { method: 'GET', subpath: p, fetchImpl: fakeFetch(calls), file })).rejects.toThrow(/Only the server/);
    }
    expect(M.removeMachine(m.id, { file })).toBe(true);
    await expect(M.relay(m.id, { method: 'GET', subpath: '/api/workspace', file })).rejects.toThrow(/not linked/);
  });
});
