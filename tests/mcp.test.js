import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(here, '..', 'mcp-server.mjs');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'memvault-mcp-'));
const clients = [];

/** Connect to a real MemVault MCP server process, exactly like an AI client does. */
async function connect(agent) {
  const env = { ...process.env, VAULT_ROOT: ROOT, MEMVAULT_TOKEN_FILE: path.join(ROOT, 'token') };
  delete env.MEMVAULT_AGENT;
  if (agent) env.MEMVAULT_AGENT = agent;
  const c = new Client({ name: 'test', version: '1' });
  await c.connect(new StdioClientTransport({ command: process.execPath, args: [SERVER], env, stderr: 'ignore' }));
  clients.push(c);
  return c;
}
const text = (r) => r.content.map((x) => x.text).join('\n');
const call = async (c, name, args = {}) => text(await c.callTool({ name, arguments: args }));
const toolNames = async (c) => (await c.listTools()).tools.map((t) => t.name);

let owner;
beforeAll(async () => {
  process.env.VAULT_ROOT = ROOT;
  // starter agents, created the supported way
  const { openVaultDb } = await import('../db.mjs');
  const { installStarterPack } = await import('../agents.mjs');
  installStarterPack(openVaultDb({ root: ROOT }), { pack: 'all' });
  owner = await connect();
}, 60_000);

afterAll(async () => {
  await Promise.all(clients.map((c) => c.close().catch(() => {})));
  fs.rmSync(ROOT, { recursive: true, force: true });
});

describe('mcp — owner mode', () => {
  it('exposes the agent tools and the original vault tools', async () => {
    const names = await toolNames(owner);
    for (const t of ['agent_list', 'agent_activate', 'agent_define', 'agent_handoff', 'agent_inbox', 'vault_add', 'vault_search', 'vault_backup']) {
      expect(names).toContain(t);
    }
  });

  it('lists the starter agents', async () => {
    const out = await call(owner, 'agent_list');
    expect(out).toMatch(/market-analyst/);
    expect(out).toMatch(/telegram-editor/);
  });

  it('agent_define creates a least-privilege agent and cannot grant permissions', async () => {
    const out = await call(owner, 'agent_define', {
      name: 'Options Desk', id: 'options-desk', role: 'Explains option structures',
      never: ['Do not recommend a trade'], always: ['State assumptions'], domains: ['options'],
    });
    expect(out).toMatch(/Created agent `options-desk`/);
    const { openVaultDb } = await import('../db.mjs');
    const { getAgent } = await import('../agents.mjs');
    const p = getAgent(openVaultDb({ root: ROOT }), 'options-desk');
    expect(p.memory.allowSecrets).toBe(false);
    expect(p.memory.readScopes).toEqual([]);
    expect(p.tools.allow).toBeNull();
  });

  it('vault_add masks secrets in the DB and in the markdown mirror', async () => {
    const out = await call(owner, 'vault_add', {
      type: 'diary', title: 'Deploy notes', content: 'Use token=ghp_abcdefghijklmnopqrstuvwxyz0123456789 for CI',
    });
    expect(out).toMatch(/Masked before saving/);
    const found = await call(owner, 'vault_search', { query: 'Deploy notes' });
    expect(found).toMatch(/REDACTED:github-token/);
    expect(found).not.toMatch(/ghp_abc/);
    const mirrors = fs.readdirSync(path.join(ROOT, 'entries'), { recursive: true })
      .filter((f) => String(f).endsWith('.md'))
      .map((f) => fs.readFileSync(path.join(ROOT, 'entries', String(f)), 'utf8'));
    expect(mirrors.length).toBeGreaterThan(0);
    expect(mirrors.join('\n')).not.toMatch(/ghp_abc/);
  });

  it('masks secrets in tags and source as well, in the DB and in the markdown mirror', async () => {
    await call(owner, 'vault_add', {
      type: 'diary', title: 'Mirror tags check', content: 'plain text',
      tags: 'deploy,sk-ant-abcdefghijklmnopqrstuvwxyz012345',
      source: 'cli ghp_abcdefghijklmnopqrstuvwxyz0123456789',
    });
    const { openVaultDb } = await import('../db.mjs');
    const row = openVaultDb({ root: ROOT }).query("SELECT source, tags FROM items WHERE title = 'Mirror tags check'")[0];
    expect(row.tags).not.toMatch(/sk-ant-abc/);
    expect(row.source).not.toMatch(/ghp_abc/);
    const mirror = fs.readdirSync(path.join(ROOT, 'entries'), { recursive: true })
      .filter((f) => String(f).includes('Mirror-tags-check'))
      .map((f) => fs.readFileSync(path.join(ROOT, 'entries', String(f)), 'utf8'))
      .join('\n');
    expect(mirror).toMatch(/Mirror tags check/);
    expect(mirror).not.toMatch(/sk-ant-abc|ghp_abc/);
    expect(fs.readFileSync(path.join(ROOT, 'audit.log'), 'utf8')).not.toMatch(/sk-ant-abc|ghp_abc/);
  });

  it('vault_smart_search works (it used to query a table that never existed)', async () => {
    await call(owner, 'vault_add', { type: 'worklog', title: 'Nifty retest plan', content: 'Support zone held after the breakout retest.' });
    const out = await call(owner, 'vault_smart_search', { query: 'breakout retest support' });
    expect(out).not.toMatch(/no such table/i);
    expect(out).toMatch(/Nifty retest plan/);
  });

  it('keyword search matches ANY word, not only the exact phrase', async () => {
    const out = await call(owner, 'vault_smart_search', { query: 'retest nifty' });
    expect(out).toMatch(/Nifty retest plan/);
  });

  it('does not crash on regex characters in a query', async () => {
    const out = await call(owner, 'vault_smart_search', { query: 'C++ (nifty [retest' });
    expect(out).not.toMatch(/Invalid regular expression/);
  });
});

