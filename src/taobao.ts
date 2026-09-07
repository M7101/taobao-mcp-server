import { chromium, type BrowserContext, type Page, type ElementHandle } from "playwright";
import { promises as fs } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

dotenv.config();

// Anchored to this file's own location (dist/taobao.js -> project root),
// not process.cwd() — Claude Desktop launches MCP server processes with
// whatever cwd it defaults to, not necessarily this project's directory.
const PROJECT_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

// A real, persistent Chromium profile directory — not a storageState()
// snapshot. A live session died repeatedly within minutes even with
// correct cookies+localStorage restored and consistent IP/pacing, which
// pointed at storageState()'s known gap: it never captures IndexedDB (or
// Service Worker / Cache Storage), and Alibaba's own risk-control device
// fingerprint (UMID etc.) partly lives there. Every fresh
// chromium.launch()+newContext() was, in effect, a brand-new never-seen
// device presenting an old account's cookies — exactly what a risk engine
// is built to catch, independent of IP or request rate. Logging in once
// into this directory and reusing the SAME directory for every automated
// action keeps the entire browser environment (cookies, localStorage,
// IndexedDB, cache, device fingerprint) identical across restarts, the way
// a real returning user's browser would be.
const PROFILE_DIR = path.join(PROJECT_ROOT, "browser-profile");

const LOGIN_URL = "https://login.taobao.com/member/login.jhtml";
const SEARCH_URL = (q: string) => "https://s.taobao.com/search?q=" + encodeURIComponent(q);

interface SearchResultItem {
  title: string;
  price: string;
  shop: string;
  item_url: string;
}

interface ItemView {
  title: string;
  price: string;
  dimensions: Record<string, string[]>;
}

interface OrderPreview {
  title: string;
  price: string;
  address: string;
  ready_to_pay: boolean;
}

// Normal Taobao/Tmall product purchases only — see the exploration notes
// from this session: search/browse/cart/checkout on plain taobao.com has no
// anti-bot gate once logged in (unlike Meituan's Yoda or JD's eid-token,
// which this project deliberately does not try to work around). Never used
// for 淘宝闪购/外卖 (ele.me-backed instant delivery) — that path hits a
// Zebra CAPTCHA immediately and is out of scope on purpose.
//
// Deliberately avoids the shared cart (cart.taobao.com) for the actual
// purchase path: the account's real cart holds the human's own unrelated
// items, and reliably scoping a checkbox-based selection to just one item
// proved fragile during manual testing (a broad selector accidentally
// toggled "select all" once). "立即购买" (Buy Now) from the product page is
// scoped to exactly one item/SKU with no such risk, so buyNow always uses
// that path. add_to_cart is offered as a separate, simple tool for the
// cases where that's literally all that's wanted.
export class TaobaoClient {
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private loginContext: BrowserContext | null = null;
  private loginPage: Page | null = null;
  private lastActionAt = 0;

  constructor() {}

  async initialize() {
    // Session cookies are read lazily by ensurePage() — nothing to preload.
  }

