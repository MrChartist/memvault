import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'memvault-e2e-'));
const VAULT = path.join(TMP, 'vault');
const HOME = path.join(TMP, 'home'); // isolates ~/.memvaultrc.json from the real machine
fs.mkdirSync(HOME, { recursive: true });

const EXPECTED_TOOLS = [
  'vault_search', 'vault_add', 'vault_list', 'vault_get_context', 'vault_stats', 'vault_secret_list',
  'vault_git_log', 'vault_recent_files', 'vault_system_info', 'vault_projects',
  'vault_smart_context', 'vault_project_context', 'vault_daily_digest', 'vault_remember',
  'vault_capture_prompt', 'vault_log_conversation', 'vault_ai_summarize', 'vault_ai_insights',
  'vault_smart_search', 'vault_weekly_digest', 'vault_backup', 'vault_backups',
  'vault_bridge_list', 'vault_bridge_sync',
];

let client;
let transport;

const call = async (name, args = {}) => {
  const res = await client.callTool({ name, arguments: args });
  return { isError: !!res.isError, text: res.content.map((c) => c.text).join('\n') };
};

beforeAll(async () => {
  transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(ROOT, 'mcp-server.mjs')],
    env: { ...process.env, VAULT_ROOT: VAULT, HOME, USERPROFILE: HOME, GEMINI_API_KEY: '', GOOGLE_AI_API_KEY: '' },
    stderr: 'ignore',
  });
  client = new Client({ name: 'e2e', version: '1.0.0' }, { capabilities: {} });
  await client.connect(transport);
}, 30_000);

afterAll(async () => {
  await client?.close();
  fs.rmSync(TMP, { recursive: true, force: true });
});

describe('MCP server — protocol surface', () => {
  it('registers exactly the 24 documented tools', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...EXPECTED_TOOLS].sort());
  });

  it('exposes resources and prompts', async () => {
    const { resources } = await client.listResources();
    expect(resources.length).toBeGreaterThanOrEqual(5);
    const { prompts } = await client.listPrompts();
    expect(prompts.map((p) => p.name).sort()).toEqual(['daily_brief', 'project_summary', 'user_context']);
  });
});

describe('MCP server — works with no web server running', () => {
  it('vault_add → vault_search round trip', async () => {
    const add = await call('vault_add', { type: 'worklog', title: 'Fixed auth bug', content: 'Rotated session tokens in middleware', tags: 'auth,bugfix' });
    expect(add.isError).toBe(false);
    expect(add.text).toContain('Entry saved');

    const found = await call('vault_search', { query: 'session tokens' });
    expect(found.text).toContain('Fixed auth bug');
  });

  it('vault_remember and vault_capture_prompt persist directly', async () => {
    expect((await call('vault_remember', { what: 'I prefer tabs over spaces', category: 'preference' })).text).toContain('Remembered');
    expect((await call('vault_capture_prompt', { prompt: 'How do I deploy?', aiTool: 'claude' })).text).toContain('logged');
    expect((await call('vault_log_conversation', { summary: 'Discussed deploy pipeline' })).text).toContain('saved');

    const found = await call('vault_search', { query: 'tabs over spaces' });
    expect(found.text).toContain('Memory:preference');
  });

  it('vault_stats counts what was written', async () => {
    const stats = await call('vault_stats');
    expect(stats.text).toMatch(/Total entries\*\*: [4-9]/);
  });
});

describe('MCP server — tools that used to be broken', () => {
  it('vault_smart_search works (it queried a table that never existed)', async () => {
    const res = await call('vault_smart_search', { query: 'auth bug middleware' });
    expect(res.isError).toBe(false);
    expect(res.text).toContain('Fixed auth bug');
    expect(res.text).not.toMatch(/no such table/i);
  });

  it('vault_smart_context copes with regex/SQL metacharacters in the topic', async () => {
    for (const topic of ['c++ (parens', '[unclosed', 'a.*b', '100% sure_', "O'Reilly"]) {
      const res = await call('vault_smart_context', { topic });
      expect(res.isError, topic).toBe(false);
    }
  });

  it('vault_ai_* degrade gracefully without an API key', async () => {
    expect((await call('vault_ai_summarize', { query: 'auth' })).text).toContain('not configured');
    expect((await call('vault_ai_insights', {})).text).toContain('not configured');
    expect((await call('vault_weekly_digest', {})).text).toContain('not configured');
  });
});

