#!/usr/bin/env node
/**
 * sync-all.mjs — Run every enabled capture engine, then back up.
 * ─────────────────────────────────────────────────────────────────────────────
 * Honors the "sync" flags in ~/.memvaultrc.json so users only run what they
 * opted into. After capturing, if a Google Drive backend is enabled it pushes a
 * backup automatically.
 *
 * Note: the clipboard engine is a long-running daemon and is intentionally NOT
 * run here — start it separately with `npm run sync:clipboard`.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { spawn } from "child_process";
import path from "path";
import { fileURLToPath } from "url";
import { SYNC_CONFIG, STORAGE_CONFIG } from "./config.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Map config flags → engine scripts (one-shot only; clipboard excluded).
const engines = [
  { script: "sync-git.mjs", enabled: true }, // gitDirs always scanned
  { script: "sync-vscode.mjs", enabled: SYNC_CONFIG.vscodeEnabled !== false },
  { script: "sync-system.mjs", enabled: SYNC_CONFIG.systemEnabled !== false },
  { script: "sync-files.mjs", enabled: SYNC_CONFIG.filesEnabled !== false },
  { script: "sync-browser.mjs", enabled: SYNC_CONFIG.browserEnabled === true },
  { script: "sync-antigravity.mjs", enabled: SYNC_CONFIG.antigravityEnabled === true },
].filter((e) => e.enabled);

function runEngine(script) {
  return new Promise((resolve) => {
    const cp = spawn(process.execPath, [path.join(__dirname, script)], { stdio: "inherit" });
    cp.on("exit", resolve);
    cp.on("error", () => resolve(1));
  });
}

async function main() {
  console.log(`🔄 Running ${engines.length} enabled sync engine(s)...\n`);
  for (const { script } of engines) {
    console.log(`\n▶️ Starting ${script}...`);
    await runEngine(script);
  }
  console.log(`\n✅ All sync engines complete!`);

  // Auto-backup if Google Drive is enabled, otherwise just keep local.
  const driveOn = STORAGE_CONFIG.gdriveFolder?.enabled || STORAGE_CONFIG.gdriveApi?.enabled;
  if (driveOn) {
    console.log(`\n💾 Backing up vault to Google Drive + local...`);
    const { backupVault } = await import("./storage.mjs");
    const results = await backupVault();
    for (const r of results) {
      console.log(r.ok ? `   ✅ ${r.backend}: ${r.location}` : `   ❌ ${r.backend}: ${r.error}`);
    }
  }
}

main().catch(console.error);
