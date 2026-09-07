import { Router, type Request, type Response } from "express";
import { createHash, randomBytes, randomUUID } from "crypto";

// Minimal single-user OAuth 2.1 + PKCE shim, just enough to satisfy the MCP
// Authorization spec that claude.ai's remote-connector UI actually speaks.
// That UI has no field for pasting a static bearer token — on seeing any 401
// from /mcp it always tries to run an OAuth authorization_code flow, and
// fails immediately ("无法启动mcp授权") if the server doesn't expose the
// discovery/register/authorize/token endpoints below. The one real gate is
// the password prompt in /authorize: only whoever knows `secret` (the same
// value that used to be pasted as a raw bearer token) can ever complete the
// flow and mint themselves a fresh, revocable access token.
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
    const redirectUris: string[] = Array.isArray(req.body?.redirect_uris) ? req.body.redirect_uris : [];
    const clientId = randomUUID();
    clients.set(clientId, { redirectUris });
    res.status(201).json({
      client_id: clientId,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      redirect_uris: redirectUris,
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
    // Auto-register unknown client ids on first sight — DCR is technically
    // required first, but some clients call /authorize directly; trusting
    // the redirect_uri they present here is fine since the real gate is the
    // password prompt below, not client/redirect allow-listing.
    if (!clients.has(params.client_id)) {
      clients.set(params.client_id, { redirectUris: [params.redirect_uri] });
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
      const record = codes.get(code);
      if (!record || record.expiresAt < Date.now()) {
        res.status(400).json({ error: "invalid_grant" });
        return;
      }
      codes.delete(code);
      if (!pkceMatches(codeVerifier, record.codeChallenge, record.codeChallengeMethod)) {
        res.status(400).json({ error: "invalid_grant", error_description: "PKCE verification failed" });
        return;
      }
      const accessToken = randomBytes(32).toString("hex");
      const refreshToken = randomBytes(32).toString("hex");
      accessTokens.set(accessToken, { expiresAt: Date.now() + ACCESS_TOKEN_TTL_MS });
      refreshTokens.set(refreshToken, { expiresAt: Date.now() + REFRESH_TOKEN_TTL_MS });
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
      const record = refreshTokens.get(refreshToken);
      if (!record || record.expiresAt < Date.now()) {
        res.status(400).json({ error: "invalid_grant" });
        return;
      }
      const accessToken = randomBytes(32).toString("hex");
      accessTokens.set(accessToken, { expiresAt: Date.now() + ACCESS_TOKEN_TTL_MS });
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
