import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'cli.mjs');
// A home folder with a space and non-Latin letters, like a real person's.
const HOME = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'memvault cli ')), 'रोहित Singh');
const run = (...args) => spawnSync(process.execPath, [CLI, ...args], {
  encoding: 'utf8', timeout: 60_000,
  env: { ...process.env, HOME, USERPROFILE: HOME, VAULT_ROOT: '', MEMVAULT_TOKEN_FILE: '', MEMVAULT_TOKEN: '', MEMVAULT_AGENT: '', MEMVAULT_BACKUP_PASSPHRASE: '' },
});

beforeAll(() => fs.mkdirSync(HOME, { recursive: true }));
afterAll(() => fs.rmSync(path.dirname(HOME), { recursive: true, force: true }));

describe('command line', () => {
  it('help lists the everyday commands, including the clipboard watcher', () => {
    const r = run('help');
    expect(r.status).toBe(0);
    for (const c of ['setup', 'open', 'doctor', 'scrub', 'agent', 'audit', 'token', 'mcp-config', 'backup', 'import', 'sync', 'clipboard']) expect(r.stdout).toContain(c);
  });

  it('--version prints the package version, so a bug report can say which one', () => {
    const want = JSON.parse(fs.readFileSync(path.join(path.dirname(CLI), 'package.json'), 'utf8')).version;
    for (const flag of ['--version', '-v', 'version']) {
      const r = run(flag);
      expect(r.status).toBe(0);
      expect(r.stdout.trim()).toBe(want);
    }
  });

  it('an unknown command says so and fails', () => {
    const r = run('nonsense');
    expect(r.status).toBe(1);
    expect(r.stderr + r.stdout).toMatch(/Unknown command/);
  });

  it('setup creates the vault, a private access key and the starter agents, and can be run again', () => {
    const r = run('setup');
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/Vault ready/);
    const token = path.join(HOME, '.memvault', 'api-token');
    expect(fs.existsSync(token)).toBe(true);
    if (process.platform !== 'win32') expect(fs.statSync(token).mode & 0o077).toBe(0);
    expect(run('setup').status).toBe(0);
  });

  it('token prints the key, and --rotate replaces it', () => {
    const a = run('token').stdout.trim();
    expect(a.length).toBeGreaterThan(30);
    expect(run('token').stdout.trim()).toBe(a);
    run('token', '--rotate');
    expect(run('token').stdout.trim()).not.toBe(a);
  });

  it('doctor reports a healthy new vault', () => {
    const r = run('doctor');
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/No problems/);
    expect(r.stdout).not.toContain(HOME); // paths are shown as ~/… so a screenshot does not reveal the account name
  });

  it('mcp-config prints valid JSON even when the install path has spaces and non-Latin letters', () => {
    const r = run('mcp-config');
    const cfg = JSON.parse(r.stdout);
    expect(cfg.mcpServers.memvault.args[0]).toMatch(/mcp-server\.mjs$/);
    expect(fs.realpathSync(cfg.mcpServers.memvault.command)).toBe(fs.realpathSync(process.execPath));
    const bound = JSON.parse(run('mcp-config', '--agent', 'study-buddy').stdout);
    expect(bound.mcpServers['memvault-study-buddy'].env.MEMVAULT_AGENT).toBe('study-buddy');
    expect(run('mcp-config', '--agent', 'nobody').status).toBe(1);
    const noName = run('mcp-config', '--agent');
    expect(noName.status).toBe(1);
    expect(noName.stderr).toMatch(/Say which agent/);
    expect(noName.stderr).not.toMatch(/"true"/);
  });

  it('every example in the help works straight after setup', () => {
    const help = run('help').stdout;
    const agent = help.match(/mcp-config --agent (\S+)/)[1];
    expect(run('mcp-config', '--agent', agent).status).toBe(0);
  });

  it('`<command> --help` explains the command instead of running it', () => {
    const r = run('backup', '--help');
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/memvault backup/);
    expect(r.stdout).not.toMatch(/Backing up/);
  });

  it('a missing file or a bad agent file gets one plain sentence, not a stack trace', () => {
    for (const args of [['agent', 'import', path.join(HOME, 'missing.json')], ['agent', 'create', '--from-file', path.join(HOME, 'missing.txt')]]) {
      const r = run(...args);
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/no such file/);
      expect(r.stderr).not.toMatch(/node:fs|at .*\.js:\d+|ENOENT/);
    }
    const bad = path.join(HOME, 'bad.json');
    fs.writeFileSync(bad, '{ not json');
    const r = run('agent', 'import', bad);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/not a valid JSON file/);
  });

  it('restoring a backup that does not exist says so plainly', () => {
    const r = run('backup', 'restore', 'no-such-backup.sqlite');
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/Backup not found/);
    expect(r.stderr).not.toMatch(/at .*\.mjs:\d+/);
  });

  it('importing from a folder that does not exist fails', () => {
    expect(run('import', path.join(HOME, 'no-such-export')).status).toBe(1);
  });

  it('agent commands list, show and export the starter agents', () => {
    expect(run('agent', 'list').stdout).toMatch(/study-buddy/);
    expect(JSON.parse(run('agent', 'show', 'coder').stdout).id).toBe('coder');
    expect(run('agent', 'brief', 'planner').stdout).toMatch(/You are acting as: Planner/);
    expect(run('agent', 'show', 'ghost').status).toBe(1);
  });

  it('deleting an agent needs --yes', () => {
    expect(run('agent', 'delete', 'writer').status).toBe(1);
    expect(run('agent', 'delete', 'writer', '--yes').status).toBe(0);
    expect(run('agent', 'list').stdout).not.toMatch(/\bwriter\b/);
  });

  it('audit --verify says the log is intact', () => {
    expect(run('audit', '--verify').stdout).toMatch(/intact/);
  });

  it('scrub previews and changes nothing until --apply', () => {
    const r = run('scrub');
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/Nothing to mask|preview/i);
  });

  it('backup writes a backup that doctor then notices', () => {
    expect(run('backup').status).toBe(0);
    expect(run('doctor').stdout).toMatch(/Latest local backup is from today/);
  });
});

