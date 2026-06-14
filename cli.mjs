#!/usr/bin/env node
/**
 * cli.mjs — MemVault Command Line Interface
 * ─────────────────────────────────────────────────────────────────────────────
 * The main entry point for the `memvault` npm package command.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { spawn } from "child_process";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const [,, command, ...args] = process.argv;

const commands = {
  init:    { script: "init.mjs",       desc: "Run the interactive setup wizard" },
  serve:   { script: "server.mjs",     desc: "Start the API & Web server (localhost:7799)" },
  mcp:     { script: "mcp-server.mjs", desc: "Start the MCP stdio server" },
  sync:    { script: "sync-all.mjs",   desc: "Run all enabled sync engines" },
  import:  { script: "import-all.mjs", desc: "Import AI conversations (ChatGPT, Claude, Gemini, Perplexity)" },
  backup:  { script: "storage.mjs",    desc: "Back up the vault to local + Google Drive" },
  bridge:  { script: "mcp-bridge.mjs", desc: "List/sync other AI MCP servers (list|sync|call)" },
  vault:   { script: "vault.mjs",      desc: "CLI tool to add/search items" },
};

function showHelp() {
  console.log(`
🗄️  MemVault CLI — Universal AI Memory Layer

Usage: memvault <command> [options]

Commands:`);
  for (const [cmd, info] of Object.entries(commands)) {
    console.log(`  ${cmd.padEnd(10)} ${info.desc}`);
  }
  console.log(`
Examples:
  memvault init                          # Setup wizard
  memvault serve                         # Start web server
  memvault sync                          # Run all sync engines
  memvault import ~/Downloads/export/    # Import AI conversations
  memvault backup                        # Back up to local + Google Drive
  memvault bridge list                   # Inspect connected AI MCP servers
  memvault bridge sync                   # Pull other AI memories into the vault
`);
  process.exit(1);
}

if (!command || ["help", "--help", "-h"].includes(command)) {
  showHelp();
}

if (!commands[command]) {
  console.error(`❌ Unknown command: ${command}`);
  showHelp();
}

const scriptPath = path.join(__dirname, commands[command].script);

// Spawn the target script natively
const child = spawn(process.execPath, [scriptPath, ...args], {
  stdio: "inherit",
  env: process.env,
});

child.on("exit", (code) => {
  process.exit(code || 0);
});
