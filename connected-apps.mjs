/**
 * Which AI apps have connected to MemVault on this computer, for the Getting started list and `memvault doctor`.
 *
 * The MCP server writes one small file per app in ~/.memvault/apps/ when an app connects. It holds only what the
 * app says about itself (its name and version), the agent the connection is tied to, and when. Nothing from your
 * memory, and it never leaves this computer.
 */

import fs from "fs";
import path from "path";
import { TOKEN_FILE } from "./config.mjs";

const appsDir = (dir) => path.join(dir, "apps");
const MAX_APPS = 50;

// The names apps report about themselves are not documented everywhere, so these are best guesses;
// any other app is shown with the name it gives.
const KNOWN = {
  "claude-ai": "Claude Desktop",
  "claude-code": "Claude Code",
  "cursor-vscode": "Cursor",
  "visual studio code": "VS Code",
  "antigravity": "Antigravity",
  "windsurf-client": "Windsurf",
  "cline": "Cline",
  "roo-code": "Roo Code",
};

/** One line of plain text, at most `max` characters (an app can call itself anything). */
const clean = (v, max) => String(v ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);

export const appLabel = (name) => KNOWN[clean(name, 80).toLowerCase()] || clean(name, 80) || "An AI app";

const slug = (name, agent) =>
  `${clean(name, 80).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "app"}${agent ? `--${agent}` : ""}`;

/** Note that an app connected. Never throws: a full disk must not stop the app from using MemVault. */
export function recordApp({ name, version, agent = null, dir = path.dirname(TOKEN_FILE), now = new Date() } = {}) {
  try {
    const folder = appsDir(dir);
    fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
    const file = path.join(folder, `${slug(name, agent)}.json`);
    let first = now.toISOString();
    try { first = JSON.parse(fs.readFileSync(file, "utf8")).first_seen || first; } catch { /* first time */ }
    const rec = { name: clean(name, 80) || null, version: clean(version, 40) || null, agent: agent || null, first_seen: first, last_seen: now.toISOString() };
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(rec, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
    return rec;
  } catch {
    return null;
  }
}

/** The apps that have connected, the most recent first. */
export function listApps({ dir = path.dirname(TOKEN_FILE) } = {}) {
  let names = [];
  try { names = fs.readdirSync(appsDir(dir)).filter((n) => n.endsWith(".json")).slice(0, MAX_APPS); } catch { return []; }
  return names
    .flatMap((n) => {
      try {
        const r = JSON.parse(fs.readFileSync(path.join(appsDir(dir), n), "utf8"));
        return [{ name: clean(r.name, 80), label: appLabel(r.name), version: clean(r.version, 40), agent: r.agent ? clean(r.agent, 40) : null, first_seen: r.first_seen, last_seen: r.last_seen }];
      } catch { return []; }
    })
    .sort((a, b) => String(b.last_seen).localeCompare(String(a.last_seen)));
}