describe('stopping the server', () => {
  it.skipIf(process.platform === 'win32')('stopping `memvault serve` also stops the server it started', async () => {
    const { spawn } = await import('child_process');
    const http = await import('http');
    const port = await new Promise((res) => { const s = http.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
    const env = { ...process.env, HOME, USERPROFILE: HOME, VAULT_ROOT: '', MEMVAULT_TOKEN_FILE: '', MEMVAULT_AGENT: '', PORT: String(port) };
    const cli = spawn(process.execPath, [CLI, 'serve'], { env, stdio: 'ignore' });
    const up = async () => { try { return (await fetch(`http://127.0.0.1:${port}/health`)).ok; } catch { return false; } };
    for (let i = 0; i < 100 && !(await up()); i++) await new Promise((r) => setTimeout(r, 100));
    expect(await up()).toBe(true);
    const exited = new Promise((res) => cli.on('exit', res));
    cli.kill('SIGTERM');
    await exited;
    let stillUp = true;
    for (let i = 0; i < 50 && (stillUp = await up()); i++) await new Promise((r) => setTimeout(r, 100));
    expect(stillUp).toBe(false);
  }, 30000);
});

describe('connecting AI apps', () => {
  it('a copy started by npx tells apps to start it through npx, not from npm\'s cache folder', async () => {
    const { mcpEntry, mv } = await import('../cli-tools.mjs');
    const dir = path.join(os.homedir(), '.npm', '_npx', 'f3bc96e2557f9332', 'node_modules', '@mrchartist', 'memvault');
    expect(mcpEntry({ agent: 'coder', dir, platform: 'linux' })).toEqual({ command: 'npx', args: ['-y', '@mrchartist/memvault', 'mcp'], env: { MEMVAULT_AGENT: 'coder' } });
    expect(mcpEntry({ dir, platform: 'win32' })).toEqual({ command: 'cmd', args: ['/c', 'npx', '-y', '@mrchartist/memvault', 'mcp'] });
    expect(mv('doctor', dir)).toBe('npx -y @mrchartist/memvault doctor');
    expect(mv('doctor', '/usr/lib/node_modules/@mrchartist/memvault')).toBe('memvault doctor');
  });

  it.skipIf(process.platform === 'win32')('writes the node found on PATH, which survives a Node upgrade, not the versioned folder behind it', async () => {
    const { stableNodePath } = await import('../cli-tools.mjs');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'memvault node '));
    try {
      const cellar = path.join(tmp, 'Cellar', 'node', '22.1.0', 'bin');
      const bin = path.join(tmp, 'bin');
      fs.mkdirSync(cellar, { recursive: true }); fs.mkdirSync(bin);
      fs.writeFileSync(path.join(cellar, 'node'), '');
      fs.symlinkSync(path.join(cellar, 'node'), path.join(bin, 'node'));
      const execPath = path.join(cellar, 'node'); // what process.execPath reports: symlinks already resolved
      expect(stableNodePath({ execPath, envPath: ['/nowhere', bin].join(path.delimiter), platform: 'linux' })).toBe(path.join(bin, 'node'));
      expect(stableNodePath({ execPath, envPath: '/nowhere', platform: 'linux' })).toBe(execPath);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('opening the dashboard', () => {
  it('does not trust another program that happens to answer on the port', async () => {
    const { healthy } = await import('../cli-tools.mjs');
    const http = await import('http');
    const serve = (body) => new Promise((res) => { const s = http.createServer((_q, r) => { r.setHeader('content-type', 'application/json'); r.end(body); }).listen(0, '127.0.0.1', () => res(s)); });
    const other = await serve('{"ok":true}');
    const real = await serve('{"ok":true,"name":"memvault","version":"3.0.0"}');
    try {
      expect(await healthy(`http://127.0.0.1:${other.address().port}`)).toBe(false);
      expect(await healthy(`http://127.0.0.1:${real.address().port}`)).toBe(true);
    } finally {
      other.close(); real.close();
    }
  });

  it('keeps the key out of the browser\'s command line: it opens a private page that redirects', async () => {
    const { makeOpenPage } = await import('../cli-tools.mjs');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memvault open '));
    try {
      const old = path.join(dir, 'open-0000.html');
      fs.writeFileSync(old, 'stale');
      const longAgo = new Date(Date.now() - 3600_000);
      fs.utimesSync(old, longAgo, longAgo);
      const file = makeOpenPage({ url: 'http://127.0.0.1:7799/#token=abc_DEF-123', dir });
      expect(path.dirname(file)).toBe(dir);
      expect(fs.readFileSync(file, 'utf8')).toContain('url=http://127.0.0.1:7799/#token=abc_DEF-123');
      if (process.platform !== 'win32') expect(fs.statSync(file).mode & 0o077).toBe(0);
      expect(fs.existsSync(old)).toBe(false); // an earlier page that was never cleaned up is removed
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
