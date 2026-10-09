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
import { getVersion } from "./util.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const [, , command, ...args] = process.argv;

const commands = {
  init:    { script: "init.mjs",       desc: "Run the interactive setup wizard" },
  serve:   { script: "server.mjs",     desc: "Start the API & web UI (http://localhost:7799)" },
  mcp:     { script: "mcp-server.mjs", desc: "Start the MCP stdio server (what AI clients launch)" },
  sync:    { script: "sync-all.mjs",   desc: "Run all enabled sync engines" },
  import:  { script: "import-all.mjs", desc: "Import AI conversations (ChatGPT, Claude, Gemini, Perplexity)" },
  backup:  { script: "storage.mjs",    desc: "Back up the vault to local + Google Drive (also: list | restore <name>)" },
  bridge:  { script: "mcp-bridge.mjs", desc: "Connect other AI MCP servers (list|presets|add|sync|call)" },
  vault:   { script: "vault.mjs",      desc: "Add or search entries from the terminal" },
};

function showHelp(exitCode) {
  const out = exitCode === 0 ? console.log : console.error;
  out(`
🗄️  MemVault ${getVersion()} — Universal AI Memory Layer

Usage: memvault <command> [options]

Commands:`);
  for (const [cmd, info] of Object.entries(commands)) out(`  ${cmd.padEnd(10)} ${info.desc}`);
  out(`
Examples:
  memvault init                          # Setup wizard
  memvault serve                         # Start the web UI
  memvault sync                          # Run all enabled sync engines
  memvault import ~/Downloads/export/    # Import AI conversations
  memvault backup                        # Back up to local + Google Drive
  memvault bridge list                   # Inspect connected AI MCP servers
  memvault vault search "auth bug"       # Search from the terminal
`);
  process.exit(exitCode);
}

if (["--version", "-v", "version"].includes(command)) {
  console.log(getVersion());
  process.exit(0);
}
if (["help", "--help", "-h"].includes(command)) showHelp(0);
if (!command) showHelp(1);
if (!Object.hasOwn(commands, command)) {
  console.error(`❌ Unknown command: ${command}`);
  showHelp(1);
}

// Run the target script as a child process, sharing stdin/stdout (needed for the MCP stdio transport).
const child = spawn(process.execPath, [path.join(__dirname, commands[command].script), ...args], {
  stdio: "inherit",
  env: process.env,
});

child.on("error", (e) => {
  console.error(`❌ Could not start ${commands[command].script}: ${e.message}`);
  process.exit(1);
});
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));

// Forward termination so the child (e.g. the MCP server) is not orphaned.
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => child.kill(sig));
