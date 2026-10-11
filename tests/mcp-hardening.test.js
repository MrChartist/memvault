// Regression tests for the MCP server: agent_define cannot reset a locked-down profile, revoking an agent
// reaches its running connection, AI features need an explicit opt-in, the daily digest uses the local day,
// the owner cannot fake an agent's acknowledgement, limits are whole numbers, and agents never see the vault path.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(here, '..', 'mcp-server.mjs');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'memvault-hardening-'));
const ROOT = path.join(HOME, 'vault');
const clients = [];

/** Start a real server process the way an AI app does. `home` decides which ~/.memvaultrc.json it reads. */
async function connect(agent, { home = HOME, root = ROOT, env: more = {}, nodeArgs = [] } = {}) {
  const env = { ...process.env, HOME: home, USERPROFILE: home, VAULT_ROOT: root, MEMVAULT_TOKEN_FILE: path.join(HOME, 'token') };
  delete env.MEMVAULT_AGENT; delete env.GEMINI_API_KEY; delete env.GOOGLE_AI_API_KEY;
  Object.assign(env, more);
  if (agent) env.MEMVAULT_AGENT = agent;
  const c = new Client({ name: 'test', version: '1' });
  await c.connect(new StdioClientTransport({ command: process.execPath, args: [...nodeArgs, SERVER], env, stderr: 'ignore' }));
  clients.push(c);
  return c;
}
const text = (r) => r.content.map((x) => x.text).join('\n');
const call = async (c, name, args = {}) => text(await c.callTool({ name, arguments: args }));
const toolNames = async (c) => (await c.listTools()).tools.map((t) => t.name).sort();
/** Resolves when the server process behind `c` has gone away. */
const ended = (c) => new Promise((resolve) => { c.onclose = resolve; });

let A; // agents.mjs
let odb; // an owner handle on the test vault, like the dashboard or CLI holds
let owner;
const SECRET = 'PLOT-TWIST-SECRET-4711';

beforeAll(async () => {
  process.env.VAULT_ROOT = ROOT;
  const { openVaultDb } = await import('../db.mjs');
  A = await import('../agents.mjs');
  odb = openVaultDb({ root: ROOT });
  A.installStarterPack(odb, { pack: 'all' });
  // Another agent's private note: what a revoked connection must stop seeing.
  odb.addItem({ type: 'diary', title: 'Writer private draft', content: SECRET, scope: 'agent:writer', agent_id: 'writer' });
  owner = await connect();
}, 60_000);

afterAll(async () => {
  await Promise.all(clients.map((c) => c.close().catch(() => {})));
  fs.rmSync(HOME, { recursive: true, force: true });
});

/** The owner changes an agent's saved profile (as the dashboard or `memvault agent` does). */
function edit(id, change) {
  const p = A.getAgent(odb, id);
  change(p);
  A.saveAgent(odb, p);
  return A.getAgent(odb, id);
}

describe('agent_define keeps what only the owner may set', () => {
  it('agent_define by name updates the existing profile and keeps its permissions', async () => {
    const locked = edit('coordinator', (p) => {
      p.tools.allow = ['vault_search'];
      p.memory.readScopes = ['project:*'];
      p.role = 'Routes work between agents';
      p.rules.never = ['Never publish anything'];
      p.brand.handle = '@coord';
      p.domains = ['planning'];
    });
    const bound = await connect('coordinator');
    const before = await toolNames(bound);
    expect(before).toContain('vault_search');
    expect(before).not.toContain('vault_add');

    // An AI in owner mode "refines the persona" and, as the schema allows, leaves out the id.
    const out = await call(owner, 'agent_define', { name: 'Coordinator', persona: 'Be brief.' });
    expect(out).toMatch(/Updated agent `coordinator`/);
    expect(out).not.toMatch(/Created/);

    const after = A.getAgent(odb, 'coordinator');
    expect(after.persona).toBe('Be brief.');
    expect(after.tools).toEqual(locked.tools);
    expect(after.memory).toEqual(locked.memory);
    expect(after.role).toBe(locked.role);
    expect(after.rules).toEqual(locked.rules);
    expect(after.brand).toEqual(locked.brand);
    expect(after.domains).toEqual(locked.domains);

    // Only the persona changed, so the running connection keeps working, and a new one gets the same tools.
    const r = await bound.callTool({ name: 'vault_search', arguments: { query: 'anything' } });
    expect(r.isError, text(r)).toBeFalsy();
    expect(await toolNames(await connect('coordinator'))).toEqual(before);
  }, 60_000);

  it('a name nobody has yet still creates a new least-privilege agent', async () => {
    const out = await call(owner, 'agent_define', { name: 'Garden Helper', role: 'Plans the garden' });
    expect(out).toMatch(/Created agent `garden-helper`/);
    const p = A.getAgent(odb, 'garden-helper');
    expect(p.memory.readScopes).toEqual([]);
    expect(p.memory.allowSecrets).toBe(false);
  });
});

