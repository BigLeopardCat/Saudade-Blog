import { test, expect } from "@playwright/test";
import path from "node:path";
import {
  FE_DIR,
  compileSass,
  htmlDoc,
  withSandbox,
  collectPageErrors,
  esbuildInSandbox,
} from "./sandbox";

/**
 * 后台「数据统计」页的无头验收：真组件 + 真 antd + 假后端。
 * （原 tests/analytics-tabs.test.py，20261019 迁移）
 *
 * 20261001 这一轮把这一页从"一张假的月更折线 + 一张假饼图"改成了**两个页签**：
 *   · 文章数据 —— 阅读量 / 点赞量 / 收藏量 / 讨论量（四个汇总卡 + 四个榜 + 30 天趋势）
 *     + **周报 / 月报 / 年报**（按期一张可展开的列表）；
 *   · 用户活跃 —— 直接渲染 `GET /api/protected/stats/users`。
 *
 * 这些东西里**只有真跑一遍才看得见**的占大多数：
 *   · 页标题上那条波浪线（`text-decoration: underline wavy`）删没删干净——
 *     是 computedStyle，不是源码文本；
 *   · 切粒度到底发没发对请求（`kind` / `limit` 有没有跟着走）——
 *     只有桩里记的请求条数说了算；
 *   · **`since` 为 null 与"统计了但都是 0"** 是两件事，界面上必须分开说——
 *     前者是「还没有统计数据」的空态，后者是一行行的 0；写错了从界面上看不出来；
 *   · 「部分统计」那枚 Tag 只在 `partial` 期上出现（上线那一周只有半截数据，
 *     不标出来会被读成"那周流量掉了"）。
 *
 * 沿用既定手段（本机不能 vite build，见 CLAUDE.md §2）：esbuild 把**真组件**打成一个
 * bundle、只桩 axios 这一个边界；sass 用 programmatic API 单独编译。
 * 本机无中文字体（截图里汉字是豆腐块），断言全走数值与请求，不受影响。
 */

const DEFINE_ENV =
  '{"VITE_HTTP_BASEURL":"","VITE_CDN_BASEURL":"","MODE":"production","DEV":false,"PROD":true,"BASE_URL":"/"}';

