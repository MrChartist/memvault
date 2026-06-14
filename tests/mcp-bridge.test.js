import { describe, it, expect } from 'vitest';
import { connectBridge, enabledBridges, PRESET_BRIDGES } from '../mcp-bridge.mjs';

describe('mcp-bridge — config', () => {
  it('exposes enabledBridges as an array (none configured by default)', () => {
    expect(Array.isArray(enabledBridges())).toBe(true);
  });
});

describe('mcp-bridge — presets', () => {
  it('ships at least two preset memory servers', () => {
    expect(PRESET_BRIDGES.length).toBeGreaterThanOrEqual(2);
  });

  it('each preset has the fields needed to connect and sync', () => {
    for (const p of PRESET_BRIDGES) {
      expect(typeof p.name).toBe('string');
      expect(p.command).toBeTruthy();
      expect(Array.isArray(p.args)).toBe(true);
      expect(typeof p.description).toBe('string');
    }
  });

  it('includes the official knowledge-graph memory server', () => {
    const memory = PRESET_BRIDGES.find((p) => p.name === 'memory');
    expect(memory).toBeTruthy();
    expect(memory.args.join(' ')).toContain('@modelcontextprotocol/server-memory');
  });
});

describe('mcp-bridge — guards', () => {
  it('rejects a bridge with no command', async () => {
    await expect(connectBridge({ name: 'broken' })).rejects.toThrow(/command/i);
  });
});
