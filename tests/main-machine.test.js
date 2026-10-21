import { describe, it, expect, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'memvault-main-'));
process.env.MEMVAULT_TOKEN_FILE = path.join(ROOT, 'home', 'api-token');
const { mountMain } = await import('../main-machine.mjs');
const folder = path.join(ROOT, 'main-folder');
fs.mkdirSync(folder, { recursive: true });

let settings = { main: 'this', folder, enabled: true };
const app = express();
app.use((req, _res, next) => { req.deviceKeyId = req.headers['x-key'] || undefined; next(); }); // stands in for requireToken
const ownerOnly = (req, res, next) => (req.deviceKeyId ? res.status(403).json({ ok: false }) : next());
const changes = [];
mountMain(app, { express, ownerOnly, dir: path.join(ROOT, 'home'), settings: () => settings, updateSettings: (c) => changes.push(c) });
const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}`;
afterAll(() => server.close());

const NAME = 'memvault-aaaaaaaaaaaaaaaa.mvsync';
const put = (name, key, body = 'x') => fetch(`${base}/api/main/files/${name}`, { method: 'PUT', headers: { 'content-type': 'application/octet-stream', ...(key ? { 'x-key': key } : {}) }, body });

describe('main machine', () => {
  it('stores uploads, and only the first uploader may replace a file', async () => {
    expect((await put(NAME, 'laptop', 'one')).status).toBe(200);
    expect((await put(NAME, 'laptop', 'two')).status).toBe(200);
    expect((await put(NAME, 'phone', 'evil')).status).toBe(403);
    expect(fs.readFileSync(path.join(folder, NAME), 'utf8')).toBe('two');
    const list = await (await fetch(`${base}/api/main/files`)).json();
    expect(list.files.map((f) => f.name)).toEqual([NAME]);
    expect(await (await fetch(`${base}/api/main/files/${NAME}`)).text()).toBe('two');
  });

  it('refuses odd names and paths', async () => {
    for (const n of ['..%2Fapi-token', 'notes.txt', 'memvault-AAAA.mvsync']) expect((await put(n, 'laptop')).status).toBeGreaterThanOrEqual(400);
    expect((await fetch(`${base}/api/main/files/..%2F..%2Fhome%2Fapi-token`)).status).toBeGreaterThanOrEqual(400);
  });

  it('is closed when this is not the main machine, and only the owner key changes the setting', async () => {
    settings = { ...settings, main: '' };
    expect((await fetch(`${base}/api/main/files`)).status).toBe(404);
    const r = await fetch(`${base}/api/main`, { method: 'PUT', headers: { 'content-type': 'application/json', 'x-key': 'phone' }, body: JSON.stringify({ main: 'this' }) });
    expect(r.status).toBe(403);
    expect(changes).toEqual([]);
  });
});
