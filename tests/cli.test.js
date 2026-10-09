import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync, spawnSync } from 'child_process';
import { fileURLToPath, pathToFileURL } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'memvault-cli-'));
const HOME = path.join(TMP, 'home');
fs.mkdirSync(HOME, { recursive: true });
const env = { ...process.env, VAULT_ROOT: path.join(TMP, 'vault'), HOME, USERPROFILE: HOME };
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

const cli = (...args) => spawnSync(process.execPath, [path.join(ROOT, 'cli.mjs'), ...args], { env, encoding: 'utf8' });

afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));

describe('cli', () => {
  it('--version prints the package version', () => {
    expect(cli('--version').stdout.trim()).toBe(pkg.version);
  });

  it('help succeeds (exit 0) and lists every command', () => {
    const r = cli('help');
    expect(r.status).toBe(0);
    for (const c of ['init', 'serve', 'mcp', 'sync', 'import', 'backup', 'bridge', 'vault']) expect(r.stdout).toContain(c);
  });

  it('no command / unknown command fail (exit 1)', () => {
    expect(cli().status).toBe(1);
    const r = cli('definitely-not-a-command');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('Unknown command');
  });

  it('does not treat inherited object properties as commands', () => {
    expect(cli('constructor').status).toBe(1);
    expect(cli('toString').status).toBe(1);
  });

  it('vault diary → vault search works end to end through the CLI', () => {
    expect(cli('vault', 'diary', 'remember the milk').stdout).toContain('OK');
    const r = cli('vault', 'search', 'milk');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('remember the milk');
  });

  it('backup writes a backup and a missing restore name fails cleanly', () => {
    const b = cli('backup');
    expect(b.status).toBe(0);
    expect(b.stdout).toMatch(/local/);
    expect(cli('backup', 'list').stdout).toMatch(/1 local backup/);
    expect(cli('backup', 'restore', '../../etc/passwd').status).not.toBe(0);
  });

  it('bridge presets lists the catalog', () => {
    const r = cli('bridge', 'presets');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('memory');
  });
});

describe('isMainModule — works where `import.meta.url === file://${argv[1]}` does not', () => {
  const run = (script) => execFileSync(process.execPath, [script], { encoding: 'utf8' }).trim();
  // file:// URLs: bare absolute paths are not valid ESM specifiers on Windows
  const body = `import { isMainModule } from ${JSON.stringify(pathToFileURL(path.join(ROOT, 'util.mjs')).href)};\nconsole.log(isMainModule(import.meta.url));`;

  it('true for a script in a directory whose path contains spaces', () => {
    const dir = path.join(TMP, 'dir with spaces');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'x.mjs'), body);
    expect(run(path.join(dir, 'x.mjs'))).toBe('true');
  });

  it('true when started through a symlink (how npm installs bins)', () => {
    if (process.platform === 'win32') return;
    const real = path.join(TMP, 'real.mjs');
    fs.writeFileSync(real, body);
    const link = path.join(TMP, 'link.mjs');
    fs.symlinkSync(real, link);
    expect(run(link)).toBe('true');
  });

  it('false when the module is only imported', () => {
    const target = path.join(TMP, 'imported-target.mjs');
    fs.writeFileSync(target, body);
    const importer = path.join(TMP, 'importer.mjs');
    fs.writeFileSync(importer, `import ${JSON.stringify(pathToFileURL(target).href)};`);
    expect(run(importer)).toBe('false');
  });

});

describe('setup wizard', () => {
  const wizard = (answers, rc) => {
    const home = fs.mkdtempSync(path.join(TMP, 'wiz-'));
    if (rc) fs.writeFileSync(path.join(home, '.memvaultrc.json'), JSON.stringify(rc));
    const r = spawnSync(process.execPath, [path.join(ROOT, 'init.mjs')], {
      env: { ...process.env, HOME: home, USERPROFILE: home, VAULT_ROOT: '' },
      input: answers.join('\n') + '\n', encoding: 'utf8',
    });
    const cfgFile = path.join(home, '.memvaultrc.json');
    return { ...r, home, cfg: fs.existsSync(cfgFile) ? JSON.parse(fs.readFileSync(cfgFile, 'utf8')) : null };
  };
  // 1 vault path · 6 engines (git vscode system files browser clipboard) · git dir · gemini key · drive folder? · drive api? · bridges?
  const ALL_DEFAULT = (vault) => [vault, '', '', '', '', '', '', '', '', '', '', ''];

  it('works with piped answers and saves an owner-only config', () => {
    const r = wizard(['', 'y', 'y', 'y', 'y', 'n', 'n', '', '', 'n', 'n', 'n']);
    expect(r.status).toBe(0);
    expect(r.cfg.sync.browserEnabled).toBe(false);
    expect(r.cfg.sync.clipboardEnabled).toBe(false);
    expect(r.stdout).toContain('@mrchartist/memvault');
    if (process.platform !== 'win32') expect(fs.statSync(path.join(r.home, '.memvaultrc.json')).mode & 0o777).toBe(0o600);
  });

  it('expands "~" in the vault location instead of creating a folder named "~"', () => {
    const r = wizard(['~/myvault', 'n', 'n', 'n', 'n', 'n', 'n', '', 'n', 'n', 'n']);
    expect(r.cfg.vaultRoot).toBe(path.join(r.home, 'myvault'));
    expect(fs.existsSync(path.join(r.home, 'myvault', 'db'))).toBe(true);
  });

  it('answering "n" really turns Drive API upload off, even if it was enabled before', () => {
    const r = wizard(['', 'n', 'n', 'n', 'n', 'n', 'n', '', 'n', 'n', 'n'], {
      storage: { gdriveApi: { enabled: true, clientId: 'x', clientSecret: 'y', refreshToken: 'z' } },
    });
    expect(r.cfg.storage.gdriveApi.enabled).toBe(false);
    expect(r.cfg.storage.gdriveApi.clientId).toBe('x'); // credentials are kept, just disabled
  });

  it('fails loudly (non-zero, nothing saved) if its input ends early', () => {
    const r = wizard(['only-one-answer']);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('nothing was saved');
    expect(r.cfg).toBeNull();
  });
});