describe('revoking an agent reaches its running connection', () => {
  it('deleting the agent (with purge) ends the connection: the next call reads and writes nothing', async () => {
    edit('assistant', (p) => { p.memory.readScopes = ['agent:*']; }); // trusted for a while
    const bound = await connect('assistant');
    expect(await call(bound, 'vault_search', { query: SECRET })).toMatch(/Writer private draft/);

    const gone = ended(bound);
    A.deleteAgent(odb, 'assistant', { purge: true });
    const r = await bound.callTool({ name: 'vault_search', arguments: { query: SECRET } });
    expect(r.isError).toBe(true);
    expect(text(r)).not.toContain('Writer private draft');
    expect(text(r)).toMatch(/assistant.*(removed|no longer exists)/i);
    await gone; // the process exits, so the app shows it as disconnected

    await expect(bound.callTool({ name: 'vault_add', arguments: { type: 'diary', title: 'Written after delete', content: 'x', private: true } })).rejects.toThrow();
    expect(odb.query("SELECT COUNT(*) AS n FROM items WHERE title = 'Written after delete'")[0].n).toBe(0);
  }, 30_000);

  it('narrowing its read scopes ends the connection instead of serving the old view', async () => {
    edit('researcher', (p) => { p.memory.readScopes = ['agent:writer']; });
    const bound = await connect('researcher');
    expect(await call(bound, 'vault_search', { query: SECRET })).toMatch(/Writer private draft/);

    const gone = ended(bound);
    edit('researcher', (p) => { p.memory.readScopes = []; });
    const r = await bound.callTool({ name: 'vault_search', arguments: { query: SECRET } });
    expect(r.isError).toBe(true);
    expect(text(r)).not.toContain('Writer private draft');
    expect(text(r)).toMatch(/restart/i);
    await gone;
  }, 30_000);

  it('taking a tool away ends the connection before that tool runs', async () => {
    const bound = await connect('study-buddy');
    expect(await toolNames(bound)).toContain('vault_add');

    const gone = ended(bound);
    edit('study-buddy', (p) => { p.tools.allow = ['vault_search']; });
    const r = await bound.callTool({ name: 'vault_add', arguments: { type: 'diary', title: 'Written after the tool was removed', content: 'x' } });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/restart/i);
    await gone;
    expect(odb.query("SELECT COUNT(*) AS n FROM items WHERE title = 'Written after the tool was removed'")[0].n).toBe(0);
  }, 30_000);

  it('resources are checked too', async () => {
    edit('market-analyst', (p) => { p.memory.readScopes = ['agent:writer']; });
    const bound = await connect('market-analyst');
    const seen = await bound.readResource({ uri: 'memvault://entries/diary' });
    expect(JSON.stringify(seen)).toContain('Writer private draft');

    A.deleteAgent(odb, 'market-analyst');
    let out = '';
    try { out = JSON.stringify(await bound.readResource({ uri: 'memvault://entries/diary' })); } catch (e) { out = e.message; }
    expect(out).not.toContain('Writer private draft');
    expect(out).toMatch(/removed|no longer exists/i);
  }, 30_000);

  it('prompts are checked too', async () => {
    edit('nism-educator', (p) => { p.memory.readScopes = ['agent:writer']; });
    const bound = await connect('nism-educator');
    const seen = await bound.getPrompt({ name: 'user_context', arguments: { topic: SECRET } });
    expect(JSON.stringify(seen)).toContain('Writer private draft');

    A.deleteAgent(odb, 'nism-educator');
    let out = '';
    try { out = JSON.stringify(await bound.getPrompt({ name: 'user_context', arguments: { topic: SECRET } })); } catch (e) { out = e.message; }
    expect(out).not.toContain('Writer private draft');
    expect(out).toMatch(/removed|no longer exists/i);
  }, 30_000);

  it('a change that does not touch access (the persona) keeps the connection working', async () => {
    const bound = await connect('writer');
    edit('writer', (p) => { p.persona = 'A NEW PERSONA FOR THE WRITER.'; });
    const r = await bound.callTool({ name: 'vault_search', arguments: { query: SECRET } });
    expect(r.isError, text(r)).toBeFalsy();
    expect(text(r)).toMatch(/Writer private draft/); // its own private note
    expect(await call(bound, 'agent_activate')).toMatch(/A NEW PERSONA FOR THE WRITER/);
  }, 30_000);
});

