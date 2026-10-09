import { describe, it, expect, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { pathToFileURL, fileURLToPath } from 'url';
import { isMain } from '../is-main.mjs';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'memvault ismain '));
afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));

describe('isMain', () => {
  it('is true for the file that was run, false for another, even with spaces and non-Latin names', () => {
    const f = path.join(TMP, 'सरल file.mjs');
    fs.writeFileSync(f, '');
    expect(isMain(pathToFileURL(f).href, f)).toBe(true);
    expect(isMain(pathToFileURL(f).href, path.join(TMP, 'other.mjs'))).toBe(false);
    expect(isMain(pathToFileURL(f).href, undefined)).toBe(false);
  });

  it('follows a symbolic link (npm bin links, Homebrew, version managers)', () => {
    if (process.platform === 'win32') return;
    const real = path.join(TMP, 'real.mjs');
    fs.writeFileSync(real, '');
    const link = path.join(TMP, 'link.mjs');
    fs.symlinkSync(real, link);
    expect(isMain(pathToFileURL(real).href, link)).toBe(true);
  });
});

describe('scripts started through a link still run', () => {
  it('storage.mjs list works when started through a symlink to the install folder', () => {
    if (process.platform === 'win32') return;
    const linkDir = path.join(TMP, 'linked repo');
    fs.symlinkSync(REPO, linkDir);
    const r = spawnSync(process.execPath, [path.join(linkDir, 'storage.mjs'), 'list'], {
      encoding: 'utf8', env: { ...process.env, HOME: TMP, VAULT_ROOT: path.join(TMP, 'v') },
    });
    expect(r.stdout).toMatch(/local backup/);
  });
});
