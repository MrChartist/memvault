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
  init: { script: "init.mjs", desc: "Run the interactive setup wizard" },
  serve: { script: "server.mjs", desc: "Start the API & Web server (localhost:7799)" },
  mcp: { script: "mcp-server.mjs", desc: "Start the MCP stdio server" },
  sync: { script: "sync-all.mjs", desc: "Run all enabled sync engines" },
  vault: { script: "vault.mjs", desc: "CLI tool to add/search items (alias for vault.mjs)" },
};

function showHelp() {
  console.log(`
🗄️  MemVault CLI

Usage: memvault <command>

Commands:`);
  for (const [cmd, info] of Object.entries(commands)) {
    console.log(`  ${cmd.padEnd(8)} ${info.desc}`);
  }
  console.log(`
Examples:
  npx memvault init
  npx memvault sync
  memvault serve
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
