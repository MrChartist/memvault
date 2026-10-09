/**
 * util.mjs — small helpers shared by the CLI scripts and servers.
 */

import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

/**
 * True when the module at `metaUrl` is the script Node was started with.
 *
 * `import.meta.url === \`file://${process.argv[1]}\`` is NOT portable: it breaks
 * on Windows (backslashes, drive letters), on paths containing spaces, and when
 * the script is launched through an npm/npx bin symlink. Comparing real paths
 * works everywhere.
 */
export function isMainModule(metaUrl) {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(metaUrl));
  } catch {
    return false;
  }
}

/**
 * Expand a leading "~" to the home folder (and nothing else). Shells do this for
 * you, but JSON config files, MCP client "env" blocks and Windows cmd do not — a
 * literal "~/x" would otherwise become a folder called "~" inside the current directory.
 */
export function expandTilde(p, home = os.homedir()) {
  if (typeof p !== "string" || !p.trim()) return p;
  const out = p.trim();
  if (out === "~") return home;
  if (/^~[\\/]/.test(out)) return path.join(home, out.slice(2));
  return out;
}

/**
 * A path from a CONFIG FILE → absolute. "~" is expanded and a relative path is taken
 * relative to the user's home folder (config files have no meaningful working directory).
 */
export function expandHome(p, home = os.homedir()) {
  const out = expandTilde(p, home);
  if (typeof out !== "string" || !out) return out;
  return path.isAbsolute(out) ? path.normalize(out) : path.resolve(home, out);
}

/**
 * A path typed on the COMMAND LINE or set in an environment variable → absolute.
 * "~" is expanded and a relative path is relative to the current directory, like any CLI tool.
 */
export function resolveUserPath(p, home = os.homedir()) {
  const out = expandTilde(p, home);
  return typeof out === "string" && out ? path.resolve(out) : out;
}

/** Version from this package's package.json (single source of truth). */
export function getVersion() {
  try {
    return JSON.parse(fs.readFileSync(new URL("./package.json", import.meta.url), "utf8")).version;
  } catch {
    return "0.0.0";
  }
}

/** Local calendar date as YYYY-MM-DD. */
export function isoDate(d = new Date()) {
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}

/**
 * ISO-timestamp bounds of a LOCAL calendar day. Entries are stored as UTC ISO
 * strings, so "today" must be converted from the user's own midnight.
 * @param {string} dateStr YYYY-MM-DD (default: today)
 */
export function dayRange(dateStr = isoDate()) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const start = new Date(y, m - 1, d);
  const end = new Date(y, m - 1, d + 1);
  return { start: start.toISOString(), end: end.toISOString(), date: start };
}

/** Escape LIKE wildcards so user text is matched literally (use with ESCAPE '\\'). */
export function likeEscape(s) {
  return String(s).replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** Escape a string for safe use inside a RegExp. */
export function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Clamp a possibly-garbage value to an integer in [min, max]. */
export function clampInt(value, min, max, fallback) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}
