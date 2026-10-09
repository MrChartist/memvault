#!/usr/bin/env node
/**
 * sync-files.mjs — MemVault Recent File Activity Sync
 * ─────────────────────────────────────────────────────────────────────────────
 * Scans configured directories for recently modified files and saves one
 * snapshot per project folder (file NAMES, sizes and dates only — never file
 * contents). Each run replaces the previous snapshot of a project.
 *
 * Directories come from "sync.filesDirs" in ~/.memvaultrc.json
 * (default: ~/Documents and ~/Desktop).
 *
 * Usage:
 *   node sync-files.mjs                    (scan the configured directories)
 *   node sync-files.mjs --path ~/projects  (scan a specific directory)
 *   node sync-files.mjs --hours 24         (last 24 hours, default: 48)
 *   node sync-files.mjs --dry-run          (preview, nothing is saved)
 * ─────────────────────────────────────────────────────────────────────────────
 */

import fs from "fs";
import path from "path";
import { SYNC_CONFIG } from "./config.mjs";
import { flagValue, flagNumber, saveEntries, describeResult } from "./sync-lib.mjs";
import { isMainModule, resolveUserPath } from "./util.mjs";

// File extensions to track
const TRACK_EXTENSIONS = new Set([
  ".js", ".mjs", ".ts", ".tsx", ".jsx",
  ".py", ".java", ".go", ".rs", ".c", ".cpp", ".h",
  ".html", ".css", ".scss", ".less",
  ".json", ".yaml", ".yml", ".toml", ".xml",
  ".md", ".txt", ".csv",
  ".sql", ".sh", ".ps1", ".bat",
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

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function scanDirectory(dir, cutoffTime, depth = 0) {
  const results = [];
  if (depth > MAX_DEPTH) return results;

  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return results;
  }

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
        results.push({ path: fullPath, name: entry.name, ext, size: stat.size, modified: stat.mtime, dir });
      }
    } catch { /* permission denied */ }
  }
  return results;
}

// ─── Main ───────────────────────────────────────────────────────────────────

export async function main(args = process.argv.slice(2)) {
  const dryRun = args.includes("--dry-run");
  const hours = flagNumber(args, "--hours", 48);
  const custom = flagValue(args, "--path");
  const scanDirs = (custom ? [resolveUserPath(custom)] : SYNC_CONFIG.filesDirs).map((d) => path.resolve(d));

  console.log(`📁 File activity — last ${hours} hours${dryRun ? " (dry run)" : ""}`);

  const cutoff = Date.now() - hours * 3_600_000;
  const byPath = new Map();
  for (const dir of scanDirs) {
    if (!fs.existsSync(dir)) {
      console.log(`  ⚠️  Skipping (not found): ${dir}`);
      continue;
    }
    const files = scanDirectory(dir, cutoff);
    console.log(`  ${dir}: ${files.length} recently modified files`);
    for (const f of files) byPath.set(f.path, f);
  }
  const allFiles = [...byPath.values()].sort((a, b) => b.modified - a.modified);

  if (allFiles.length === 0) {
    console.log("No recently modified files found.\n");
    return { inserted: 0, duplicates: 0 };
  }

  // Group by project folder: the first directory level under each scan root.
  const projects = new Map();
  for (const file of allFiles) {
    const root = scanDirs.find((r) => file.path.startsWith(r + path.sep)) || path.dirname(file.path);
    const rel = path.relative(root, file.path).split(path.sep);
    const key = rel.length > 1 ? path.join(root, rel[0]) : root;
    if (!projects.has(key)) projects.set(key, []);
    projects.get(key).push(file);
  }

  const entries = [];
  for (const [projectPath, files] of projects) {
    const projectName = path.basename(projectPath) || projectPath;
    const fileList = files.slice(0, 30).map((f) => {
      const when = `${f.modified.toLocaleDateString("en-IN")} ${f.modified.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })}`;
      return `- \`${path.relative(projectPath, f.path) || f.name}\` (${formatBytes(f.size)}) — modified ${when}`;
    }).join("\n");

    const extCounts = {};
    for (const f of files) extCounts[f.ext] = (extCounts[f.ext] || 0) + 1;
    const extSummary = Object.entries(extCounts).sort((a, b) => b[1] - a[1]).map(([e, n]) => `${e}: ${n}`).join(", ");

    entries.push({
      type: "worklog",
      source: "filesystem",
      upsert: true, // each run replaces the previous snapshot of THIS folder (file_path tells same-named folders apart)
      title: `[Files] ${projectName}`,
      file_path: projectPath,
      content: [
        `## Recent File Activity: ${projectName}`,
        ``,
        `**Files changed (last ${hours}h)**: ${files.length}`,
        `**File types**: ${extSummary}`,
        `**Path**: ${projectPath}`,
        ``,
        `### Modified Files`,
        fileList,
      ].join("\n"),
      tags: `files,activity,${projectName.toLowerCase().replace(/[^a-z0-9]/g, "-")}`,
    });
  }

  const result = saveEntries(entries, { dryRun });
  console.log(`\n✅ ${allFiles.length} files in ${projects.size} project folder(s) — ${describeResult(result)}\n`);
  return result;
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => { console.error(`❌ ${e.message}`); process.exit(1); });
}