describe('AI features stay off until the config says "enabled": true', () => {
  const LOG = path.join(HOME, 'fetch-log.txt');
  const SPY = path.join(HOME, 'fetch-spy.mjs');
  const nodeArgs = ['--import', pathToFileURL(SPY).href];
  const homeWith = (config) => {
    const h = fs.mkdtempSync(path.join(HOME, 'home-'));
    if (config) fs.writeFileSync(path.join(h, '.memvaultrc.json'), JSON.stringify(config));
    return h;
  };
  const googleCalls = () => (fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8').split('\n').filter((l) => l.includes('generativelanguage.googleapis.com')).length : 0);

  beforeAll(() => {
    // Stands in for the network: records every fetch the server makes and answers like Gemini would.
    fs.writeFileSync(SPY, `import fs from "fs";
globalThis.fetch = async (url) => {
  fs.appendFileSync(${JSON.stringify(LOG)}, String(url).replace(/key=[^&]+/, "key=***") + "\\n");
  return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "1" }] } }] }), { status: 200 });
};\n`);
    odb.addItem({ type: 'diary', title: 'Therapy notes', content: 'Session about anxiety and the divorce' });
  });

  it('a GEMINI_API_KEY that merely exists in the environment sends nothing to Google', async () => {
    fs.rmSync(LOG, { force: true });
    const c = await connect(null, { home: homeWith(null), env: { GEMINI_API_KEY: 'key-set-for-another-app' }, nodeArgs });
    const found = await call(c, 'vault_smart_search', { query: 'therapy' });
    expect(found).toMatch(/Therapy notes/);
    expect(found).not.toMatch(/AI-ranked/);
    const digest = await call(c, 'vault_weekly_digest');
    expect(digest).toMatch(/"enabled": true/); // says how to switch it on
    expect(await call(c, 'vault_ai_summarize', { query: 'therapy' })).toMatch(/"enabled": true/);
    expect(await call(c, 'vault_ai_insights')).toMatch(/"enabled": true/);
    expect(googleCalls()).toBe(0);
  }, 30_000);

  it('a key without "enabled": true in the config is not enough either', async () => {
    fs.rmSync(LOG, { force: true });
    const c = await connect(null, { home: homeWith({ ai: { apiKey: 'key-in-config' } }), nodeArgs });
    expect(await call(c, 'vault_smart_search', { query: 'therapy' })).not.toMatch(/AI-ranked/);
    expect(googleCalls()).toBe(0);
  }, 30_000);

  it('with "enabled": true the key may come from the environment', async () => {
    fs.rmSync(LOG, { force: true });
    const c = await connect(null, { home: homeWith({ ai: { enabled: true } }), env: { GEMINI_API_KEY: 'key-from-env' }, nodeArgs });
    expect(await call(c, 'vault_smart_search', { query: 'therapy' })).toMatch(/AI-ranked/);
    expect(googleCalls()).toBe(1);
  }, 30_000);
});

describe("the daily digest means the user's own day, not the UTC day", () => {
  it('a note written just now is in today\'s digest and daily brief, wherever the user lives', async () => {
    // A zone whose date differs from the UTC date right now, so a UTC comparison would miss the note.
    const tz = new Date().getUTCHours() >= 10 ? 'Pacific/Kiritimati' : 'Pacific/Pago_Pago'; // UTC+14 / UTC-11
    const localDate = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    expect(localDate).not.toBe(new Date().toISOString().slice(0, 10));

    const root = path.join(HOME, 'digest-vault'); // its own vault: the digest lists at most 8 entries per type
    const c = await connect(null, { root, env: { TZ: tz } });
    await call(c, 'vault_add', { type: 'worklog', title: 'Wrote this just now', content: 'breakfast meeting notes' });

    expect(await call(c, 'vault_daily_digest')).toMatch(/Wrote this just now/);
    expect(await call(c, 'vault_daily_digest', { date: localDate })).toMatch(/Wrote this just now/);
    const brief = await c.getPrompt({ name: 'daily_brief', arguments: {} });
    expect(JSON.stringify(brief)).toMatch(/Wrote this just now/);
    expect(JSON.stringify(brief)).toContain(localDate);
  }, 30_000);
});

describe('only the agent a handoff is addressed to can acknowledge it', () => {
  it('an owner connection is told so, nothing is written, and the handoff stays open', async () => {
    const sent = await call(owner, 'agent_handoff', { to: 'planner', subject: 'Owner-ack check', message: 'Plan the week.' });
    const id = sent.match(/id ([^)]+)\)/)[1];

    const out = await call(owner, 'agent_inbox', { agent_id: 'planner', ack: [id] });
    expect(out).not.toMatch(/Acknowledged/);
    expect(out).toMatch(/only `planner`/i);
    expect(odb.query('SELECT COUNT(*) AS n FROM items WHERE tags LIKE ?', [`%ref:${id}%`])[0].n).toBe(0);
    expect(await call(owner, 'agent_inbox', { agent_id: 'planner' })).toMatch(/Owner-ack check/);

    // The addressee itself still can.
    const planner = await connect('planner');
    expect(await call(planner, 'agent_inbox', { ack: [id] })).toMatch(/Acknowledged 1/);
    expect(await call(owner, 'agent_inbox', { agent_id: 'planner' })).not.toMatch(/Owner-ack check/);
  }, 30_000);
});

