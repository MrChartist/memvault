import { describe, it, expect, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { writeMirror, removeMirrors, removeAllMirrors, updateMirror } from '../mirror.mjs';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'memvault-mirror-'));
afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));
const fresh = () => fs.mkdtempSync(path.join(TMP, 'm-'));
const all = (root) => fs.existsSync(root) ? fs.readdirSync(root, { recursive: true }).filter((f) => String(f).endsWith('.md')).map(String) : [];
const item = (over = {}) => ({ id: 'diary_1700000000000_ab12cd34ef', type: 'diary', title: 'Meeting notes', content: 'full text', source: 'mcp', tags: 'a,b', created_at: '2026-10-07T10:00:00.000Z', ...over });

describe('markdown copies', () => {
  it('two notes with the same title on the same day get two files (the second used to overwrite the first)', () => {
    const root = fresh();
    writeMirror(root, item({ id: 'diary_1_aaaaaaaaaa', content: 'first' }));
    writeMirror(root, item({ id: 'diary_2_bbbbbbbbbb', content: 'second' }));
    expect(all(root)).toHaveLength(2);
  });

  it('keeps letters from any language in the file name', () => {
    const root = fresh();
    const f = writeMirror(root, item({ title: 'ملاحظات اليوم 今週の目標' }));
    expect(path.basename(f)).toMatch(/ملاحظات/);
    expect(path.basename(f)).not.toMatch(/^[\d-]+_-?\.md$/);
  });

  it('removes the copy of a deleted memory, and only that one', () => {
    const root = fresh();
    writeMirror(root, item({ id: 'diary_1_aaaaaaaaaa', title: 'Keep me' }));
    writeMirror(root, item({ id: 'diary_2_bbbbbbbbbb', title: 'Delete me', content: 'private words' }));
    expect(removeMirrors(root, [{ id: 'diary_2_bbbbbbbbbb', title: 'Delete me', created_at: '2026-10-07T10:00:00.000Z' }])).toBe(1);
    expect(all(root)).toHaveLength(1);
    expect(fs.readFileSync(path.join(root, 'entries', all(root)[0].replace(/^entries[\\/]/, '')), 'utf8')).toContain('Keep me');
  });

  it('also removes copies made by earlier versions (no id in the name), found by title and time', () => {
    const root = fresh();
    const dir = path.join(root, 'worklogs', '2026', '10');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '2026-10-07_Old-note.md'), '# Old note\n\nsecret text\n\n---\nSource: mcp\nTags: \nCreated: 2026-10-07T09:00:00.000Z\n');
    fs.writeFileSync(path.join(dir, '2026-10-07_Other.md'), '# Other\n\nstays\n\n---\nSource: mcp\nTags: \nCreated: 2026-10-07T09:30:00.000Z\n');
    expect(removeMirrors(root, [{ id: 'worklog_9_cccccccccc', title: 'Old note', created_at: '2026-10-07T09:00:00.000Z' }])).toBe(1);
    expect(fs.readdirSync(dir)).toEqual(['2026-10-07_Other.md']);
  });

  it('rewrites the copy when the memory is edited, instead of leaving the old text behind', () => {
    const root = fresh();
    writeMirror(root, item({ content: 'old words' }));
    updateMirror(root, item({ content: 'new words' }));
    const text = fs.readFileSync(path.join(root, 'entries', all(root)[0].replace(/^entries[\\/]/, '')), 'utf8');
    expect(text).toContain('new words');
    expect(text).not.toContain('old words');
  });

  it('can remove every copy at once', () => {
    const root = fresh();
    writeMirror(root, item({ id: 'diary_1_aaaaaaaaaa' }));
    writeMirror(root, item({ id: 'worklog_2_bbbbbbbbbb', type: 'worklog' }));
    expect(removeAllMirrors(root)).toBe(2);
    expect(all(root)).toHaveLength(0);
  });

  it('copies are private to the account', () => {
    if (process.platform === 'win32') return;
    const root = fresh();
    expect(fs.statSync(writeMirror(root, item())).mode & 0o077).toBe(0);
  });
});
