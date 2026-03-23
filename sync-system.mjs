#!/usr/bin/env node
/**
 * sync-system.mjs — MemVault System Info Snapshot
 * ─────────────────────────────────────────────────────────────────────────────
 * Captures a snapshot of the system state — OS, hardware, running processes,
 * installed software, disk usage — and saves it to the vault. Helps AI
 * understand your working environment.
 *
 * Usage:
 *   node sync-system.mjs              (capture and save)
 *   node sync-system.mjs --dry-run    (preview only)
 * ─────────────────────────────────────────────────────────────────────────────
 */

import os from "os";
import { execSync } from "child_process";

import { API_URL as API } from "./config.mjs";
const DRY_RUN = process.argv.includes("--dry-run");

// ─── Helpers ────────────────────────────────────────────────────────────────

async function postToVault(entry) {
  if (DRY_RUN) {
    console.log(`  [DRY] ${entry.title}`);
    console.log(`  Content preview: ${entry.content.slice(0, 200)}...`);
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
    hostname: os.hostname(),
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
    homeDir: os.homedir(),
    tmpDir: os.tmpdir(),
  };
}

function getDiskUsage() {
  if (process.platform !== "win32") {
    const df = execSafe("df -h / | tail -1");
    return df || "N/A";
  }

  // Windows: use WMIC
  const drives = execSafe('wmic logicaldisk get name,size,freespace /format:csv');
  if (!drives) return "N/A";

  const lines = drives.split("\n").filter(l => l.trim() && !l.includes("Node"));
  return lines.map(line => {
    const parts = line.split(",").map(p => p.trim());
    if (parts.length >= 4) {
      const [, free, name, total] = parts;
      if (total && free) {
        const totalGb = (Number(total) / (1024 ** 3)).toFixed(0);
        const freeGb = (Number(free) / (1024 ** 3)).toFixed(0);
        const usedPct = ((1 - Number(free) / Number(total)) * 100).toFixed(0);
        return `${name} ${freeGb}GB free / ${totalGb}GB total (${usedPct}% used)`;
      }
    }
    return null;
  }).filter(Boolean).join("\n") || "N/A";
}

function getRunningProcesses() {
  if (process.platform === "win32") {
    // Get top processes by memory usage
    const result = execSafe('powershell -command "Get-Process | Sort-Object WorkingSet64 -Descending | Select-Object -First 20 Name, @{N=\\"MemMB\\";E={[Math]::Round($_.WorkingSet64/1MB)}} | Format-Table -AutoSize | Out-String"');
    return result || "N/A";
  }

  return execSafe("ps aux --sort=-%mem | head -20") || "N/A";
}

function getInstalledNodeVersions() {
  const nodeV = execSafe("node --version");
  const npmV = execSafe("npm --version");
  const gitV = execSafe("git --version");
  const pythonV = execSafe("python --version 2>&1") || execSafe("python3 --version 2>&1");

  return { node: nodeV, npm: npmV, git: gitV, python: pythonV || "not found" };
}

function getNetworkInfo() {
  const interfaces = os.networkInterfaces();
  const results = [];

  for (const [name, addrs] of Object.entries(interfaces)) {
    for (const addr of addrs) {
      if (addr.family === "IPv4" && !addr.internal) {
        results.push(`${name}: ${addr.address}`);
      }
    }
  }

  return results.join(", ") || "No active network";
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  console.log("╔══════════════════════════════════════╗");
  console.log("║  System → MemVault Snapshot          ║");
  console.log(`║  ${DRY_RUN ? "DRY RUN                            " : "LIVE MODE                          "}║`);
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
    title: `[System] ${sys.hostname} — ${sys.os} (${sys.arch})`,
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
    title: "[System] Developer Tools Installed",
    content: `## Developer Tools\n\n${toolsContent}`,
    tags: "system,tools,development",
  });
  if (toolsOk) totalSynced++;
  console.log(`  🛠️  Node ${tools.node} | npm ${tools.npm} | ${tools.git}`);

  // 4. Network
  console.log("\n── Network ────────────────────────────");
  const network = getNetworkInfo();
  console.log(`  🌐 ${network}`);

  // 5. Top Processes
  console.log("\n── Top Processes ───────────────────────");
  const procs = getRunningProcesses();

  const procsOk = await postToVault({
    type: "worklog",
    source: "system",
    title: "[System] Running Processes Snapshot",
    content: `## Top Processes (by memory)\n\n\`\`\`\n${procs}\n\`\`\`\n\n**Network**: ${network}\n\n_Captured: ${new Date().toISOString()}_`,
    tags: "system,processes,runtime",
  });
  if (procsOk) totalSynced++;
  console.log(`  📊 Top processes captured`);

  console.log(`\n═══════════════════════════════════════`);
  console.log(`✅ Synced: ${totalSynced} snapshots to vault`);
  console.log(`═══════════════════════════════════════\n`);
}

main().catch(console.error);
