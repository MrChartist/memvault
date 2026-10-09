/**
 * sync-guard.mjs — automatic capture stays OFF until the owner switches it on.
 * Each capture script calls this first. `memvault sync` already only runs the engines that are on,
 * and this makes running a script directly (npm run sync:git, node sync-files.mjs …) behave the same way.
 */
import { SYNC_CONFIG } from "./config.mjs";

export function requireEnabled(flag, what) {
  if (process.argv.includes("--force") || SYNC_CONFIG[flag] === true) return;
  console.log(`${what} is switched off, so nothing was saved. That is the safe default.`);
  console.log("Switch it on in the dashboard (Settings → Automatic saving), or run this script once with --force.");
  process.exit(0);
}
