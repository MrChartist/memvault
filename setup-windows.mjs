import fs from "fs";
import path from "path";
import { execSync } from "child_process";

console.log("🚀 Setting up MemVault Ultimate Windows Autostart...\n");

const repoDir = process.cwd();
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
  const taskVbsPath = path.join(repoDir, "run-sync-silent.vbs");
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
