import { randomBytes } from "crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { TaobaoClient } from "./taobao.js";

const PAYMENT_TOKEN_TTL_MS = 5 * 60 * 1000;

interface PendingPayment {
  token: string;
  amountCny: number;
  title: string;
  address: string;
  expiresAt: number;
}

// TaobaoClient is shared across HTTP MCP sessions. Keep the one pending
// checkout attached to that client rather than to an individual transport,
// so a reconnect between buy_now_taobao and pay_now_taobao does not silently
// lose the safety state. A fresh buy_now_taobao replaces the previous one.
const pendingPayments = new WeakMap<TaobaoClient, PendingPayment>();

function parseCny(text: string): number | null {
  if (!text) return null;
  const yenMatch = text.match(/[¥￥]\s*([\d,]+(?:\.\d{1,2})?)/);
  const genericMatch = text.match(/([\d,]+(?:\.\d{1,2})?)/);
  const raw = (yenMatch?.[1] ?? genericMatch?.[1])?.replace(/,/g, "");
  if (!raw) return null;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function paymentCapCny(): number {
  const raw = process.env.TAOBAO_MAX_PAYMENT_CNY ?? "0";
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function sameCent(a: number, b: number): boolean {
  return Math.abs(Math.round(a * 100) - Math.round(b * 100)) === 0;
}

// Shared tool registration used by both the stdio entry point (server.ts)
// and the HTTP entry point (httpServer.ts). The payment path intentionally
// has a server-side safety gate: buy_now_taobao can only prepare checkout;
// pay_now_taobao additionally requires a short-lived token, an exact amount
// match, a re-read of the live payment button, and an out-of-band host cap.
export function createMcpServer(taobaoClient: TaobaoClient): Server {
  const server = new Server(
    { name: "taobao-mcp-server", version: "1.1.0-safe" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: [
        {
          name: "login_taobao",
          description: "Open a visible browser window for the human to log in to Taobao manually.",
          inputSchema: { type: "object", properties: {} },
        },
        {
          name: "complete_taobao_login",
          description: "Save the Taobao session after the human has finished logging in manually.",
          inputSchema: { type: "object", properties: {} },
        },
        {
          name: "check_taobao_auth",
          description: "Check whether the saved Taobao session is still valid.",
          inputSchema: { type: "object", properties: {} },
        },
        {
          name: "search_taobao_item",
          description: "Search Taobao for a product by keyword. Returns titles, prices, and item URLs.",
          inputSchema: {
            type: "object",
            properties: { query: { type: "string", description: "Search keywords" } },
            required: ["query"],
          },
        },
        {
          name: "view_taobao_item",
          description:
            "Load a product page (from search results' item_url) and return its price and SKU option " +
            "dimensions (e.g. 材质/颜色分类/尺码) without buying or adding to cart.",
          inputSchema: {
            type: "object",
            properties: { item_url: { type: "string", description: "The item_url from search results" } },
            required: ["item_url"],
          },
        },
        {
          name: "view_taobao_item_image",
          description:
            "Screenshot a product's main image so you can actually see what you're about to buy. Call this " +
            "ONCE, right before deciding to buy_now_taobao a specific item — not for every search result.",
          inputSchema: {
            type: "object",
            properties: { item_url: { type: "string", description: "The item_url from search results" } },
            required: ["item_url"],
          },
        },
        {
          name: "add_to_cart_taobao",
          description:
            "Add a product to the real Taobao shopping cart (does not purchase). Picks the first available " +
            "SKU option for any dimension not specified in choices.",
          inputSchema: {
            type: "object",
            properties: {
              item_url: { type: "string" },
              choices: {
                type: "object",
                description: "Optional SKU choices, e.g. {\"材质\": \"陶瓷覆层\", \"颜色分类\": \"山茶粉-720ml\"}",
                additionalProperties: { type: "string" },
              },
            },
            required: ["item_url"],
          },
        },
        {
          name: "buy_now_taobao",
          description:
            "Select SKU options and click 立即购买 (Buy Now) for one item, landing on the real confirm-order " +
            "page. Does NOT pay. On success it returns a short-lived payment_confirmation_token and the parsed " +
            "order amount; pay_now_taobao still has to pass all server-side safety checks.",
          inputSchema: {
            type: "object",
            properties: {
              item_url: { type: "string" },
              choices: {
                type: "object",
                description: "Optional SKU choices; unspecified dimensions default to their first option.",
                additionalProperties: { type: "string" },
              },
            },
            required: ["item_url"],
          },
        },
        {
          name: "pay_now_taobao",
          description:
            "Complete REAL payment for the checkout most recently prepared by buy_now_taobao. Requires its " +
            "short-lived confirmation token and the exact expected amount. The server re-reads the live payment " +
            "button and refuses any mismatch or any amount above TAOBAO_MAX_PAYMENT_CNY. If that environment " +
            "variable is absent or 0, real payment is disabled.",
          inputSchema: {
            type: "object",
            properties: {
              confirmation_token: {
                type: "string",
                description: "Short-lived token returned by the immediately preceding buy_now_taobao call.",
              },
              expected_amount_cny: {
                type: "number",
                description: "Exact order total in CNY returned by buy_now_taobao.",
              },
            },
            required: ["confirmation_token", "expected_amount_cny"],
          },
        },
        {
          name: "debug_pay_button_taobao",
          description:
            "Read-only diagnostic for the confirm-order page reached via buy_now_taobao: reports whether the " +
            "payment button can be found and returns a screenshot, WITHOUT clicking anything or spending money.",
          inputSchema: { type: "object", properties: {} },
        },
      ],
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    try {
      switch (name) {
        case "login_taobao":
          return { content: [{ type: "text", text: JSON.stringify(await taobaoClient.login(), null, 2) }] };
        case "complete_taobao_login":
          return { content: [{ type: "text", text: JSON.stringify(await taobaoClient.completeLogin(), null, 2) }] };
        case "check_taobao_auth": {
          const { screenshot, ...result } = await taobaoClient.checkAuth();
          const content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = [
            { type: "text", text: JSON.stringify(result, null, 2) },
          ];
          if (screenshot) content.push({ type: "image", data: screenshot.data, mimeType: screenshot.mimeType });
          return { content };
        }
        case "search_taobao_item": {
          const query = args?.query as string;
          if (!query) throw new Error("query is required");
          return {
            content: [{ type: "text", text: JSON.stringify(await taobaoClient.searchItem(query), null, 2) }],
          };
        }
        case "view_taobao_item": {
          const item_url = args?.item_url as string;
          if (!item_url) throw new Error("item_url is required");
          return {
            content: [{ type: "text", text: JSON.stringify(await taobaoClient.viewItem(item_url), null, 2) }],
          };
        }
        case "view_taobao_item_image": {
          const item_url = args?.item_url as string;
          if (!item_url) throw new Error("item_url is required");
          const { mimeType, data } = await taobaoClient.viewItemImage(item_url);
          return { content: [{ type: "image", data, mimeType }] };
        }
        case "add_to_cart_taobao": {
          const item_url = args?.item_url as string;
          const choices = args?.choices as Record<string, string> | undefined;
          if (!item_url) throw new Error("item_url is required");
          return {
            content: [
              { type: "text", text: JSON.stringify(await taobaoClient.addToCart(item_url, choices), null, 2) },
            ],
          };
        }
        case "buy_now_taobao": {
          const item_url = args?.item_url as string;
          const choices = args?.choices as Record<string, string> | undefined;
          if (!item_url) throw new Error("item_url is required");

          const preview = await taobaoClient.buyNow(item_url, choices);
          const amountCny = parseCny(preview.price);
          if (amountCny === null) {
            pendingPayments.delete(taobaoClient);
            throw new Error(
              "已到确认订单页，但无法可靠解析订单金额，因此安全模式拒绝生成支付凭证。请人工检查页面。"
            );
          }

          const token = randomBytes(32).toString("hex");
          pendingPayments.set(taobaoClient, {
            token,
            amountCny,
            title: preview.title,
            address: preview.address,
            expiresAt: Date.now() + PAYMENT_TOKEN_TTL_MS,
          });

          const result = {
            ...preview,
            parsed_amount_cny: amountCny,
            payment_confirmation_token: token,
            payment_confirmation_expires_in_seconds: PAYMENT_TOKEN_TTL_MS / 1000,
            payment_cap_cny: paymentCapCny(),
            payment_enabled: paymentCapCny() > 0,
          };
          return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
        }
        case "pay_now_taobao": {
          const confirmationToken = args?.confirmation_token as string;
          const expectedAmount = Number(args?.expected_amount_cny);
          if (!confirmationToken) throw new Error("confirmation_token is required");
          if (!Number.isFinite(expectedAmount) || expectedAmount < 0) {
            throw new Error("expected_amount_cny must be a valid non-negative number");
          }

          const pending = pendingPayments.get(taobaoClient);
          if (!pending) {
            throw new Error("没有有效的待支付凭证。请重新调用 buy_now_taobao，从确认订单页重新开始。");
          }
          if (pending.token !== confirmationToken) {
            throw new Error("支付确认 token 不匹配；安全模式已拒绝付款。");
          }
          if (pending.expiresAt < Date.now()) {
            pendingPayments.delete(taobaoClient);
            throw new Error("支付确认 token 已过期。请重新调用 buy_now_taobao。");
          }
          if (!sameCent(expectedAmount, pending.amountCny)) {
            throw new Error(
              `金额不匹配：凭证记录为 ¥${pending.amountCny.toFixed(2)}，请求为 ¥${expectedAmount.toFixed(2)}。已拒绝付款。`
            );
          }

          const cap = paymentCapCny();
          if (cap <= 0) {
            throw new Error(
              "真实付款当前处于关闭状态。需要由电脑主人在服务端设置 TAOBAO_MAX_PAYMENT_CNY 为明确的单笔上限后才允许付款。"
            );
          }
          if (pending.amountCny > cap) {
            throw new Error(
              `订单金额 ¥${pending.amountCny.toFixed(2)} 超过服务端单笔上限 ¥${cap.toFixed(2)}，已拒绝付款。`
            );
          }

          // Re-read the actual live payment button immediately before the
          // irreversible click. If we cannot parse the live total, or if it
          // changed by even one cent since buy_now_taobao, fail closed.
          const diagnostic = await taobaoClient.debugPayButton();
          if (!diagnostic.found || !diagnostic.matchedText) {
            throw new Error("付款前复核失败：没有可靠找到当前支付按钮。已拒绝付款。");
          }
          const liveAmount = parseCny(diagnostic.matchedText);
          if (liveAmount === null) {
            throw new Error("付款前复核失败：无法从当前支付按钮可靠解析金额。已拒绝付款。");
          }
          if (!sameCent(liveAmount, pending.amountCny) || !sameCent(liveAmount, expectedAmount)) {
            throw new Error(
              `付款前金额发生变化：当前页面为 ¥${liveAmount.toFixed(2)}，原确认金额为 ¥${pending.amountCny.toFixed(2)}。已拒绝付款。`
            );
          }

          // One-shot token: consume it before the irreversible click so a
          // retry can never double-submit the same checkout by accident.
          pendingPayments.delete(taobaoClient);
          const paymentResult = await taobaoClient.payNow();
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    ...paymentResult,
                    verified_amount_cny: liveAmount,
                    payment_cap_cny: cap,
                  },
                  null,
                  2
                ),
              },
            ],
          };
        }
        case "debug_pay_button_taobao": {
          const { screenshot, ...result } = await taobaoClient.debugPayButton();
          return {
            content: [
              { type: "text", text: JSON.stringify(result, null, 2) },
              { type: "image", data: screenshot.data, mimeType: screenshot.mimeType },
            ],
          };
        }
        default:
          throw new Error(`Unknown tool: ${name}`);
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return { content: [{ type: "text", text: `Error: ${errorMessage}` }], isError: true };
    }
  });

  return server;
}
