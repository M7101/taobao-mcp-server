import { Router, type Request, type Response } from "express";
import { createHash, randomBytes, randomUUID } from "crypto";

// Minimal single-user OAuth 2.1 + PKCE shim for remote MCP clients.
// The authorization password remains the human gate, but client IDs and
// redirect URIs are also bound and checked so an authorize request cannot
// silently invent a new client or swap the callback destination.
const CODE_TTL_MS = 5 * 60 * 1000;
const ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000;
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

interface ClientRecord {
  redirectUris: string[];
}
interface AuthCodeRecord {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  expiresAt: number;
}
interface TokenRecord {
  clientId: string;
  expiresAt: number;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

function pkceMatches(verifier: string, challenge: string, method: string): boolean {
  if (method !== "S256") return false;
  const hash = createHash("sha256").update(verifier).digest();
  const b64url = hash.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return b64url === challenge;
}

function isAllowedRedirectUri(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol === "https:") return true;
    if (url.protocol !== "http:") return false;
    return url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  } catch {
    return false;
  }
}

export function createOAuthShim(opts: { secret: string; publicBaseUrl: string }) {
  const { secret, publicBaseUrl } = opts;
  const clients = new Map<string, ClientRecord>();
  const codes = new Map<string, AuthCodeRecord>();
  const accessTokens = new Map<string, TokenRecord>();
  const refreshTokens = new Map<string, TokenRecord>();

  function isValidAccessToken(token: string): boolean {
    if (!token) return false;
    const rec = accessTokens.get(token);
    if (!rec) return false;
    if (rec.expiresAt < Date.now()) {
      accessTokens.delete(token);
      return false;
    }
    return true;
  }

  function clientAllowsRedirect(clientId: string, redirectUri: string): boolean {
    const client = clients.get(clientId);
    return !!client && client.redirectUris.includes(redirectUri);
  }

  function renderAuthorizeForm(params: Record<string, string>, error?: string): string {
    const hidden = ["client_id", "redirect_uri", "state", "code_challenge", "code_challenge_method", "scope"]
      .map((k) => `<input type="hidden" name="${k}" value="${escapeHtml(params[k] ?? "")}">`)
      .join("\n  ");
    return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Taobao MCP 授权</title>
<style>
body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;max-width:360px;margin:15vh auto 0;padding:0 24px;color:#222}
input[type=password]{width:100%;padding:12px;font-size:16px;margin:10px 0;box-sizing:border-box;border:1px solid #ccc;border-radius:6px}
button{width:100%;padding:12px;font-size:16px;background:#ff5000;color:#fff;border:none;border-radius:6px}
.err{color:#c00;font-size:14px;margin:4px 0}
</style></head>
<body>
<h2>授权访问 Taobao MCP</h2>
<p>只有拥有访问密码的人可以完成授权。</p>
${error ? `<p class="err">${escapeHtml(error)}</p>` : ""}
<form method="POST">
  ${hidden}
  <input type="password" name="password" placeholder="访问密码" autofocus required>
  <button type="submit">授权</button>
</form>
</body></html>`;
  }

  const router = Router();

  router.get("/.well-known/oauth-protected-resource", (_req: Request, res: Response) => {
    res.json({
      resource: `${publicBaseUrl}/mcp`,
      authorization_servers: [publicBaseUrl],
    });
  });

  router.get("/.well-known/oauth-authorization-server", (_req: Request, res: Response) => {
    res.json({
      issuer: publicBaseUrl,
      authorization_endpoint: `${publicBaseUrl}/authorize`,
      token_endpoint: `${publicBaseUrl}/token`,
      registration_endpoint: `${publicBaseUrl}/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      scopes_supported: ["mcp"],
    });
  });

  router.post("/register", (req: Request, res: Response) => {
    const redirectUris: string[] = Array.isArray(req.body?.redirect_uris)
      ? req.body.redirect_uris.map(String)
      : [];
    if (redirectUris.length === 0 || redirectUris.some((uri) => !isAllowedRedirectUri(uri))) {
      res.status(400).json({
        error: "invalid_redirect_uri",
        error_description: "At least one HTTPS redirect URI (or localhost HTTP URI) is required.",
      });
      return;
    }

    const clientId = randomUUID();
    clients.set(clientId, { redirectUris: [...new Set(redirectUris)] });
    res.status(201).json({
      client_id: clientId,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      redirect_uris: [...new Set(redirectUris)],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    });
  });

  router.get("/authorize", (req: Request, res: Response) => {
    const params = {
      client_id: String(req.query.client_id ?? ""),
      redirect_uri: String(req.query.redirect_uri ?? ""),
      state: String(req.query.state ?? ""),
      code_challenge: String(req.query.code_challenge ?? ""),
      code_challenge_method: String(req.query.code_challenge_method ?? "S256"),
      scope: String(req.query.scope ?? ""),
    };
    if (!params.client_id || !params.redirect_uri || !params.code_challenge) {
      res.status(400).send("Missing required OAuth parameters");
      return;
    }
    if (params.code_challenge_method !== "S256") {
      res.status(400).send("Only PKCE S256 is supported");
      return;
    }
    if (!clientAllowsRedirect(params.client_id, params.redirect_uri)) {
      res.status(400).send("Unknown client_id or unregistered redirect_uri");
      return;
    }
    res.set("Content-Type", "text/html; charset=utf-8").send(renderAuthorizeForm(params));
  });

  router.post("/authorize", (req: Request, res: Response) => {
    const params = {
      client_id: String(req.body?.client_id ?? ""),
      redirect_uri: String(req.body?.redirect_uri ?? ""),
      state: String(req.body?.state ?? ""),
      code_challenge: String(req.body?.code_challenge ?? ""),
      code_challenge_method: String(req.body?.code_challenge_method ?? "S256"),
      scope: String(req.body?.scope ?? ""),
    };
    if (!clientAllowsRedirect(params.client_id, params.redirect_uri) || params.code_challenge_method !== "S256") {
      res.status(400).send("Invalid OAuth client, redirect URI, or PKCE method");
      return;
    }

    const password = String(req.body?.password ?? "");
    if (password !== secret) {
      res.status(401).set("Content-Type", "text/html; charset=utf-8").send(renderAuthorizeForm(params, "密码错误，请重试"));
      return;
    }
    const code = randomBytes(24).toString("hex");
    codes.set(code, {
      clientId: params.client_id,
      redirectUri: params.redirect_uri,
      codeChallenge: params.code_challenge,
      codeChallengeMethod: params.code_challenge_method,
      expiresAt: Date.now() + CODE_TTL_MS,
    });
    const redirectUrl = new URL(params.redirect_uri);
    redirectUrl.searchParams.set("code", code);
    if (params.state) redirectUrl.searchParams.set("state", params.state);
    res.redirect(302, redirectUrl.toString());
  });

  router.post("/token", (req: Request, res: Response) => {
    const grantType = req.body?.grant_type;
    if (grantType === "authorization_code") {
      const code = String(req.body?.code ?? "");
      const codeVerifier = String(req.body?.code_verifier ?? "");
      const clientId = String(req.body?.client_id ?? "");
      const redirectUri = String(req.body?.redirect_uri ?? "");
      const record = codes.get(code);
      if (!record || record.expiresAt < Date.now()) {
        res.status(400).json({ error: "invalid_grant" });
        return;
      }
      // Consume the code once it reaches the token endpoint. Even a failed
      // validation must not leave a reusable authorization code behind.
      codes.delete(code);
      if (!clientId || clientId !== record.clientId) {
        res.status(400).json({ error: "invalid_grant", error_description: "client_id mismatch" });
        return;
      }
      if (redirectUri && redirectUri !== record.redirectUri) {
        res.status(400).json({ error: "invalid_grant", error_description: "redirect_uri mismatch" });
        return;
      }
      if (!pkceMatches(codeVerifier, record.codeChallenge, record.codeChallengeMethod)) {
        res.status(400).json({ error: "invalid_grant", error_description: "PKCE verification failed" });
        return;
      }
      const accessToken = randomBytes(32).toString("hex");
      const refreshToken = randomBytes(32).toString("hex");
      accessTokens.set(accessToken, { clientId: record.clientId, expiresAt: Date.now() + ACCESS_TOKEN_TTL_MS });
      refreshTokens.set(refreshToken, { clientId: record.clientId, expiresAt: Date.now() + REFRESH_TOKEN_TTL_MS });
      res.json({
        access_token: accessToken,
        token_type: "Bearer",
        expires_in: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
        refresh_token: refreshToken,
      });
      return;
    }
    if (grantType === "refresh_token") {
      const refreshToken = String(req.body?.refresh_token ?? "");
      const clientId = String(req.body?.client_id ?? "");
      const record = refreshTokens.get(refreshToken);
      if (!record || record.expiresAt < Date.now()) {
        res.status(400).json({ error: "invalid_grant" });
        return;
      }
      if (clientId && clientId !== record.clientId) {
        res.status(400).json({ error: "invalid_grant", error_description: "client_id mismatch" });
        return;
      }
      const accessToken = randomBytes(32).toString("hex");
      accessTokens.set(accessToken, { clientId: record.clientId, expiresAt: Date.now() + ACCESS_TOKEN_TTL_MS });
      res.json({
        access_token: accessToken,
        token_type: "Bearer",
        expires_in: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
        refresh_token: refreshToken,
      });
      return;
    }
    res.status(400).json({ error: "unsupported_grant_type" });
  });

  return { router, isValidAccessToken };
}
