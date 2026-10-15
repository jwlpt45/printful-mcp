#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { PrintfulClient } from "./printful.js";
import { createServer } from "./server.js";

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const client = new PrintfulClient({
    token: config.token,
    baseUrl: config.baseUrl,
    ...(config.storeId ? { storeId: config.storeId } : {}),
  });
  const server = createServer(client, [config.token]);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "printful-mcp failed to start.";
  console.error(message);
  process.exit(1);
});
