import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { FE_DIR, compileSass, withSandbox, collectPageErrors, esbuildInSandbox } from "./sandbox";

/**
 * 公告弹窗"发出来当场收到"的无头验收（20260926）：真组件 + 假后端 + 真事件
 * （原 tests/announcement-popup-mount.test.py，20261019 迁移）。
 *
 * 为什么值得单起一个脚本（而不是只靠 tests/announcement-popup.test.mjs）：
 *   · mjs 套件锁的是 pending.ts 那层**判据**（该不该弹、已读记哪、什么时候查）；
 *     而用户报的是**看得见的行为**——"弹不出来""只有刷新才弹"。这两件事之间隔着组件：
 *     重入守卫（已弹着就不再换正文）、关窗后的抑制、以及 antd Modal 真的开没开。
 *   · 本套件验的就是那一段：**不刷新、不重新挂载**，只把后台发布这个事件送进来，
 *     弹窗自己出现。
 *
 * 手段（本机不能 vite build，见 CLAUDE.md §2）：esbuild 把**真组件**打成一个 bundle、
 * 只桩边界（axios），antd 与 react-dom 用真的。
 *
 * （TS 迁移注：CLI esbuild 换成 esbuildInSandbox node API；sass 走 compileSass。）
 */

const DEFINE_ENV =
  '{"VITE_HTTP_BASEURL":"","VITE_CDN_BASEURL":"","MODE":"production","DEV":false,"PROD":true,"BASE_URL":"/"}';

// 边界：假后端。按 URL 查 `window.__routes` 里那一版响应（测试中途换掉它 = 服务端那边变了），
// 每次请求记进 `window.__calls`。
const FAKE_AXIOS = `const http: any = (cfg: any) => {
  const w = window as any;
  w.__calls.push({ url: cfg.url, method: (cfg.method || 'GET').toUpperCase(), data: cfg.data });
  const r = (w.__routes || {})[cfg.url];
  if (!r) return Promise.resolve({ status: 200, data: { code: 404, message: '没有这个接口' } });
  return Promise.resolve(JSON.parse(JSON.stringify(r)));
};
export default http;
`;

// 装卸分开给（理由同 dashboard-announcement-refresh：同一次 evaluate 里连着
// render(null) + render(<C/>) 会被 React 18 批量成一次更新，组件其实从没卸载过）。
const ENTRY = `import * as React from 'react';
import { createRoot } from 'react-dom/client';
import AnnouncementModal from './src/components/AnnouncementModal/index.tsx';
import { ConfigProvider, theme as antdTheme } from 'antd';
const root = createRoot(document.getElementById('root')!);
(window as any).__mount = () => { localStorage.removeItem('isDarkMode'); root.render(<AnnouncementModal />); };
// 后台那一套（Dashboard 的壳）：ConfigProvider(darkAlgorithm) + isDarkMode。
// ⚠️ 20261001 起卡片穿的是 washi 手账皮，深浅**不由 antd token 决定**了：Modal 是
// Portal 到 document.body 的，App 的 .frontDark / 后台的 .dark 都不是它的祖先，
// 令牌取不到 ⇒ 组件改用 useIsDarkMode()（= localStorage.isDarkMode + darkmode-change
// 事件，与后台壳里的 isDarkMode 同源）决定要不要加 \`.washiDark\`。
// 所以这里两个都得给：darkAlgorithm 管 antd 自己那部分（遮罩、滚动条），
// isDarkMode 管我们的纸底/胶带/渐变字。系统认的仍然是"同一个 isDarkMode"。
(window as any).__mountDark = () => {
  localStorage.setItem('isDarkMode', '"true"');
  root.render(<ConfigProvider theme={{ algorithm: antdTheme.darkAlgorithm }}><AnnouncementModal /></ConfigProvider>);
};
(window as any).__clear = () => root.render(null);
`;

const NOTIF = "/api/protected/notifications";
const READ = "/api/protected/notifications/read";
const PUBLIC = "/api/public/announcements";

const SUMMARY = {
  status: 200,
  data: { code: 200, data: { notifications: 1, messages: 0, total: 1, pendingReview: 0 } },
};