describe('mcp — SQL injection regression', () => {
  it("user_context's topic can no longer reach other tables", async () => {
    const { openVaultDb } = await import('../db.mjs');
    openVaultDb({ root: ROOT }).run(
      "INSERT OR REPLACE INTO secrets (id,category,label,encrypted,created_at,updated_at) VALUES ('s1','apikey','K','CIPHERTEXT-MARKER','x','x')"
    );
    const r = await owner.getPrompt({
      name: 'user_context',
      arguments: { topic: "zzz%' UNION SELECT 'x', encrypted, 'x', 'x' FROM secrets --" },
    });
    expect(JSON.stringify(r)).not.toMatch(/CIPHERTEXT-MARKER/);
  });

  it("vault_daily_digest's date can no longer reach other tables", async () => {
    const { openVaultDb } = await import('../db.mjs');
    openVaultDb({ root: ROOT }).run(
      "INSERT OR REPLACE INTO secrets (id,category,label,encrypted,created_at,updated_at) VALUES ('s1','apikey','K','CIPHERTEXT-MARKER','x','x')"
    );
    const out = await call(owner, 'vault_daily_digest', {
      date: "x' UNION SELECT id, 'diary', 'x', encrypted, encrypted, 'x', '2020-01-01T00:00:00Z' FROM secrets --",
    });
    expect(out).not.toMatch(/CIPHERTEXT-MARKER/);
  });

  it('vault_daily_digest still works for a real date', async () => {
    const today = new Date().toISOString().slice(0, 10);
    expect(await call(owner, 'vault_daily_digest', { date: today })).toMatch(/Daily Digest|No activity/);
  });
});

