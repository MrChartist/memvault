#!/usr/bin/env node
/**
 * sync-git.mjs — MemVault Git Commit Sync
 * ─────────────────────────────────────────────────────────────────────────────
 * Scans Git repositories and imports commit history into the vault.
 * Re-running is safe: commits already in the vault are skipped.
 *
 * Usage:
 *   node sync-git.mjs                    (scan the "sync.gitDirs" from your config)
 *   node sync-git.mjs --dry-run          (preview, nothing is saved)
 *   node sync-git.mjs --path ~/code      (scan a specific directory)
 *   node sync-git.mjs --days 30          (last 30 days, default: 14)
 * ─────────────────────────────────────────────────────────────────────────────
 */

import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";
import { SYNC_CONFIG } from "./config.mjs";
import { flagValue, flagNumber, saveEntries, describeResult } from "./sync-lib.mjs";
import { isMainModule } from "./util.mjs";

const MAX_DEPTH = 3; // how deep to look for .git directories
const SKIP_DIRS = new Set([
  "node_modules", "dist", "build", "target", "venv", "__pycache__", "vendor",
  "Library", "AppData", "Applications", "Pictures", "Movies", "Music", "Downloads",
]);

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Find repositories under `rootDir` (a directory containing `.git`). */
export function findGitRepos(rootDir, depth = 0) {
  const repos = [];
  if (depth > MAX_DEPTH) return repos;

  let entries;
  try {
    entries = fs.readdirSync(rootDir, { withFileTypes: true });
  } catch {
    return repos; // permission denied, vanished, ...
  }

  // `.git` is a directory in normal clones and a file in worktrees/submodules.
  if (entries.some((e) => e.name === ".git")) return [rootDir];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;
    repos.push(...findGitRepos(path.join(rootDir, entry.name), depth + 1));
  }
  return repos;
}

const git = (repoPath, args, timeout = 10_000) =>
  execFileSync("git", args, { cwd: repoPath, encoding: "utf8", timeout, stdio: ["ignore", "pipe", "ignore"] });

// ASCII unit/record separators cannot appear in commit text, unlike quotes or newlines.
const FIELD = "\x1f";
const RECORD = "\x1e";
const LOG_FORMAT = ["%H", "%h", "%an", "%aI", "%s", "%b"].join("%x1f") + "%x1e";

/** Parse the output of `git log --format=<LOG_FORMAT>`. */
export function parseGitLog(output) {
  const commits = [];
  for (const record of String(output).split(RECORD)) {
    if (!record.trim()) continue;
    const [hash, short, author, date, subject, body = ""] = record.replace(/^\s+/, "").split(FIELD);
    if (!hash || !subject) continue;
    commits.push({ hash, short, author, date, subject: subject.trim(), body: body.trim() });
  }
  return commits;
}

function getGitCommits(repoPath, days) {
  try {
    return parseGitLog(git(repoPath, ["log", `--since=${days} days ago`, `--format=${LOG_FORMAT}`, "--no-merges"]));
  } catch {
    return []; // empty repo, git missing, timeout...
  }
}

function getRepoName(repoPath) {
  try {
    const remote = git(repoPath, ["remote", "get-url", "origin"], 5000).trim();
    const match = remote.match(/\/([^/]+?)(?:\.git)?$/);
    return match ? match[1] : path.basename(repoPath);
  } catch {
    return path.basename(repoPath);
  }
}

function getRepoBranch(repoPath) {
  try {
    return git(repoPath, ["branch", "--show-current"], 5000).trim() || "detached";
  } catch {
    return "unknown";
  }
}

/** Build a vault entry from a commit. Branch is a tag only, so switching branches never re-imports a commit. */
export function commitToEntry(commit, { repoName, repoPath, branch }) {
  return {
    type: "worklog",
    source: "git",
    title: `[${repoName}] ${commit.subject.slice(0, 100)}`,
    content: [
      `**Commit**: \`${commit.short}\``,
      `**Author**: ${commit.author}`,
      `**Repo**: ${repoName}`,
      `**Path**: ${repoPath}`,
      ``,
      `### Message`,
      commit.subject,
      commit.body ? `\n${commit.body}` : "",
    ].join("\n"),
    tags: `git,commit,${repoName},${branch}`,
    created_at: commit.date,
  };
}

// ─── Main ───────────────────────────────────────────────────────────────────

export async function main(args = process.argv.slice(2)) {
  const dryRun = args.includes("--dry-run");
  const days = flagNumber(args, "--days", 14);
  const explicitRoot = flagValue(args, "--path") || process.env.GIT_SCAN_ROOT;
  const roots = explicitRoot ? [explicitRoot] : SYNC_CONFIG.gitDirs;

  console.log(`🔍 Git sync — last ${days} days${dryRun ? " (dry run)" : ""}`);

  const repos = [];
  for (const root of roots) {
    if (!fs.existsSync(root)) {
      console.log(`  ⚠️  Not found: ${root}`);
      continue;
    }
    console.log(`  Scanning: ${root}`);
    repos.push(...findGitRepos(root));
  }
  console.log(`📁 Found ${repos.length} repositories\n`);

  const entries = [];
  for (const repoPath of [...new Set(repos)]) {
    const commits = getGitCommits(repoPath, days);
    if (commits.length === 0) continue;

    const repoName = getRepoName(repoPath);
    const branch = getRepoBranch(repoPath);
    console.log(`  ${repoName} (${branch}) — ${commits.length} commits`);
    for (const c of commits) entries.push(commitToEntry(c, { repoName, repoPath, branch }));
  }

  const result = saveEntries(entries, { dryRun });
  console.log(`\n✅ ${entries.length} commits found — ${describeResult(result)}\n`);
  return result;
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error(`❌ ${e.message}`);
    process.exit(1);
  });
}