interface AnnRow {
  id: number;
  type: "announcement";
  title: string;
  content: string;
  link: null;
  isRead: boolean;
  createdAt: string;
}
function annRow(rid: number, title: string, content: string, isRead = false): AnnRow {
  return {
    id: rid,
    type: "announcement",
    title,
    content,
    link: null,
    isRead,
    createdAt: "2026-09-26 10:00:00",
  };
}

const notifBody = (items: AnnRow[]) => ({
  status: 200,
  data: { code: 200, data: { unread: items.filter((i) => !i.isRead).length, items } },
});
const annBody = (rows: unknown[]) => ({ status: 200, data: { code: 200, data: rows } });

interface Call {
  url: string;
  method: string;
  data?: unknown;
}

const route = (pg: Page, mapping: Record<string, unknown>) =>
  pg.evaluate((m) => {
    (window as unknown as { __routes: Record<string, unknown> }).__routes = m;
  }, mapping);

const calls = (pg: Page, url: string | null = null, method: string | null = null): Promise<Call[]> =>
  pg.evaluate(
    ([u, m]) =>
      ((window as unknown as { __calls: Call[] }).__calls || []).filter(
        (c) => (!u || c.url === u) && (!m || c.method === m),
      ),
    [url, method] as [string | null, string | null],
  );

/** 弹窗**可见**（不是"DOM 里有"）：antd 关掉之后 wrapper 仍在，只看 count 会假通过。 */
const popped = (pg: Page, text?: string) => {
  const loc = text
    ? pg.locator(".ant-modal-content:visible", { hasText: text })
    : pg.locator(".ant-modal-content:visible");
  return loc.count();
};

const setToken = (pg: Page, token: string | null) =>
  pg.evaluate((t) => {
    if (t) localStorage.setItem("tokenKey", t);
    else localStorage.removeItem("tokenKey");
  }, token);

/** 从弹窗外关掉：点遮罩（div.ant-modal-wrap 的空白区）。**不记已读**。 */
const closeOutside = (pg: Page) => pg.click(".ant-modal-wrap", { position: { x: 6, y: 6 } });

/** 右上角 ×（同样只是"收起卡片"，不记已读）。 */
const closeByX = (pg: Page) => pg.click(".ant-modal-close");

/** 点「我知道了」——唯一会记已读的出口。 */
const clickOk = (pg: Page) =>
  pg.click(".ant-modal-content:visible button:has-text('我知道了')");

