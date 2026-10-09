#!/usr/bin/env node
/**
 * sync-system.mjs — MemVault System Info Snapshot
 * ─────────────────────────────────────────────────────────────────────────────
 * Captures a snapshot of the machine — OS, hardware, disk, dev tool versions,
 * top processes — so an AI can understand your working environment. Each run
 * replaces the previous snapshot instead of piling up new entries.
 *
 * Captured data includes the hostname, home directory, local IP addresses and
 * the names of the largest running processes. Turn the engine off with
 * "sync": { "systemEnabled": false } in ~/.memvaultrc.json.
 *
 * Usage:
 *   node sync-system.mjs              (capture and save)
 *   node sync-system.mjs --dry-run    (preview only)
 * ─────────────────────────────────────────────────────────────────────────────
 */

import os from "os";
import { execSync } from "child_process";
import { saveEntries } from "./sync-lib.mjs";
import { isMainModule } from "./util.mjs";

// ─── Helpers ────────────────────────────────────────────────────────────────

function execSafe(cmd, timeout = 10_000) {
  try {
    return execSync(cmd, { encoding: "utf8", timeout, stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch { return ""; }
}

const powershell = (script) =>
  execSafe(`powershell -NoProfile -NonInteractive -Command "${script.replace(/"/g, '\\"')}"`, 15_000);

function formatBytes(bytes) {
  const gb = bytes / 1024 ** 3;
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${(bytes / 1024 ** 2).toFixed(0)} MB`;
}

// ─── Collectors ─────────────────────────────────────────────────────────────

function getSystemInfo() {
  const cpus = os.cpus();
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  return {
    hostname: os.hostname(),
    platform: os.platform(),
    arch: os.arch(),
    os: `${os.type()} ${os.release()}`,
    cpu: cpus[0]?.model || "unknown",
    cores: cpus.length,
    totalMemory: formatBytes(totalMem),
    nodeVersion: process.version,
    homeDir: os.homedir(),
  };
}

function getDiskUsage() {
  if (process.platform !== "win32") return execSafe("df -h / | tail -n 1") || "N/A";

  // WMIC was removed from current Windows builds; use CIM via PowerShell.
  const out = powershell(
    "Get-CimInstance Win32_LogicalDisk | ForEach-Object { '{0} {1}|{2}' -f $_.DeviceID, $_.FreeSpace, $_.Size }"
  );
  const lines = out.split(/\r?\n/).map((line) => {
    const [name, nums = ""] = line.trim().split(" ");
    const [free, total] = nums.split("|").map(Number);
    if (!name || !total) return null;
    const gb = (n) => (n / 1024 ** 3).toFixed(0);
    return `${name} ${gb(free)}GB free / ${gb(total)}GB total (${((1 - free / total) * 100).toFixed(0)}% used)`;
  }).filter(Boolean);
  return lines.join("\n") || "N/A";
}

function getRunningProcesses() {
  if (process.platform === "win32") {
    return powershell(
      "Get-Process | Sort-Object WorkingSet64 -Descending | Select-Object -First 20 Name, @{N='MemMB';E={[Math]::Round($_.WorkingSet64/1MB)}} | Format-Table -AutoSize | Out-String"
    ) || "N/A";
  }
  // GNU ps understands --sort; BSD/macOS ps uses -m (sort by memory).
  const cmd = process.platform === "darwin" ? "ps aux -m | head -n 20" : "ps aux --sort=-%mem | head -n 20";
  return execSafe(cmd) || "N/A";
}

function getDevTools() {
  return {
    node: execSafe("node --version"),
    npm: execSafe("npm --version"),
    git: execSafe("git --version"),
    python: execSafe("python3 --version") || execSafe("python --version") || "not found",
  };
}

function getNetworkInfo() {
  const found = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const addr of addrs || []) {
      if (addr.family === "IPv4" && !addr.internal) found.push(`${name}: ${addr.address}`);
    }
  }
  return found.join(", ") || "No active network";
}

const bullets = (obj) => Object.entries(obj).map(([k, v]) => `- **${k}**: ${v}`).join("\n");

// ─── Main ───────────────────────────────────────────────────────────────────

export async function main(args = process.argv.slice(2)) {
  const dryRun = args.includes("--dry-run");
  const sys = getSystemInfo();
  const disk = getDiskUsage();
  const tools = getDevTools();
  const network = getNetworkInfo();
  const procs = getRunningProcesses();

  const snap = { type: "worklog", source: "system", upsert: true };
  const entries = [
    { ...snap, title: `[System] ${sys.hostname}`, tags: "system,hardware,environment",
      content: `## System Information\n\n${bullets(sys)}` },
    { ...snap, title: "[System] Disk Usage", tags: "system,disk,storage",
      content: `## Disk Usage\n\n\`\`\`\n${disk}\n\`\`\`` },
    { ...snap, title: "[System] Developer Tools", tags: "system,tools,development",
      content: `## Developer Tools\n\n${bullets(tools)}` },
    { ...snap, title: "[System] Running Processes", tags: "system,processes,runtime",
      content: `## Top Processes (by memory)\n\n\`\`\`\n${procs}\n\`\`\`\n\n**Network**: ${network}\n\n_Captured: ${new Date().toISOString()}_` },
  ];

  console.log(`💻 ${sys.os} | ${sys.cpu} | ${sys.cores} cores | ${sys.totalMemory} RAM`);
  console.log(`🛠️  Node ${tools.node} | npm ${tools.npm} | ${tools.git}`);
  const result = saveEntries(entries, { dryRun });
  console.log(`✅ ${entries.length} system snapshots ${dryRun ? "found (dry run, nothing saved)" : "saved"}\n`);
  return result;
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => { console.error(`❌ ${e.message}`); process.exit(1); });
}
