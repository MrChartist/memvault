import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// The product page in site/ is uploaded as a folder (MrChartist.com) and published by
// .github/workflows/pages.yml (GitHub Pages). These checks keep it whole and honest.
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const site = path.join(root, 'site');
const html = fs.readFileSync(path.join(site, 'index.html'), 'utf8');
const attrs = (name) => [...html.matchAll(new RegExp(`\\s${name}="([^"]*)"`, 'g'))].map((m) => m[1]);
const same = (a, b) => fs.readFileSync(path.join(root, a)).equals(fs.readFileSync(path.join(root, b)));

describe('product page (site/)', () => {
  it('every file the page loads is in the folder, so it works when uploaded anywhere', () => {
    const local = [...attrs('src'), ...attrs('href'), ...[...html.matchAll(/url\("([^"]+)"\)/g)].map((m) => m[1])]
      .filter((u) => !/^(https?:|mailto:|#)/.test(u));
    expect(local.length).toBeGreaterThan(5);
    for (const u of local) expect(fs.existsSync(path.join(site, u)), u).toBe(true);
  });

  it('loads nothing from other websites (links to them are fine)', () => {
    expect(attrs('src').filter((u) => /^(https?:)?\/\//.test(u))).toEqual([]);
    const linkTags = [...html.matchAll(/<link\b[^>]*>/g)].map((m) => m[0]);
    for (const tag of linkTags) expect(tag, tag).not.toMatch(/href="(https?:)?\/\//);
    expect(html).not.toMatch(/url\("?(https?:)?\/\//);
    expect(html).not.toMatch(/googletagmanager|google-analytics|gtag\(|fonts\.googleapis/);
  });

  it('every link inside the page goes somewhere', () => {
    const ids = new Set(attrs('id'));
    for (const h of attrs('href').filter((u) => u.startsWith('#'))) expect(ids.has(h.slice(1)), h).toBe(true);
  });

  it('every image says what it shows, or is marked as decoration', () => {
    for (const tag of html.match(/<img\b[^>]*>/g)) expect(tag, tag).toMatch(/\salt="/);
  });

  it('uses the official logo and fonts unchanged', () => {
    for (const f of ['logo-horizontal-black.svg', 'logo-horizontal-white.svg', 'mrchartist-symbol.svg']) {
      expect(same(`site/assets/brand/${f}`, `public/brand/${f}`), f).toBe(true);
    }
    for (const f of fs.readdirSync(path.join(root, 'public/brand/fonts'))) {
      expect(same(`site/assets/fonts/${f}`, `public/brand/fonts/${f}`), f).toBe(true);
    }
  });

  it('shows the same screenshots as the README', () => {
    for (const f of fs.readdirSync(path.join(root, 'docs/images'))) {
      if (fs.existsSync(path.join(site, 'assets/img', f))) expect(same(`site/assets/img/${f}`, `docs/images/${f}`), f).toBe(true);
    }
  });

  it('describes MemVault the same way as package.json', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    expect(html).toContain(`"softwareVersion": "${pkg.version}"`);
    // The page tells people which Node.js they need; keep it in step with "engines".
    expect(pkg.engines.node).toBe('>=20');
    expect(html).toContain('Node.js 20 or newer');
  });
});
