#!/usr/bin/env node
/**
 * sync-files.mjs — MemVault Recent File Activity Sync
 * ─────────────────────────────────────────────────────────────────────────────
 * Scans configured directories for recently modified files and logs them
 * to the vault. Captures your file editing patterns and project activity.
 *
 * Usage:
 *   node sync-files.mjs                       (sync default directories)
 *   node sync-files.mjs --path "D:\Projects"  (scan specific directory)
 *   node sync-files.mjs --hours 24            (last 24 hours, default: 48)
 *   node sync-files.mjs --dry-run             (preview, no posts)
 * ─────────────────────────────────────────────────────────────────────────────
 */

import fs from "fs";
import path from "path";
import os from "os";

import { API_URL as API, SYNC_CONFIG } from "./config.mjs";
const argsArr = process.argv.slice(2);
const DRY_RUN = argsArr.includes("--dry-run");

const hoursIdx = argsArr.indexOf("--hours");
const HOURS = hoursIdx !== -1 ? Number(argsArr[hoursIdx + 1]) || 48 : 48;

const pathIdx = argsArr.indexOf("--path");
const CUSTOM_PATH = pathIdx !== -1 ? argsArr[pathIdx + 1] : null;

const HOME = os.homedir();

// Default scan directories
const SCAN_DIRS = CUSTOM_PATH ? [CUSTOM_PATH] : [
  "D:\\AG",
  path.join(HOME, "Desktop"),
  path.join(HOME, "Documents"),
  path.join(HOME, "Downloads"),
];

// File extensions to track
const TRACK_EXTENSIONS = new Set([
  ".js", ".mjs", ".ts", ".tsx", ".jsx",
  ".py", ".java", ".go", ".rs", ".c", ".cpp", ".h",
  ".html", ".css", ".scss", ".less",
  ".json", ".yaml", ".yml", ".toml", ".xml",
  ".md", ".txt", ".csv",
  ".sql", ".sh", ".ps1", ".bat",
  ".env", ".gitignore", ".dockerignore",
  ".pdf", ".docx", ".xlsx", ".pptx",
]);

// Directories to skip
const SKIP_DIRS = new Set([
  "node_modules", ".git", ".next", "dist", "build", ".cache",
  "__pycache__", ".venv", "venv", ".tox", "target",
  "coverage", ".nyc_output", ".turbo",
]);

const MAX_DEPTH = 4;

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

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function scanDirectory(dir, cutoffTime, depth = 0) {
  const results = [];
  if (depth > MAX_DEPTH) return results;

  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
        results.push(...scanDirectory(fullPath, cutoffTime, depth + 1));
        continue;
      }

      if (!entry.isFile()) continue;

      const ext = path.extname(entry.name).toLowerCase();
      if (!TRACK_EXTENSIONS.has(ext)) continue;

      try {
        const stat = fs.statSync(fullPath);
        if (stat.mtimeMs >= cutoffTime) {
          results.push({
            path: fullPath,
            name: entry.name,
            ext,
            size: stat.size,
            modified: stat.mtime,
            dir: path.dirname(fullPath),
          });
        }
      } catch { /* permission denied */ }
    }
  } catch { /* can't read dir */ }

  return results;
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  console.log("╔══════════════════════════════════════╗");
  console.log("║  File Activity → MemVault Sync       ║");
  console.log(`║  Past ${String(HOURS).padEnd(3)} hours | ${DRY_RUN ? "DRY RUN" : "LIVE   "}              ║`);
  console.log("╚══════════════════════════════════════╝\n");

  if (!DRY_RUN) {
    try {
      const h = await fetch(`${API}/health`);
      if (!h.ok) throw new Error();
      console.log("✅ Vault API reachable\n");
    } catch {
      console.error("❌ Vault API not reachable at", API);
      process.exit(1);
    }
  }

  const cutoffTime = Date.now() - (HOURS * 60 * 60 * 1000);
  let allFiles = [];

  for (const dir of SCAN_DIRS) {
    if (!fs.existsSync(dir)) {
      console.log(`  ⚠️  Skipping (not found): ${dir}`);
      continue;
    }
    console.log(`🔍 Scanning: ${dir}`);
    const files = scanDirectory(dir, cutoffTime);
    console.log(`   Found ${files.length} recently modified files`);
    allFiles.push(...files);
  }

  // Sort by modification time, most recent first
  allFiles.sort((a, b) => b.modified - a.modified);

  // Deduplicate by path
  const seen = new Set();
  allFiles = allFiles.filter(f => {
    if (seen.has(f.path)) return false;
    seen.add(f.path);
    return true;
  });

  console.log(`\n📊 Total unique recent files: ${allFiles.length}\n`);

  if (allFiles.length === 0) {
    console.log("No recently modified files found.");
    return;
  }

  // Group files by project directory
  const projects = {};
  for (const file of allFiles) {
    // Use the first 2-3 path segments after the root as project key
    const parts = file.dir.split(path.sep);
    const projectKey = parts.slice(0, 4).join(path.sep);
    if (!projects[projectKey]) projects[projectKey] = [];
    projects[projectKey].push(file);
  }

  let totalSynced = 0;

  // Create one vault entry per project group
  for (const [projectPath, files] of Object.entries(projects)) {
    const projectName = path.basename(projectPath);
    const fileList = files
      .slice(0, 30) // Max 30 files per project
      .map(f => {
        const time = f.modified.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" });
        const date = f.modified.toLocaleDateString("en-IN");
        return `- \`${f.name}\` (${formatBytes(f.size)}) — modified ${date} ${time}`;
      })
      .join("\n");

    const extCounts = {};
    for (const f of files) {
      extCounts[f.ext] = (extCounts[f.ext] || 0) + 1;
    }
    const extSummary = Object.entries(extCounts)
      .sort((a, b) => b[1] - a[1])
      .map(([ext, count]) => `${ext}: ${count}`)
      .join(", ");

    const content = [
      `## Recent File Activity: ${projectName}`,
      ``,
      `**Files changed**: ${files.length}`,
      `**File types**: ${extSummary}`,
      `**Path**: ${projectPath}`,
      ``,
      `### Modified Files`,
      fileList,
    ].join("\n");

    const synced = await postToVault({
      type: "worklog",
      source: "filesystem",
      title: `[Files] ${projectName} — ${files.length} files modified`,
      content,
      tags: `files,activity,${projectName.toLowerCase().replace(/[^a-z0-9]/g, "-")}`,
    });

    if (synced) {
      totalSynced++;
      process.stdout.write(".");
    }
  }

  console.log(`\n\n═══════════════════════════════════════`);
  console.log(`📁 Directories scanned : ${SCAN_DIRS.length}`);
  console.log(`📄 Files found         : ${allFiles.length}`);
  console.log(`📦 Project groups      : ${Object.keys(projects).length}`);
  console.log(`✅ Synced to vault     : ${totalSynced}`);
  console.log(`═══════════════════════════════════════\n`);
}

main().catch(console.error);
