import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { retryBusy } from '../retry.mjs';

const err = (code) => Object.assign(new Error(code), { code });

describe('retry on a briefly locked file (antivirus, indexers, cloud sync on Windows)', () => {
  it('tries again after EBUSY, EPERM or EACCES and then succeeds', () => {
    for (const code of ['EBUSY', 'EPERM', 'EACCES']) {
      let n = 0;
      const out = retryBusy(() => { if (++n < 3) throw err(code); return 'ok'; }, { delayMs: 1 });
      expect(out).toBe('ok');
      expect(n).toBe(3);
    }
  });

  it('gives up after the allowed number of tries and shows the real error', () => {
    let n = 0;
    expect(() => retryBusy(() => { n++; throw err('EBUSY'); }, { tries: 4, delayMs: 1 })).toThrow(/EBUSY/);
    expect(n).toBe(4);
  });

  it('does not hide a different error', () => {
    let n = 0;
    expect(() => retryBusy(() => { n++; throw err('ENOENT'); }, { delayMs: 1 })).toThrow(/ENOENT/);
    expect(n).toBe(1);
  });

  it('a normal rename still works', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-retry-'));
    fs.writeFileSync(path.join(dir, 'a'), '1');
    retryBusy(() => fs.renameSync(path.join(dir, 'a'), path.join(dir, 'b')));
    expect(fs.readFileSync(path.join(dir, 'b'), 'utf8')).toBe('1');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
