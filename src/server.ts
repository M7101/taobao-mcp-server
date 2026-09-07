#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpServer } from "./mcpServer.js";
import { TaobaoClient } from "./taobao.js";

// Local-only entry point — this is what Claude Desktop launches directly
// (see claude_desktop_config.json's "taobao" entry). No auth needed here:
// stdio means only a local process that spawned this one can talk to it.
// httpServer.ts is the separate, bearer-token-gated entry point used for
// the Cloudflare Tunnel / claude.ai remote connector.
async function main() {
  const taobaoClient = new TaobaoClient();
  await taobaoClient.initialize();
  const server = createMcpServer(taobaoClient);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Taobao MCP server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error in main():", error);
  process.exit(1);
});
