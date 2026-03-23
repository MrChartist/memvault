import { describe, it, expect } from 'vitest';
import { autoTag, detectProject, scoreRelevance } from '../context-engine.mjs';

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
    const tags = autoTag(text);
    expect(tags).toContain('python');
  });

  it('should return empty array for unrelated content', () => {
    const text = 'Just had lunch, it was good.';
    const tags = autoTag(text);
    expect(tags.length).toBe(0);
  });
});

describe('Context Engine - detectProject', () => {
  it('should extract exact project tags', () => {
    const text = 'Working on the Investology project today.';
    const project = detectProject(text);
    expect(project).toEqual({ name: 'Investology', tags: 'investology,trading' });
  });

  it('should return null if no project info is available', () => {
    const project = detectProject('generic text learning react');
    expect(project).toBeNull();
  });
});

describe('Context Engine - scoreRelevance', () => {
  it('should score high for title exact match', () => {
    const currentEntry = { title: 'Fix auth bug', content: 'logging in', tags: 'auth,bug' };
    const query = "fix auth bug";
    const score = scoreRelevance(currentEntry, query);
    expect(score).toBeGreaterThan(50);
  });

  it('should score lower for partial match', () => {
    const currentEntry = { title: 'Some other thing', content: 'logging in', tags: 'frontend' };
    const query = "auth bug";
    const score = scoreRelevance(currentEntry, query);
    expect(score).toBeLessThan(40);
  });
});
