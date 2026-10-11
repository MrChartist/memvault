#!/usr/bin/env node
/**
 * sync-git.mjs — MemVault Git Commit Sync
 * ─────────────────────────────────────────────────────────────────────────────
 * Scans Git repositories and imports commit history into the vault.
 *
 * Usage:
 *   node sync-git.mjs                    (sync all configured repos)
 *   node sync-git.mjs --dry-run          (preview, no posts)
 *   node sync-git.mjs --path ~/code      (scan specific directory)
 *   node sync-git.mjs --days 30          (last 30 days, default: 14)
 * ─────────────────────────────────────────────────────────────────────────────
 */

import fs from "fs";
import path from "path";
import os from "os";
import { execSync } from "child_process";
import { SYNC_CONFIG } from "./config.mjs";
import { resolveUserPath } from "./paths.mjs";
import { createIngestQueue, clipText } from "./ingest.mjs";
import { getVaultDb } from "./db.mjs";
import { readCommits } from "./git-log.mjs";
import { requireEnabled } from "./sync-guard.mjs";
requireEnabled("gitEnabled", "Saving git commits");

const queue = createIngestQueue({ actor: "git" });

const titleOf = (repoName, c) => `[${repoName}] ${clipText(c.subject, 100)}`;
// Each commit is saved with its hash ("commit:<hash>" in file_path), compared as stored, i.e. masked like everything else.
const markOf = (c) => (c.hash ? clipText(`commit:${c.hash}`, 200) : null);
// git prints "+05:30", the vault stores "...Z": compare the same instant, not the same text.
const isoOf = (v) => { const t = Date.parse(String(v)); return Number.isFinite(t) ? new Date(t).toISOString() : String(v); };
// Commits already in the vault are skipped, so running this again (or on another branch) does not add them twice.
const alreadyStored = new Set();
const storedWithoutMark = new Set(); // saved by an older version, which kept no hash: matched by date + title
if (!process.argv.includes("--dry-run")) {
  for (const r of getVaultDb().query("SELECT title, created_at, file_path FROM items WHERE source = 'git'")) {
    if (String(r.file_path ?? "").startsWith("commit:")) alreadyStored.add(r.file_path);
    else storedWithoutMark.add(`${isoOf(r.created_at)}|${r.title}`);
  }
}
const isStored = (repoName, c) => alreadyStored.has(markOf(c)) || storedWithoutMark.has(`${isoOf(c.date)}|${titleOf(repoName, c)}`);

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");

// Parse --days N
const daysIdx = args.indexOf("--days");
const DAYS = daysIdx !== -1 ? Number(args[daysIdx + 1]) || 14 : 14;

// Parse --path "..." (otherwise every folder in gitDirs is scanned)
const pathIdx = args.indexOf("--path");
const SCAN_ROOTS = pathIdx !== -1 ? [resolveUserPath(args[pathIdx + 1])] : (process.env.GIT_SCAN_ROOT ? [resolveUserPath(process.env.GIT_SCAN_ROOT)] : (SYNC_CONFIG.gitDirs?.length ? SYNC_CONFIG.gitDirs : [os.homedir()]));

// Max depth to search for .git directories
const MAX_DEPTH = 3;

// ─── Helpers ────────────────────────────────────────────────────────────────

async function postToVault(entry) {
  if (DRY_RUN) {
    console.log(`  [DRY] ${entry.title}`);
    return true;
  }
  queue.add(entry);
  return true;
}

function findGitRepos(rootDir, depth = 0) {
  const repos = [];
  if (depth > MAX_DEPTH) return repos;

  try {
    const entries = fs.readdirSync(rootDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const full = path.join(rootDir, entry.name);

      if (entry.name === ".git") {
        repos.push(rootDir);
        return repos; // Don't recurse into .git
      }

      if (entry.name === "node_modules" || entry.name === ".next" || entry.name === "dist") continue;

      repos.push(...findGitRepos(full, depth + 1));
    }
  } catch { /* permission denied or similar */ }

  return repos;
}

function getRepoName(repoPath) {
  try {
    const remote = execSync("git remote get-url origin", {
      cwd: repoPath,
      encoding: "utf8",
      timeout: 5000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();

    // Extract repo name from URL
    const match = remote.match(/\/([^/]+?)(?:\.git)?$/);
    return match ? match[1] : path.basename(repoPath);
  } catch {
    return path.basename(repoPath);
  }
}

function getRepoBranch(repoPath) {
  try {
    return execSync("git branch --show-current", {
      cwd: repoPath,
      encoding: "utf8",
      timeout: 5000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim() || "unknown";
  } catch {
    return "unknown";
  }
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  console.log("╔══════════════════════════════════════╗");
  console.log("║  Git → MemVault Sync                 ║");
  console.log(`║  Scanning: ${(SCAN_ROOTS.length === 1 ? SCAN_ROOTS[0] : `${SCAN_ROOTS.length} folders`).slice(0, 24).padEnd(24)}║`);
  console.log(`║  Past ${String(DAYS).padEnd(3)} days | ${DRY_RUN ? "DRY RUN" : "LIVE   "}              ║`);
  console.log("╚══════════════════════════════════════╝\n");

// Find repos (one found from two listed folders is read once)
  const repos = [];
  const seenRepos = new Set();
  for (const root of SCAN_ROOTS) {
    console.log(`🔍 Scanning for Git repos in: ${root}`);
    for (const repo of findGitRepos(root)) {
      let key = path.resolve(repo);
      try { key = fs.realpathSync(repo); } catch { /* keep the resolved path */ }
      if (!seenRepos.has(key)) { seenRepos.add(key); repos.push(repo); }
    }
  }
  console.log(`📁 Found ${repos.length} repositories\n`);

  let totalSynced = 0;
  let totalCommits = 0;

  for (const repoPath of repos) {
    const repoName = getRepoName(repoPath);
    const branch = getRepoBranch(repoPath);
    const commits = readCommits(repoPath, DAYS).filter((c) => !isStored(repoName, c));

    if (commits.length === 0) continue;

    totalCommits += commits.length;
    console.log(`\n── ${repoName} (${branch}) — ${commits.length} commits ──`);

    for (const commit of commits) {
      // The text is part of a commit's id in the vault (db.mjs), so the branch checked out right now and the
      // folder stay out of it; the branch is in the tags.
      const content = [
        `**Commit**: \`${commit.short}\``,
        `**Author**: ${commit.author} <${commit.email}>`,
        `**Repo**: ${repoName}`,
        ``,
        `### Message`,
        commit.subject,
        commit.body ? `\n${commit.body.trim()}` : "",
      ].join("\n");

      const synced = await postToVault({
        type: "worklog",
        source: "git",
        title: titleOf(repoName, commit),
        content,
        file_path: commit.hash ? `commit:${commit.hash}` : undefined,
        tags: `git,commit,${repoName},${branch}`,
        created_at: commit.date,
      });
      if (commit.hash) alreadyStored.add(markOf(commit)); // so a second copy of the same repository does not add it again

      if (synced) {
        totalSynced++;
        process.stdout.write(".");
      } else {
        process.stdout.write("✗");
      }
    }
  }

  queue.done();
  console.log(`\n\n═══════════════════════════════════════`);
  console.log(`📦 Repos scanned    : ${repos.length}`);
  console.log(`📝 Commits found    : ${totalCommits}`);
  console.log(`✅ Synced to vault  : ${totalSynced}`);
  console.log(`═══════════════════════════════════════\n`);
}

main().catch(console.error);
