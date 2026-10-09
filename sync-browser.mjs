#!/usr/bin/env node
/**
 * sync-browser.mjs — MemVault Browser Activity Sync
 * ─────────────────────────────────────────────────────────────────────────────
 * Reads Chrome & Edge history/bookmarks from Windows paths (via WSL /mnt/c)
 * and syncs them into the Knowledge Vault as searchable entries.
 *
 * Usage:
 *   node sync-browser.mjs           (sync everything)
 *   node sync-browser.mjs --dry-run (preview, no posts)
 *   node sync-browser.mjs --chrome  (Chrome only)
 *   node sync-browser.mjs --edge    (Edge only)
 * ─────────────────────────────────────────────────────────────────────────────
 */

import fs from "fs";
import path from "path";
import os from "os";

import { createIngestQueue } from "./ingest.mjs";

const queue = createIngestQueue({ actor: "browser" });
const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const ONLY_CHROME = args.includes("--chrome");
const ONLY_EDGE = args.includes("--edge");

// Where each browser keeps its profile, per operating system. Only folders that exist are used.
// WIN_USER lets WSL users point at the Windows side (/mnt/c/Users/<name>).
const IS_WSL = process.platform === "linux" && /microsoft/i.test(os.release());

function browserProfiles() {
    const home = os.homedir();
    const found = [];
    const add = (name, userDataDir) => {
        const dir = path.join(userDataDir, "Default");
        found.push({ name, historyPath: path.join(dir, "History"), bookmarksPath: path.join(dir, "Bookmarks") });
    };
    if (process.platform === "win32") {
        const local = process.env.LOCALAPPDATA || path.join(home, "AppData", "Local");
        add("Chrome", path.join(local, "Google", "Chrome", "User Data"));
        add("Edge", path.join(local, "Microsoft", "Edge", "User Data"));
        add("Brave", path.join(local, "BraveSoftware", "Brave-Browser", "User Data"));
    } else if (process.platform === "darwin") {
        const app = path.join(home, "Library", "Application Support");
        add("Chrome", path.join(app, "Google", "Chrome"));
        add("Edge", path.join(app, "Microsoft Edge"));
        add("Brave", path.join(app, "BraveSoftware", "Brave-Browser"));
    } else {
        const cfg = process.env.XDG_CONFIG_HOME || path.join(home, ".config");
        add("Chrome", path.join(cfg, "google-chrome"));
        add("Edge", path.join(cfg, "microsoft-edge"));
        add("Brave", path.join(cfg, "BraveSoftware", "Brave-Browser"));
        add("Chromium", path.join(cfg, "chromium"));
        if (IS_WSL) {
            let users = [];
            try {
                users = process.env.WIN_USER
                    ? [process.env.WIN_USER]
                    : fs.readdirSync("/mnt/c/Users").filter((d) => !["Public", "Default", "Default User", "All Users"].includes(d));
            } catch { /* no Windows drive mounted */ }
            for (const u of users) {
                const local = `/mnt/c/Users/${u}/AppData/Local`;
                add(`Chrome (Windows ${u})`, path.join(local, "Google", "Chrome", "User Data"));
                add(`Edge (Windows ${u})`, path.join(local, "Microsoft", "Edge", "User Data"));
            }
        }
    }
    return found.filter((p) => fs.existsSync(p.historyPath) || fs.existsSync(p.bookmarksPath));
}

const BROWSER_PROFILES = browserProfiles().filter((p) =>
    (!ONLY_CHROME || /^chrome/i.test(p.name)) && (!ONLY_EDGE || /^edge/i.test(p.name)));

// Skip these URL patterns
const SKIP_URLS = [
    /^chrome:/, /^edge:/, /^about:/,
    /^127\.0\./, /^localhost/, /^file:/,
    /^chrome-extension:/,
];

function shouldSkip(url) {
    return SKIP_URLS.some(r => r.test(url));
}

async function postToVault(entry) {
    if (DRY_RUN) {
        console.log(`  [DRY] ${entry.title || entry.content?.slice(0, 60)}`);
        return true;
    }
    queue.add(entry);
    return true;
}

// ─── Chrome/Edge History (SQLite via sql.js) ─────────────────────────────────
// Chrome stores visit time as microseconds since 1601-01-01 (Windows FILETIME)
function chromeTimeToISO(t) {
    const EPOCH_DIFF = 11644473600n * 1000000n;
    const ms = (BigInt(t) - EPOCH_DIFF) / 1000n;
    return new Date(Number(ms)).toISOString();
}

