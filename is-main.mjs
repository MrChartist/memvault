/**
 * is-main.mjs — "was this file started directly?" for scripts that are also imported as modules.
 * Compares real file paths. Building a file:// URL by hand and comparing strings fails for folders with
 * spaces or non-Latin letters (URL-encoded) and for symbolic links (npm bin links, Homebrew, nvm),
 * which made a command silently do nothing.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

export function isMain(metaUrl, argv1 = process.argv[1]) {
  if (!argv1) return false;
  try {
    return fs.realpathSync(fileURLToPath(metaUrl)) === fs.realpathSync(path.resolve(argv1));
  } catch {
    return false;
  }
}
