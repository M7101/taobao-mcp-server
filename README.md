# taobao-mcp-server

基于 [MCP](https://modelcontextprotocol.io)（Model Context Protocol）协议和 [Playwright](https://playwright.dev) 的淘宝自动购物 server，让 Claude 等支持 MCP 的 AI 助手可以直接帮你在淘宝搜索、查看商品、加购物车、下单，甚至完成支付。

> **声明**：本项目仅供个人学习交流使用，不用于商业用途，请遵守淘宝平台相关规定。自动化操作可能触发平台风控（例如短时间内频繁访问同一账号），使用者需自行承担相应风险。本项目**不存储任何用户账号密码**——登录状态通过手动扫码/密码在真实浏览器窗口里完成，程序本身从不接触你的账号密码。

## 技术栈

- Node.js + TypeScript
- [Playwright](https://playwright.dev)（真实 Chromium，非无头模式）
- [`@modelcontextprotocol/sdk`](https://github.com/modelcontextprotocol/typescript-sdk)
- Express（HTTP 传输 + 简易 OAuth 2.1 授权层）

## 功能列表

| 工具 | 说明 |
|---|---|
| `login_taobao` | 打开一个可见的浏览器窗口，供你手动登录（扫码/密码/短信均可） |
| `complete_taobao_login` | 手动登录完成后，保存登录状态 |
| `check_taobao_auth` | 检查保存的登录状态是否仍然有效（失效时附带页面截图） |
| `search_taobao_item` | 按关键词搜索商品，返回标题、价格、链接 |
| `view_taobao_item` | 查看商品详情页，返回价格和 SKU 规格选项（材质/颜色/尺码等） |
| `view_taobao_item_image` | 截取商品主图，方便下单前确认商品长相 |
| `add_to_cart_taobao` | 选好规格后加入购物车（不下单） |
| `buy_now_taobao` | 选择规格并点击"立即购买"，进入确认订单页（不付款） |
| `pay_now_taobao` | 在确认订单页完成**真实付款**——会真的花钱，谨慎调用 |
| `debug_pay_button_taobao` | 只读诊断：截图当前页面并检查支付按钮能否被找到，**不会点击、不会花钱** |

## 安装

```bash
git clone <your-fork-url>
cd taobao-mcp-server
npm install
npm run build   # 编译 TypeScript + 安装 Playwright 的 Chromium
```

## 使用方法

### 方式一：本地 stdio（配合 Claude Desktop）

在 Claude Desktop 的 `claude_desktop_config.json` 里添加：

```json
{
  "mcpServers": {
    "taobao": {
      "command": "node",
      "args": ["/path/to/taobao-mcp-server/dist/server.js"]
    }
  }
}
```

首次使用先调用 `login_taobao`，在弹出的浏览器窗口里手动登录，登录完成后调用 `complete_taobao_login` 保存状态。之后的操作会复用同一个真实浏览器 Profile（`browser-profile/` 目录），不是简单的 cookie 快照——这样做是因为 Taobao 的风控会检查设备指纹，光有 cookie 没有完整的浏览器环境（IndexedDB、Service Worker 等）容易被识别为异常登录。

### 方式二：远程 HTTP（配合 claude.ai 网页/手机端）

```bash
npm start   # 启动 HTTP server，默认监听 :8787
```

需要把这个端口通过内网穿透（比如 [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/)）暴露到公网，并设置环境变量：

```bash
export PUBLIC_BASE_URL=https://your-tunnel-domain.example.com
export MCP_AUTH_TOKEN=<一个你自己生成的随机字符串，作为授权密码>
```

`claude.ai` 的自定义连接器只认标准 OAuth 2.1 + PKCE 授权流程，不支持直接填写静态 token——本项目内置了一个最简单的单用户 OAuth 授权层（`src/oauth.ts`）：连接时会打开一个网页，输入你设置的 `MCP_AUTH_TOKEN` 作为访问密码即可完成授权，之后颁发的是有过期时间的 access token，而不是把密码本身暴露给客户端。

## 注意事项

- **必须在有图形界面的本地 Mac/PC 上运行**：浏览器是有头模式（非 headless），因为测试发现无头模式的浏览器指纹和有头模式不同，容易导致登录状态频繁失效。这意味着这台电脑不能休眠、进程不能退出，否则远程连接会失效。
- **登录只能手动完成**：出于安全考虑，程序不会、也不能帮你输入账号密码——`login_taobao` 只是打开一个浏览器窗口，剩下的（扫码/输密码/验证码）必须你自己动手。
- **请求节流**：每次操作之间会有约 5-10 秒的随机延迟，避免过于规律或过于密集的请求模式触发平台风控。即便如此，仍然可能因为短时间内操作过于频繁（尤其是反复调试同一个流程）被要求重新验证登录——遇到这种情况，正常重新登录、放慢使用频率即可，不建议尝试绕过验证。
- **`pay_now_taobao` 会花真实的钱**：这是唯一一个会真正提交支付的工具，请在明确需要下单时再调用。
- **天猫（Tmall）兼容说明**：天猫店铺的页面模板和淘宝店铺不完全一致（比如 SKU 规格标签可能写作"商品规格"而非"规格"，促销商品的购买按钮可能显示"领券购买"而非"立即购买"，规格选项可能是带图片的卡片而非纯文字标签）。代码里已经针对这些常见变体做了兼容，但淘系页面模板经常变化，如果遇到"找不到按钮"或"规格读不出来"的问题，欢迎提 issue 并附上截图。

## License

MIT

## 致谢

感谢 [Anthropic](https://www.anthropic.com) 提出并开源 Model Context Protocol，感谢 [Playwright](https://playwright.dev) 开源社区。
