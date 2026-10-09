import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync, spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

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
  const body = `import { isMainModule } from ${JSON.stringify(path.join(ROOT, 'util.mjs'))};\nconsole.log(isMainModule(import.meta.url));`;

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
    const importer = path.join(TMP, 'importer.mjs');
    fs.writeFileSync(importer, `import ${JSON.stringify(path.join(TMP, 'real.mjs'))};`);
    expect(run(importer)).toBe('false');
  });
});
