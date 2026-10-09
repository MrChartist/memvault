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
    expect(cfg.mcpServers.memvault.command).toBe(process.execPath);
    const bound = JSON.parse(run('mcp-config', '--agent', 'study-buddy').stdout);
    expect(bound.mcpServers['memvault-study-buddy'].env.MEMVAULT_AGENT).toBe('study-buddy');
    expect(run('mcp-config', '--agent', 'nobody').status).toBe(1);
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
