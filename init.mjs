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
import { CONFIG_FILE, loadUserConfig, saveUserConfig } from "./config.mjs";
import { resolveUserPath } from "./util.mjs";

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY });
// Read answers through an async iterator: unlike rl.question() it also works when
// answers are piped in (`printf 'a\nb\n' | memvault init`) instead of typed.
const lines = rl[Symbol.asyncIterator]();
const ask = async (q) => {
  process.stdout.write(q);
  const { value, done } = await lines.next();
  if (done) throw new Error("Input ended before the wizard finished — nothing was saved.");
  if (!process.stdin.isTTY) process.stdout.write(`${value}\n`); // echo piped answers so logs read naturally
  return value;
};
const yes = (answer, dflt = true) => {
  const a = (answer || "").trim().toLowerCase();
  if (!a) return dflt;
  return a === "y" || a === "yes";
};

async function main() {
  console.log("🗄️  MemVault Setup Wizard\n");
  console.log(`This configures your local MemVault installation (${CONFIG_FILE}).`);
  console.log("Everything stays on this machine unless you enable an option marked ☁️ below.\n");

  const HOME = os.homedir();
  const existing = loadUserConfig();
  const defaultVaultData = existing.vaultRoot || path.join(HOME, ".memvault", "data");

  // ── 1. Vault location ──────────────────────────────────────────────────────
  const vaultRoot = resolveUserPath(
    (await ask(`1. Where to store your vault data?\n   [default: ${defaultVaultData}]: `)).trim() || defaultVaultData
  );

  // ── 2. Capture engines ─────────────────────────────────────────────────────
  console.log("\n2. Which auto-capture engines do you want to enable?");
  const gitOn = yes(await ask("   - Git commits?        (y/n) [y]: "));
  const vscodeOn = yes(await ask("   - VS Code activity?   (y/n) [y]: "));
  const sysOn = yes(await ask("   - System environment? (y/n) [y]: "));
  const filesOn = yes(await ask("   - Recent file changes (names only)? (y/n) [y]: "));
  const browserOn = yes(await ask("   - Browser history & bookmarks (sensitive)? (y/n) [n]: "), false);
  const clipOn = yes(await ask("   - Clipboard daemon (sensitive)? (y/n) [n]: "), false);

  let gitDirs = existing.sync?.gitDirs || [HOME];
  if (gitOn) {
    const dirAns = await ask(`\n   Which root folder holds your code projects? (scanned 3 levels deep)\n   [default: ${gitDirs[0]}]: `);
    if (dirAns.trim()) gitDirs = [resolveUserPath(dirAns.trim())];
  }

  // ── 3. AI intelligence (Gemini) ────────────────────────────────────────────
  console.log("\n3. ☁️  AI intelligence layer (Gemini) — optional, powers smart search & digests.");
  console.log("   If you add a key, entry titles/snippets needed for a request are sent to Google's Gemini API.");
  const aiKey = (await ask("   Gemini API key (Enter to skip): ")).trim();

  // ── 4. Google Drive backup ─────────────────────────────────────────────────
  console.log("\n4. Storage & backup — your vault is always saved locally. Add Google Drive?");
  const gdriveFolderOn = yes(await ask("   - ☁️  Mirror to a Google Drive for Desktop folder? (y/n) [n]: "), false);
  let gdriveFolderPath = existing.storage?.gdriveFolder?.path || "";
  if (gdriveFolderOn) {
    gdriveFolderPath = resolveUserPath(
      (await ask(`   Path to your synced Drive folder (e.g. ${path.join(HOME, "Google Drive")}): `)).trim() || gdriveFolderPath
    );
  }
  const gdriveApiOn = yes(await ask("   - ☁️  Upload backups via the Google Drive API (OAuth)? (y/n) [n]: "), false);
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
  console.log("   Popular local memory servers (no API key; fetched and run on demand via npx):");
  for (const p of PRESET_BRIDGES) console.log(`     • ${p.name} — ${p.description}`);
  const bridgesOn = yes(await ask("   Enable these memory bridges now? (y/n) [n]: "), false);
  const mcpBridges = existing.mcpBridges || [];
  if (bridgesOn) {
    const have = new Set(mcpBridges.map((b) => b.name));
    for (const p of PRESET_BRIDGES) {
      if (!have.has(p.name)) {
        const { description, ...entry } = p;
        mcpBridges.push(entry);
      }
    }
  }
  console.log("   (Add or edit more later under \"mcpBridges\" in the config file — see docs/mcp-bridge.md)");

  // ── Build config ───────────────────────────────────────────────────────────
  const config = {
    ...existing,
    vaultRoot,
    port: existing.port || 7799,
    sync: {
      ...(existing.sync || {}),
      gitDirs,
      gitEnabled: gitOn,
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
      gdriveApi: { ...gdriveApi, enabled: gdriveApiOn }, // answer wins over any previously saved "enabled"
      keepLocalBackups: existing.storage?.keepLocalBackups ?? 20,
    },
    mcpBridges,
  };

  try {
    saveUserConfig(config); // owner-only permissions: it may contain API keys
    console.log(`\n✅ Settings saved to ${CONFIG_FILE}`);

    for (const sub of ["db", "entries", "conversations", "worklogs", "files", "backups"]) {
      fs.mkdirSync(path.join(vaultRoot, sub), { recursive: true });
    }
    console.log(`✅ Vault directory ready at ${vaultRoot}`);

    console.log(`\n🎉 MemVault is ready!\n`);
    console.log(`Next steps:`);
    console.log(`  1. Capture your data:  npx -y @mrchartist/memvault sync`);
    console.log(`  2. Open the web UI:    npx -y @mrchartist/memvault serve   → http://localhost:${config.port}`);
    console.log(`  3. Back up:            npx -y @mrchartist/memvault backup`);
    console.log(`  4. Bridge other AIs:   npx -y @mrchartist/memvault bridge list`);
    console.log(`\n  Add this to your Claude / Cursor MCP config:`);
    console.log(`\n{
  "mcpServers": {
    "memvault": {
      "command": "npx",
      "args": ["-y", "@mrchartist/memvault", "mcp"]
    }
  }
}\n`);
    console.log(`  (The vault location is read from ${CONFIG_FILE}; add "env": { "VAULT_ROOT": "..." } only to override it.)\n`);
  } catch (err) {
    console.error(`❌ Failed to save config: ${err.message}`);
    process.exitCode = 1;
  }

  rl.close();
}

main().catch((err) => {
  console.error(`\n❌ ${err.message}`);
  rl.close();
  process.exit(1);
});