describe('MCP server — injection attempts', () => {
  it('rejects a malformed date instead of interpolating it into SQL', async () => {
    const res = await call('vault_daily_digest', { date: "2026-01-01' OR '1'='1" });
    expect(res.isError).toBe(true);
  });

  it('treats quote/SQL text in search terms as plain text', async () => {
    const res = await call('vault_search', { query: "x' OR 1=1; DROP TABLE items; --" });
    expect(res.text).toContain('No results');
    // table still there and data intact
    expect((await call('vault_search', { query: 'session tokens' })).text).toContain('Fixed auth bug');
  });

  it('does not treat % and _ as wildcards', async () => {
    expect((await call('vault_search', { query: '%' })).text).toContain('No results');
    expect((await call('vault_search', { query: 'Fixed _uth bug' })).text).toContain('No results');
  });

  it('prompt topic is bound, not interpolated', async () => {
    const res = await client.getPrompt({ name: 'user_context', arguments: { topic: "' OR 1=1 --" } });
    expect(res.messages[0].content.text).toContain('No entries found');
  });
});

describe('MCP server — digests use the local day', () => {
  it('vault_daily_digest includes entries written today', async () => {
    const res = await call('vault_daily_digest', {});
    expect(res.text).toContain('Daily Digest');
    expect(res.text).toContain('Fixed auth bug');
  });
});

describe('MCP server — retrieval finds the right entry, not just the newest', () => {
  const count = (text) => (text.match(/^### \d+\./gm) || []).length;

  it('answers a natural-language question with the OLD specific entry despite many newer, chattier ones', async () => {
    await call('vault_add', { type: 'worklog', title: 'Decision: database schema uses UUID primary keys', content: 'We decided in review that every table gets a UUID primary key.' });
    for (let i = 0; i < 40; i++) {
      await call('vault_add', { type: 'diary', title: `Weather note ${i}`, content: 'Did you see the thing about the weather today? It was all about the rain.' });
    }
    const q = 'what did I decide about the database schema';
    for (const tool of ['vault_get_context', 'vault_smart_context']) {
      const r = await call(tool, { topic: q });
      expect(r.text, tool).toContain('UUID primary keys');
    }
    expect((await call('vault_smart_search', { query: q })).text).toContain('UUID primary keys');
  });

  it('a very short topic is matched literally instead of returning "everything recent"', async () => {
    await call('vault_add', { type: 'diary', title: 'Learning Go generics', content: 'Go 1.22 notes on generics.' });
    const r = await call('vault_get_context', { topic: 'Go' });
    expect(r.text).toContain('Learning Go generics');
    expect(r.text).not.toContain('Weather note 39'); // not just the newest entries
  });

  it('freshOnly pages through results instead of burning candidates it never showed', async () => {
    for (let i = 0; i < 25; i++) {
      await call('vault_add', { type: 'worklog', title: `zebra-${i} quokka${i}x`, content: `unique${i}alpha unique${i}beta distinct${i}gamma topic${i}delta` });
    }
    const seen = new Set();
    for (let round = 0; round < 3; round++) {
      const r = await call('vault_smart_context', { topic: 'zebra', limit: 5, freshOnly: true });
      const titles = [...r.text.matchAll(/zebra-(\d+)/g)].map((m) => m[1]);
      expect(new Set(titles).size, `round ${round}`).toBe(5);
      for (const t of titles) { expect(seen.has(t)).toBe(false); seen.add(t); }
    }
    expect(seen.size).toBe(15);
  });
});
