import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { audit, verifyAudit, tailAudit, auditPath } from '../audit.mjs';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'memvault-audit-'));
afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));

let root;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(TMP, 'a-'));
});

describe('audit log', () => {
  it('writes a verifiable hash chain', () => {
    audit({ actor: 'analyst', action: 'tool', detail: { tool: 'vault_search' } }, root);
    audit({ actor: 'coder', action: 'tool', detail: { tool: 'vault_add' } }, root);
    audit({ actor: 'owner', action: 'backup' }, root);
    expect(verifyAudit(root)).toEqual({ ok: true, entries: 3 });
    expect(tailAudit(10, {}, root).map((r) => r.actor)).toEqual(['analyst', 'coder', 'owner']);
  });

  it('detects an edited record', () => {
    audit({ actor: 'analyst', action: 'tool', detail: { tool: 'vault_search' } }, root);
    audit({ actor: 'coder', action: 'tool', detail: { tool: 'vault_add' } }, root);
    const f = auditPath(root);
    fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('"analyst"', '"nobody"'));
    const r = verifyAudit(root);
    expect(r.ok).toBe(false);
    expect(r.brokenAtLine).toBe(1);
  });

  it('detects a deleted record', () => {
    for (let i = 0; i < 4; i++) audit({ actor: 'a', action: `n${i}` }, root);
    const f = auditPath(root);
    const lines = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean);
    lines.splice(1, 1); // remove the 2nd record
    fs.writeFileSync(f, lines.join('\n') + '\n');
    const r = verifyAudit(root);
    expect(r.ok).toBe(false);
    expect(r.brokenAtLine).toBe(2);
  });

  it('treats a missing log as valid and empty', () => {
    expect(verifyAudit(root)).toEqual({ ok: true, entries: 0 });
  });

  it('never stores long content — metadata is truncated', () => {
    audit({ actor: 'a', action: 'x', detail: { q: 'z'.repeat(5000) } }, root);
    const rec = tailAudit(1, {}, root)[0];
    expect(rec.detail.q.length).toBeLessThanOrEqual(120);
  });

  it('keeps the chain intact under concurrent writers', async () => {
    const worker = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'audit-writer.mjs');
    const run = (tag) =>
      new Promise((res, rej) =>
        spawn(process.execPath, [worker, root, tag, '30'], { stdio: ['ignore', 'ignore', 'inherit'] })
          .on('exit', (c) => (c === 0 ? res() : rej(new Error(`${tag} exit ${c}`))))
      );
    await Promise.all([run('a'), run('b'), run('c')]);
    expect(verifyAudit(root)).toEqual({ ok: true, entries: 90 });
  }, 30_000);
});
