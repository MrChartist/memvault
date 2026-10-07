#!/usr/bin/env node
/**
 * mcp-bridge.mjs — Connect MemVault OUT to other AI tools' MCP servers
 * ═══════════════════════════════════════════════════════════════════════════════
 * MemVault is itself an MCP *server* (mcp-server.mjs). This module makes it an MCP
 * *client* too: it dials into other MCP servers — memory servers, note tools,
 * other AI assistants — lists what they expose, and pulls their context into your
 * vault so every AI you use shares one brain.
 *
 * Bridges are declared in ~/.memvaultrc.json under "mcpBridges":
 *
 *   "mcpBridges": [
 *     {
 *       "name": "openmemory",
 *       "command": "npx",
 *       "args": ["-y", "openmemory"],
 *       "env": { "API_KEY": "..." },
 *       "enabled": true,
 *       "importTool": "list_memories",   // optional: tool to pull data from
 *       "importArgs": {}                  // optional: args for that tool
 *     }
 *   ]
 *
 * Usage:
 *   node mcp-bridge.mjs list                 # list tools/resources of each bridge
 *   node mcp-bridge.mjs sync [name]          # pull data into the vault
 *   node mcp-bridge.mjs call <name> <tool> '<jsonArgs>'
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { MCP_BRIDGES, loadUserConfig, saveUserConfig } from "./config.mjs";
import { ingest } from "./ingest.mjs";

const CONNECT_TIMEOUT_MS = 20000;

// ─── Preset bridges ─────────────────────────────────────────────────────────
// A curated catalog of popular, local, no-API-key AI memory MCP servers so
// `memvault bridge list` shows useful options out of the box. Enable one with
// `memvault bridge add <name>` (writes it into ~/.memvaultrc.json).
export const PRESET_BRIDGES = [
  {
    name: "memory",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-memory"],
    enabled: true,
    importTool: "read_graph",
    importArgs: {},
    description: "Official MCP knowledge-graph memory (local file, no API key).",
  },
  {
    name: "knowledge-graph",
    command: "npx",
    args: ["-y", "mcp-knowledge-graph"],
    enabled: true,
    importTool: "read_graph",
    importArgs: {},
    description: "Persistent knowledge-graph memory across chats (local file, no API key).",
  },
];

/** Add a preset bridge to ~/.memvaultrc.json (idempotent). */
export function addPreset(name) {
  const preset = PRESET_BRIDGES.find((p) => p.name === name);
  if (!preset) throw new Error(`Unknown preset "${name}". Available: ${PRESET_BRIDGES.map((p) => p.name).join(", ")}`);
  const cfg = loadUserConfig();
  cfg.mcpBridges = cfg.mcpBridges || [];
  if (cfg.mcpBridges.some((b) => b.name === name)) {
    return { added: false, name, reason: "already configured" };
  }
  const { description, ...entry } = preset; // don't persist the catalog blurb
  cfg.mcpBridges.push(entry);
  saveUserConfig(cfg);
  return { added: true, name };
}

// ─── Bridge connection ──────────────────────────────────────────────────────

/** Open an MCP client connection to a bridge. Caller must close() it. */
export async function connectBridge(bridge) {
  if (!bridge?.command) throw new Error(`Bridge "${bridge?.name}" is missing a "command".`);

  const transport = new StdioClientTransport({
    command: bridge.command,
    args: bridge.args || [],
    env: { ...process.env, ...(bridge.env || {}) },
  });

  const client = new Client(
    { name: "memvault-bridge", version: "2.1.0" },
    { capabilities: {} }
  );

  const connect = client.connect(transport);
  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error("connection timed out")), CONNECT_TIMEOUT_MS)
  );
  await Promise.race([connect, timeout]);
  return { client, transport };
}

/** Inspect a bridge: list its tools and resources. */
export async function inspectBridge(bridge) {
  const { client } = await connectBridge(bridge);
  try {
    const tools = await client.listTools().catch(() => ({ tools: [] }));
    const resources = await client.listResources().catch(() => ({ resources: [] }));
    return {
      name: bridge.name,
      tools: (tools.tools || []).map((t) => ({ name: t.name, description: t.description })),
      resources: (resources.resources || []).map((r) => ({ uri: r.uri, name: r.name })),
    };
  } finally {
    await client.close().catch(() => {});
  }
}

/** Call a single tool on a bridge and return its text output. */
export async function callBridgeTool(bridge, toolName, args = {}) {
  const { client } = await connectBridge(bridge);
  try {
    const result = await client.callTool({ name: toolName, arguments: args });
    return extractText(result);
  } finally {
    await client.close().catch(() => {});
  }
}

function extractText(result) {
  if (!result) return "";
  if (typeof result === "string") return result;
  const parts = result.content || result.contents || [];
  return parts
    .map((p) => (typeof p === "string" ? p : p.text || p.blob || ""))
    .filter(Boolean)
    .join("\n\n");
}

// ─── Ingestion into the vault ───────────────────────────────────────────────

// Bridged content comes from OTHER tools' servers, so it is untrusted: ingest() masks
// secrets and writes it as ordinary shared memory tagged with its source.
async function ingestEntry(entry) {
  ingest(entry, { actor: `bridge:${entry.source || "mcp"}` });
  return true;
}

