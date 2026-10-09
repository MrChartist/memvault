#!/usr/bin/env node
/**
 * setup-windows.mjs — start MemVault silently at Windows login
 * ─────────────────────────────────────────────────────────────────────────────
 *   1. Adds a hidden launcher to your Startup folder that runs the web UI
 *      (and the clipboard daemon, if you enabled it).
 *   2. Creates a Scheduled Task that runs `sync` every 30 minutes.
 *
 * Works from any install location (global npm install, a git clone, ...):
 * everything is resolved from this file's own location, not the current folder.
 *
 *   node setup-windows.mjs            # install
 *   node setup-windows.mjs --remove   # uninstall both
 * ─────────────────────────────────────────────────────────────────────────────
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { execFileSync } from "child_process";
import { SYNC_CONFIG } from "./config.mjs";

if (process.platform !== "win32") {
  console.error("❌ setup-windows.mjs only works on Windows. See docs/autostart.md for macOS and Linux.");
  process.exit(1);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const node = process.execPath;
const script = (name) => path.join(here, name);

const startupFolder = path.join(process.env.APPDATA, "Microsoft", "Windows", "Start Menu", "Programs", "Startup");
const launcherPath = path.join(startupFolder, "MemVault-Autostart.vbs");
const syncVbsPath = path.join(process.env.LOCALAPPDATA || here, "MemVault", "run-sync-silent.vbs");
const taskName = "MemVault-Periodic-Sync";

// In VBScript a literal quote inside a string is written as two quotes.
const vbsQuote = (s) => `""${s}""`;
const vbsRun = (file, ...args) => `"${[node, file, ...args].map((p) => vbsQuote(p)).join(" ")}"`;

if (process.argv.includes("--remove")) {
  try { fs.rmSync(launcherPath, { force: true }); console.log(`🗑️  Removed ${launcherPath}`); } catch { /* ignore */ }
  try { execFileSync("schtasks", ["/Delete", "/TN", taskName, "/F"], { stdio: "ignore" }); console.log(`🗑️  Removed task ${taskName}`); } catch { /* not installed */ }
  try { fs.rmSync(syncVbsPath, { force: true }); } catch { /* ignore */ }
  process.exit(0);
}

console.log("🚀 Setting up MemVault autostart for Windows...\n");

// 1. Hidden launcher in the Startup folder
let launcher = `' MemVault auto-start (runs hidden)\nSet sh = CreateObject("WScript.Shell")\n`;
launcher += `sh.Run ${vbsRun(script("server.mjs"))}, 0, False\n`;
if (SYNC_CONFIG.clipboardEnabled) launcher += `sh.Run ${vbsRun(script("sync-clipboard.mjs"))}, 0, False\n`;
fs.mkdirSync(startupFolder, { recursive: true });
fs.writeFileSync(launcherPath, launcher);
console.log(`✅ Startup launcher: ${launcherPath}`);

// 2. Scheduled task: sync every 30 minutes (through a tiny wrapper so no console window flashes)
fs.mkdirSync(path.dirname(syncVbsPath), { recursive: true });
fs.writeFileSync(syncVbsPath, `Set sh = CreateObject("WScript.Shell")\nsh.Run ${vbsRun(script("sync-all.mjs"))}, 0, True\n`);

try {
  execFileSync("schtasks", ["/Delete", "/TN", taskName, "/F"], { stdio: "ignore" });
} catch { /* did not exist */ }

try {
  execFileSync("schtasks", ["/Create", "/SC", "MINUTE", "/MO", "30", "/TN", taskName, "/TR", `wscript.exe "${syncVbsPath}"`, "/F"], { stdio: "inherit" });
  console.log(`✅ Scheduled task '${taskName}' — runs every 30 minutes`);
  execFileSync("schtasks", ["/Run", "/TN", taskName], { stdio: "ignore" });
  console.log("▶️  Triggered the first sync.");
} catch (error) {
  console.error("⚠️  Failed to create the scheduled task:", error.message);
}

console.log("\n🎉 Done. The web UI starts at login (http://localhost:7799) and data syncs every 30 minutes.");
console.log("   Undo with: node setup-windows.mjs --remove");
