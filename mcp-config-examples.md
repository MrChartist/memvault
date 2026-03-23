# MemVault MCP — Client Configuration Guides

## Claude Desktop

Add this to `%APPDATA%\Claude\claude_desktop_config.json` (Windows) or `~/Library/Application Support/Claude/claude_desktop_config.json` (Mac):

```json
{
  "mcpServers": {
    "memvault": {
      "command": "npx",
      "args": ["memvault", "mcp"]
    }
  }
}
```

## Cursor

Add this to Cursor settings (Cursor Settings > Features > MCP):

- **Name**: `memvault`
- **Type**: `command`
- **Command**: `npx memvault mcp`

## Antigravity

Antigravity auto-loads MCP servers from its `mcp_config.json` in the tool's core directory (`~/.gemini/antigravity/mcp_config.json`):

```json
{
  "mcpServers": {
    "memvault": {
      "command": "npx",
      "args": ["memvault", "mcp"]
    }
  }
}
```

## VS Code

Currently, VS Code extensions like Cline or RooCode require providing the command in their respective MCP configuration files (often `mcp_settings.json` in the workspace root or global config):

```json
{
  "mcpServers": {
    "memvault": {
      "command": "npx",
      "args": ["memvault", "mcp"]
    }
  }
}
```
