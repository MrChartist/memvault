#!/usr/bin/env node
/**
 * init.mjs — MemVault Setup Wizard
 * ─────────────────────────────────────────────────────────────────────────────
 * Interactive CLI prompt to configure ~/.memvaultrc.json — vault location,
 * capture engines, AI intelligence, Google Drive backup, and MCP bridges.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import readline from "readline";
import fs from "fs";
import path from "path";
import os from "os";

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise((resolve) => rl.question(q, resolve));
const yes = (answer, dflt = true) => {
  const a = (answer || "").trim().toLowerCase();
  if (!a) return dflt;
  return a === "y" || a === "yes";
};

async function main() {
  console.log("🗄️  MemVault Setup Wizard\n");
  console.log("This configures your local MemVault installation (~/.memvaultrc.json).\n");

  const HOME = os.homedir();
  const configPath = path.join(HOME, ".memvaultrc.json");
  const existing = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, "utf8")) : {};
  const defaultVaultData = existing.vaultRoot || path.join(HOME, ".memvault", "data");

  // ── 1. Vault location ──────────────────────────────────────────────────────
  const vaultRoot =
    (await ask(`1. Where to store your vault data?\n   [default: ${defaultVaultData}]: `)).trim() || defaultVaultData;

  // ── 2. Capture engines ─────────────────────────────────────────────────────
  console.log("\n2. Which auto-capture engines do you want to enable?");
  const gitOn = yes(await ask("   - Git commits?        (y/n) [y]: "));
  const vscodeOn = yes(await ask("   - VS Code activity?   (y/n) [y]: "));
  const sysOn = yes(await ask("   - System environment? (y/n) [y]: "));
  const filesOn = yes(await ask("   - Recent file changes?(y/n) [y]: "));
  const browserOn = yes(await ask("   - Browser history?    (y/n) [n]: "), false);
  const clipOn = yes(await ask("   - Clipboard (daemon)? (y/n) [n]: "), false);

  let gitDirs = existing.sync?.gitDirs || [HOME];
  if (gitOn) {
    const dirAns = await ask(`\n   Which root folder holds your code projects? (scanned 3 levels deep)\n   [default: ${gitDirs[0]}]: `);
    if (dirAns.trim()) gitDirs = [dirAns.trim()];
  }

  // ── 3. AI intelligence (Gemini) ────────────────────────────────────────────
  console.log("\n3. AI intelligence layer (Gemini) — optional, powers smart search & digests.");
  const aiKey = (await ask("   Gemini API key (Enter to skip): ")).trim();

  // ── 4. Google Drive backup ─────────────────────────────────────────────────
  console.log("\n4. Storage & backup — your vault is always saved locally. Add Google Drive?");
  const gdriveFolderOn = yes(await ask("   - Mirror to a Google Drive for Desktop folder? (y/n) [n]: "), false);
  let gdriveFolderPath = existing.storage?.gdriveFolder?.path || "";
  if (gdriveFolderOn) {
    gdriveFolderPath =
      (await ask(`   Path to your synced Drive folder (e.g. ${path.join(HOME, "Google Drive")}): `)).trim() || gdriveFolderPath;
  }
  const gdriveApiOn = yes(await ask("   - Upload backups via the Google Drive API (OAuth)? (y/n) [n]: "), false);
  let gdriveApi = existing.storage?.gdriveApi || {};
  if (gdriveApiOn) {
    console.log("   (See docs/google-drive.md to create OAuth credentials.)");
    gdriveApi = {
      clientId: (await ask("   OAuth Client ID: ")).trim() || gdriveApi.clientId || "",
      clientSecret: (await ask("   OAuth Client Secret: ")).trim() || gdriveApi.clientSecret || "",
      refreshToken: (await ask("   OAuth Refresh Token: ")).trim() || gdriveApi.refreshToken || "",
      folderId: (await ask("   Drive folder ID (Enter for My Drive root): ")).trim() || gdriveApi.folderId || "",
    };
  }

  // ── 5. MCP bridges ─────────────────────────────────────────────────────────
  console.log("\n5. Connect to other AI MCP servers (bridges) so all your AI tools share memory.");
  const { PRESET_BRIDGES } = await import("./mcp-bridge.mjs");
  console.log("   Popular local memory servers (no API key, run via npx):");
  for (const p of PRESET_BRIDGES) console.log(`     • ${p.name} — ${p.description}`);
  const bridgesOn = yes(await ask("   Enable these memory bridges now? (y/n) [n]: "), false);
  let mcpBridges = existing.mcpBridges || [];
  if (bridgesOn) {
    const have = new Set(mcpBridges.map((b) => b.name));
    for (const p of PRESET_BRIDGES) {
      if (!have.has(p.name)) {
        const { description, ...entry } = p;
        mcpBridges.push(entry);
      }
    }
  }
  console.log("   (Add or edit more later under \"mcpBridges\" in ~/.memvaultrc.json — see docs/mcp-bridge.md)");

  // ── Build config ───────────────────────────────────────────────────────────
  const config = {
    ...existing,
    vaultRoot,
    port: existing.port || 7799,
    sync: {
      gitDirs,
      vscodeEnabled: vscodeOn,
      systemEnabled: sysOn,
      filesEnabled: filesOn,
      browserEnabled: browserOn,
      clipboardEnabled: clipOn,
      antigravityEnabled: existing.sync?.antigravityEnabled ?? false,
    },
    ai: {
      enabled: !!aiKey || existing.ai?.enabled || false,
      apiKey: aiKey || existing.ai?.apiKey || "",
      model: existing.ai?.model || "gemini-2.0-flash",
    },
    storage: {
      local: { enabled: true },
      gdriveFolder: { enabled: gdriveFolderOn, path: gdriveFolderPath },
      gdriveApi: { enabled: gdriveApiOn, ...gdriveApi },
      keepLocalBackups: existing.storage?.keepLocalBackups ?? 20,
    },
    mcpBridges,
  };

  try {
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), "utf8");
    console.log(`\n✅ Settings saved to ${configPath}`);

    for (const sub of ["db", "entries", "conversations", "worklogs", "backups"]) {
      fs.mkdirSync(path.join(vaultRoot, sub), { recursive: true });
    }
    console.log(`✅ Vault directory ready at ${vaultRoot}`);

    console.log(`\n🎉 MemVault is ready!\n`);
    console.log(`Next steps:`);
    console.log(`  1. Start the UI:       npx memvault serve   → http://localhost:${config.port}`);
    console.log(`  2. Capture your data:  npx memvault sync`);
    console.log(`  3. Back up:            npx memvault backup`);
    console.log(`  4. Bridge other AIs:   npx memvault bridge list`);
    console.log(`\n  Add this to your Claude/Cursor MCP config:`);
    console.log(`\n{
  "mcpServers": {
    "memvault": {
      "command": "npx",
      "args": ["memvault", "mcp"],
      "env": { "VAULT_ROOT": ${JSON.stringify(vaultRoot)} }
    }
  }
}\n`);
  } catch (err) {
    console.error(`❌ Failed to save config: ${err.message}`);
  }

  rl.close();
}

main().catch((err) => {
  console.error(err);
  rl.close();
});