describe('limits are whole numbers', () => {
  const withLimit = [
    ['vault_search', { query: 'x' }], ['vault_list', {}], ['vault_get_context', { topic: 'x' }],
    ['vault_git_log', {}], ['vault_smart_context', { topic: 'x' }],
    ['vault_ai_summarize', { query: 'x' }], ['vault_smart_search', { query: 'x' }],
  ];
  for (const [name, args] of withLimit) {
    it(`${name} rejects a fractional limit as invalid input instead of failing in SQL`, async () => {
      const bad = await owner.callTool({ name, arguments: { ...args, limit: 2.5 } });
      expect(bad.isError, text(bad)).toBe(true);
      expect(text(bad)).not.toMatch(/datatype mismatch/i);
      expect(text(bad)).toMatch(/int/i);
      const good = await owner.callTool({ name, arguments: { ...args, limit: 2 } });
      expect(good.isError, text(good)).toBeFalsy();
    });
  }
});

describe('a bound agent is never shown where the vault lives', () => {
  it('vault_add tells an agent a copy was saved without the full path; the owner still sees it', async () => {
    const coder = await connect('coder');
    const out = await call(coder, 'vault_add', { type: 'diary', title: 'Path check', content: 'y' });
    expect(out).toMatch(/Entry saved/);
    expect(out).not.toContain(HOME);
    expect(await call(owner, 'vault_add', { type: 'diary', title: 'Owner path check', content: 'y' })).toContain(ROOT);
  }, 30_000);
});
