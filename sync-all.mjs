#!/usr/bin/env node
/**
 * sync-all.mjs — Run every enabled capture engine, then back up.
 * ─────────────────────────────────────────────────────────────────────────────
 * Honors the "sync" flags in ~/.memvaultrc.json so only engines you opted into
 * run. After capturing, if a Google Drive backend is enabled it pushes a backup.
 *
 * Defaults: git, VS Code, system and file-activity engines are ON; browser
 * history and Antigravity are OFF. The clipboard engine is a long-running
 * daemon and is intentionally NOT run here — start it with `npm run sync:clipboard`.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { spawn } from "child_process";
import path from "path";
import { fileURLToPath } from "url";
import { SYNC_CONFIG, STORAGE_CONFIG } from "./config.mjs";
import { isMainModule } from "./util.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const engines = [
  { script: "sync-git.mjs", enabled: SYNC_CONFIG.gitEnabled !== false },
  { script: "sync-vscode.mjs", enabled: SYNC_CONFIG.vscodeEnabled !== false },
  { script: "sync-system.mjs", enabled: SYNC_CONFIG.systemEnabled !== false },
  { script: "sync-files.mjs", enabled: SYNC_CONFIG.filesEnabled !== false },
  { script: "sync-browser.mjs", enabled: SYNC_CONFIG.browserEnabled === true },
  { script: "sync-antigravity.mjs", enabled: SYNC_CONFIG.antigravityEnabled === true },
].filter((e) => e.enabled);

function runEngine(script) {
  return new Promise((resolve) => {
    const cp = spawn(process.execPath, [path.join(__dirname, script), ...process.argv.slice(2)], { stdio: "inherit" });
    cp.on("exit", (code) => resolve(code ?? 1));
    cp.on("error", () => resolve(1));
  });
}

async function main() {
  console.log(`🔄 Running ${engines.length} enabled sync engine(s)...\n`);
  const failed = [];
  for (const { script } of engines) {
    console.log(`▶️  ${script}`);
    if ((await runEngine(script)) !== 0) failed.push(script);
  }
  console.log(failed.length ? `⚠️  Finished with problems in: ${failed.join(", ")}` : "✅ All sync engines complete!");

  // Auto-backup if Google Drive is enabled, otherwise just keep local.
  const driveOn = STORAGE_CONFIG.gdriveFolder?.enabled || STORAGE_CONFIG.gdriveApi?.enabled;
  if (driveOn) {
    console.log(`\n💾 Backing up vault to Google Drive + local...`);
    const { backupVault } = await import("./storage.mjs");
    for (const r of await backupVault()) {
      console.log(r.ok ? `   ✅ ${r.backend}: ${r.location}` : `   ❌ ${r.backend}: ${r.error}`);
      if (!r.ok) failed.push(r.backend);
    }
  }
  process.exitCode = failed.length ? 1 : 0;
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
