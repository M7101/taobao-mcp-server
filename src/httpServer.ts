#!/usr/bin/env node

import express, { type Request, type Response, type NextFunction } from "express";
import { randomUUID } from "crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpServer } from "./mcpServer.js";
import { TaobaoClient } from "./taobao.js";
import { getOrCreateAuthToken } from "./auth.js";
import { createOAuthShim } from "./oauth.js";

// Local/private MCP entry point. The process binds to loopback by default so
// the local tunnel runtime can reach it without exposing the Taobao session to
// the LAN. Non-loopback callers still need bearer/OAuth authentication.
const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? "127.0.0.1";
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL ?? `http://localhost:${PORT}`;
const TRUST_LOOPBACK = (process.env.MCP_TRUST_LOOPBACK ?? "true").toLowerCase() !== "false";

// One shared TaobaoClient (and its one persistent browser page) across
// every HTTP session, so buyNow/payNow keep acting on the same live page.
const taobaoClient = new TaobaoClient();

const transports = new Map<string, StreamableHTTPServerTransport>();

function isLoopback(req: Request): boolean {
  const ip = req.socket.remoteAddress ?? "";
  return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
}

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

  // The OpenAI tunnel runtime connects locally from loopback. When the server
  // is loopback-bound, allowing that local hop without a second bearer token
  // avoids an unusable localhost OAuth redirect while keeping remote callers
  // protected. Set MCP_TRUST_LOOPBACK=false to require bearer auth even locally.
  function requireBearerToken(req: Request, res: Response, next: NextFunction) {
    if (TRUST_LOOPBACK && isLoopback(req)) {
      next();
      return;
    }

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

  app.listen(PORT, HOST, () => {
    console.error(`Taobao MCP server (HTTP) listening on ${HOST}:${PORT}, endpoint POST/GET /mcp`);
  });
}

main().catch((error) => {
  console.error("Fatal error in main():", error);
  process.exit(1);
});
