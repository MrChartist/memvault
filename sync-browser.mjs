#!/usr/bin/env node
/**
 * sync-browser.mjs — MemVault Browser Activity Sync   (OFF by default)
 * ─────────────────────────────────────────────────────────────────────────────
 * Reads Chrome / Edge / Brave history and bookmarks and saves them as searchable
 * entries. Browser history is sensitive, so this engine only runs when you turn
 * it on ("sync": { "browserEnabled": true } in ~/.memvaultrc.json) or run it by
 * hand. Only pages visited at least twice are kept; extra domains can be
 * excluded with "sync": { "browserExcludeDomains": ["bank.example", ...] }.
 *
 * Works on Windows, macOS, Linux, and WSL (reads the Windows-side profiles).
 *
 * Usage:
 *   node sync-browser.mjs                (Chrome + Edge + Brave)
 *   node sync-browser.mjs --chrome       (one browser: --chrome | --edge | --brave)
 *   node sync-browser.mjs --dry-run      (preview, nothing is saved)
 *   Env: BROWSER_PROFILE=Default   (Chromium profile folder name)
 * ─────────────────────────────────────────────────────────────────────────────
 */

import fs from "fs";
import os from "os";
import path from "path";
import { SYNC_CONFIG } from "./config.mjs";
import { candidateHomes, saveEntries, describeResult } from "./sync-lib.mjs";
import { isMainModule } from "./util.mjs";

const PROFILE = process.env.BROWSER_PROFILE || "Default";

/** "User Data" folder of each Chromium browser, relative to a home directory, per OS. */
const BROWSERS = {
  chrome: { name: "Chrome", dirs: {
    win32: ["AppData", "Local", "Google", "Chrome", "User Data"],
    darwin: ["Library", "Application Support", "Google", "Chrome"],
    linux: [".config", "google-chrome"],
  } },
  edge: { name: "Edge", dirs: {
    win32: ["AppData", "Local", "Microsoft", "Edge", "User Data"],
    darwin: ["Library", "Application Support", "Microsoft Edge"],
    linux: [".config", "microsoft-edge"],
  } },
  brave: { name: "Brave", dirs: {
    win32: ["AppData", "Local", "BraveSoftware", "Brave-Browser", "User Data"],
    darwin: ["Library", "Application Support", "BraveSoftware", "Brave-Browser"],
    linux: [".config", "BraveSoftware", "Brave-Browser"],
  } },
};

/** Every profile folder we can find for the requested browsers. */
export function findProfiles(which = Object.keys(BROWSERS), homes = candidateHomes()) {
  const found = [];
  for (const key of which) {
    const b = BROWSERS[key];
    for (const home of homes) {
      // Under WSL the Windows-side home holds Windows-layout data.
      const layout = home.startsWith("/mnt/") ? "win32" : process.platform === "win32" ? "win32" : process.platform === "darwin" ? "darwin" : "linux";
      const base = path.join(home, ...b.dirs[layout]);
      const historyPath = path.join(base, PROFILE, "History");
      if (fs.existsSync(historyPath)) {
        found.push({ name: b.name, historyPath, bookmarksPath: path.join(base, PROFILE, "Bookmarks") });
      }
    }
  }
  return found;
}

