import { randomBytes } from "crypto";
import { promises as fs } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const PROJECT_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const TOKEN_PATH = path.join(PROJECT_ROOT, "mcp-auth-token.txt");

// Generated once and persisted to disk so it survives restarts (and so the
// same value can be copied into claude.ai's connector config once, rather
// than changing every time the server restarts). Required on every HTTP
// request once the server is exposed publicly — see server.ts's bearer
// middleware, which runs before any tool (including pay_now_taobao, the one
// that spends real money) can be reached.
//
// On Railway (or anywhere with an ephemeral filesystem) the local file
// won't survive a redeploy, which would silently invalidate whatever token
// is already saved in claude.ai's connector config — MCP_AUTH_TOKEN set as
// a platform env var takes priority precisely so the token stays the same
// across redeploys without needing to update claude.ai every time.
export async function getOrCreateAuthToken(): Promise<string> {
  if (process.env.MCP_AUTH_TOKEN) return process.env.MCP_AUTH_TOKEN;
  try {
    const existing = (await fs.readFile(TOKEN_PATH, "utf-8")).trim();
    if (existing) return existing;
  } catch {
    // No token file yet.
  }
  const token = randomBytes(32).toString("hex");
  await fs.writeFile(TOKEN_PATH, token, { mode: 0o600 });
  return token;
}
