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

describe('bridge command line', () => {
  it('runs from a folder whose name has spaces and non-Latin letters (it used to print nothing)', async () => {
    const fs = await import('fs');
    const os = await import('os');
    const path = await import('path');
    const { spawnSync } = await import('child_process');
    const here = path.dirname(new URL(import.meta.url).pathname);
    const src = path.join(here, '..');
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'memvault bridge-'));
    const dir = path.join(base, 'Rohit Singh', 'मेमवॉल्ट');
    fs.mkdirSync(dir, { recursive: true });
    for (const f of fs.readdirSync(src).filter((x) => x.endsWith('.mjs') || x === 'package.json')) fs.copyFileSync(path.join(src, f), path.join(dir, f));
    fs.symlinkSync(path.join(src, 'node_modules'), path.join(dir, 'node_modules'), 'junction');
    try {
      const r = spawnSync(process.execPath, [path.join(dir, 'mcp-bridge.mjs'), 'presets'], {
        encoding: 'utf8', env: { ...process.env, HOME: base, USERPROFILE: base, VAULT_ROOT: path.join(base, 'v') },
      });
      expect(r.stdout).toMatch(/Preset AI memory servers/);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
});
