import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { readCommits } from '../git-log.mjs';

const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'memvault git repo-'));
const git = (...args) => execFileSync('git', args, { cwd: repo, stdio: 'pipe', env: { ...process.env, GIT_AUTHOR_NAME: 'Asha "Ash" Rao', GIT_AUTHOR_EMAIL: 'asha@example.com', GIT_COMMITTER_NAME: 'Asha', GIT_COMMITTER_EMAIL: 'asha@example.com' } });

beforeAll(() => {
  git('init', '-q');
  git('config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(repo, 'a.txt'), '1');
  git('add', '.');
  git('commit', '-q', '-m', 'fix: handle "quoted" text and back\\slash', '-m', 'Body line one\nBody line two with a tab\there\nUnicode: नमस्ते 日本語');
  fs.writeFileSync(path.join(repo, 'a.txt'), '2');
  git('commit', '-q', '-am', 'second commit');
});
afterAll(() => fs.rmSync(repo, { recursive: true, force: true }));

describe('git log reader', () => {
  it('reads every commit, including quotes, backslashes, new lines and non-Latin text', () => {
    const commits = readCommits(repo, 14);
    expect(commits).toHaveLength(2);
    const c = commits.find((x) => x.subject.startsWith('fix:'));
    expect(c.subject).toBe('fix: handle "quoted" text and back\\slash');
    expect(c.body).toContain('Body line two with a tab');
    expect(c.body).toContain('नमस्ते 日本語');
    expect(c.author).toBe('Asha "Ash" Rao');
    expect(c.hash).toMatch(/^[0-9a-f]{40}$/);
    expect(new Date(c.date).getTime()).not.toBeNaN();
  });

  it('returns an empty list, not an error, for a folder that is not a repository', () => {
    expect(readCommits(os.tmpdir(), 14)).toEqual([]);
  });
});