async function syncHistory(profile) {
    const src = profile.historyPath;
    if (!fs.existsSync(src)) {
        console.log(`  ⚠️  ${profile.name} history not found: ${src}`);
        return 0;
    }

    // The browser locks its history file while running, so read a private, short-lived copy.
    const safeName = profile.name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    const tmp = path.join(os.tmpdir(), `memvault_${safeName}_history_${process.pid}_${Date.now()}`);
    fs.copyFileSync(src, tmp);
    try { fs.chmodSync(tmp, 0o600); } catch { /* non-POSIX */ }

    let db;
    try {
        const { default: initSqlJs } = await import("sql.js");
        const SQL = await initSqlJs();
        db = new SQL.Database(fs.readFileSync(tmp));
    } finally {
        fs.rmSync(tmp, { force: true }); // never leave a copy of someone's browsing history behind
    }

    const stmt = db.prepare(`
    SELECT u.url, u.title, u.visit_count, v.visit_time
    FROM urls u
    JOIN visits v ON u.id = v.url
    WHERE u.visit_count >= 2
      AND u.hidden = 0
    ORDER BY v.visit_time DESC
    LIMIT 500
  `);

    const toSync = [];
    const seen = new Set();

    while (stmt.step()) {
        const row = stmt.getAsObject();
        if (shouldSkip(row.url)) continue;
        const dateKey = `${row.url}::${chromeTimeToISO(row.visit_time).slice(0, 10)}`;
        if (seen.has(dateKey)) continue;
        seen.add(dateKey);
        toSync.push(row);
    }
    stmt.free();
    db.close();

    console.log(`  📖 ${profile.name} history: ${toSync.length} entries to sync`);

    let ok = 0;
    for (const row of toSync) {
        const iso = chromeTimeToISO(row.visit_time);
        const synced = await postToVault({
            type: "worklog",
            source: profile.name.toLowerCase(),
            title: row.title || row.url,
            content: `Visited: ${row.url}\nVisit count: ${row.visit_count}`,
            tags: `browser,history,${profile.name.toLowerCase()}`,
            created_at: iso,
        });
        if (synced) { ok++; process.stdout.write("."); }
        else process.stdout.write("✗");
    }
    console.log(`\n  ✅ ${ok}/${toSync.length} synced`);
    return ok;
}

// ─── Bookmarks (JSON file) ───────────────────────────────────────────────────
function extractBookmarks(node, folderPath = "") {
    const results = [];
    if (node.type === "url") {
        results.push({ ...node, folder: folderPath });
    } else if (node.children) {
        const nextFolder = node.name ? `${folderPath}/${node.name}`.replace(/^\//, "") : folderPath;
        for (const child of node.children) {
            results.push(...extractBookmarks(child, nextFolder));
        }
    }
    return results;
}

async function syncBookmarks(profile) {
    const src = profile.bookmarksPath;
    if (!fs.existsSync(src)) {
        console.log(`  ⚠️  ${profile.name} bookmarks not found: ${src}`);
        return 0;
    }

    const raw = JSON.parse(fs.readFileSync(src, "utf8"));
    const roots = Object.values(raw.roots || {});
    const all = roots.flatMap(r => extractBookmarks(r));
    const valid = all.filter(b => b.url && !shouldSkip(b.url));

    console.log(`  🔖 ${profile.name} bookmarks: ${valid.length} entries to sync`);

    let ok = 0;
    for (const bm of valid) {
        const synced = await postToVault({
            type: "conversation",
            source: `${profile.name.toLowerCase()}-bookmarks`,
            title: bm.name || bm.url,
            content: `Bookmarked URL: ${bm.url}\nFolder: ${bm.folder || "Root"}`,
            tags: `browser,bookmark,${profile.name.toLowerCase()},${bm.folder?.split("/")[0] || "root"}`,
            created_at: bm.date_added
                ? chromeTimeToISO(bm.date_added)
                : new Date().toISOString(),
        });
        if (synced) { ok++; process.stdout.write("."); }
        else process.stdout.write("✗");
    }
    console.log(`\n  ✅ ${ok}/${valid.length} synced`);
    return ok;
}

// ─── Main ───────────────────────────────────────────────────────────────────
async function main() {
    console.log("╔════════════════════════════════════════╗");
    console.log("║  Browser → MemVault Sync               ║");
    console.log(`║  Windows User: ${WIN_USER.padEnd(24)}║`);
    console.log(`║  ${DRY_RUN ? "DRY RUN                             " : "LIVE MODE                           "}║`);
    console.log("╚════════════════════════════════════════╝\n");

    if (!BROWSER_PROFILES.length) {
        console.log("No Chrome, Edge, Brave or Chromium profile was found on this computer, so there is nothing to sync.");
        return;
    }
    let totalOk = 0;

    for (const profile of BROWSER_PROFILES) {
        console.log(`\n── ${profile.name} ────────────────────────`);
        console.log("  History:");
        totalOk += await syncHistory(profile);
        console.log("  Bookmarks:");
        totalOk += await syncBookmarks(profile);
    }

    queue.done();
    console.log(`\n═══════════════════════════════════════`);
    console.log(`✅ Total synced: ${totalOk} entries`);
    console.log(`🌐 Open http://127.0.0.1:7799 to browse`);
    console.log(`═══════════════════════════════════════\n`);
}

main().catch(console.error);
