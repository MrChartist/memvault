# 🔌 MCP Bridges — One Memory Across Every AI

MemVault works in **both directions**:

1. **Inbound** — MemVault is an MCP *server*, so Claude, Cursor, VS Code, and
   Antigravity can read your vault. (See the main README → *MCP Integration*.)
2. **Outbound** — MemVault is also an MCP *client* (a "bridge"). It dials into
   **other** AI tools' MCP servers, pulls their context, and stores it in your
   vault. The result: every AI you use shares one brain.

---

## Quick start with presets

MemVault ships a catalog of popular, **local, no-API-key** memory servers so
bridging works out of the box. List them and enable one in a single command:

```bash
npx -y @mrchartist/memvault bridge presets        # see the catalog
npx -y @mrchartist/memvault bridge add memory     # enable the official knowledge-graph memory
npx -y @mrchartist/memvault bridge sync memory    # pull its memories into your vault
```

| Preset | Package | Notes |
|--------|---------|-------|
| `memory` | `@modelcontextprotocol/server-memory` | Official MCP knowledge-graph memory (local file) |
| `knowledge-graph` | `mcp-knowledge-graph` | Persistent knowledge graph across chats (local file) |

`bridge add` writes the entry into `~/.memvaultrc.json`; `bridge list` shows any
remaining presets you haven't enabled yet. The setup wizard (`memvault init`)
can also enable them for you.

## Configure bridges

Add a `mcpBridges` array to `~/.memvaultrc.json`. Each entry describes an
external MCP server to connect to:

```json
{
  "mcpBridges": [
    {
      "name": "openmemory",
      "command": "npx",
      "args": ["-y", "openmemory"],
      "env": { "OPENMEMORY_API_KEY": "..." },
      "enabled": true,
      "importTool": "list_memories",
      "importArgs": {}
    },
    {
      "name": "obsidian",
      "command": "npx",
      "args": ["-y", "obsidian-mcp", "/path/to/vault"],
      "enabled": true
    }
  ]
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `name` | ✅ | Label used for tags/sources (`mcp:<name>`) |
| `command` | ✅ | Executable to launch the external MCP server (stdio) |
| `args` | | Arguments passed to the command |
| `env` | | Extra environment variables (merged over your shell env) |
| `enabled` | | Set `false` to keep the config but skip it |
| `importTool` | | A tool on that server to call when syncing. If omitted, MemVault reads **all** of the server's resources instead. |
| `importArgs` | | Arguments for `importTool` |

---

## Use bridges

```bash
# Inspect what each connected server exposes (tools + resources)
npx -y @mrchartist/memvault bridge list

# Pull data from all bridges into the vault
npx -y @mrchartist/memvault bridge sync

# Pull from just one bridge
npx -y @mrchartist/memvault bridge sync openmemory

# Call a specific tool on a bridge ad-hoc
node mcp-bridge.mjs call openmemory search '{"query":"auth bug"}'
```

From an AI client, the same is available as MCP tools:

- `vault_bridge_list` — list bridges and their tools/resources
- `vault_bridge_sync` — pull other AI memories into the vault

Ingested items are stored as `conversation` entries with source `mcp:<name>` and
the tag `mcp-bridge`, so they show up in normal vault search.

---

## How sync works

- If `importTool` is set → MemVault calls it with `importArgs` and saves the text
  it returns.
- Otherwise → MemVault lists every resource the server exposes and saves each
  one's contents.

MemVault writes straight into the vault database, so bridging works whether or
not the web server is running. Each sync **replaces** the previous copy of the
same item (same bridge + tool/resource), so running it on a schedule does not pile
up duplicates.

## Security notes

- A bridge is a program that MemVault **launches on your machine** (`command` +
  `args`). The presets use `npx -y`, which downloads and runs a package from npm.
  Only add bridges you trust, and review `mcpBridges` in `~/.memvaultrc.json`.
- Bridges receive a minimal environment (`PATH`, `HOME`, ...) plus whatever you put
  in the bridge's own `"env"` — your other environment variables, such as API keys,
  are **not** passed along.
- Whatever a bridge returns is stored in your vault as ordinary text and can later
  be shown to your AI clients, so treat it as untrusted input.