  private async randomDelay(minMs: number, maxMs: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, minMs + Math.random() * (maxMs - minMs)));
  }

  // Strict ~10s gap before every Taobao-facing action (search/view/cart/
  // buy/pay/authcheck) — a real risk-control session got invalidated during
  // testing after a short burst of back-to-back automated page loads with
  // no pacing at all, on the SAME IP throughout, which pointed at request
  // frequency/behavioral pattern rather than IP/geography as the trigger.
  // Bumped from a 5-10s randomized gap to a strict, deliberately higher
  // 10-11s floor specifically to re-test that hypothesis in isolation on
  // Railway (Linux + Xvfb, a different hardware/OS fingerprint from the
  // real Mac this profile was created on) — if the session now survives
  // there too, frequency alone was sufficient and the fingerprint mismatch
  // theory was a red herring; if it still dies quickly, frequency isn't the
  // (whole) story. Skipped before the very first action of the process.
  // login()/completeLogin() don't call this — they run on a separate
  // browser and are already paced by real human wall-clock time.
  //
  // Measures elapsed time since the PREVIOUS action actually finished
  // (markActionComplete(), called in a `finally` at the end of every public
  // method below) — not since it started. An earlier version stamped
  // lastActionAt right here, before the goto, which meant the page load +
  // settle() + DOM reads that follow (often 3-7s on their own) silently ate
  // the entire budget: by the time the next tool call arrived, elapsed
  // already exceeded the minimum gap and throttle() waited ~0ms. That let
  // back-to-back tool calls (e.g. search immediately followed by
  // view_item_image) hit Taobao with almost no real pacing at all, which is
  // what kept killing the session despite this function "running".
  private async throttle(): Promise<void> {
    if (this.lastActionAt !== 0) {
      const minGapMs = 10000 + Math.random() * 1000;
      const elapsed = Date.now() - this.lastActionAt;
      if (elapsed < minGapMs) {
        await new Promise((resolve) => setTimeout(resolve, minGapMs - elapsed));
      }
    }
  }

  private markActionComplete(): void {
    this.lastActionAt = Date.now();
  }

  // 2-3s pause after a page finishes navigating, before reading or clicking
  // anything on it — a real person always has this kind of reaction lag
  // after a page appears, whereas automation acting the instant the DOM is
  // ready is itself a distinguishing signal. Randomized for the same reason
  // throttle() is.
  private async settle(): Promise<void> {
    await this.randomDelay(2000, 3000);
  }

  private async hasSavedSession(): Promise<boolean> {
    try {
      const entries = await fs.readdir(PROFILE_DIR);
      return entries.length > 0;
    } catch {
      return false;
    }
  }

  // Lazily opens ONE persistent headless context (same on-disk profile
  // directory every time), reused across searchItem/viewItem/buyNow/payNow
  // calls within this server process — buyNow and payNow in particular
  // must act on the very same live page (payNow clicks a button on the
  // confirm-order page buyNow just navigated to). login() below must never
  // run concurrently with this — launchPersistentContext locks the profile
  // directory, only one Chromium process can hold it at a time.
  private async ensurePage(): Promise<Page> {
    if (this.page) return this.page;
    // headless: false — matching login()'s mode exactly. Every session
    // tested so far died within minutes of real use even with a correct,
    // complete, IP-consistent profile; the one variable that was NEVER
    // controlled for is that login always ran headed while every automated
    // action after it ran headless. Headless Chromium has real, detectable
    // fingerprint differences from headed (navigator.webdriver and other
    // signals), even from the exact same profile directory — so every
    // automated request was presenting a environment the account had never
    // actually been "seen" in, regardless of cookies/IP/pacing. Untested
    // until now; if this doesn't hold either, headless-vs-headed isn't it.
    // --no-sandbox: required for Chromium to launch at all in most
    // containerized Linux environments (Railway included) — harmless
    // locally too.
    this.context = await chromium.launchPersistentContext(PROFILE_DIR, {
      headless: false,
      args: ["--no-sandbox", "--disable-gpu"],
      locale: "zh-CN",
    });
    this.page = this.context.pages()[0] ?? (await this.context.newPage());
    return this.page;
  }

  async login() {
    if (this.loginContext) {
      await this.loginContext.close();
      this.loginContext = null;
      this.loginPage = null;
    }
    // The automation context (ensurePage above) must not be holding the
    // profile directory lock while we open it here for a headed login.
    if (this.context) {
      await this.context.close();
      this.context = null;
      this.page = null;
    }
    // Headed Chromium needs a real display — works locally, but there is no
    // display at all on a headless cloud host (Railway included). Fails
    // fast with a clear message instead of an opaque Playwright launch
    // error: the actual fix is to log in locally, where this profile
    // directory then holds a real, complete browser environment (not just
    // cookies) that every later automated action reuses as-is.
    try {
      this.loginContext = await chromium.launchPersistentContext(PROFILE_DIR, {
        headless: false,
        args: ["--no-sandbox", "--disable-gpu"],
        locale: "zh-CN",
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        message:
          "打不开可见浏览器窗口，这台机器上大概率没有图形界面（比如部署在服务器上）。" +
          "请在有屏幕的本地电脑上登录一次——这个方案下登录状态是一整个真实浏览器Profile目录" +
          "（" + PROFILE_DIR + "），需要把这个目录本身同步过去，不再是一段能塞进环境变量的文本。" +
          "原始错误: " + msg,
      };
    }
    this.loginPage = this.loginContext.pages()[0] ?? (await this.loginContext.newPage());
    await this.loginPage.goto(LOGIN_URL);
    return {
      success: true,
      message:
        "已打开淘宝登录页面，请在浏览器窗口里手动完成登录（扫码/密码/短信验证码都行）。" +
        "登录成功后调用 complete_taobao_login 保存登录状态。",
    };
  }

  async completeLogin() {
    if (!this.loginPage) {
      return { success: false, message: "还没有打开登录窗口，请先调用 login_taobao。" };
    }
    const url = this.loginPage.url();
    if (url.includes("login.taobao.com")) {
      return { success: false, message: "浏览器窗口似乎还停留在登录页，看起来还没登录成功。" };
    }
    // Nothing to export — this login wrote directly into the persistent
    // profile directory (cookies, localStorage, IndexedDB, cache, the
    // works) that ensurePage() reuses as-is. Just release the lock.
    await this.loginContext?.close();
    this.loginContext = null;
    this.loginPage = null;
    return {
      success: true,
      message: "登录状态已保存在本地浏览器Profile里，之后的操作会复用同一个真实浏览器环境。",
    };
  }

  async checkAuth(): Promise<{ authenticated: boolean; message: string; screenshot?: { mimeType: string; data: string } }> {
    if (!(await this.hasSavedSession())) {
      return { authenticated: false, message: "还没有保存过登录状态，请先调用 login_taobao 登录。" };
    }
    await this.throttle();
    try {
      const page = await this.ensurePage();
      await page.goto("https://www.taobao.com/");
      await this.settle();
      const loginPrompt = await page.getByText("亲，请登录", { exact: false }).count();
      if (loginPrompt > 0) {
        // Screenshotted on the failure path only — this is a heuristic text
        // match, and a remote environment (different network path/render
        // timing to Taobao's CDN, e.g. Railway) is exactly where it's worth
        // double-checking what's actually on screen instead of trusting the
        // match blind: a slow-loading page, a CAPTCHA, or a genuine risk-
        // control logout all read as "亲，请登录 not found... or found" very
        // differently and only a screenshot tells them apart.
        const buffer = await page.screenshot({ type: "jpeg", quality: 70, fullPage: false });
        return {
          authenticated: false,
          message: "保存的登录状态看起来已经失效了，请重新调用 login_taobao 登录。",
          screenshot: { mimeType: "image/jpeg", data: buffer.toString("base64") },
        };
      }
      return { authenticated: true, message: "登录状态有效。" };
    } finally {
      this.markActionComplete();
    }
  }

  async searchItem(query: string): Promise<{ count: number; items: SearchResultItem[] }> {
    await this.throttle();
    try {
      return await this.searchItemInner(query);
    } finally {
      this.markActionComplete();
    }
  }

  private async searchItemInner(query: string): Promise<{ count: number; items: SearchResultItem[] }> {
    const page = await this.ensurePage();
    await page.goto(SEARCH_URL(query));
    await this.settle();

    const items = await page.evaluate(() => {
      const anchors = Array.from(
        document.querySelectorAll<HTMLAnchorElement>("a[href*='item.taobao.com'], a[href*='detail.tmall.com']")
      );
      const seen = new Set<string>();
      const results: { title: string; price: string; shop: string; item_url: string }[] = [];
      for (const a of anchors) {
        const href = a.href.split("&")[0];
        if (seen.has(href)) continue;
        seen.add(href);
        // The anchor wraps the whole card (image + title + promo badges +
        // price), so a.innerText is noisy — the title is reliably the
        // longest single line in it; badges/labels are short fragments.
        const lines = (a.innerText || "").split("\n").map((l) => l.trim()).filter(Boolean);
        const title = lines.reduce((longest, l) => (l.length > longest.length ? l : longest), "").slice(0, 80);
        // Price fragments render as separate "¥"/"￥" / "29" / ".9" lines
        // right next to each other (both yen glyphs show up depending on
        // the page) — stitch adjacent short numeric-ish lines starting from
        // the yen-sign line instead of regexing the whole blob (which can
        // match an unrelated yen sign elsewhere in the card, e.g. a
        // "满¥200减25" promo line).
        let price = "";
        const yenIdx = lines.findIndex((l) => l === "¥" || l === "￥");
        if (yenIdx !== -1) {
          price = "¥" + lines.slice(yenIdx + 1, yenIdx + 3).join("");
        } else {
          const inline = lines.find((l) => /^[¥￥]\s?[\d,]+(\.\d+)?$/.test(l));
          if (inline) price = inline;
        }
        if (!title) continue;
        results.push({ title, price, shop: "", item_url: href });
        if (results.length >= 20) break;
      }
      return results;
    });

    return { count: items.length, items };
  }

  // SKU dimension groups render as a label (材质/颜色分类/尺码/...) followed
  // by a row of clickable option chips — walk the DOM looking for that
  // shape rather than any specific (build-hashed) class name. Assumes the
  // caller has already navigated to the item page and scrolled the SKU
  // area into view.
  private async readDimensions(page: Page): Promise<Record<string, string[]>> {
    return page.evaluate(() => {
      const out: Record<string, string[]> = {};
      const KNOWN_LABELS = ["材质", "颜色分类", "颜色", "尺码", "规格", "口味", "容量", "款式", "套餐"];
      // Only elements whose OWN trimmed text (no descendants' text mixed in)
      // IS one of the known dimension-label words, OR ENDS WITH one — some
      // Tmall templates (e.g. flowers/gifts shops) prefix it, like "商品规格"
      // instead of bare "规格". Suffix-only (not "contains") to avoid
      // matching unrelated longer strings that merely happen to include one
      // of these words in the middle.
      const labels = Array.from(document.querySelectorAll("body *")).filter((el) => {
        if (el.children.length > 0) return false;
        const t = el.textContent?.trim() ?? "";
        if (!t || t.length > 8) return false;
        return KNOWN_LABELS.some((label) => t === label || t.endsWith(label));
      });
      for (const label of labels) {
        const rawText = label.textContent!.trim();
        // Key on the canonical word ("规格"), not the raw label text ("商品
        // 规格") — keeps `choices` keys predictable across shops/templates
        // that prefix the same dimension differently.
        const dimensionName = KNOWN_LABELS.find((w) => rawText === w || rawText.endsWith(w)) ?? rawText;
        if (out[dimensionName]) continue;
        // The options container isn't a direct sibling of the label itself
        // — walk up through ancestors until one's OWN next-sibling actually
        // has text (label and its row wrapper(s) have none), which is the
        // options container.
        let node: Element | null = label;
        let optionsContainer: Element | null = null;
        for (let hops = 0; hops < 6 && node; hops++) {
          const sib = node.nextElementSibling;
          if (sib && (sib.textContent?.trim() ?? "").length > 0) {
            optionsContainer = sib;
            break;
          }
          node = node.parentElement;
        }
        if (!optionsContainer) continue;

        // Two option shapes exist in the wild: simple text chips (each a
        // single leaf, e.g. "红色"/"S码") and richer cards (e.g. Tmall gift
        // shops: a thumbnail + badge + name per option, several leaves
        // each). Treating every leaf in the container as its own option
        // works for the first shape but shreds the second into fragments
        // ("【性价比推荐】" / "11朵戴安娜混搭花束" / "¥75" as three separate
        // "options"), none of which is the clickable option's actual label —
        // which is why dimensions came back empty on those pages. Extract
        // one label per DIRECT CHILD instead: a plain chip child IS its own
        // label; a card child's longest non-price leaf line is its name.
        const options: string[] = [];
        for (const child of Array.from(optionsContainer.children)) {
          if (child.children.length === 0) {
            const t = child.textContent?.trim() ?? "";
            if (t && t.length < 40) options.push(t);
            continue;
          }
          const leaves = Array.from(child.querySelectorAll("*"))
            .filter((el) => el.children.length === 0)
            .map((el) => el.textContent?.trim() ?? "")
            .filter((t) => t && t.length < 40 && t !== "店长主推" && !/^[¥￥]/.test(t));
          const longest = leaves.reduce((a, b) => (b.length > a.length ? b : a), "");
          if (longest) options.push(longest);
        }
        let unique = [...new Set(options)].slice(0, 12);
        if (unique.length === 0) {
          // Fallback: the container's direct children aren't one-per-option
          // (e.g. an extra wrapper level between it and the actual chips) —
          // scan every leaf in the whole subtree instead, as before.
          const leafTexts = Array.from(optionsContainer.querySelectorAll("*"))
            .filter((el) => el.children.length === 0)
            .map((el) => el.textContent?.trim() ?? "")
            .filter((t) => t && t.length < 40 && t !== "店长主推");
          unique = [...new Set(leafTexts)].slice(0, 12);
        }
        if (unique.length > 0) out[dimensionName] = unique;
      }
      return out;
    });
  }

  // Reveals a product's SKU choices without adding anything to cart or buying.
  async viewItem(item_url: string): Promise<ItemView> {
    await this.throttle();
    try {
      const page = await this.ensurePage();
      await page.goto(item_url);
      await this.settle();
      await page.mouse.wheel(0, 1050);
      await page.waitForTimeout(800);

      const title = (await page.title()).replace(/-tmall\.com.*$|-淘宝网.*$/, "").trim();
      const priceText = await this.readFirstPrice(page);
      const dimensions = await this.readDimensions(page);

      return { title, price: priceText, dimensions };
    } finally {
      this.markActionComplete();
    }
  }

  // Screenshots just the product's main image — meant to be called once,
  // right before committing to buy_now_taobao on a specific item, not on
  // every search result (that would burn tokens on every listing instead
  // of the one item actually being bought). Finds the largest <img> near
  // the top of the page (the gallery area) rather than a fixed selector,
  // since Taobao/Tmall's own class names are build-hashed and vary by
  // template.
  async viewItemImage(item_url: string): Promise<{ mimeType: string; data: string }> {
    await this.throttle();
    try {
      const page = await this.ensurePage();
      await page.goto(item_url);
      await this.settle();

      const handle = await page.evaluateHandle(() => {
        const imgs = Array.from(document.querySelectorAll("img"));
        let best: HTMLImageElement | null = null;
        let bestArea = 0;
        for (const img of imgs) {
          const rect = img.getBoundingClientRect();
          if (rect.top > 900 || rect.width < 150 || rect.height < 150) continue;
          const area = rect.width * rect.height;
          if (area > bestArea) {
            best = img;
            bestArea = area;
          }
        }
        return best;
      });
      const el = handle.asElement() as ElementHandle<Element> | null;
      if (!el) {
        throw new Error("没找到商品主图 — 页面结构可能变了，或者图片还没加载出来。");
      }
      const buffer = await el.screenshot({ type: "jpeg", quality: 80 });
      return { mimeType: "image/jpeg", data: buffer.toString("base64") };
    } finally {
      this.markActionComplete();
    }
  }

  // Finds the smallest clickable ancestor whose full rendered text matches,
  // then walks up until an element with cursor:pointer is found —
  // Taobao/Tmall wrap real buttons in build-hashed class names that change
  // across deployments, so this generalizes instead of hardcoding one.
  //
  // Matches against each ELEMENT's aggregated textContent (all descendant
  // text combined), not individual DOM Text nodes — a label and its price
  // routinely render as separate adjacent fragments (e.g. "免密支付" and
  // "￥36.90" as sibling nodes, sometimes the price itself split further
  // into "￥"/"36"/"."/"90"), so no single Text node ever contains a
  // pattern spanning both. This is the same reason readFirstPrice() has to
  // stitch fragments together instead of regexing one node — Playwright's
  // own `text=` locator already matches this way, which is why the earlier
  // manual testing that used `page.locator("text=...")` worked while this
  // Text-node walk silently never found the button.
  private async findClickableText(page: Page, textPattern: RegExp): Promise<ElementHandle<Element> | null> {
    const handle = await page.evaluateHandle((patternSource) => {
      const pattern = new RegExp(patternSource);
      const all = document.querySelectorAll("body *");
      let best: Element | null = null;
      let bestLength = Infinity;
      for (const el of all) {
        const t = el.textContent ?? "";
        if (pattern.test(t) && t.length < bestLength) {
          best = el;
          bestLength = t.length;
        }
      }
      if (!best) return null;
      // Walk up to the nearest cursor:pointer ancestor, but stop climbing if
      // that ancestor is dramatically wider than the matched text itself —
      // Taobao/Tmall sometimes group several sibling buttons (e.g. a cart-
      // icon shortcut next to "领券购买") inside one shared row wrapper that
      // also reports cursor:pointer. Climbing into that wrapper makes
      // Playwright's click land on the row's bounding-box center, which can
      // fall in the gap between buttons or on the WRONG button entirely —
      // silently doing nothing instead of clicking the button whose text
      // actually matched.
      const matchedWidth = (best as HTMLElement).getBoundingClientRect().width;
      let el: HTMLElement | null = best as HTMLElement;
      let chosen: HTMLElement | null = null;
      for (let i = 0; i < 8 && el; i++) {
        const width = el.getBoundingClientRect().width;
        if (!chosen && getComputedStyle(el).cursor === "pointer" && width < matchedWidth * 2.5) chosen = el;
        el = el.parentElement;
      }
      return chosen ?? best;
    }, textPattern.source);
    return handle.asElement() as ElementHandle<Element> | null;
  }

  private async clickByClickableText(page: Page, textPattern: RegExp): Promise<boolean> {
    const el = await this.findClickableText(page, textPattern);
    if (!el) return false;
    await el.click();
    return true;
  }

  // SKU option selection used `page.getByText(wanted, { exact: true })`,
  // which requires some single element's OWN text to equal `wanted`
  // exactly — the same class of bug the buy button had (clickByClickableText
  // exists specifically to fix it there): once an option's visible label is
  // split across sibling text fragments (or the option is a Tmall-style
  // card, not a bare chip), no element's exact text ever equals the full
  // extracted label, so the click silently no-ops and that dimension is
  // left unselected. Routes through the same aggregated-text matcher instead.
  private async clickExactText(page: Page, text: string): Promise<boolean> {
    const escaped = text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return this.clickByClickableText(page, new RegExp(`^${escaped}$`));
  }

  // Read-only counterpart to payNow()'s button search — reports whether the
  // pattern matches and what it matched, with a screenshot, but never
  // clicks. payNow() clicking a real "立即支付" button spends real money the
  // instant it succeeds, so once that match ever becomes unreliable (page
  // structure changed, A/B test, etc.) the only safe way to re-diagnose it
  // is a method that is structurally incapable of accidentally paying.
  async debugPayButton(): Promise<{
    url: string;
    onConfirmPage: boolean;
    found: boolean;
    matchedText?: string;
    screenshot: { mimeType: string; data: string };
  }> {
    if (!this.page) {
      throw new Error("当前没有打开的页面 — 请先调用某个操作（比如 buy_now_taobao）打开一个页面。");
    }
    const page = this.page;
    const pattern = /(免密支付|立即支付).*[¥￥]?\s?[\d,]+(\.\d+)?/;
    const el = await this.findClickableText(page, pattern);
    const matchedText = el ? ((await el.evaluate((e) => e.textContent)) ?? "").trim() : undefined;
    const buffer = await page.screenshot({ type: "jpeg", quality: 70 });
    return {
      url: page.url(),
      onConfirmPage: page.url().includes("confirm_order.htm"),
      found: !!el,
      matchedText,
      screenshot: { mimeType: "image/jpeg", data: buffer.toString("base64") },
    };
  }

  // Selects SKU options (or the first available option per dimension when
  // not specified) and clicks 立即购买 — scoped to exactly this one item,
  // never touches the shared cart. Lands on the real confirm-order page;
  // nothing is bought yet until payNow() is called separately.
  // The currency glyph and its digits often render as separate adjacent
  // text nodes (e.g. "￥" / "34" / "." / "90"), so a single-node regex match
  // frequently comes back empty or fragmented — stitch together the first
  // yen-sign occurrence and the handful of short text fragments right after
  // it in document order instead.
  private async readFirstPrice(page: Page): Promise<string> {
    return page.evaluate(() => {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      const texts: string[] = [];
      let node: Text | null;
      while ((node = walker.nextNode() as Text | null)) {
        const t = node.textContent?.trim();
        if (t) texts.push(t);
      }
      const yenIdx = texts.findIndex((t) => t === "¥" || t === "￥");
      if (yenIdx === -1) return "";
      let price = "¥";
      for (let i = yenIdx + 1; i < texts.length && i < yenIdx + 4; i++) {
        if (!/^[\d.,]+$/.test(texts[i])) break;
        price += texts[i];
      }
      return price;
    });
  }

  async buyNow(item_url: string, choices?: Record<string, string>): Promise<OrderPreview> {
    await this.throttle();
    try {
      const page = await this.ensurePage();
      await page.goto(item_url);
      await this.settle();
      await page.mouse.wheel(0, 1050);
      await page.waitForTimeout(800);

      const title = (await page.title()).replace(/-tmall\.com.*$|-淘宝网.*$/, "").trim();
      const dimensions = await this.readDimensions(page);
      for (const [dimension, options] of Object.entries(dimensions)) {
        const wanted = choices?.[dimension] ?? options[0];
        if (!wanted) continue;
        await this.clickExactText(page, wanted);
        await page.waitForTimeout(400);
      }
      // Screenshot right after SKU selection, before ever touching 立即购买 —
      // so a wrong/failed option click (page structure changed, our label
      // extraction picked something unclickable, etc.) is visible from a
      // saved image instead of only showing up later as "didn't reach the
      // confirm-order page" with no way to tell why.
      if (Object.keys(dimensions).length > 0) {
        const skuBuffer = await page.screenshot({ type: "jpeg", quality: 70 }).catch(() => null);
        if (skuBuffer) await fs.writeFile(path.join(PROJECT_ROOT, "debug-buynow-after-sku.jpg"), skuBuffer);
      }

      // Plain "立即购买" isn't the only label Taobao/Tmall shows here —
      // items with an active coupon promotion swap it for "领券购买" (claim
      // coupon & buy) instead, same button/same confirm-order destination,
      // just different text. Matching only the exact original string meant
      // buyNow() failed outright on any such item before ever reaching the
      // confirm-order page (and therefore payNow()), which looked like a
      // "pay button broken" report but was actually never getting there.
      const buyEl = await this.findClickableText(page, /^(立即购买|领券购买)$/);
      if (!buyEl) {
        throw new Error("没找到「立即购买」按钮 — 商品页面结构可能变了，或者规格没选完整。");
      }
      await buyEl.click();
      await page.waitForTimeout(3000);

      if (!page.url().includes("confirm_order.htm")) {
        // "领券购买" opens a coupon-claim dialog first instead of navigating
        // straight through like "立即购买" does — try to find and click
        // whatever confirms/dismisses that dialog (common labels across
        // Taobao/Tmall coupon modals), then check again before giving up.
        const dialogClicked = await this.clickByClickableText(
          page,
          /^(确定|确认|立即购买|去支付|同意协议并购买|同意协议并支付|立即领取并购买)$/
        );
        if (dialogClicked) {
          await page.waitForTimeout(2500);
        }
      }

      if (!page.url().includes("confirm_order.htm")) {
        const buffer = await page.screenshot({ type: "jpeg", quality: 70 }).catch(() => null);
        if (buffer) {
          await fs.writeFile(path.join(PROJECT_ROOT, "debug-buynow-stuck.jpg"), buffer);
        }
        throw new Error(
          "点击立即购买后没有进入确认订单页（当前: " + page.url() + "），可能需要先选完所有规格。" +
            (buffer ? " 已保存截图到 debug-buynow-stuck.jpg 方便排查。" : "")
        );
      }

      const priceText = await this.readFirstPrice(page);
      // Only the selected/default address card, never the whole saved address
      // book — walk up from the "默认" (default) marker to the smallest
      // ancestor whose text also contains an 11-digit phone number, which is
      // exactly the one selected card and nothing past it.
      const addressText = await page.evaluate(() => {
        const marker = Array.from(document.querySelectorAll("body *")).find(
          (el) => el.children.length === 0 && el.textContent?.trim() === "默认"
        );
        if (!marker) return "";
        let node: Element | null = marker;
        for (let i = 0; i < 8 && node; i++) {
          const t = node.textContent?.trim() ?? "";
          if (/\d{11}/.test(t) && t.length < 200) return t;
          node = node.parentElement;
        }
        return "";
      });

      return {
        title,
        price: priceText,
        address: addressText,
        ready_to_pay: true,
      };
    } finally {
      this.markActionComplete();
    }
  }

  // The only tool that actually spends real money — must be called
  // separately, right after buyNow(), against the same still-open
  // confirm-order page. Deliberately two distinct tool calls (buyNow then
  // payNow) rather than one, so reaching the confirm-order page and
  // committing to a real payment are always visibly separate steps.
  async payNow(): Promise<{ success: boolean; message: string; final_url: string }> {
    if (!this.page || !this.page.url().includes("confirm_order.htm")) {
      return {
        success: false,
        message: "当前没有停在确认订单页 — 请先调用 buy_now 生成待支付订单，再调用这个工具。",
        final_url: this.page?.url() ?? "",
      };
    }
    await this.throttle();
    try {
      const page = this.page;
      const clicked = await this.clickByClickableText(page, /(免密支付|立即支付).*[¥￥]?\s?[\d,]+(\.\d+)?/);
      if (!clicked) {
        return { success: false, message: "没找到支付按钮，可能页面结构变了。", final_url: page.url() };
      }
      await page.waitForTimeout(5000);
      const finalUrl = page.url();
      const stillOnConfirm = finalUrl.includes("confirm_order.htm");
      return {
        success: !stillOnConfirm,
        message: stillOnConfirm
          ? "点击了支付按钮，但页面还停在确认订单页，可能没有成功 — 需要人工检查。"
          : "支付已提交，订单应该已经出现在“待发货”里。",
        final_url: finalUrl,
      };
    } finally {
      this.markActionComplete();
    }
  }

  async addToCart(item_url: string, choices?: Record<string, string>) {
    await this.throttle();
    try {
      const page = await this.ensurePage();
      await page.goto(item_url);
      await this.settle();
      await page.mouse.wheel(0, 1050);
      await page.waitForTimeout(800);

      const dimensions = await this.readDimensions(page);
      for (const [dimension, options] of Object.entries(dimensions)) {
        const wanted = choices?.[dimension] ?? options[0];
        if (!wanted) continue;
        await this.clickExactText(page, wanted);
        await page.waitForTimeout(400);
      }

      const clicked = await this.clickByClickableText(page, /^加入购物车$/);
      if (!clicked) {
        throw new Error("没找到「加入购物车」按钮 — 规格可能没选完整。");
      }
      await page.waitForTimeout(2000);
      const confirmed = await page.getByText("成功加入购物车", { exact: false }).count();
      return {
        success: confirmed > 0,
        message: confirmed > 0 ? "已加入购物车。" : "点击了加入购物车，但没看到成功提示，建议人工确认。",
      };
    } finally {
      this.markActionComplete();
    }
  }
}
