import { describe, it, expect } from 'vitest';
import {
  autoTag, detectProject, compileProjects, scoreRelevance, rankByRelevance,
  deduplicateEntries, generateDigest,
} from '../context-engine.mjs';

describe('Context Engine - autoTag', () => {
  it('should detect technology tags from content', () => {
    const text = 'I am working on a react and node.js project fixing a bug.';
    const tags = autoTag(text);
    expect(tags).toContain('react');
    expect(tags).toContain('nodejs');
    expect(tags).toContain('bugfix');
  });

  it('should detect languages from markdown code blocks', () => {
    const text = 'Here is the code: ```python\nprint("hello")\n```';
    expect(autoTag(text)).toContain('python');
  });

  it('should return empty array for unrelated content', () => {
    expect(autoTag('Just had lunch, it was good.').length).toBe(0);
  });

  it('does not tag the everyday word "go" as golang', () => {
    expect(autoTag("let's go for lunch")).not.toContain('golang');
    expect(autoTag('run go test ./... before pushing')).toContain('golang');
  });

  it('ships no author-specific tags', () => {
    expect(autoTag('working on investology')).not.toContain('investology');
  });
});

describe('Context Engine - detectProject', () => {
  const projects = compileProjects([
    { name: 'My App', patterns: ['my-?app', 'myapp\\.com'], tags: 'myapp,web' },
    { name: 'Broken', patterns: ['(unclosed'] }, // invalid regex must be ignored, not crash
  ]);

  it('detects a project configured by the user', () => {
    expect(detectProject('Deploying my-app to staging', projects)).toEqual({ name: 'My App', tags: 'myapp,web' });
  });

  it('returns null if nothing matches', () => {
    expect(detectProject('generic text learning react', projects)).toBeNull();
  });

  it('knows no projects unless the user configures some', () => {
    expect(detectProject('Working on the Investology project today.')).toBeNull();
  });

  it('skips entries with invalid patterns instead of throwing', () => {
    expect(projects.map((p) => p.name)).toEqual(['My App']);
  });
});

describe('Context Engine - scoreRelevance', () => {
  it('should score high for title exact match', () => {
    const entry = { title: 'Fix auth bug', content: 'logging in', tags: 'auth,bug' };
    expect(scoreRelevance(entry, 'fix auth bug')).toBeGreaterThan(50);
  });

  it('should score lower for partial match', () => {
    const entry = { title: 'Some other thing', content: 'logging in', tags: 'frontend' };
    expect(scoreRelevance(entry, 'auth bug')).toBeLessThan(40);
  });

  it('does not crash on regex metacharacters in the query', () => {
    const entry = { title: 'C++ notes', content: 'c++ and (parens [brackets] a.*b', tags: '' };
    for (const q of ['c++ notes', '(parens', '[brackets', 'a.*b', '\\', '$^']) {
      expect(() => scoreRelevance(entry, q), q).not.toThrow();
    }
  });

  it('treats metacharacters literally when counting matches', () => {
    const literal = { title: '', content: 'a.b a.b a.b', tags: '' };
    const other = { title: '', content: 'axb axb axb', tags: '' };
    expect(scoreRelevance(literal, 'a.b')).toBeGreaterThan(scoreRelevance(other, 'a.b'));
  });

  it('rankByRelevance orders best match first', () => {
    const ranked = rankByRelevance(
      [{ title: 'unrelated', content: 'nothing' }, { title: 'deploy pipeline', content: 'deploy steps' }],
      'deploy pipeline'
    );
    expect(ranked[0].title).toBe('deploy pipeline');
  });
});

describe('Context Engine - deduplicateEntries / generateDigest', () => {
  it('drops near-identical entries', () => {
    const rows = [
      { title: 'Deploy notes', content: 'steps to deploy the service to production safely' },
      { title: 'Deploy notes', content: 'steps to deploy the service to production safely' },
      { title: 'Lunch', content: 'something entirely different about food' },
    ];
    expect(deduplicateEntries(rows).length).toBe(2);
  });

  it('labels the digest with the requested day, not today', () => {
    const day = new Date(2026, 0, 15);
    const digest = generateDigest([{ type: 'diary', title: 'x', content: 'y', created_at: day.toISOString() }], day);
    expect(digest).toContain('15 January 2026');
  });
});
