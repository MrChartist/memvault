# MemVault MCP — Client Configuration Guides

MemVault runs as a local **stdio** MCP server: the client launches it, so nothing needs to be started
beforehand and nothing listens on the network. Use the same entry in every client:

```json
{
  "mcpServers": {
    "memvault": {
      "command": "npx",
      "args": ["-y", "@mrchartist/memvault", "mcp"]
    }
  }
}
```

> Always use the **scoped** name `@mrchartist/memvault`. The unscoped `memvault` package on npm is a different, unrelated project.

The vault location comes from `~/.memvaultrc.json` (created by `npx -y @mrchartist/memvault init`). To override it for one client add
`"env": { "VAULT_ROOT": "/path/to/vault" }`. Running from a git clone? Use `"command": "node", "args": ["/absolute/path/to/memvault/mcp-server.mjs"]`.

Client-specific notes follow.

## Claude Desktop

Add this to `%APPDATA%\Claude\claude_desktop_config.json` (Windows) or `~/Library/Application Support/Claude/claude_desktop_config.json` (Mac):

```json
{
  "mcpServers": {
    "memvault": {
      "command": "npx",
      "args": ["-y", "@mrchartist/memvault", "mcp"]
    }
  }
}
```

## Cursor

Add this to Cursor settings (Cursor Settings > Features > MCP):

- **Name**: `memvault`
- **Type**: `command`
- **Command**: `npx -y @mrchartist/memvault mcp`

## Antigravity

Antigravity auto-loads MCP servers from its `mcp_config.json` in the tool's core directory (`~/.gemini/antigravity/mcp_config.json`):

```json
{
  "mcpServers": {
    "memvault": {
      "command": "npx",
      "args": ["-y", "@mrchartist/memvault", "mcp"]
    }
  }
}
```

> **Connect MemVault to *other* AI MCP servers (bridges):** MemVault can also act
> as an MCP client and pull context from other AI tools into your vault. See
> [mcp-bridge.md](mcp-bridge.md).

## VS Code

Currently, VS Code extensions like Cline or RooCode require providing the command in their respective MCP configuration files (often `mcp_settings.json` in the workspace root or global config):

```json
{
  "mcpServers": {
    "memvault": {
      "command": "npx",
      "args": ["-y", "@mrchartist/memvault", "mcp"]
    }
  }
}
```
