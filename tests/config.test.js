import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath, pathToFileURL } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Child scripts import by file:// URL: bare absolute paths (D:\...) are not valid ESM specifiers on Windows.
const CONFIG_URL = JSON.stringify(pathToFileURL(path.join(ROOT, 'config.mjs')).href);
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'memvault-config-'));

/** Load config.mjs in a fresh process so env + ~/.memvaultrc.json are read from scratch. */
function loadConfig(rc, env = {}) {
  const home = fs.mkdtempSync(path.join(TMP, 'h-'));
  if (rc !== undefined) fs.writeFileSync(path.join(home, '.memvaultrc.json'), typeof rc === 'string' ? rc : JSON.stringify(rc));
  const script = `
    const c = await import(${CONFIG_URL});
    console.log(JSON.stringify({ HOST: c.HOST, PORT: c.PORT, VAULT_ROOT: c.VAULT_ROOT, SYNC: c.SYNC_CONFIG, SERVER: c.SERVER_CONFIG, PROJECTS: c.USER_PROJECTS, DRIVE: c.STORAGE_CONFIG.gdriveFolder.path, HOME: ${JSON.stringify(home)} }));
  `;
  const f = path.join(home, 'probe.mjs');
  fs.writeFileSync(f, script);
  const clean = { ...process.env };
  for (const k of ['VAULT_ROOT', 'VAULT_PORT', 'PORT', 'VAULT_HOST', 'VAULT_API']) delete clean[k];
  const out = execFileSync(process.execPath, [f], { env: { ...clean, HOME: home, USERPROFILE: home, ...env }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  return JSON.parse(out);
}

afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));

describe('config defaults are private and local', () => {
  const c = loadConfig(undefined);

  it('listens on loopback only', () => expect(c.HOST).toBe('127.0.0.1'));
  it('uses the default port', () => expect(c.PORT).toBe(7799));
  it('keeps the vault under the user home', () => expect(c.VAULT_ROOT).toBe(path.join(c.HOME, '.memvault', 'data')));

  it('turns the sensitive engines OFF: browser history, clipboard, Antigravity', () => {
    expect(c.SYNC.browserEnabled).toBe(false);
    expect(c.SYNC.clipboardEnabled).toBe(false);
    expect(c.SYNC.antigravityEnabled).toBe(false);
  });

  it('turns the low-risk engines on and scans no personal paths', () => {
    expect(c.SYNC.gitEnabled ?? true).toBe(true);
    expect(c.SYNC.vscodeEnabled).toBe(true);
    expect(JSON.stringify(c.SYNC)).not.toMatch(/D:\\\\AG|rohit/i);
  });

  it('allows no extra hosts or browser origins', () => expect(c.SERVER).toEqual({ allowedHosts: [], allowedOrigins: [] }));
  it('has no built-in projects', () => expect(c.PROJECTS).toEqual([]));
});

describe('config overrides', () => {
  it('merges partial "sync" settings over the defaults instead of replacing them', () => {
    const c = loadConfig({ sync: { browserEnabled: true } });
    expect(c.SYNC.browserEnabled).toBe(true);
    expect(c.SYNC.vscodeEnabled).toBe(true); // default survives
    expect(c.SYNC.clipboardEnabled).toBe(false);
  });

  it('env vars beat the config file', () => {
    const c = loadConfig({ vaultRoot: '/from/file', port: 8000 }, { VAULT_ROOT: '/from/env', VAULT_PORT: '9001' });
    expect(c.VAULT_ROOT).toBe('/from/env');
    expect(c.PORT).toBe(9001);
  });

  it('ignores an invalid port', () => {
    expect(loadConfig({ port: 'banana' }).PORT).toBe(7799);
    expect(loadConfig({ port: 99999 }).PORT).toBe(7799);
  });

  it('survives a corrupt config file', () => {
    expect(loadConfig('{ this is not json').PORT).toBe(7799);
  });

  it('reads host, allowed hosts/origins and projects', () => {
    const c = loadConfig({ host: '0.0.0.0', server: { allowedHosts: ['a.local'], allowedOrigins: ['https://x.example'] }, projects: [{ name: 'P', patterns: ['p'] }] });
    expect(c.HOST).toBe('0.0.0.0');
    expect(c.SERVER).toEqual({ allowedHosts: ['a.local'], allowedOrigins: ['https://x.example'] });
    expect(c.PROJECTS).toHaveLength(1);
  });
});

describe('"~" in config values and env vars means the user\'s home, not a folder called "~"', () => {
  it('expands vaultRoot, git/files dirs and the Drive folder (relative paths are taken from home, not the cwd)', () => {
    const c = loadConfig({
      vaultRoot: '~/myvault',
      sync: { gitDirs: ['~/code', 'projects'], filesDirs: ['~/Notes'] },
      storage: { gdriveFolder: { enabled: true, path: '~/Google Drive' } },
    });
    expect(c.VAULT_ROOT).toBe(path.join(c.HOME, 'myvault'));
    expect(c.SYNC.gitDirs).toEqual([path.join(c.HOME, 'code'), path.join(c.HOME, 'projects')]);
    expect(c.SYNC.filesDirs).toEqual([path.join(c.HOME, 'Notes')]);
    expect(c.DRIVE).toBe(path.join(c.HOME, 'Google Drive'));
  });

  it('expands VAULT_ROOT from the environment too (MCP client env blocks are not shell-expanded)', () => {
    const c = loadConfig({}, { VAULT_ROOT: '~/from-env' });
    expect(c.VAULT_ROOT).toBe(path.join(c.HOME, 'from-env'));
    expect(path.isAbsolute(c.VAULT_ROOT)).toBe(true);
  });

  it('expandHome handles ~, ~/x, ~\\x, relative and absolute paths', async () => {
    const { expandHome } = await import('../util.mjs');
    const home = path.join(TMP, 'h');
    expect(expandHome('~', home)).toBe(home);
    expect(expandHome('~/a/b', home)).toBe(path.join(home, 'a', 'b'));
    expect(expandHome('~\\a', home)).toBe(path.join(home, 'a'));
    expect(expandHome('rel/x', home)).toBe(path.join(home, 'rel', 'x'));
    expect(expandHome(path.join(TMP, 'abs'), home)).toBe(path.join(TMP, 'abs'));
    expect(expandHome('', home)).toBe('');
  });
});

describe('config file permissions', () => {
  it('saveUserConfig writes owner-only (it can hold API keys and OAuth secrets)', () => {
    if (process.platform === 'win32') return;
    const home = fs.mkdtempSync(path.join(TMP, 'perm-'));
    const f = path.join(home, 'save.mjs');
    fs.writeFileSync(f, `const { saveUserConfig, CONFIG_FILE } = await import(${CONFIG_URL}); saveUserConfig({ ai: { apiKey: 'k' } }); console.log(CONFIG_FILE);`);
    const file = execFileSync(process.execPath, [f], { env: { ...process.env, HOME: home, USERPROFILE: home }, encoding: 'utf8' }).trim();
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });
});
