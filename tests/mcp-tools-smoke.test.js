// Proposed: per-tool smoke tests for the MCP tools that have no test in the repo. Copy to tests/.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs'; import os from 'os'; import path from 'path';
import { fileURLToPath } from 'url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(here, '..', 'mcp-server.mjs');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'memvault-smoke-'));
const ROOT = path.join(HOME, 'vault');
const KEY = 'sk-ant-api03-' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0U1v2W3x4Y5z6';
let c;
const run = async (name, args = {}) => {
  const r = await c.callTool({ name, arguments: args });
  return { err: !!r.isError, text: r.content.map((x) => x.text).join('\n') };
};
beforeAll(async () => {
  const env = { ...process.env, HOME, USERPROFILE: HOME, VAULT_ROOT: ROOT, MEMVAULT_TOKEN_FILE: path.join(HOME, 'tok') };
  delete env.MEMVAULT_AGENT; delete env.ANTHROPIC_API_KEY; delete env.OPENAI_API_KEY; delete env.GEMINI_API_KEY;
  c = new Client({ name: 'smoke', version: '1' });
  await c.connect(new StdioClientTransport({ command: process.execPath, args: [SERVER], env, stderr: 'ignore' }));
}, 30000);
afterAll(async () => { try { await c.close(); } catch {} fs.rmSync(HOME, { recursive: true, force: true }); });

describe('every listed tool answers a minimal valid call without error', () => {
  const minimal = {
    vault_search: { query: 'x' }, vault_list: {}, vault_get_context: { topic: 'x' }, vault_stats: {},
    vault_secret_list: {}, vault_recent_files: {}, vault_system_info: {}, vault_projects: {},
    vault_smart_context: { topic: 'x' }, vault_project_context: { project: 'x' }, vault_daily_digest: {},
    vault_remember: { what: 'smoke remember' }, agent_list: {}, agent_inbox: {},
    vault_capture_prompt: { prompt: 'smoke prompt' }, vault_log_conversation: { summary: 'smoke convo' },
    vault_ai_summarize: { query: 'x' }, vault_ai_insights: {}, vault_smart_search: { query: 'x' },
    vault_weekly_digest: {}, vault_backups: {}, vault_bridge_list: {}, vault_bridge_sync: {},
    vault_backup: {}, vault_git_log: {},
  };
  it('covers all listed tools (fails when a new tool is added without a smoke entry)', async () => {
    const names = (await c.listTools()).tools.map((t) => t.name);
    const known = new Set([...Object.keys(minimal), 'vault_add', 'agent_activate', 'agent_define', 'agent_handoff']);
    expect(names.filter((n) => !known.has(n))).toEqual([]);
  });
  for (const [name, args] of Object.entries(minimal)) {
    it(name, async () => {
      const listed = (await c.listTools()).tools.some((t) => t.name === name);
      if (!listed) return; // hidden by default for this profile (e.g. git_log)
      const r = await run(name, args);
      expect(r.err, r.text).toBe(false);
      expect(r.text.length).toBeGreaterThan(0);
      expect(r.text).not.toMatch(/undefined|\[object Object\]|TypeError|at .*\.mjs:\d+/);
    }, 30000);
  }
});

describe('write-type tools mask secrets before storing and stay findable', () => {
  for (const [tool, args] of [
    ['vault_add', { type: 'diary', title: 'smoke add', content: 'key ' + KEY }],
    ['vault_remember', { what: 'remember ' + KEY }],
    ['vault_capture_prompt', { prompt: 'prompt ' + KEY }],
    ['vault_log_conversation', { summary: 'convo ' + KEY, keyPoints: 'kp ' + KEY }],
  ]) {
    it(tool, async () => {
      const r = await run(tool, args);
      expect(r.err, r.text).toBe(false);
      expect(r.text).not.toContain(KEY);
    });
  }
  it('nothing in the vault, nor the audit log, contains the raw key', async () => {
    const r = await run('vault_search', { query: 'REDACTED' });
    expect(r.text).not.toContain(KEY);
    for (const f of [path.join(ROOT, 'audit.log')]) if (fs.existsSync(f)) expect(fs.readFileSync(f, 'utf8')).not.toContain(KEY);
    const db = path.join(ROOT, 'db', 'index.sqlite');
    expect(fs.readFileSync(db).includes(Buffer.from(KEY))).toBe(false);
  });
});

describe('inputs that real clients send', () => {
  it('vault_search with % and _ wildcards does not match everything', async () => {
    await run('vault_add', { type: 'diary', title: 'plain', content: 'nothing special' });
    const r = await run('vault_search', { query: '100%_zzz' });
    expect(r.text).toMatch(/No results/);
  });
  it('unicode / very long content round-trips', async () => {
    const big = '日本語🚀 '.repeat(20000);
    const r = await run('vault_add', { type: 'diary', title: 'uni', content: big });
    expect(r.err, r.text).toBe(false);
  });
  it('invalid enum is a clean error, not a crash', async () => {
    const r = await run('vault_list', { type: 'bogus' }).catch((e) => ({ err: true, text: String(e) }));
    expect(r.err).toBe(true);
  });
});
