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
import initSqlJs from "sql.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { API_URL, MCP_BRIDGES, VAULT_ROOT, loadUserConfig, saveUserConfig } from "./config.mjs";

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

let _sqlDb = null;
async function directDbInsert(entry) {
  // Fallback path used when the web API isn't running.
  const DB_PATH = path.join(VAULT_ROOT, "db", "index.sqlite");
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  if (!_sqlDb) {
    const Sql = await initSqlJs();
    _sqlDb = fs.existsSync(DB_PATH) ? new Sql.Database(fs.readFileSync(DB_PATH)) : new Sql.Database();
    _sqlDb.run(`CREATE TABLE IF NOT EXISTS items (
      id TEXT PRIMARY KEY, type TEXT NOT NULL, source TEXT, title TEXT,
      content TEXT, file_path TEXT, tags TEXT, created_at TEXT NOT NULL);`);
  }
  const id = `${entry.type}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  _sqlDb.run(
    `INSERT INTO items (id,type,source,title,content,file_path,tags,created_at) VALUES (?,?,?,?,?,?,?,?)`,
    [id, entry.type, entry.source, entry.title, entry.content, null, entry.tags, entry.created_at]
  );
  fs.writeFileSync(DB_PATH, Buffer.from(_sqlDb.export()));
  return true;
}

async function ingest(entry) {
  try {
    const res = await fetch(`${API_URL}/add`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(entry),
    });
    if (res.ok) return true;
  } catch { /* API not running — fall back to direct DB write */ }
  return directDbInsert(entry);
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
        await ingest({
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
          await ingest({
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

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
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
