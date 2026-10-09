import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => JSON.parse(fs.readFileSync(path.join(root, f), 'utf8'));
const pkg = read('package.json');
const reg = read('server.json');

describe('package and MCP registry entry agree', () => {
  it('same name, version and registry name', () => {
    expect(reg.version).toBe(pkg.version);
    expect(reg.packages[0].identifier).toBe(pkg.name);
    expect(reg.packages[0].version).toBe(pkg.version);
    expect(reg.name).toBe(pkg.mcpName);
  });

  it('meets the registry limits (description is 100 characters at most)', () => {
    expect(reg.description.length).toBeLessThanOrEqual(100);
    expect(reg.description.length).toBeGreaterThan(0);
  });

  it('starts the MCP server, not the command-line help, when installed from the registry', () => {
    // The registry runs `npx <identifier> <packageArguments>`; the default bin is the CLI.
    expect(reg.packages[0].packageArguments).toEqual([{ type: 'positional', valueHint: 'mcp', value: 'mcp' }]);
    expect(pkg.bin.memvault).toBe('cli.mjs');
  });

  it('ships every file the program needs and none of the tests or private notes', () => {
    const out = execFileSync('npm', ['pack', '--dry-run', '--json'], { cwd: root, encoding: 'utf8', shell: process.platform === 'win32' });
    const files = JSON.parse(out)[0].files.map((f) => f.path);
    for (const must of ['cli.mjs', 'mcp-server.mjs', 'server.mjs', 'git-log.mjs', 'public/index.html', 'public/app.js', 'public/app.css', 'profiles/general/pack.json', 'LICENSE', 'SECURITY.md']) {
      expect(files).toContain(must);
    }
    expect(files.some((f) => f.startsWith('tests/') || f.startsWith('docs/review/') || f.includes('.env') || f.endsWith('.log'))).toBe(false);
  });
});
