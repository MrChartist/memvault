import { describe, it, expect } from 'vitest';
import { getAIStatus, isAIEnabled } from '../ai-engine.mjs';

describe('AI Engine Configuration', () => {
  it('should correctly report ai status', () => {
    const status = getAIStatus();
    expect(status).toHaveProperty('enabled');
    expect(status).toHaveProperty('hasApiKey');
    expect(status).toHaveProperty('model');
    expect(status).toHaveProperty('provider', 'gemini');
  });

  it('isAIEnabled should return a boolean', () => {
    const enabled = isAIEnabled();
    expect(typeof enabled).toBe('boolean');
  });
});