// Skip internal pages, local dev servers and files (patterns are anchored to the full URL).
const SKIP_URLS = [
  /^(chrome|edge|brave|about|chrome-extension|devtools|file|view-source|data|blob):/i,
  /^https?:\/\/(localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|\[::1\])(?=[:/?#]|$)/i,
];

export function shouldSkip(url, excludeDomains = SYNC_CONFIG.browserExcludeDomains || []) {
  if (!url || SKIP_URLS.some((r) => r.test(url))) return true;
  let host = "";
  try { host = new URL(url).hostname.toLowerCase(); } catch { return false; }
  return excludeDomains.some((d) => host === d.toLowerCase() || host.endsWith(`.${d.toLowerCase()}`));
}

// Chrome stores times as microseconds since 1601-01-01 (Windows FILETIME).
export function chromeTimeToISO(t) {
  const ms = (BigInt(t) - 11644473600n * 1000000n) / 1000n;
  return new Date(Number(ms)).toISOString();
}

async function readHistory(profile) {
  // Chrome locks the live file while it runs, so read a copy.
  const tmp = path.join(os.tmpdir(), `memvault_${profile.name.toLowerCase()}_history_${process.pid}_${Date.now()}`);
  fs.copyFileSync(profile.historyPath, tmp);
  try {
    const { default: initSqlJs } = await import("sql.js");
    const SQL = await initSqlJs();
    const db = new SQL.Database(fs.readFileSync(tmp));
    const stmt = db.prepare(`
      SELECT u.url, u.title, u.visit_count, v.visit_time
      FROM urls u JOIN visits v ON u.id = v.url
      WHERE u.visit_count >= 2 AND u.hidden = 0
      ORDER BY v.visit_time DESC
      LIMIT 500`);
    const rows = [];
    const seen = new Set();
    while (stmt.step()) {
      const row = stmt.getAsObject();
      if (shouldSkip(row.url)) continue;
      const iso = chromeTimeToISO(row.visit_time);
      const key = `${row.url}::${iso.slice(0, 10)}`; // one entry per URL per day
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push({ ...row, iso });
    }
    stmt.free();
    db.close();
    return rows;
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

function extractBookmarks(node, folderPath = "") {
  const out = [];
  if (node.type === "url") {
    out.push({ ...node, folder: folderPath });
  } else if (node.children) {
    const next = node.name ? `${folderPath}/${node.name}`.replace(/^\//, "") : folderPath;
    for (const child of node.children) out.push(...extractBookmarks(child, next));
  }
  return out;
}

function readBookmarks(profile) {
  if (!fs.existsSync(profile.bookmarksPath)) return [];
  const fallback = fs.statSync(profile.bookmarksPath).mtime.toISOString();
  const raw = JSON.parse(fs.readFileSync(profile.bookmarksPath, "utf8"));
  return Object.values(raw.roots || {})
    .filter((r) => r && typeof r === "object")
    .flatMap((r) => extractBookmarks(r))
    .filter((b) => b.url && !shouldSkip(b.url))
    .map((b) => {
      let iso = fallback;
      try { if (b.date_added) iso = chromeTimeToISO(b.date_added); } catch { /* keep fallback */ }
      return { ...b, iso };
    });
}

// ─── Main ───────────────────────────────────────────────────────────────────

export async function main(args = process.argv.slice(2)) {
  const dryRun = args.includes("--dry-run");
  const only = Object.keys(BROWSERS).filter((k) => args.includes(`--${k}`));
  const profiles = findProfiles(only.length ? only : undefined);

  console.log(`🌐 Browser sync${dryRun ? " (dry run)" : ""}`);
  if (profiles.length === 0) {
    console.log(`ℹ️  No Chrome/Edge/Brave profile "${PROFILE}" found on this machine.\n`);
    return { inserted: 0, duplicates: 0 };
  }

  let total = { inserted: 0, duplicates: 0 };
  for (const profile of profiles) {
    const tag = profile.name.toLowerCase();
    const entries = [];

    try {
      const history = await readHistory(profile);
      console.log(`  📖 ${profile.name} history: ${history.length} pages`);
      for (const row of history) {
        entries.push({
          type: "worklog", source: tag,
          title: row.title || row.url,
          content: `Visited: ${row.url}\nVisit count: ${row.visit_count}`,
          tags: `browser,history,${tag}`,
          created_at: row.iso, // real timestamp → de-duplicated on re-run
        });
      }
    } catch (e) {
      console.log(`  ⚠️  ${profile.name} history unreadable: ${e.message}`);
    }

    try {
      const marks = readBookmarks(profile);
      console.log(`  🔖 ${profile.name} bookmarks: ${marks.length}`);
      for (const b of marks) {
        entries.push({
          type: "conversation", source: `${tag}-bookmarks`,
          title: b.name || b.url,
          content: `Bookmarked URL: ${b.url}\nFolder: ${b.folder || "Root"}`,
          tags: `browser,bookmark,${tag},${b.folder?.split("/")[0] || "root"}`,
          created_at: b.iso,
        });
      }
    } catch (e) {
      console.log(`  ⚠️  ${profile.name} bookmarks unreadable: ${e.message}`);
    }

    const r = saveEntries(entries, { dryRun });
    console.log(`  ✅ ${profile.name}: ${describeResult(r)}`);
    total = { inserted: total.inserted + r.inserted, duplicates: total.duplicates + r.duplicates };
  }
  console.log("");
  return total;
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => { console.error(`❌ ${e.message}`); process.exit(1); });
}
