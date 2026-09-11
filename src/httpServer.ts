#!/usr/bin/env node

import express, { type Request, type Response, type NextFunction } from "express";
import { randomUUID } from "crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpServer } from "./mcpServer.js";
import { TaobaoClient } from "./taobao.js";
import { getOrCreateAuthToken } from "./auth.js";
import { createOAuthShim } from "./oauth.js";

// Public-facing entry point. Every MCP request must carry a valid bearer
// token: this server holds a live logged-in Taobao session and exposes a
// real payment path. Query-string tokens are deliberately not accepted,
// because URLs are commonly retained in browser history, proxy logs and
// analytics. Use Authorization: Bearer ... or the OAuth flow below.
const PORT = Number(process.env.PORT ?? 8787);
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL ?? `http://localhost:${PORT}`;

// One shared TaobaoClient (and its one persistent browser page) across
// every HTTP session, so buyNow/payNow keep acting on the same live page.
const taobaoClient = new TaobaoClient();

const transports = new Map<string, StreamableHTTPServerTransport>();

async function main() {
  await taobaoClient.initialize();
  const token = await getOrCreateAuthToken();
  console.error(`Bearer token (also in ${process.cwd()}/mcp-auth-token.txt): ${token}`);

  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  app.use((req: Request, res: Response, next: NextFunction) => {
    res.header("Access-Control-Allow-Origin", req.header("origin") ?? "*");
    res.header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.header("Access-Control-Allow-Headers", "Authorization, Content-Type, mcp-session-id");
    res.header("Access-Control-Expose-Headers", "mcp-session-id");
    if (req.method === "OPTIONS") {
      res.sendStatus(204);
      return;
    }
    next();
  });

  const oauth = createOAuthShim({ secret: token, publicBaseUrl: PUBLIC_BASE_URL });
  app.use(oauth.router);

  // Accept either the host's static secret in the Authorization header
  // (useful for local/manual testing) or a short-lived OAuth access token.
  // Never accept credentials from the URL/query string.
  function requireBearerToken(req: Request, res: Response, next: NextFunction) {
    const header = req.header("authorization") ?? "";
    const candidate = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
    if (candidate === token || oauth.isValidAccessToken(candidate)) {
      next();
      return;
    }
    res
      .status(401)
      .header("WWW-Authenticate", `Bearer resource_metadata="${PUBLIC_BASE_URL}/.well-known/oauth-protected-resource"`)
      .json({ error: "unauthorized" });
  }

  app.all("/mcp", requireBearerToken, async (req: Request, res: Response) => {
    const sessionId = req.header("mcp-session-id");
    let transport = sessionId ? transports.get(sessionId) : undefined;

    if (!transport) {
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          transports.set(id, transport!);
        },
      });
      transport.onclose = () => {
        if (transport!.sessionId) transports.delete(transport!.sessionId);
      };
      const server = createMcpServer(taobaoClient);
      await server.connect(transport);
    }

    await transport.handleRequest(req, res, req.body);
  });

  app.listen(PORT, () => {
    console.error(`Taobao MCP server (HTTP) listening on :${PORT}, endpoint POST/GET /mcp`);
  });
}

main().catch((error) => {
  console.error("Fatal error in main():", error);
  process.exit(1);
});
