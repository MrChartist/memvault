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

// In-process commands (fast, no server needed) — implemented in cli-tools.mjs
const tools = {
  setup:      { fn: "cmdSetup",     desc: "One-step setup: vault, API token, starter agents (no questions)" },
  open:       { fn: "cmdOpen",      desc: "Open the dashboard (starts the server if needed)" },
  doctor:     { fn: "cmdDoctor",    desc: "Check your setup: permissions, exposure, backups, secrets" },
  scrub:      { fn: "cmdScrub",     desc: "Mask credentials already stored in your vault (preview first)" },
  agent:      { fn: "cmdAgent",     desc: "Manage agent profiles (list|create|edit|brief|export|…)" },
  audit:      { fn: "cmdAudit",     desc: "Show who accessed the vault; verify the log is untampered" },
  token:      { fn: "cmdToken",     desc: "Print the dashboard/API token (--rotate to replace it)" },
  "mcp-config": { fn: "cmdMcpConfig", desc: "Print ready-to-paste MCP config for your AI clients" },
};

// Script commands — run as separate processes
const commands = {
  init:    { script: "init.mjs",       desc: "Run the interactive setup wizard (sync engines, AI, Drive)" },
  serve:   { script: "server.mjs",     desc: "Start the API & Web server (127.0.0.1:7799)" },
  mcp:     { script: "mcp-server.mjs", desc: "Start the MCP stdio server" },
  sync:    { script: "sync-all.mjs",   desc: "Run all enabled sync engines" },
  import:  { script: "import-all.mjs", desc: "Import AI conversations (ChatGPT, Claude, Gemini, Perplexity)" },
  backup:  { script: "storage.mjs",    desc: "Back up the vault to local + Google Drive" },
  bridge:  { script: "mcp-bridge.mjs", desc: "Connect other AI MCP servers (list|presets|add|sync|call)" },
  vault:   { script: "vault.mjs",      desc: "CLI tool to add/search items" },
  clipboard: { script: "sync-clipboard.mjs", desc: "Watch what you copy and save it (off until switched on; passwords are hidden)" },
};

function showHelp(exitCode = 0) {
  console.log(`
🗄️  MemVault CLI — one local memory for every AI you use
    Part of the Mr. Chartist ecosystem · MrChartist.com

Usage: memvault <command> [options]

Commands:`);
  for (const [cmd, info] of Object.entries({ ...tools, ...commands })) {
    console.log(`  ${cmd.padEnd(11)} ${info.desc}`);
  }
  console.log(`
Start here:
  memvault setup                         # one step, no questions
  memvault mcp-config --agent market-analyst   # paste into your AI client
  memvault open                          # dashboard
  memvault doctor                        # verify your setup

More:
  memvault init                          # Setup wizard
  memvault serve                         # Start web server
  memvault sync                          # Run all sync engines
  memvault import ~/Downloads/export/    # Import AI conversations
  memvault backup                        # Back up to local + Google Drive
  memvault bridge list                   # Inspect connected AI MCP servers
  memvault bridge sync                   # Pull other AI memories into the vault
  memvault clipboard                     # Save what you copy (switch it on in Settings first)
`);
  process.exit(exitCode);
}

if (!command || ["help", "--help", "-h"].includes(command)) {
  showHelp();
}

if (tools[command]) {
  const mod = await import("./cli-tools.mjs");
  await mod[tools[command].fn](args);
  process.exit(process.exitCode || 0);
}

if (!commands[command]) {
  console.error(`❌ Unknown command: ${command}`);
  showHelp(1);
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