test.describe("公告弹窗：发出来当场收到", () => {
  test.setTimeout(180_000);

  test("两个出口分工 + 当场收到 + 不反复弹 + 几何与深色（51 条判据）", async ({ browser }) => {
    // ── 样式：卡片皮 + 全站令牌表 ──────────────────────────────────────────
    // ⚠️ 这两份**都必须在场**：组件自己的 .sass 管纸底/胶带/圆钮，index.css 管
    // `--washi-*` 令牌（深色那一档只有它有）。少了 index.css，第 ⑨ 组量的就是
    // var() 兜底字面量 —— 那会把"令牌没生效"读成"夜间没实现"。
    const css =
      compileSass(path.join(FE_DIR, "src/components/AnnouncementModal/index.sass")) +
      "\n" +
      readFileSync(path.join(FE_DIR, "src/index.css"), "utf-8");

    const INDEX_HTML =
      '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">' +
      `<style>${css}</style></head>` +
      '<body><div id="root"></div><script src="bundle.js"></script>' +
      "<script>window.__mount();</script></body></html>";

    await withSandbox({ "index.html": INDEX_HTML }, async (sb) => {
      await esbuildInSandbox(sb, {
        entry: "entry.tsx",
        files: {
          "entry.tsx": ENTRY,
          "src/apis/axios.tsx": FAKE_AXIOS,
        },
        copySrc: true,
        define: { "import.meta.env": DEFINE_ENV },
        loaders: { ".sass": "text" },
      });

      const makePage = async () => {
        const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
        const pg = await ctx.newPage();
        const errs = collectPageErrors(pg);
        await pg.addInitScript("window.__calls = []; window.__routes = {};");
        await pg.goto(sb.url);
        await pg.waitForTimeout(300);
        return { ctx, pg, errs };
      };
      const remount = async (pg: Page, dark = false) => {
        await pg.evaluate(() => {
          const w = window as unknown as { __clear: () => void };
          w.__clear();
        });
        await pg.waitForTimeout(150);
        await pg.evaluate((d: boolean) => {
          const w = window as unknown as { __mount: () => void; __mountDark: () => void };
          (d ? w.__mountDark : w.__mount)();
        }, dark);
        await pg.waitForTimeout(500);
      };

      const { ctx, pg, errs } = await makePage();

      // ──【一】游客（未登录）：点弹窗外只是收起卡片，仍是未读 ──
      await route(pg, {
        [PUBLIC]: annBody([
          {
            id: 7,
            title: "新公告：今晚维护",
            content: "正文七",
            createdAt: "2026-09-26 09:00:00",
            updatedAt: "2026-09-26 09:30:00",
          },
        ]),
      });
      await remount(pg);
      expect.soft((await popped(pg, "新公告：今晚维护")) > 0, `游客：有新公告 ⇒ 弹窗弹出来了 → ${await popped(pg)}`).toBe(true);
      expect.soft((await popped(pg, "正文七")) > 0, "游客：弹的是公开接口那份正文").toBe(true);
      expect.soft(
        await pg.locator(".ant-modal-content:visible button:has-text('我知道了')").count() === 1,
        "卡片上有「我知道了」按钮（唯一的已读出口）",
      ).toBe(true);
      await closeOutside(pg); // 点遮罩
      await pg.waitForTimeout(300);
      expect.soft((await popped(pg)) === 0, "点弹窗外 ⇒ 卡片收起了").toBe(true);
      const seen1 = await pg.evaluate(() => localStorage.getItem("announcement_seen_id"));
      expect.soft(
        seen1 === null,
        `**没点「我知道了」⇒ 不写本机水位**（这就是「仍是未读」） → ${JSON.stringify(seen1)}`,
      ).toBe(true);
      const posts1 = await calls(pg, null, "POST");
      expect.soft(
        posts1.length === 0,
        `游客：一次写请求都没发（服务端没有他的身份） → ${JSON.stringify(posts1)}`,
      ).toBe(true);
      expect.soft((await popped(pg)) === 0, "同一页不立刻重弹（会话级抑制，不是「算你读过」）").toBe(true);

      // 重新挂载（= 刷新）⇒ 仍是未读 ⇒ 照旧弹
      await remount(pg);
      expect.soft(
        (await popped(pg, "新公告：今晚维护")) > 0,
        "游客：刷新之后**照旧弹**（没点我知道了就是没读过）",
      ).toBe(true);
      await closeByX(pg); // 这次用右上角 ×，同样只是收起
      await pg.waitForTimeout(300);
      expect.soft(
        (await pg.evaluate(() => localStorage.getItem("announcement_seen_id"))) === null,
        "右上角 × 同款：收起卡片、不写水位",
      ).toBe(true);

      // 点「我知道了」⇒ 这才算读过
      await remount(pg);
      expect.soft(
        (await popped(pg, "新公告：今晚维护")) > 0,
        "刷新后第三次仍会弹（前两次都没表态）",
      ).toBe(true);
      await clickOk(pg);
      await pg.waitForTimeout(300);
      expect.soft((await popped(pg)) === 0, "点「我知道了」⇒ 卡片收起").toBe(true);
      const seen2 = await pg.evaluate(() => localStorage.getItem("announcement_seen_id"));
      expect.soft(
        seen2 === "7",
        `游客点「我知道了」：已读落在本机水位上 → ${JSON.stringify(seen2)}`,
      ).toBe(true);
      const posts2 = await calls(pg, null, "POST");
      expect.soft(
        posts2.length === 0,
        `游客：全程依然一次写请求都没发 → ${JSON.stringify(posts2)}`,
      ).toBe(true);
      await remount(pg);
      expect.soft(
        (await popped(pg)) === 0,
        "游客：点过「我知道了」之后刷新不再弹（水位生效）",
      ).toBe(true);

      // ──【二】登录用户：判据在服务端（个人中心那份已读与弹窗是同一批行） ──
      await route(pg, { [NOTIF]: notifBody([annRow(9, "公告：本周更新", "正文九")]), [READ]: SUMMARY });
      await setToken(pg, "x.y.z");
      // 清空请求记录与上一段留下的水位：本段要独立判"登录的人走哪条接口、已读记在哪"
      const watermarkBefore = await pg.evaluate(() => localStorage.getItem("announcement_seen_id"));
      await pg.evaluate(() => {
        (window as unknown as { __calls: Call[] }).__calls = [];
      });
      await remount(pg);
      expect.soft((await popped(pg, "公告：本周更新")) > 0, "登录：有未读公告行 ⇒ 弹").toBe(true);
      const pubCalls = await calls(pg, PUBLIC);
      const notifGets = await calls(pg, NOTIF, "GET");
      expect.soft(
        pubCalls.length === 0 && notifGets.length >= 1,
        `登录：走通知接口，不打公开公告接口 → ${JSON.stringify(await calls(pg))}`,
      ).toBe(true);
      await closeOutside(pg); // 点遮罩：不算读过
      await pg.waitForTimeout(400);
      const readPosts1 = await calls(pg, READ, "POST");
      expect.soft(
        readPosts1.length === 0,
        `点弹窗外 ⇒ **一次已读请求都不发**（服务端那行照旧未读 ⇒ 红点照旧亮、个人中心照旧未读） → `
        + JSON.stringify(readPosts1),
      ).toBe(true);
      expect.soft(
        (await pg.evaluate(() => localStorage.getItem("announcement_seen_id"))) === watermarkBefore,
        `登录用户不写本机水位（免得留下第二本账） → ${JSON.stringify(watermarkBefore)} → `
        + JSON.stringify(await pg.evaluate(() => localStorage.getItem("announcement_seen_id"))),
      ).toBe(true);
      // 刷新（= 重新挂载）：服务端那行还挂着未读 ⇒ 照旧弹
      await remount(pg);
      expect.soft(
        (await popped(pg, "公告：本周更新")) > 0,
        "点弹窗外的下一次刷新照旧弹（服务端判它未读，弹窗没替他表态）",
      ).toBe(true);
      await clickOk(pg); // 这次点「我知道了」
      await pg.waitForTimeout(400);
      const posts = await calls(pg, READ, "POST");
      expect.soft(
        posts.length === 1,
        `点「我知道了」⇒ POST 了一次已读 → ${JSON.stringify(posts)}`,
      ).toBe(true);
      expect.soft(
        posts.length > 0 && JSON.stringify(posts[0].data) === JSON.stringify({ ids: [9], all: false }),
        `标的是弹过的那一行（ids=[9]，不是 all） → ${JSON.stringify(posts)}`,
      ).toBe(true);
      expect.soft(
        (await pg.evaluate(() => localStorage.getItem("announcement_seen_id"))) === watermarkBefore,
        "本机水位依旧不动",
      ).toBe(true);

      // 服务端已读之后再挂载（= 刷新）也不弹
      await route(pg, {
        [NOTIF]: notifBody([annRow(9, "公告：本周更新", "正文九", true)]),
        [READ]: SUMMARY,
      });
      await remount(pg);
      expect.soft(
        (await popped(pg)) === 0,
        "登录：点过「我知道了」之后刷新不重弹（服务端那份已读生效） → isRead 已是 true",
      ).toBe(true);

      // ──【三】后台发布 ⇒ 不刷新、不重新挂载，弹窗自己弹出来 ──
      await route(pg, {
        [NOTIF]: notifBody([annRow(9, "公告：本周更新", "正文九", true)]),
        [READ]: SUMMARY,
      });
      await remount(pg);
      expect.soft((await popped(pg)) === 0, "挂载时没有可弹的（最新那条已读）").toBe(true);
      // 后台公告页发了一条（服务端多了一行未读），紧接着派发发布事件 —— 页面不动
      await route(pg, {
        [NOTIF]: notifBody([
          annRow(31, "公告：新上线的图库", "正文三十一"),
          annRow(9, "公告：本周更新", "正文九", true),
        ]),
        [READ]: SUMMARY,
      });
      await pg.evaluate(() => window.dispatchEvent(new CustomEvent("announcement-published")));
      await pg.waitForTimeout(600);
      expect.soft(
        (await popped(pg, "公告：新上线的图库")) > 0,
        "派发 announcement-published ⇒ 当场弹出来（这就是「发出来用户当时就能收到」）",
      ).toBe(true);
      expect.soft(
        (await popped(pg, "公告：本周更新 正文九")) === 0,
        "弹的是新的那条，不是旧的那条 → 旧卡没被拿来顶替",
      ).toBe(true);
      await clickOk(pg);
      await pg.waitForTimeout(400);

      // ──【四】没有信号时不查（不是「每次渲染都查一遍」） ──
      await route(pg, { [NOTIF]: notifBody([annRow(41, "公告：静默期", "正文四十一")]), [READ]: SUMMARY });
      const before = (await calls(pg, NOTIF, "GET")).length;
      await pg.waitForTimeout(800); // 60 秒那一拍远没到
      expect.soft(
        (await calls(pg, NOTIF, "GET")).length === before,
        `不发事件、不切标签页 ⇒ 不查（列表还是旧的那份） → ${before} → ${(await calls(pg, NOTIF, "GET")).length}`,
      ).toBe(true);
      expect.soft((await popped(pg, "公告：静默期")) === 0, "因此也没有弹").toBe(true);
      await pg.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
      await pg.waitForTimeout(600);
      expect.soft(
        (await popped(pg, "公告：静默期")) > 0,
        "切回标签页 ⇒ 查一次并弹出来（切回来的那一刻就是想要的时刻）",
      ).toBe(true);
      await clickOk(pg);
      await pg.waitForTimeout(400);

      // ──【五】收起之后同一页不反复弹（没点「我知道了」，服务端仍判未读） ──
      await route(pg, { [NOTIF]: notifBody([annRow(41, "公告：静默期", "正文四十一")]), [READ]: SUMMARY });
      const before5 = (await calls(pg, NOTIF, "GET")).length;
      await pg.evaluate(() => window.dispatchEvent(new CustomEvent("announcement-published")));
      await pg.waitForTimeout(600);
      expect.soft(
        (await calls(pg, NOTIF, "GET")).length > before5,
        "复查确实发生了（不是「没查所以没弹」）",
      ).toBe(true);
      expect.soft(
        (await popped(pg)) === 0,
        "但刚收起的那条不再弹回来（同一页会话级抑制；它照旧是未读、照旧会出现在个人中心与红点里）",
      ).toBe(true);

      // ──【六】读不到 ≠ 没有 ──
      await route(pg, {
        [NOTIF]: { status: 200, data: { code: 500, message: "未登录" } },
        [READ]: SUMMARY,
      });
      await remount(pg);
      expect.soft((await popped(pg)) === 0, "通知接口 code=500 ⇒ 不弹").toBe(true);
      // 失败信封里**带着**一份能弹的内容（token 过期时正文里带不带旧数据不由前端决定）
      await route(pg, {
        [NOTIF]: {
          status: 200,
          data: {
            code: 500,
            message: "未登录",
            data: { unread: 1, items: [annRow(55, "不该弹的公告", "X")] },
          },
        },
        [READ]: SUMMARY,
      });
      await remount(pg);
      expect.soft(
        (await popped(pg, "不该弹的公告")) === 0,
        "失败信封里带着未读公告也不弹（code ≠ 200 就是读不到）",
      ).toBe(true);

      // ──【七】游客那条腿也要"当场收到"（访客才是主要读者） ──
      await setToken(pg, null);
      await route(pg, {
        [PUBLIC]: annBody([
          { id: 7, title: "在看的那条公告", content: "C7", createdAt: "2026-09-26 08:00:00" },
        ]),
      });
      await pg.evaluate(() => localStorage.setItem("announcement_seen_id", "7"));
      await pg.evaluate(() => {
        (window as unknown as { __calls: Call[] }).__calls = [];
      });
      await remount(pg);
      expect.soft((await popped(pg)) === 0, "挂载时没有可弹的（水位已到 7）").toBe(true);
      await route(pg, {
        [PUBLIC]: annBody([
          { id: 8, title: "刚发的公告", content: "C8", createdAt: "2026-09-26 09:00:00" },
          { id: 7, title: "在看的那条公告", content: "C7", createdAt: "2026-09-26 08:00:00" },
        ]),
      });
      await pg.evaluate(() => window.dispatchEvent(new CustomEvent("announcement-published")));
      await pg.waitForTimeout(600);
      expect.soft(
        (await popped(pg, "刚发的公告")) > 0,
        "派发发布事件 ⇒ 游客也当场弹出来（不刷新、不重新挂载）",
      ).toBe(true);
      await clickOk(pg); // 收尾：点「我知道了」把这张读掉（水位写到 8）
      await pg.waitForTimeout(300);
      expect.soft(
        (await pg.evaluate(() => localStorage.getItem("announcement_seen_id"))) === "8",
        `游客点「我知道了」⇒ 水位推到 8 → ${await pg.evaluate(() => localStorage.getItem("announcement_seen_id"))}`,
      ).toBe(true);

      // ──【八】几何：标题的高度 + 「我知道了」按钮的样式（20260926 用户报"标题太靠下
      //        不协调美观，我知道了按钮样式颜色也优化"）──
      // 为什么放在这个套件里：这两条都是**看得见的**几何/配色，源码层断言（标题写在
      // header 槽里、按钮有 borderRadius）挡不住"改回 body 里再叠 28px 上边距"这类
      // 回退——只有量出来的数值能挡。旧写法实测：卡片顶→标题 48px（= 卡片 20px 内边距
      // + 自己叠的 28px），而左右各 56px、右上角的 × 贴在 12px 处。
      await setToken(pg, null);
      await route(pg, {
        [PUBLIC]: annBody([
          { id: 11, title: "几何测量用公告", content: "正文十一", createdAt: "2026-09-26 09:00:00" },
        ]),
      });
      await pg.evaluate(() => localStorage.removeItem("announcement_seen_id"));
      await remount(pg);
      expect.soft((await popped(pg, "几何测量用公告")) > 0, "几何测量：卡片弹出来了").toBe(true);
      interface Geo {
        card: { top: number; left: number; right: number; bottom: number; h: number; w: number } | null;
        head: { top: number } | null;
        title: { top: number; left: number; right: number; bottom: number; h: number; w: number } | null;
        text: { top: number } | null;
        btn: { h: number } | null;
        titleInBody: boolean;
        btnStyle: { bgImage: string; radius: string; height: string; minWidth: string; fontSize: string };
      }
      const g = await pg.evaluate(() => {
        const box = (e: Element | null) => {
          if (!e) return null;
          const r = e.getBoundingClientRect();
          return { top: r.top, left: r.left, right: r.right, bottom: r.bottom, h: r.height, w: r.width };
        };
        const q = (s: string) => box(document.querySelector(s));
        // **按文字挑**：卡片里第一颗 button 是右上角那颗 ×（radius 4 / h 32）——
        // 用 querySelector 直接取第一颗会量到它，四条断言就全在量关闭钮。
        const btn = [...document.querySelectorAll(".ant-modal-content button")].find((b) =>
          b.textContent!.includes("我知道了"),
        )!;
        const bs = getComputedStyle(btn);
        const bd = document.querySelector(".ant-modal-body");
        return {
          card: q(".ant-modal-content"),
          head: q(".ant-modal-header"),
          title: q(".ant-modal-title"),
          text: q(".ant-modal-body div"),
          btn: box(btn),
          titleInBody: !!bd && bd.textContent!.includes("几何测量用公告"),
          btnStyle: {
            bgImage: bs.backgroundImage,
            radius: bs.borderRadius,
            height: bs.height,
            minWidth: bs.minWidth,
            fontSize: bs.fontSize,
          },
        } as Geo;
      });
      const card = g.card!;
      const title = g.title!;
      const btnBox = g.btn!;
      const top = Math.round(title.top - card.top);
      const l = Math.round(title.left - card.left);
      const rr = Math.round(card.right - title.right);
      expect.soft(
        g.head !== null && !g.titleInBody,
        `标题归 antd 顶栏（.ant-modal-header 在场、标题不在正文滚动区里） → head=${g.head !== null} titleInBody=${g.titleInBody}`,
      ).toBe(true);
      expect.soft(
        24 <= top && top <= 32,
        `卡片顶→标题 落在 24–32px（旧写法是 48px，这次上提） → ${top}px`,
      ).toBe(true);
      expect.soft(
        Math.abs(l - rr) <= 2,
        `标题左右留白对称（居中不被右上角的 × 挤偏） → 左 ${l}px / 右 ${rr}px`,
      ).toBe(true);
      expect.soft(
        title.bottom <= g.text!.top + 1,
        `标题在正文之上、且正文没被标题压住 → 标题底 ${Math.round(title.bottom - card.top)}px / 正文顶 ${Math.round(g.text!.top - card.top)}px`,
      ).toBe(true);
      expect.soft(
        27 <= Math.round(title.h) && Math.round(title.h) <= 34,
        `标题行高与字号协调（19px 字号 ⇒ 行盒 27–34px） → ${Math.round(title.h)}px`,
      ).toBe(true);
      const bs = g.btnStyle;
      expect.soft(
        parseFloat(bs.radius) >= 20,
        `「我知道了」是胶囊（borderRadius ≥ 20px） → ${bs.radius}`,
      ).toBe(true);
      expect.soft(
        Math.round(btnBox.h) >= 40 && parseFloat(bs.minWidth) >= 140,
        `按钮加高到 40px、最小宽 ≥ 140px（旧版是默认 32px/120px） → h=${Math.round(btnBox.h)} minWidth=${bs.minWidth}`,
      ).toBe(true);
      expect.soft(
        bs.bgImage.includes("gradient"),
        `按钮底色是 \`--washi-grad\` 那支渐变（浅色/深色两档在 index.css 里各一份 ⇒ 不是写死的单一色值） → ${bs.bgImage.slice(0, 60)}`,
      ).toBe(true);
      expect.soft(
        parseFloat(bs.fontSize) >= 15,
        `按钮文字比正文更醒目（15px ≥ 正文 15px）：浅色档是白字压深粉紫渐变 → ${bs.fontSize}`,
      ).toBe(true);

      // ──【九】同一张卡在深色主题下（后台那套）：配色必须跟着主题变（写死的色值做不到）──
      // 20261001 起"深色"的判据从 antd token 换成 isDarkMode（见 ENTRY 里的注释）：
      // 卡片是手账皮，纸底/胶带/渐变字全走 `--washi-*`，而 Modal Portal 到 body 上、
      // 够不着 `.frontDark`/`.dark`，深色档只能由组件自己加的 `.washiDark` 兜住。
      // __mountDark 同时给 darkAlgorithm 与 isDarkMode —— 两个来源仍是同一个 isDarkMode。
      await pg.evaluate(() => localStorage.removeItem("announcement_seen_id"));
      await pg.evaluate(() => {
        (window as unknown as { __clear: () => void }).__clear();
      });
      await pg.waitForTimeout(150);
      await pg.evaluate(() => {
        (window as unknown as { __mountDark: () => void }).__mountDark();
      });
      await pg.waitForTimeout(500);
      expect.soft((await popped(pg, "几何测量用公告")) > 0, "深色下卡片照样弹出来").toBe(true);
      interface DarkInfo {
        cardBg: string;
        cardLum: number;
        btnImage: string;
        titleColor: string;
        titleLum: number;
      }
      const dark = await pg.evaluate(() => {
        const card = document.querySelector(".ant-modal-content")!;
        const btn = [...card.querySelectorAll("button")].find((b) =>
          b.textContent!.includes("我知道了"),
        )!;
        const title = document.querySelector(".ant-modal-title")!;
        const lum = (c: string) => {
          const m = (c.match(/\d+/g) || []).map(Number);
          return (0.2126 * m[0] + 0.7152 * m[1] + 0.0722 * m[2]) / 255;
        };
        const cs = getComputedStyle(card);
        const titleEl = title.firstElementChild || title;
        return {
          cardBg: cs.backgroundColor,
          cardLum: lum(cs.backgroundColor),
          btnImage: getComputedStyle(btn).backgroundImage,
          titleColor: getComputedStyle(titleEl as Element).color,
          titleLum: lum(getComputedStyle(titleEl as Element).color),
        } as DarkInfo;
      });
      expect.soft(
        dark.cardLum < 0.35,
        `后台这套真的是深色（卡片底色亮度 < 0.35） → ${dark.cardBg}`,
      ).toBe(true);
      expect.soft(
        dark.titleLum > 0.5,
        `标题在深色底上是亮字（亮度 > 0.5 ⇒ 读得清） → ${dark.titleColor}`,
      ).toBe(true);
      expect.soft(
        dark.btnImage !== bs.bgImage && dark.btnImage.includes("gradient"),
        `按钮渐变跟着主题换了一套（与浅色那次不同 ⇒ 不是写死的色值） → ${dark.btnImage.slice(0, 70)}`,
      ).toBe(true);
      expect.soft(
        errs().length === 0,
        `全程没有页面错误 → ${errs().slice(0, 3).join(" | ")}`,
      ).toBe(true);
      await ctx.close();
    });
  });
});
