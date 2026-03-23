#!/usr/bin/env node
/**
 * init.mjs — MemVault Setup Wizard
 * ─────────────────────────────────────────────────────────────────────────────
 * Interactive CLI prompt to configure ~/.memvaultrc.json
 * ─────────────────────────────────────────────────────────────────────────────
 */

import readline from "readline";
import fs from "fs";
import path from "path";
import os from "os";

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

const question = (query) => new Promise((resolve) => rl.question(query, resolve));

async function main() {
  console.log("🗄️  MemVault Setup Wizard\n");

  const HOME = os.homedir();
  const defaultConfigPath = path.join(HOME, ".memvaultrc.json");
  const defaultVaultData = path.join(HOME, ".memvault", "data");

  console.log("This will configure your local MemVault installation.\n");

  // Vault Root
  const vaultRootAns = await question(`1. Where do you want to store your vault data?\n   [default: ${defaultVaultData}]: `);
  const vaultRoot = vaultRootAns.trim() || defaultVaultData;

  console.log("\n2. Which auto-capture engines do you want to enable?");
  const gitAns = await question("   - Git commits? (y/n) [y]: ");
  const vscodeAns = await question("   - VS Code activity? (y/n) [y]: ");
  const sysAns = await question("   - System environment? (y/n) [y]: ");
  const filesAns = await question("   - Recent file changes? (y/n) [y]: ");
  
  let gitDirs = [HOME];
  if (gitAns.toLowerCase() !== "n") {
    const dirAns = await question(`\n   Let's configure Git. Which root directory contains your code projects?\n   We'll scan this folder up to 3 levels deep.\n   [default: ${HOME}]: `);
    if (dirAns.trim()) gitDirs = [dirAns.trim()];
  }

  const config = {
    vaultRoot,
    port: 7799,
    sync: {
      gitDirs,
      vscodeEnabled: vscodeAns.toLowerCase() !== "n",
      systemEnabled: sysAns.toLowerCase() !== "n",
      filesEnabled: filesAns.toLowerCase() !== "n",
      clipboardEnabled: false, // Default off for privacy
    }
  };

  try {
    fs.writeFileSync(defaultConfigPath, JSON.stringify(config, null, 2), "utf8");
    console.log(`\n✅ Settings saved to ${defaultConfigPath}`);
    
    // Create vault dir
    if (!fs.existsSync(vaultRoot)) {
      fs.mkdirSync(vaultRoot, { recursive: true });
      fs.mkdirSync(path.join(vaultRoot, "db"), { recursive: true });
      console.log(`✅ Created vault directory at ${vaultRoot}`);
    }

    console.log(`\n🎉 MemVault is ready!`);
    console.log(`\nNext steps:`);
    console.log(`  1. Start the UI:       npx memvault serve`);
    console.log(`  2. Sync data now:      npx memvault sync`);
    console.log(`  3. Provide MCP context to AI clients.`);
    console.log(`     Add the following to your Claude/Cursor MCP config:`);
    console.log(`\n{
  "mcpServers": {
    "memvault": {
      "command": "npx",
      "args": ["memvault", "mcp"]
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