/**
 * Pull data from a bridge into the vault.
 *   • If bridge.importTool is set → call it and ingest the output.
 *   • Otherwise → read every resource the bridge exposes and ingest each.
 */
export async function syncBridge(bridge) {
  const { client } = await connectBridge(bridge);
  const now = new Date().toISOString();
  let ingested = 0;
  const errors = [];

  try {
    if (bridge.importTool) {
      const result = await client.callTool({
        name: bridge.importTool,
        arguments: bridge.importArgs || {},
      });
      const text = extractText(result);
      if (text.trim()) {
        await ingestEntry({
          type: "conversation",
          source: `mcp:${bridge.name}`,
          title: `[${bridge.name}] ${bridge.importTool}`,
          content: text,
          tags: `mcp-bridge,${bridge.name}`,
          created_at: now,
        });
        ingested++;
      }
    } else {
      const { resources = [] } = await client.listResources().catch(() => ({ resources: [] }));
      for (const r of resources) {
        try {
          const read = await client.readResource({ uri: r.uri });
          const text = extractText(read);
          if (!text.trim()) continue;
          await ingestEntry({
            type: "conversation",
            source: `mcp:${bridge.name}`,
            title: `[${bridge.name}] ${r.name || r.uri}`,
            content: text,
            tags: `mcp-bridge,${bridge.name}`,
            created_at: now,
          });
          ingested++;
        } catch (e) {
          errors.push(`${r.uri}: ${e.message}`);
        }
      }
    }
  } finally {
    await client.close().catch(() => {});
  }

  return { name: bridge.name, ingested, errors };
}

/** Bridges that are enabled in config. */
export function enabledBridges() {
  return (MCP_BRIDGES || []).filter((b) => b.enabled !== false && b.command);
}

// ─── CLI ────────────────────────────────────────────────────────────────────

// Compare real file paths, not URL strings: a path with a space, non-Latin letters or a symlink
// (an npm "bin" link) does not match a hand-built file:// URL, and the command would silently do nothing.
const isMain = (() => {
  try { return !!process.argv[1] && fs.realpathSync(fileURLToPath(import.meta.url)) === fs.realpathSync(path.resolve(process.argv[1])); }
  catch { return false; }
})();
if (isMain) {
  const [cmd, ...rest] = process.argv.slice(2);
  const bridges = enabledBridges();

  const showPresets = () => {
    const configured = new Set((loadUserConfig().mcpBridges || []).map((b) => b.name));
    const available = PRESET_BRIDGES.filter((p) => !configured.has(p.name));
    if (available.length) {
      console.log(`\n📚 Available presets — enable with \`memvault bridge add <name>\`:`);
      for (const p of available) console.log(`   • ${p.name.padEnd(16)} ${p.description}`);
    }
  };

  const run = async () => {
    if (!cmd || cmd === "list") {
      if (bridges.length === 0) {
        console.log("ℹ️  No MCP bridges enabled yet.");
      } else {
        for (const b of bridges) {
          console.log(`\n🔌 ${b.name}  (${b.command} ${(b.args || []).join(" ")})`);
          try {
            const info = await inspectBridge(b);
            console.log(`   Tools     : ${info.tools.map((t) => t.name).join(", ") || "(none)"}`);
            console.log(`   Resources : ${info.resources.map((r) => r.name || r.uri).join(", ") || "(none)"}`);
          } catch (e) {
            console.log(`   ❌ ${e.message}`);
          }
        }
      }
      showPresets();
    } else if (cmd === "presets") {
      console.log("📚 Preset AI memory servers:");
      for (const p of PRESET_BRIDGES) console.log(`   • ${p.name.padEnd(16)} ${p.description}`);
    } else if (cmd === "add") {
      const name = rest[0];
      if (!name) { console.error("Usage: node mcp-bridge.mjs add <preset-name>"); process.exit(1); }
      const res = addPreset(name);
      console.log(res.added ? `✅ Added bridge "${name}". Try: memvault bridge sync ${name}` : `ℹ️  "${name}" ${res.reason}.`);
    } else if (cmd === "sync") {
      if (bridges.length === 0) { console.log("ℹ️  No bridges enabled. Run `memvault bridge add <name>` first."); return; }
      const targetName = rest[0];
      const targets = targetName ? bridges.filter((b) => b.name === targetName) : bridges;
      if (targets.length === 0) { console.error(`Bridge not found: ${targetName}`); process.exit(1); }
      for (const b of targets) {
        process.stdout.write(`🔄 Syncing ${b.name} ... `);
        try {
          const r = await syncBridge(b);
          console.log(`ingested ${r.ingested} item(s)${r.errors.length ? `, ${r.errors.length} error(s)` : ""}`);
        } catch (e) {
          console.log(`❌ ${e.message}`);
        }
      }
    } else if (cmd === "call") {
      const [name, tool, jsonArgs] = rest;
      const bridge = bridges.find((b) => b.name === name);
      if (!bridge) { console.error(`Bridge not found: ${name}`); process.exit(1); }
      const args = jsonArgs ? JSON.parse(jsonArgs) : {};
      console.log(await callBridgeTool(bridge, tool, args));
    } else {
      console.error(`Unknown command: ${cmd}\nUsage: node mcp-bridge.mjs [list|sync|call]`);
      process.exit(1);
    }
  };

  run().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
}
