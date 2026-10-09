import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import { fileURLToPath } from "url";

// This script changes how your computer starts, so it does nothing until you say yes.
//   node setup-windows.mjs --yes      add the start-up items
//   node setup-windows.mjs --remove   take them away again
const YES = process.argv.includes("--yes");
const REMOVE = process.argv.includes("--remove");
if (process.platform !== "win32") { console.log("This script is for Windows only."); process.exit(0); }
if (!YES && !REMOVE) {
  console.log(`This would, on this computer:
  1. add a hidden start-up item that starts the MemVault dashboard server each time you sign in,
  2. add a hidden start-up item for the clipboard watcher (it still saves nothing unless you switch clipboard capture on in Settings),
  3. add a Scheduled Task "MemVault-Periodic-Sync" that runs "npm run sync:all" every 30 minutes (each capture source is still off until you switch it on).

Nothing has been changed. To go ahead:   node setup-windows.mjs --yes
To remove it all later:                 node setup-windows.mjs --remove`);
  process.exit(0);
}
if (REMOVE) {
  const startup = path.join(process.env.APPDATA || "", "Microsoft", "Windows", "Start Menu", "Programs", "Startup", "MemVault-Autostart.vbs");
  try { fs.rmSync(startup, { force: true }); console.log("Removed the start-up item."); } catch (e) { console.log("Could not remove the start-up item:", e.message); }
  try { execSync('schtasks /Delete /TN "MemVault-Periodic-Sync" /F', { stdio: "ignore" }); console.log("Removed the Scheduled Task."); } catch { console.log("No Scheduled Task to remove."); }
  try { fs.rmSync(path.join(process.env.LOCALAPPDATA || "", "MemVault", "run-sync-silent.vbs"), { force: true }); } catch { /* nothing to remove */ }
  process.exit(0);
}
console.log("Setting up MemVault start-up items...\n");

// The folder this script lives in — works no matter where you run it from.
const repoDir = path.dirname(fileURLToPath(import.meta.url));
const startupFolder = path.join(process.env.APPDATA, "Microsoft", "Windows", "Start Menu", "Programs", "Startup");
const vbsPath = path.join(startupFolder, "MemVault-Autostart.vbs");

// 1. Create the Startup VBScript to run Daemons silently
const vbsContent = `' MemVault Auto-Start Daemons (Silently)
Set objShell = CreateObject("WScript.Shell")
' 1. Start Web/API Server
objShell.Run "cmd.exe /c cd /d """ & "${repoDir}" & """ && npm start", 0, False

' 2. Start Clipboard Polling Daemon
objShell.Run "cmd.exe /c cd /d """ & "${repoDir}" & """ && npm run sync:clipboard", 0, False
`;

fs.writeFileSync(vbsPath, vbsContent);
console.log(`✅ Created silent startup script in: ${vbsPath}`);

// 2. Set up a Scheduled Task to run sync:all every 30 minutes
const taskName = "MemVault-Periodic-Sync";

try {
  // Try to delete if it already exists
  execSync(`schtasks /Delete /TN "${taskName}" /F`, { stdio: "ignore" });
} catch (e) {
  // Ignore error if task doesn't exist
}

try {
  // Create an scheduled task to run sync-all.mjs every 30 minutes
  const nodePath = process.execPath;
  const syncAllPath = path.join(repoDir, "sync-all.mjs");
  
  // We need to run it silently via a tiny one-liner vbs wrapper, or just cmd /c start /min
  // Let's create a wrapper specifically for the task scheduler so it doesn't flash a cmd window
  // Generated per machine and kept OUT of the repo (it contains your local paths).
  const taskDir = path.join(process.env.LOCALAPPDATA || repoDir, "MemVault");
  fs.mkdirSync(taskDir, { recursive: true });
  const taskVbsPath = path.join(taskDir, "run-sync-silent.vbs");
  fs.writeFileSync(taskVbsPath, `Set objShell = CreateObject("WScript.Shell")\nobjShell.Run "cmd.exe /c cd /d """ & "${repoDir}" & """ && npm run sync:all", 0, False`);
  
  const cmd = `schtasks /Create /SC MINUTE /MO 30 /TN "${taskName}" /TR "wscript.exe \\"${taskVbsPath}\\"" /F`;
  execSync(cmd, { stdio: "inherit" });
  console.log(`✅ Created Windows Scheduled Task '${taskName}' — runs every 30 minutes!`);
  
  // Run it once right now to trigger the first sync
  execSync(`schtasks /Run /TN "${taskName}"`, { stdio: "ignore" });
  console.log(`▶️ Triggered the first background sync immediately.`);
  
} catch (error) {
  console.error("⚠️ Failed to create Scheduled Task:", error.message);
}

console.log("\n🎉 Ultimate Setup Complete!");
console.log("MemVault will now start silently on every boot, and seamlessly sync your data in the background.");
