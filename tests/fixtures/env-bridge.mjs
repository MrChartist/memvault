// A tiny MCP server used by the bridge tests: its one tool reports which environment variables it was started with.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
const server = new McpServer({ name: "env-bridge", version: "1" });
server.tool("env", "Report environment variable names", {}, async () => ({
  content: [{ type: "text", text: JSON.stringify(Object.keys(process.env)) }],
}));
await server.connect(new StdioServerTransport());
