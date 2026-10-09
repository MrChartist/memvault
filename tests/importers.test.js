import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'memvault-import-'));
process.env.VAULT_ROOT = path.join(TMP, 'vault');
process.env.HOME = process.env.USERPROFILE = path.join(TMP, 'home');

let db, chatgpt, claude, gemini, perplexity, importAll;
beforeAll(async () => {
  db = await import('../db.mjs');
  chatgpt = await import('../import-chatgpt.mjs');
  claude = await import('../import-claude.mjs');
  gemini = await import('../import-gemini.mjs');
  perplexity = await import('../import-perplexity.mjs');
  importAll = await import('../import-all.mjs');
});
afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));

const quiet = async (fn) => {
  const log = console.log, err = console.error;
  console.log = console.error = () => {};
  try { return await fn(); } finally { console.log = log; console.error = err; }
};
const write = (name, data) => {
  const dir = path.join(TMP, name);
  fs.mkdirSync(dir, { recursive: true });
  return { dir, file: (f, d) => fs.writeFileSync(path.join(dir, f), JSON.stringify(d)) };
};

const T0 = 1700000000; // 2023-11-14T22:13:20Z
const chatgptExport = [
  {
    title: 'Plan the launch', create_time: T0,
    mapping: {
      a: { message: { author: { role: 'user' }, create_time: T0, content: { parts: ['How do I ship an npm package?'] } } },
      b: { message: { author: { role: 'assistant' }, create_time: T0 + 5, content: { parts: ['Run npm publish.'] } } },
    },
  },
  { title: 'Empty one', create_time: T0 + 100, mapping: {} },
];

describe('ChatGPT importer', () => {
  it('imports conversations, skips empty ones, and KEEPS the original date (it used to stamp "now")', async () => {
    const { dir, file } = write('chatgpt', null);
    file('conversations.json', chatgptExport);
    const r = await quiet(() => chatgpt.importChatGPT(dir));
    expect(r).toMatchObject({ imported: 1, skipped: 1, errors: 0 });

    const row = db.queryOne("SELECT * FROM items WHERE source = 'chatgpt-import'");
    expect(row.title).toBe('Plan the launch');
    expect(row.created_at).toBe(new Date(T0 * 1000).toISOString());
    expect(row.content).toContain('How do I ship an npm package?');
    expect(row.tags).toContain('chatgpt');
  });

  it('importing the same export again adds nothing', async () => {
    const r = await quiet(() => chatgpt.importChatGPT(path.join(TMP, 'chatgpt')));
    expect(r.imported).toBe(0);
    expect(r.duplicates).toBe(1);
    expect(db.queryAll("SELECT id FROM items WHERE source = 'chatgpt-import'").length).toBe(1);
  });

  it('--dry-run writes nothing', async () => {
    const { dir, file } = write('chatgpt2', null);
    file('conversations.json', [{ ...chatgptExport[0], title: 'Another', create_time: T0 + 999 }]);
    const r = await quiet(() => chatgpt.importChatGPT(dir, { dryRun: true }));
    expect(r.imported).toBe(1);
    expect(db.queryAll("SELECT id FROM items WHERE title = 'Another'").length).toBe(0);
  });
});

describe('Claude importer', () => {
  it('imports with original timestamps and is idempotent', async () => {
    const { dir, file } = write('claude', null);
    file('conversations.json', { chat_conversations: [{
      uuid: 'u1', name: 'Refactor the parser', created_at: '2025-05-05T05:05:05.000Z',
      chat_messages: [{ sender: 'human', text: 'Please refactor' }, { sender: 'assistant', text: 'Done' }],
    }] });
    const first = await quiet(() => claude.importClaude(dir));
    expect(first.imported).toBe(1);
    expect(db.queryOne("SELECT created_at FROM items WHERE source = 'claude-import'").created_at).toBe('2025-05-05T05:05:05.000Z');
    const second = await quiet(() => claude.importClaude(dir));
    expect(second.imported).toBe(0);
  });
});

describe('Gemini + Perplexity importers', () => {
  it('Gemini: imports Takeout activity with its time', async () => {
    const { dir, file } = write('gemini', null);
    file('MyActivity.json', [{ header: 'Gemini Apps', title: 'Prompted what is MCP', time: '2025-06-06T06:06:06.000Z', products: ['Gemini Apps'], subtitles: [{ name: 'MCP is the Model Context Protocol.' }] }]);
    const r = await quiet(() => gemini.importGemini(dir));
    expect(r.imported).toBe(1);
    expect(db.queryOne("SELECT created_at FROM items WHERE source = 'gemini-import'").created_at).toBe('2025-06-06T06:06:06.000Z');
  });

  it('Perplexity: imports threads', async () => {
    const { dir, file } = write('perplexity', null);
    file('perplexity_export.json', [{ title: 'Best sqlite wrapper', query: 'best sqlite wrapper for node', answer: 'It depends on your needs and constraints.', created_at: '2025-07-07T07:07:07.000Z' }]);
    const r = await quiet(() => perplexity.importPerplexity(dir));
    expect(r.imported).toBe(1);
  });
});

describe('import-all', () => {
  it('detects ChatGPT and Claude exports in one folder', async () => {
    const { dir, file } = write('mixed', null);
    file('conversations.json', [{ ...chatgptExport[0], title: 'Mixed chatgpt', create_time: T0 + 5000 }]);
    file('claude_export.json', { chat_conversations: [{ name: 'Mixed claude', created_at: '2025-08-08T08:08:08.000Z', chat_messages: [{ sender: 'human', text: 'hi there' }] }] });
    const results = await quiet(() => importAll.importAll(dir));
    expect(Object.keys(results).sort()).toEqual(['chatgpt', 'claude']);
    expect(results.chatgpt.imported).toBe(1);
    expect(results.claude.imported).toBe(1);
  });

  it('says so when nothing is found', async () => {
    const { dir } = write('empty', null);
    expect(await quiet(() => importAll.importAll(dir))).toBeUndefined();
  });
});
