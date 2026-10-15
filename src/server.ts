import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { PrintfulClient } from "./printful.js";
import { registerTools } from "./tools.js";

export const SERVER_VERSION = "0.1.0";

export function createServer(client: PrintfulClient, secrets: readonly string[] = []): McpServer {
  const server = new McpServer({
    name: "printful-mcp",
    version: SERVER_VERSION,
  });
  registerTools(server, client, secrets);
  return server;
}