// ── 假后端 ──────────────────────────────────────────────────────────────────
// 三份数据刻意做出**三处不同的边界情形**，判据才不是空转：
//   · 文章报表：四个榜各有内容，总数非零；
//   · 期报：week 三期（第一期 partial）、month 一期、year **since=null**（一行记录都没有）
//     —— 这正是"空态 vs 一堆 0"那条判据要的输入；
//   · 用户报表：明细里留一行 `lastActiveAt: null`（"无活动"要显示成文字而不是空白）。
const FAKE_AXIOS = `
const calls: any[] = (window as any).__calls = [];

const env = (data: any) => ({ status: 200, data: { code: 200, message: 'ok', data } });

const rank = (n: number, base: number) => Array.from({ length: 5 }, (_, i) => ({
  noteId: 100 + i, title: '示例文章 ' + (i + 1) + '（标题长一点，验证省略号）',
  views: base - i * n, likes: base - i * n - 1, favorites: base - i * n - 2,
  comments: (base - i * n) % 7,
}));

const DAILY = Array.from({ length: 30 }, (_, i) => ({
  date: '2026-09-' + String(i + 1).padStart(2, '0'),
  views: i * 3, likes: i % 5, favorites: i % 3, comments: i % 4,
}));

const REPORT = {
  generatedAt: '2026-10-01 12:00',
  totalViews: 1234, totalLikes: 56, totalFavorites: 7, totalComments: 19,
  topViewed: rank(10, 500), topLiked: rank(2, 40), topFavorited: rank(1, 20),
  topCommented: rank(3, 30),
  daily: DAILY,
};

// 期报：三个粒度各给一份，**year 是 since=null**（没有数据的那一档）
const PERIODS: any = {
  week: {
    generatedAt: '2026-10-01 12:00', kind: 'week', since: '2026-09-28',
    periods: [
      { key: '2026-W40', label: '2026 年第 40 周', start: '2026-09-28', end: '2026-10-04',
        partial: true, views: 300, likes: 12, favorites: 3, comments: 8,
        topNotes: rank(5, 100) },
      { key: '2026-W39', label: '2026 年第 39 周', start: '2026-09-21', end: '2026-09-27',
        partial: false, views: 280, likes: 9, favorites: 1, comments: 5,
        topNotes: rank(4, 90) },
      { key: '2026-W38', label: '2026 年第 38 周', start: '2026-09-14', end: '2026-09-20',
        partial: false, views: 0, likes: 0, favorites: 0, comments: 0, topNotes: [] },
    ],
  },
  month: {
    generatedAt: '2026-10-01 12:00', kind: 'month', since: '2026-09-28',
    periods: [
      { key: '2026-10', label: '2026 年 10 月', start: '2026-10-01', end: '2026-10-31',
        partial: true, views: 42, likes: 3, favorites: 1, comments: 2, topNotes: rank(3, 30) },
    ],
  },
  year: { generatedAt: '2026-10-01 12:00', kind: 'year', since: null, periods: [] },
};

const USERS = {
  generatedAt: '2026-10-01 12:00',
  roleCounts: [{ role: 'admin', count: 1 }, { role: 'user', count: 3 }],
  totalUsers: 4, totalConversations: 9, totalMessages: 88, totalExecutions: 12,
  totalComments: 19,
  activeUsers7d: 2, activeUsers30d: 3, listedUsers: 2,
  users: [
    { id: 1, name: '管理员', role: 'admin', conversations: 6, messages: 70, comments: 11,
      lastActiveAt: '2026-10-01 11:30' },
    { id: 2, name: '用户#2', role: 'user', conversations: 3, messages: 18, comments: 0,
      lastActiveAt: null },
  ],
};

const http = async (cfg: any) => {
  const url = cfg.url as string;
  const params = cfg.params || {};
  calls.push({ url, params });
  if (url === '/api/protected/stats/notes') return env(REPORT);
  if (url === '/api/protected/stats/notes/periods') return env(PERIODS[params.kind] || PERIODS.week);
  if (url === '/api/protected/stats/users') return env(USERS);
  return env(null);
};
export default http;
`;

const ENTRY = `import * as React from 'react';
import { createRoot } from 'react-dom/client';
import Analytics from './src/pages/Dashboard/Analytics/index.tsx';
(window as any).__mount = () => createRoot(document.getElementById('root')!).render(<Analytics />);
`;

// 汇总卡的形状探针（20261011 第五轮，两个页签共用一份 —— 它们同一套类，
// 判据分开写容易只改一侧）。量的是**渲染值**，不是 sass 源码文本。
interface SummaryGeo {
  n: number;
  h: number[];
  w: number[];
  rows: number;
  oneLine: boolean;
  pad: string;
  clipped: string[];
}
const SUMMARY = (): SummaryGeo => {
  const pane = document.querySelector(
    ".analyticsBody .ant-tabs-tabpane-active",
  )!;
  const sum = pane.querySelector(".akSummary")!;
  const cards = [...sum.querySelectorAll(".akCard")] as HTMLElement[];
  const box = (el: Element) => el.getBoundingClientRect();
  return {
    n: cards.length,
    h: cards.map((c) => +box(c).height.toFixed(1)),
    w: cards.map((c) => +box(c).width.toFixed(1)),
    rows: new Set(cards.map((c) => Math.round(box(c).top))).size,
    oneLine: cards.every((c) => {
      const t = box(c.querySelector(".ant-statistic-title")!);
      const v = box(c.querySelector(".ant-statistic-content-value")!);
      return v.top < t.bottom - 2;
    }),
    pad: getComputedStyle(sum.querySelector(".ant-card-body")!).padding,
    clipped: cards
      .filter((c) => {
        const t = c.querySelector(".ant-statistic-title")!;
        return t.scrollWidth > t.clientWidth + 1;
      })
      .map(
        (c) =>
          (c.querySelector(".ant-statistic-title") as HTMLElement).textContent!.trim(),
      ),
  };
};

