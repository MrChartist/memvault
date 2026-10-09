#!/usr/bin/env node
/**
 * sync-system.mjs — MemVault System Info Snapshot
 * ─────────────────────────────────────────────────────────────────────────────
 * Saves a snapshot of basic facts about this computer: OS, hardware, disk space and which developer
 * tools are installed. It does NOT save the computer's name, network addresses or running programs.
 *
 * Usage:
 *   node sync-system.mjs              (capture and save)
 *   node sync-system.mjs --dry-run    (preview only)
 * ─────────────────────────────────────────────────────────────────────────────
 */

import fs from "fs";
import path from "path";
import os from "os";
import { execSync } from "child_process";

import { createIngestQueue } from "./ingest.mjs";
import { requireEnabled } from "./sync-guard.mjs";
requireEnabled("systemEnabled", "Saving computer information");

const queue = createIngestQueue({ actor: "system" });
const DRY_RUN = process.argv.includes("--dry-run");

// ─── Helpers ────────────────────────────────────────────────────────────────

async function postToVault(entry) {
  if (DRY_RUN) {
    console.log(`  [DRY] ${entry.title}`);
    console.log(`  Content preview: ${entry.content.slice(0, 200)}...`);
    return true;
  }
  queue.add(entry);
  return true;
}

function execSafe(cmd, timeout = 10000) {
  try {
    return execSync(cmd, { encoding: "utf8", timeout, stdio: ["pipe", "pipe", "pipe"] }).trim();
  } catch { return ""; }
}

function formatBytes(bytes) {
  const gb = bytes / (1024 * 1024 * 1024);
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${(bytes / (1024 * 1024)).toFixed(0)} MB`;
}

// ─── Collectors ─────────────────────────────────────────────────────────────

function getSystemInfo() {
  const cpus = os.cpus();
  const totalMem = os.totalmem();
  const freeMem = os.freemem();

  return {
    platform: os.platform(),
    arch: os.arch(),
    os: `${os.type()} ${os.release()}`,
    cpu: cpus[0]?.model || "unknown",
    cores: cpus.length,
    totalMemory: formatBytes(totalMem),
    freeMemory: formatBytes(freeMem),
    usedMemory: formatBytes(totalMem - freeMem),
    memoryUsage: `${((1 - freeMem / totalMem) * 100).toFixed(0)}%`,
    uptime: `${(os.uptime() / 3600).toFixed(1)} hours`,
    nodeVersion: process.version,
    tmpDir: os.tmpdir(),
  };
}

function getDiskUsage() {
  // One built-in call for every system (no df, no wmic: wmic is gone from newer Windows).
  try {
    const root = process.platform === "win32" ? path.parse(process.cwd()).root : "/";
    const st = fs.statfsSync(root);
    const total = st.blocks * st.bsize, free = st.bavail * st.bsize;
    if (!total) return "N/A";
    const gb = (n) => (n / 1024 ** 3).toFixed(0);
    return `${root} ${gb(free)}GB free / ${gb(total)}GB total (${((1 - free / total) * 100).toFixed(0)}% used)`;
  } catch {
    return "N/A";
  }
}

function getInstalledNodeVersions() {
  const nodeV = execSafe("node --version");
  const npmV = execSafe("npm --version");
  const gitV = execSafe("git --version");
  const pythonV = execSafe("python --version 2>&1") || execSafe("python3 --version 2>&1");

  return { node: nodeV, npm: npmV, git: gitV, python: pythonV || "not found" };
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  console.log("╔══════════════════════════════════════╗");
  console.log("║  System → MemVault Snapshot          ║");
  console.log(`║  ${DRY_RUN ? "DRY RUN                            " : "LIVE MODE                          "}║`);
  console.log("╚══════════════════════════════════════╝\n");

let totalSynced = 0;

  // 1. System Info
  console.log("── System Info ─────────────────────────");
  const sys = getSystemInfo();
  const sysContent = Object.entries(sys)
    .map(([k, v]) => `- **${k}**: ${v}`)
    .join("\n");

  const sysOk = await postToVault({
    type: "worklog",
    source: "system",
    upsert: true, // a snapshot: each run replaces the previous one instead of adding another
    title: `[System] ${sys.os} (${sys.arch})`,
    content: `## System Information\n\n${sysContent}`,
    tags: "system,hardware,environment",
  });
  if (sysOk) totalSynced++;
  console.log(`  💻 ${sys.os} | ${sys.cpu} | ${sys.cores} cores | ${sys.totalMemory} RAM`);

  // 2. Disk Usage
  console.log("\n── Disk Usage ──────────────────────────");
  const disk = getDiskUsage();
  const diskOk = await postToVault({
    type: "worklog",
    source: "system",
    upsert: true, // a snapshot: each run replaces the previous one instead of adding another
    title: "[System] Disk Usage Snapshot",
    content: `## Disk Usage\n\n\`\`\`\n${disk}\n\`\`\``,
    tags: "system,disk,storage",
  });
  if (diskOk) totalSynced++;
  console.log(`  💾 ${disk.split("\n")[0]}`);

  // 3. Dev Tools
  console.log("\n── Developer Tools ─────────────────────");
  const tools = getInstalledNodeVersions();
  const toolsContent = Object.entries(tools)
    .map(([k, v]) => `- **${k}**: ${v}`)
    .join("\n");

  const toolsOk = await postToVault({
    type: "worklog",
    source: "system",
    upsert: true, // a snapshot: each run replaces the previous one instead of adding another
    title: "[System] Developer Tools Installed",
    content: `## Developer Tools\n\n${toolsContent}`,
    tags: "system,tools,development",
  });
  if (toolsOk) totalSynced++;
  console.log(`  🛠️  Node ${tools.node} | npm ${tools.npm} | ${tools.git}`);

  // The computer's name, its network addresses and the programs running on it are deliberately NOT saved:
  // program command lines often contain passwords, and none of it is needed to help with a task.

  queue.done();
  console.log(`\n═══════════════════════════════════════`);
  console.log(`✅ Synced: ${totalSynced} snapshots to vault`);
  console.log(`═══════════════════════════════════════\n`);
}

main().catch(console.error);
