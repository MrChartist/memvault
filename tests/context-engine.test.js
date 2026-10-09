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

describe('Context Engine - detectProject (projects are the user\'s own)', () => {
  const projects = [
    { name: 'Garden Shed', match: ['shed', 'garden build'], tags: 'garden,diy' },
    { name: 'Thesis', match: ['dissertation'] },
  ];

  it('matches a configured project and returns its tags', () => {
    expect(detectProject('Bought timber for the shed today.', projects)).toEqual({ name: 'Garden Shed', tags: 'garden,diy' });
  });

  it('derives tags from the name when none are given', () => {
    expect(detectProject('Wrote the dissertation intro', projects)).toEqual({ name: 'Thesis', tags: 'thesis' });
  });

  it('matches whole words only, case-insensitively', () => {
    expect(detectProject('SHED plans', projects)?.name).toBe('Garden Shed');
    expect(detectProject('She shedded some pounds', projects)).toBeNull();
  });

  it('assumes NO projects by default — nothing is tagged for someone who configured none', () => {
    for (const t of ['working on the vault', 'tweet about it', 'Investology launch', 'tradebook export']) {
      expect(detectProject(t, [])).toBeNull();
      expect(detectProject(t)).toBeNull();
    }
  });

  it('works with non-English text', () => {
    expect(detectProject('काम चल रहा है: बगीचा परियोजना', [{ name: 'Garden', match: ['बगीचा'] }])?.name).toBe('Garden');
  });
});

describe('Context Engine - autoTag is not fooled by everyday words', () => {
  it('does not tag "rest", "go", "session" or "issue" as code topics', () => {
    expect(autoTag('I need some rest, let\'s go, one session, no issue')).toEqual([]);
  });
  it('tags everyday topics for people who are not developers', () => {
    const tags = autoTag('Exam revision plan for the week, and an essay draft to finish');
    expect(tags).toEqual(expect.arrayContaining(['learning', 'planning', 'writing']));
  });
  it('still tags developer topics', () => {
    expect(autoTag('debugging a crash in the react app')).toEqual(expect.arrayContaining(['bugfix', 'react']));
  });
  it('tags money topics for any market', () => {
    expect(autoTag('review my stocks and the NASDAQ ETF')).toContain('trading');
    expect(autoTag('monthly budget and savings')).toContain('finance');
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

describe('Context Engine - scoreRelevance with regex characters in the query', () => {
  const entry = { title: 'notes', content: 'c++ templates and price [action] notes', tags: '' };

  it('does not throw on queries containing regex metacharacters', () => {
    for (const q of ['C++ templates', 'price [action', 'nifty (breakout', 'a.b*c?', '\\d+']) {
      expect(() => scoreRelevance(entry, q)).not.toThrow();
    }
  });

  it('still counts a literal "c++" occurrence', () => {
    expect(scoreRelevance(entry, 'c++ templates')).toBeGreaterThan(0);
  });
});