test.describe("后台数据统计页", () => {
  test.setTimeout(180_000);

  test("页签/汇总卡形状/期报折叠/粒度切换/用户活跃（36 条判据）", async ({ page }) => {
    // sass 单独编译（组件里 \`import './index.sass'\` 由 --loader:.sass=text 收下）
    const css = compileSass(
      path.join(FE_DIR, "src/pages/Dashboard/Analytics/index.sass"),
    );

    await withSandbox(
      {
        "index.html": htmlDoc(
          '<div id="root"></div><script src="bundle.js"></script>' +
            "<script>window.__mount();</script>",
          "html,body,#root{height:100%;margin:0}",
          css,
        ),
      },
      async (sb) => {
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

        await page.setViewportSize({ width: 1440, height: 900 });
        const errs = collectPageErrors(page);
        await page.goto(sb.url);
        await page.waitForSelector(".analyticsBody .ant-tabs", { timeout: 15_000 });
        await page.waitForTimeout(600);

        // ── 【一】页标题「数据统计」与两个页签 ──
        const head = await page.evaluate(() => {
          const h2 = document.querySelector(".analyticsBody .akTitle")!;
          const cs = getComputedStyle(h2);
          const activeEl = document.querySelector(
            ".analyticsBody .ant-tabs-tab-active",
          );
          return {
            text: h2.textContent!.trim(),
            deco: cs.textDecorationLine || cs.textDecoration,
            tabs: [...document.querySelectorAll(".analyticsBody .ant-tabs-tab")].map(
              (t) => t.textContent!.trim(),
            ),
            active: activeEl ? activeEl.textContent : null,
          };
        });
        expect.soft(
          head.text === "数据统计",
          `页标题是「数据统计」 → ${head.text}`,
        ).toBe(true);
        // 波浪线就是 `text-decoration-line: underline` + `text-decoration-style: wavy`。
        // 判 `wavy` 而不是判 `underline`：某天有人改成实线下划线也值得再看一眼，但**波浪**是
        // 用户点名要删的那个。
        expect.soft(
          !head.deco.includes("wavy"),
          `标题上没有波浪线了 → ${head.deco}`,
        ).toBe(true);
        expect.soft(
          JSON.stringify(head.tabs) === JSON.stringify(["文章数据", "用户活跃"]),
          `两个页签：文章数据 / 用户活跃 → ${JSON.stringify(head.tabs)}`,
        ).toBe(true);
        expect.soft(
          head.active === "文章数据",
          `默认落在「文章数据」 → ${JSON.stringify(head.active)}`,
        ).toBe(true);

        // ── 【二】文章数据页：四个汇总卡 + 四个榜 ──
        const cards = await page.evaluate(() =>
          [
            ...document.querySelectorAll(
              ".analyticsBody .akCard .ant-statistic-title",
            ),
          ].map((el) => el.textContent!.trim()),
        );
        expect.soft(
          JSON.stringify(cards) ===
            JSON.stringify(["总阅读量", "总点赞量", "总收藏量", "总讨论量"]),
          `四个汇总卡：总阅读量 / 总点赞量 / 总收藏量 / 总讨论量 → ${JSON.stringify(cards)}`,
        ).toBe(true);

        // ── 【二·b】汇总卡的形状（20261011 第五轮「容器比内容大」）──
        // 用户原话：「带数字的容器或者卡片就一个数值，容器却那么大」。改之前实测 **121px 高**
        // —— 内容只有 73px（14px 标签的 22px 行高 + 4px + 30px 数字的 47px 行高），
        // 剩下的 48px 全是 antd body 默认的 24px×2 内边距，而且标签与数字分两行。
        // 这一轮定成 56px 高的一行统计条。
        //
        // ⚠️ 判据为什么是这五条而不是"变矮了"：78px 也"变矮了"，而用户要的是**一行统计条**。
        //    所以高度（设计的量）、同行、并线、不再吃 24px 内边距、标签不截断，一起判；
        //    另外那条"四张等宽铺满"是**反向**的：宽度这一层刻意没动（用户说的是容器相对内容
        //    太大，不是太宽），写成判据免得后来人顺手把铺满也收掉。
        const geo = await page.evaluate(SUMMARY);
        expect.soft(
          geo.h.filter((h) => Math.abs(h - 56) > 0.6).length === 0,
          `四张汇总卡压成一行统计条（56px 高） → ${JSON.stringify(geo.h)}`,
        ).toBe(true);
        expect.soft(
          geo.rows === 1 && new Set(geo.w).size === 1 && geo.n === 4,
          `四张在同一行、等宽铺满面板 → ${JSON.stringify(geo.w)} rows=${geo.rows}`,
        ).toBe(true);
        expect.soft(
          geo.oneLine,
          `标签与数字并线（不再是上下两行） → ${geo.oneLine}`,
        ).toBe(true);
        expect.soft(
          geo.pad.startsWith("0px 14px"),
          `内边距不再是 antd 默认的 24px → ${geo.pad}`,
        ).toBe(true);
        expect.soft(
          geo.clipped.length === 0,
          `标签没被截断（数字优先，卡再窄也不切数字） → ${JSON.stringify(geo.clipped)}`,
        ).toBe(true);

        // 对照（判据有没有牙）：把改之前那一套**注入回去**，上面那几条必须变红。
        // 量几何的判据最容易写成"恒真"（比如把 \`getBoundingClientRect().height\` 写成常量、
        // 或选择器其实没选中任何元素），所以这里反向验一次，验完立刻摘掉
        // —— 留着它会污染后面「用户活跃」那七张卡。
        const ctl = await page.addStyleTag({
          content:
            ".analyticsBody .akSummary .akCard { height: auto !important; }" +
            ".analyticsBody .akSummary .akCard .ant-card-body { padding: 24px !important; display: block !important; }" +
            ".analyticsBody .akSummary .akCard .ant-statistic { display: block !important; }",
        });
        const back = await page.evaluate(SUMMARY);
        expect.soft(
          back.h.filter((h) => Math.abs(h - 56) > 0.6).length === 4 &&
            !back.oneLine &&
            !back.pad.startsWith("0px 14px"),
          `对照：注回旧规则后判据会红（高度/并线/内边距三条都不是恒真）` +
            ` → h=${JSON.stringify(back.h)} oneLine=${back.oneLine} pad=${back.pad}`,
        ).toBe(true);
        await page.evaluate(
          (el) => (el as HTMLElement).remove(),
          ctl,
        );
        const restored = await page.evaluate(SUMMARY);
        expect.soft(
          restored.h.filter((h) => Math.abs(h - 56) > 0.6).length === 0 &&
            restored.oneLine,
          `对照摘掉之后又回到 56px（\`!important\` 只活在那一下） → ${JSON.stringify(restored.h)}`,
        ).toBe(true);

        const panels = await page.evaluate(() =>
          [...document.querySelectorAll(".analyticsBody .akPanel > h3")].map((el) =>
            el.textContent!.trim(),
          ),
        );
        expect.soft(
          JSON.stringify(
            panels.filter((t) =>
              ["阅读量 Top", "点赞量 Top", "收藏量 Top", "讨论量 Top"].some((p) =>
                t.startsWith(p),
              ),
            ),
          ) ===
            JSON.stringify([
              "阅读量 Top 10",
              "点赞量 Top 10",
              "收藏量 Top 10",
              "讨论量 Top 10",
            ]),
          `四个榜单在位 → ${JSON.stringify(panels)}`,
        ).toBe(true);
        const lines = await page.evaluate(() => {
          const canvas = document.querySelector(
            ".analyticsBody .akChart canvas",
          ) as HTMLCanvasElement | null;
          return { hasChart: !!canvas, w: canvas ? canvas.width : 0 };
        });
        expect.soft(
          lines.hasChart && lines.w > 0,
          `趋势图画出来了（有 canvas） → ${JSON.stringify(lines)}`,
        ).toBe(true);

        // ── 【三】期报列表：折叠态 / 展开态 / partial 标记 ──
        const rows = await page.evaluate(() =>
          [
            ...document.querySelectorAll(
              ".analyticsBody .akPeriodList .ant-collapse-item",
            ),
          ].map((el) => ({
            label: el.querySelector(".akPeriodLabel")!.textContent!.trim(),
            nums: el
              .querySelector(".akPeriodNums")!
              .textContent!.replace(/\s+/g, " ")
              .trim(),
            partial: !!el.querySelector(".akPartial"),
          })),
        );
        expect.soft(
          rows.length === 3,
          `列出了三期（后端给了三期） → ${rows.length}`,
        ).toBe(true);
        expect.soft(
          rows.every((r) =>
            ["阅读", "点赞", "收藏", "讨论"].every((k) => r.nums.includes(k)),
          ),
          `行上带四个数（阅读/点赞/收藏/讨论） → ${rows[0] ? rows[0].nums : ""}`,
        ).toBe(true);
        expect.soft(
          JSON.stringify(rows.map((r) => r.partial)) ===
            JSON.stringify([true, false, false]),
          `只有标记 partial 的那一期挂「部分统计」 → ${JSON.stringify(rows.map((r) => r.partial))}`,
        ).toBe(true);
        expect.soft(
          rows[2]!.label.startsWith("2026 年第 38 周"),
          `第三期（本期零数据）仍然列出来 —— 零是「真零」，不是「没统计」 → ${rows[2] ? rows[2].label : ""}`,
        ).toBe(true);

        // 展开第一期之前，正文（那 5 行标题）不该在页面上
        const before = await page.evaluate(
          () =>
            document.querySelectorAll(
              ".analyticsBody .akPeriodList .ant-collapse-content-active",
            ).length,
        );
        expect.soft(
          before === 0,
          `默认全部折叠 → 展开中的面板 ${before} 个`,
        ).toBe(true);
        await page
          .locator(".analyticsBody .akPeriodList .ant-collapse-header")
          .first()
          .click();
        await page.waitForTimeout(500);
        const opened = await page.evaluate(() => {
          const box = document.querySelector(
            ".analyticsBody .ant-collapse-content-active",
          );
          if (!box) return null;
          return {
            n: box.querySelectorAll(".akRank li").length,
            first:
              (box.querySelector(".akRankTitle") || ({} as HTMLElement))
                .textContent ?? null,
            nums:
              (
                (box.querySelector(".akRankNums") || ({} as HTMLElement))
                  .textContent || ""
              )
                .replace(/\s+/g, " ")
                .trim(),
          };
        });
        expect.soft(
          !!opened && opened.n === 5,
          `展开第一期后出现榜单正文 → ${opened ? opened.n : "null"}`,
        ).toBe(true);
        expect.soft(
          !!opened && (opened.first || "").includes("示例文章 1"),
          `正文里的标题是完整标题（不是图表里的截断） → ${opened ? opened.first : "null"}`,
        ).toBe(true);
        expect.soft(
          !!opened &&
            ["阅读", "点赞", "收藏", "讨论"].every((k) => opened.nums.includes(k)),
          `期报正文每行带四个数 → ${opened ? opened.nums : "null"}`,
        ).toBe(true);

        // 第三期（零数据）展开后要说"没有数据"，而不是空面板
        await page
          .locator(".analyticsBody .akPeriodList .ant-collapse-header")
          .nth(2)
          .click();
        await page.waitForTimeout(500);
        const emptyTxt = await page.evaluate(() => {
          const items = [
            ...document.querySelectorAll(
              ".analyticsBody .akPeriodList .ant-collapse-item",
            ),
          ];
          const box = items[2]!.querySelector(".ant-collapse-content-active");
          return box
            ? box.textContent!.replace(/\s+/g, " ").trim()
            : "";
        });
        expect.soft(
          emptyTxt.includes("没有数据"),
          `零数据那一期展开后明说「没有数据」 → ${emptyTxt.slice(0, 40)}`,
        ).toBe(true);

        // ── 【四】切粒度：请求参数必须跟着走 ──
        await page
          .locator(".analyticsBody .ant-segmented-item", { hasText: "月报" })
          .click();
        await page.waitForTimeout(600);
        const lastMonth = await page.evaluate(() => {
          const c = (window as unknown as { __calls: Array<{ url: string; params: Record<string, string> }> }).__calls;
          return c[c.length - 1]!;
        });
        expect.soft(
          lastMonth.params["kind"] === "month" &&
            parseInt(lastMonth.params["limit"], 10) === 12,
          `切「月报」发出了 kind=month&limit=12 → ${JSON.stringify(lastMonth.params)}`,
        ).toBe(true);
        const nMonth = await page.evaluate(
          () =>
            document.querySelectorAll(
              ".analyticsBody .akPeriodList .ant-collapse-item",
            ).length,
        );
        expect.soft(
          nMonth === 1,
          `月报只剩一期（后端给几期就渲染几期） → ${nMonth}`,
        ).toBe(true);

        await page
          .locator(".analyticsBody .ant-segmented-item", { hasText: "年报" })
          .click();
        await page.waitForTimeout(600);
        const lastYear = await page.evaluate(() => {
          const c = (window as unknown as { __calls: Array<{ url: string; params: Record<string, string> }> }).__calls;
          return c[c.length - 1]!;
        });
        expect.soft(
          lastYear.params["kind"] === "year" &&
            parseInt(lastYear.params["limit"], 10) === 5,
          `切「年报」发出了 kind=year&limit=5 → ${JSON.stringify(lastYear.params)}`,
        ).toBe(true);
        // since=null ⇒ **一行记录都还没有**，此时必须走空态，绝不能渲染一行行的 0
        const year = await page.evaluate(() => ({
          rows: document.querySelectorAll(
            ".analyticsBody .akPeriodList .ant-collapse-item",
          ).length,
          txt: document
            .querySelector(".analyticsBody .akPeriods")!
            .textContent!.replace(/\s+/g, " ")
            .trim(),
        }));
        expect.soft(
          year.rows === 0,
          `since=null 时不渲染任何期行 → rows=${year.rows}`,
        ).toBe(true);
        expect.soft(
          year.txt.includes("还没有统计数据"),
          `since=null 时给的是「还没有统计数据」空态（**不是**一排 0） → ${year.txt.slice(0, 60)}`,
        ).toBe(true);

        // ── 【五】用户活跃页签 ──
        const nBefore = await page.evaluate(
          () =>
            (window as unknown as { __calls: unknown[] }).__calls.length,
        );
        await page
          .locator(".analyticsBody .ant-tabs-tab", { hasText: "用户活跃" })
          .click();
        await page.waitForTimeout(900);
        const callsAfter = await page.evaluate(
          (n) =>
            (window as unknown as { __calls: Array<{ url: string }> }).__calls
              .slice(n)
              .map((c) => c.url),
          nBefore,
        );
        expect.soft(
          JSON.stringify(callsAfter) ===
            JSON.stringify(["/api/protected/stats/users"]),
          `切过去才发请求（且打的是 stats/users） → ${JSON.stringify(callsAfter)}`,
        ).toBe(true);
        // 留在 DOM 里 ≠ 看得见。非活动页签必须**真的被藏起来**——这条钉的是 sass 里
        // 记的那个坑：\`.analyticsBody .ant-tabs-tabpane { display:flex }\`（0,2,0）
        // 会盖过 antd 的 \`.ant-tabs-tabpane-hidden { display:none }\`（0,1,0），
        // 两个页签的内容会**同时**铺在屏幕上（间距交给内层 \`.akPane\` 正是为躲开它）。
        const hidden = await page.evaluate(() =>
          [...document.querySelectorAll(".analyticsBody .ant-tabs-tabpane")].map(
            (el) => getComputedStyle(el).display,
          ),
        );
        // 判据是"**有且只有一个**页签看得见"，不写死另一个的值：antd 自己没给
        // \`.ant-tabs-tabpane\` 定 display（就是 \`block\`），而本页的排版在更里面的 \`.akPane\`。
        expect.soft(
          hidden.filter((d) => d === "none").length === 1 && hidden.length === 2,
          `有且只有一个页签可见（非活动的那个 display:none） → ${JSON.stringify(hidden)}`,
        ).toBe(true);
        // ⚠️ 必须**限定在活动页签内**：antd 的 Tabs 默认 \`destroyInactiveTabPane=false\`，
        // 头一个页签进过一次就留在 DOM 里（只是 \`display:none\`）。不加这层会一次数到
        // 十一个卡（文章数据那四个 + 这里七个），看起来像"多渲染了"，其实是对面那个页签。
        const uCards = await page.evaluate(() =>
          [
            ...document.querySelectorAll(
              ".analyticsBody .ant-tabs-tabpane-active .akCard .ant-statistic-title",
            ),
          ].map((el) => el.textContent!.trim()),
        );
        expect.soft(
          JSON.stringify(uCards) ===
            JSON.stringify([
              "活跃用户（7 天）",
              "活跃用户（30 天）",
              "用户总数",
              "总会话数",
              "总消息数",
              "总执行数",
              "总讨论数",
            ]),
          `七张汇总卡（活跃 7 天/30 天 + 用户/会话/消息/执行/讨论） → ${JSON.stringify(uCards)}`,
        ).toBe(true);
        // 同一套类 ⇒ 同一副形状（20261011）。这里**只判形状不判行数**：七张卡在这个宽度下
        // 本来就折行，折成几行取决于面板有多宽（沙箱是 1440 独立挂载，真后台还要减掉侧栏
        // 与两级内边距），把行数写成判据等于把某一次量到的视口宽度钉进测试。
        const uGeo = await page.evaluate(SUMMARY);
        expect.soft(
          uGeo.n === 7 &&
            uGeo.h.filter((h) => Math.abs(h - 56) > 0.6).length === 0 &&
            uGeo.oneLine &&
            uGeo.clipped.length === 0,
          `用户活跃页七张卡也是同一种一行统计条（56px、并线、不截断）` +
            ` → h=${JSON.stringify(uGeo.h)} clipped=${JSON.stringify(uGeo.clipped)}`,
        ).toBe(true);
        const table = await page.evaluate(() => {
          const rows = [
            ...document.querySelectorAll(
              ".analyticsBody .ant-table-tbody tr.ant-table-row",
            ),
          ];
          return {
            n: rows.length,
            last: rows.map((r) => r.lastElementChild!.textContent!.trim()),
            head: [...document.querySelectorAll(".analyticsBody .ant-table-thead th")].map(
              (t) => t.textContent!.trim(),
            ),
          };
        });
        expect.soft(
          table.n === 2,
          `明细两行都在 → ${table.n}`,
        ).toBe(true);
        // \`lastActiveAt: null\` 必须显示成文字 —— 空白会被读成"渲染坏了"（stats.rs 的口径原话）
        expect.soft(
          table.last[1] === "无活动",
          `无活动的用户显示「无活动」而不是空白 → ${JSON.stringify(table.last)}`,
        ).toBe(true);
        expect.soft(
          JSON.stringify(table.head) ===
            JSON.stringify(["用户", "角色", "会话数", "消息数", "讨论数", "最近活动"]),
          `表头是活动口径那几列（讨论数在第 5 列，最近活动仍是最后一列） → ${JSON.stringify(table.head)}`,
        ).toBe(true);

        expect.soft(
          errs().length === 0,
          `全程无页面异常 → ${errs().slice(0, 3).join("; ")}`,
        ).toBe(true);
      },
    );
  });
});
