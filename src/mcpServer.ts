import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { TaobaoClient } from "./taobao.js";

// Shared tool registration used by both the stdio entry point (server.ts,
// what Claude Desktop launches locally) and the HTTP entry point
// (httpServer.ts, what sits behind the Cloudflare Tunnel + bearer-token
// check for claude.ai's remote connector). One Server instance per
// transport connection, all closing over the same TaobaoClient instance
// passed in by the caller.
export function createMcpServer(taobaoClient: TaobaoClient): Server {
  const server = new Server(
    { name: "taobao-mcp-server", version: "1.0.0" },
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
            "ONCE, right before deciding to buy_now_taobao a specific item — not for every search result, " +
            "since that would spend tokens on listings never purchased.",
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
            "SKU option for any dimension not specified in `choices`.",
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
            "Select SKU options and click 立即购买 (Buy Now) for a single item, landing on the real " +
            "confirm-order page (address + price shown). Does NOT pay — call pay_now_taobao separately " +
            "to actually complete a real payment. Never touches the shared cart.",
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
            "Complete REAL payment for the order currently shown on the confirm-order page reached via " +
            "buy_now_taobao. This spends real money — only call it when actually intended.",
          inputSchema: { type: "object", properties: {} },
        },
        {
          name: "debug_pay_button_taobao",
          description:
            "Read-only diagnostic for the confirm-order page reached via buy_now_taobao: reports whether the " +
            "payment button can be found and returns a screenshot, WITHOUT ever clicking anything or spending " +
            "money. Use this if pay_now_taobao reports it can't find the button, instead of retrying pay_now_taobao " +
            "blindly.",
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
          return {
            content: [{ type: "text", text: JSON.stringify(await taobaoClient.buyNow(item_url, choices), null, 2) }],
          };
        }
        case "pay_now_taobao":
          return { content: [{ type: "text", text: JSON.stringify(await taobaoClient.payNow(), null, 2) }] };
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
