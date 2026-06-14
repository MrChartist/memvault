import { describe, it, expect } from 'vitest';
import { connectBridge, enabledBridges } from '../mcp-bridge.mjs';

describe('mcp-bridge — config', () => {
  it('exposes enabledBridges as an array (none configured by default)', () => {
    expect(Array.isArray(enabledBridges())).toBe(true);
  });
});

describe('mcp-bridge — guards', () => {
  it('rejects a bridge with no command', async () => {
    await expect(connectBridge({ name: 'broken' })).rejects.toThrow(/command/i);
  });
});
