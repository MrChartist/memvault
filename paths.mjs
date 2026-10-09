/**
 * paths.mjs — turning user-typed paths into real ones
 * ─────────────────────────────────────────────────────────────────────────────
 * Shells expand "~", but JSON config files, MCP-client "env" blocks and Windows
 * cmd do not. A literal "~/x" would become a folder called "~" inside whatever
 * the current directory happens to be — so different programs (the MCP client,
 * `serve`, a scheduled sync) could end up using different vaults, and a Google
 * Drive "backup" would be written locally and never reach Drive.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import os from "os";
import path from "path";

/** Expand a leading "~" to the home folder — and nothing else. */
export function expandTilde(p, home = os.homedir()) {
  if (typeof p !== "string" || !p.trim()) return p;
  const out = p.trim();
  if (out === "~") return home;
  if (/^~[\\/]/.test(out)) return path.join(home, out.slice(2));
  return out;
}

/**
 * A path from a CONFIG FILE → absolute. "~" is expanded; a relative path is taken
 * relative to the user's home folder (a config file has no meaningful cwd).
 */
export function expandHome(p, home = os.homedir()) {
  const out = expandTilde(p, home);
  if (typeof out !== "string" || !out) return out;
  return path.isAbsolute(out) ? path.normalize(out) : path.resolve(home, out);
}

/**
 * A path typed on the COMMAND LINE, in an environment variable or in the setup
 * wizard → absolute. "~" is expanded; a relative path is relative to the current
 * directory, like any command-line tool.
 */
export function resolveUserPath(p, home = os.homedir()) {
  const out = expandTilde(p, home);
  return typeof out === "string" && out ? path.resolve(out) : out;
}