describe('mcp — bound to an agent', () => {
  it('never even registers owner-only tools', async () => {
    const editor = await connect('telegram-editor');
    const names = await toolNames(editor);
    for (const t of ['agent_define', 'vault_backup', 'vault_backups', 'vault_bridge_list', 'vault_bridge_sync', 'vault_secret_list']) {
      expect(names).not.toContain(t);
    }
    for (const t of ['agent_activate', 'agent_inbox', 'agent_handoff', 'vault_search', 'vault_add']) {
      expect(names).toContain(t);
    }
  });

  it('fails closed when the profile does not exist (does not fall back to owner access)', () => {
    const r = spawnSync(process.execPath, [SERVER], {
      env: { ...process.env, VAULT_ROOT: ROOT, MEMVAULT_AGENT: 'no-such-agent' },
      input: '', encoding: 'utf8', timeout: 20_000,
    });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/no such agent profile/);
  });

  it('activates its own persona by default', async () => {
    const editor = await connect('telegram-editor');
    const out = await call(editor, 'agent_activate');
    expect(out).toMatch(/You are acting as: Telegram Editor/);
    expect(out).toMatch(/Do not add new data/);
  });

  it("private memory is private: other agents cannot search it, owner can", async () => {
    const analyst = await connect('market-analyst');
    const editor = await connect('telegram-editor');
    await call(analyst, 'vault_add', { type: 'worklog', title: 'Analyst private levels', content: 'PRIVATE-LEVELS-XYZ', private: true });
    await call(analyst, 'vault_add', { type: 'worklog', title: 'Analyst shared view', content: 'SHARED-VIEW-XYZ' });

    expect(await call(analyst, 'vault_search', { query: 'PRIVATE-LEVELS-XYZ' })).toMatch(/Analyst private levels/);
    expect(await call(editor, 'vault_search', { query: 'PRIVATE-LEVELS-XYZ' })).toMatch(/No results/);
    expect(await call(editor, 'vault_search', { query: 'SHARED-VIEW-XYZ' })).toMatch(/Analyst shared view/);
    expect(await call(owner, 'vault_search', { query: 'PRIVATE-LEVELS-XYZ' })).toMatch(/Analyst private levels/);
  });

  it('writes are attributed to the bound agent, not to whatever the model claims', async () => {
    const coder = await connect('coder');
    await call(coder, 'vault_add', { type: 'worklog', title: 'Attribution check', content: 'x' });
    const { openVaultDb } = await import('../db.mjs');
    const row = openVaultDb({ root: ROOT }).query("SELECT agent_id FROM items WHERE title = 'Attribution check'")[0];
    expect(row.agent_id).toBe('coder');
  });

  it('multi-agent handoff: analyst → editor, editor acks, inbox empties; editor cannot read analyst inbox', async () => {
    const analyst = await connect('market-analyst');
    const editor = await connect('telegram-editor');

    const sent = await call(analyst, 'agent_handoff', { to: 'telegram-editor', subject: 'Nifty post', message: 'Format the attached draft for Telegram.' });
    expect(sent).toMatch(/Handed to `telegram-editor`/);

    const activation = await call(editor, 'agent_activate');
    expect(activation).toMatch(/Inbox — handoffs waiting/);

    const inbox = await call(editor, 'agent_inbox');
    expect(inbox).toMatch(/Nifty post/);
    const id = inbox.match(/\(id: ([^,]+),/)[1];

    expect(await call(editor, 'agent_inbox', { agent_id: 'market-analyst' })).toMatch(/only read your own inbox/);

    expect(await call(editor, 'agent_inbox', { ack: [id] })).toMatch(/Acknowledged 1/);
    expect(await call(editor, 'agent_inbox')).toMatch(/Inbox empty/);
  });

  it('refuses to hand off to an unknown agent', async () => {
    const analyst = await connect('market-analyst');
    expect(await call(analyst, 'agent_handoff', { to: 'ghost', subject: 's', message: 'm' })).toMatch(/No agent "ghost"/);
  });

  it('honours a profile tool allow-list (tools outside it are not registered)', async () => {
    const { openVaultDb } = await import('../db.mjs');
    const { saveAgent, getAgent } = await import('../agents.mjs');
    const db = openVaultDb({ root: ROOT });
    saveAgent(db, { ...getAgent(db, 'researcher'), tools: { allow: ['vault_search'] } });
    const r = await connect('researcher');
    const names = await toolNames(r);
    expect(names).toContain('vault_search');
    expect(names).toContain('agent_activate'); // agent basics are always available
    expect(names).not.toContain('vault_add');
    expect(names).not.toContain('vault_git_log');
  });
});

describe('mcp — audit', () => {
  it('records tool calls by agent and tool name, with argument names only', async () => {
    const { tailAudit, verifyAudit } = await import('../audit.mjs');
    const recs = tailAudit(500, {}, ROOT);
    const mine = recs.filter((r) => r.action === 'tool' && r.actor === 'telegram-editor');
    expect(mine.length).toBeGreaterThan(0);
    expect(mine[0].detail.tool).toBeTruthy();
    expect(JSON.stringify(recs)).not.toMatch(/PRIVATE-LEVELS-XYZ|ghp_abc/); // content never logged
    expect(verifyAudit(ROOT).ok).toBe(true);
  });
});
