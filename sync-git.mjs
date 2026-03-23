#!/usr/bin/env node
/**
 * sync-git.mjs — MemVault Git Commit Sync
 * ─────────────────────────────────────────────────────────────────────────────
 * Scans Git repositories and imports commit history into the vault.
 *
 * Usage:
 *   node sync-git.mjs                    (sync all configured repos)
 *   node sync-git.mjs --dry-run          (preview, no posts)
 *   node sync-git.mjs --path "D:\AG"     (scan specific directory)
 *   node sync-git.mjs --days 30          (last 30 days, default: 14)
 * ─────────────────────────────────────────────────────────────────────────────
 */

import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import { API_URL as API, SYNC_CONFIG } from "./config.mjs";

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");

// Parse --days N
const daysIdx = args.indexOf("--days");
const DAYS = daysIdx !== -1 ? Number(args[daysIdx + 1]) || 14 : 14;

// Parse --path "..."
const pathIdx = args.indexOf("--path");
const SCAN_ROOT = pathIdx !== -1 ? args[pathIdx + 1] : (process.env.GIT_SCAN_ROOT || (SYNC_CONFIG.gitDirs && SYNC_CONFIG.gitDirs[0]) || "D:\\AG");

// Max depth to search for .git directories
const MAX_DEPTH = 3;

// ─── Helpers ────────────────────────────────────────────────────────────────

async function postToVault(entry) {
  if (DRY_RUN) {
    console.log(`  [DRY] ${entry.title}`);
    return true;
  }
  try {
    const res = await fetch(`${API}/add`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(entry),
    });
    return (await res.json()).ok;
  } catch { return false; }
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

function getGitCommits(repoPath, days) {
  try {
    const since = `--since="${days} days ago"`;
    const format = '--format={"hash":"%H","short":"%h","author":"%an","email":"%ae","date":"%aI","subject":"%s","body":"%b"}---COMMIT_END---';
    const cmd = `git log ${since} ${format} --no-merges`;

    const output = execSync(cmd, {
      cwd: repoPath,
      encoding: "utf8",
      timeout: 10000,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const commits = [];
    const chunks = output.split("---COMMIT_END---").filter(c => c.trim());

    for (const chunk of chunks) {
      try {
        // Clean the JSON — git body can have newlines
        const cleaned = chunk.trim()
          .replace(/\n/g, " ")
          .replace(/\r/g, "")
          .replace(/\t/g, " ");
        const parsed = JSON.parse(cleaned);
        commits.push(parsed);
      } catch { /* skip malformed */ }
    }

    return commits;
  } catch {
    return [];
  }
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
  console.log(`║  Scanning: ${SCAN_ROOT.slice(0, 24).padEnd(24)}║`);
  console.log(`║  Past ${String(DAYS).padEnd(3)} days | ${DRY_RUN ? "DRY RUN" : "LIVE   "}              ║`);
  console.log("╚══════════════════════════════════════╝\n");

  // Health check
  if (!DRY_RUN) {
    try {
      const h = await fetch(`${API}/health`);
      if (!h.ok) throw new Error();
      console.log("✅ Vault API reachable\n");
    } catch {
      console.error("❌ Vault API not reachable at", API);
      console.error("   Run: node server.mjs");
      process.exit(1);
    }
  }

  // Find repos
  console.log(`🔍 Scanning for Git repos in: ${SCAN_ROOT}`);
  const repos = findGitRepos(SCAN_ROOT);
  console.log(`📁 Found ${repos.length} repositories\n`);

  let totalSynced = 0;
  let totalCommits = 0;

  for (const repoPath of repos) {
    const repoName = getRepoName(repoPath);
    const branch = getRepoBranch(repoPath);
    const commits = getGitCommits(repoPath, DAYS);

    if (commits.length === 0) continue;

    totalCommits += commits.length;
    console.log(`\n── ${repoName} (${branch}) — ${commits.length} commits ──`);

    for (const commit of commits) {
      const content = [
        `**Commit**: \`${commit.short}\``,
        `**Author**: ${commit.author} <${commit.email}>`,
        `**Branch**: ${branch}`,
        `**Repo**: ${repoName}`,
        `**Path**: ${repoPath}`,
        ``,
        `### Message`,
        commit.subject,
        commit.body ? `\n${commit.body.trim()}` : "",
      ].join("\n");

      const synced = await postToVault({
        type: "worklog",
        source: "git",
        title: `[${repoName}] ${commit.subject.slice(0, 100)}`,
        content,
        tags: `git,commit,${repoName},${branch}`,
        created_at: commit.date,
      });

      if (synced) {
        totalSynced++;
        process.stdout.write(".");
      } else {
        process.stdout.write("✗");
      }
    }
  }

  console.log(`\n\n═══════════════════════════════════════`);
  console.log(`📦 Repos scanned    : ${repos.length}`);
  console.log(`📝 Commits found    : ${totalCommits}`);
  console.log(`✅ Synced to vault  : ${totalSynced}`);
  console.log(`═══════════════════════════════════════\n`);
}

main().catch(console.error);
