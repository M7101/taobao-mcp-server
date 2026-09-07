#!/usr/bin/env node

import express, { type Request, type Response, type NextFunction } from "express";
import { randomUUID } from "crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpServer } from "./mcpServer.js";
import { TaobaoClient } from "./taobao.js";
import { getOrCreateAuthToken } from "./auth.js";
import { createOAuthShim } from "./oauth.js";

// Public-facing entry point — meant to sit behind a Cloudflare Tunnel so
// claude.ai's remote MCP connector can reach it. Unlike server.ts (stdio,
// local-only, no auth needed), every request here MUST carry a valid
// bearer token: this server holds a live, real, logged-in Taobao session
// and exposes pay_now_taobao, which spends real money the instant it's
// called — there is no other gate in front of it once this is on the
// public internet, so the bearer check below is not optional.
const PORT = Number(process.env.PORT ?? 8787);
// Must be set to the real public URL (e.g. your Cloudflare Tunnel hostname)
// once this sits behind one — it's baked into the OAuth issuer/endpoint
// URLs and the WWW-Authenticate header, so claude.ai's connector can't
// complete the auth flow against a wrong or placeholder value. Defaults to
// localhost so `npm run dev` still boots without configuring a tunnel.
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL ?? `http://localhost:${PORT}`;

// One shared TaobaoClient (and its one persistent browser page) across
// every HTTP session, same as the stdio entry point — buyNow/payNow must
// keep acting on the same live confirm-order page across separate tool
// calls regardless of which transport carried them.
const taobaoClient = new TaobaoClient();

const transports = new Map<string, StreamableHTTPServerTransport>();

async function main() {
  await taobaoClient.initialize();
  const token = await getOrCreateAuthToken();
  console.error(`Bearer token (also in ${process.cwd()}/mcp-auth-token.txt): ${token}`);

  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  // claude.ai's connector runs the MCP request through a browser fetch, which
  // sends a CORS preflight OPTIONS request first. Without these headers the
  // preflight either gets rejected by requireBearerToken (browsers never
  // attach custom headers/auth to a preflight) or succeeds but the browser
  // still discards the real response because mcp-session-id isn't in the
  // allow-list of readable response headers — either way the client sees a
  // silent "can't connect" with no useful error.
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

  // claude.ai's connector UI has no field to paste a static token — it only
  // speaks the MCP Authorization spec's OAuth flow, and gives up with "无法
  // 启动mcp授权" the instant /mcp 401s without also exposing the discovery/
  // register/authorize/token endpoints that flow needs. This shim (oauth.ts)
  // provides exactly that, gated by a password prompt on /authorize using
  // the same secret that used to be pasted directly as a bearer token.
  const oauth = createOAuthShim({ secret: token, publicBaseUrl: PUBLIC_BASE_URL });
  app.use(oauth.router);

  // Accepts either the static secret directly (manual/curl testing, or the
  // `?token=<token>` query-param fallback) or a short-lived access token
  // minted by completing the OAuth flow above.
  function requireBearerToken(req: Request, res: Response, next: NextFunction) {
    const header = req.header("authorization") ?? "";
    const fromHeader = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
    const fromQuery = typeof req.query.token === "string" ? req.query.token : "";
    const candidate = fromHeader || fromQuery;
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
