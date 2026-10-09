/**
 * sync-lib.mjs — helpers shared by the sync engines and the importers
 * ─────────────────────────────────────────────────────────────────────────────
 * Engines write straight into the vault database (see db.mjs), so they work
 * whether or not the web server is running, and re-running them is safe:
 * entries that carry a real timestamp are de-duplicated, "snapshot" entries are
 * replaced in place.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import fs from "fs";
import path from "path";
import os from "os";
import { addItems } from "./db.mjs";

/** Value following `--flag` in argv, or `fallback`. */
export function flagValue(args, flag, fallback = null) {
  const i = args.indexOf(flag);
  return i !== -1 && args[i + 1] !== undefined ? args[i + 1] : fallback;
}

/** Like flagValue but numeric; garbage or non-positive values fall back. */
export function flagNumber(args, flag, fallback) {
  const n = Number(flagValue(args, flag));
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Save entries (in chunks, one database write per chunk).
 * @returns {{inserted:number, duplicates:number}}
 */
export function saveEntries(entries, { dryRun = false, chunkSize = 200 } = {}) {
  if (dryRun) {
    for (const e of entries) console.log(`  [DRY] ${e.title || String(e.content || "").slice(0, 60)}`);
    return { inserted: entries.length, duplicates: 0 };
  }
  let inserted = 0;
  let duplicates = 0;
  for (let i = 0; i < entries.length; i += chunkSize) {
    const r = addItems(entries.slice(i, i + chunkSize));
    inserted += r.inserted;
    duplicates += r.duplicates;
  }
  return { inserted, duplicates };
}

/** Print the usual "N new, M already in the vault" line. */
export function describeResult({ inserted, duplicates }) {
  return `${inserted} new${duplicates ? `, ${duplicates} already in vault` : ""}`;
}

/**
 * Windows user folders visible from WSL (/mnt/c/Users/<name>), so engines that
 * read Windows-side app data work when MemVault runs inside WSL.
 */
export function wslWindowsHomes() {
  if (process.platform !== "linux") return [];
  const root = "/mnt/c/Users";
  try {
    const skip = new Set(["Public", "Default", "Default User", "All Users", "desktop.ini"]);
    return fs
      .readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !skip.has(d.name) && !d.name.startsWith("."))
      .map((d) => path.join(root, d.name));
  } catch {
    return [];
  }
}

/** Candidate home directories to look in: this user's home, plus Windows homes under WSL. */
export function candidateHomes() {
  const homes = [os.homedir()];
  const explicit = process.env.WIN_USER && path.join("/mnt/c/Users", process.env.WIN_USER);
  for (const h of explicit ? [explicit] : wslWindowsHomes()) if (!homes.includes(h)) homes.push(h);
  return homes;
}
