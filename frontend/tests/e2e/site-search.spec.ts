import { test, expect, type Browser, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { copyFile } from "node:fs/promises";
import path from "node:path";
import {
  FE_DIR,
  withSandbox,
  esbuildInSandbox,
  collectPageErrors,
  compileSass,
  htmlDoc,
} from "./sandbox";

/**
 * 站内聚合搜索（20261006）无头验收：真 Head 组件 + 假后端，走真渲染与真点击。
 * （原 tests/site-search.test.py，20261019 迁移）
 *
 * 为什么值得单起一个脚本：
 *   「点了一条结果能不能到那一条上」这件事**只有真跑一遍才知道**——四类四条路径，
 *   写错一条的症状是"某一类点了没反应 / 跳到别处"，不报错、不白屏、编译也照样过。
 *   另有两条同样只在真渲染里看得见的：
 *     · 计数栏那四枚在 375 视口会不会把整行撑出弹窗（`flex-wrap` 写了不等于生效）；
 *     · 读失败会不会被渲染成"没搜到"（本站失败是 HTTP 200 + code=500，只看 status 就会）。
 *
 *   纯模型与源码契约（`hitTarget` 四条路径、说说深链读的是响应式 searchParams）由
 *   `tests/site-search.test.mjs` 在 CI 里守着；这里负责几何与真点击。
 *
 *     · sass 用 programmatic API 编译（CLI sass 在本机有 chokidar 的 ESM 问题）；
 *     · esbuild 把真 Head 打成一个 bundle，**只桩边界**（axios 假后端 / 路由 / redux），
 *       antd 与 react-dom 都用真的；
 *     · Playwright 真渲染后按"发了什么请求 + 界面变成什么样 + `__nav` 记到了什么"断言。
 *
 * 注意：本机无中文字体（fc-list CJK = 0）⇒ 汉字是豆腐块，结构与请求判据不受影响；
 * 像素那一节的字号读数特意用 ASCII 文案（见 ⑩）。
 */

const DEFINE = JSON.stringify({
  VITE_HTTP_BASEURL: "",
  VITE_CDN_BASEURL: "",
  MODE: "production",
  DEV: false,
  PROD: true,
  BASE_URL: "/",
});

// ── 假后端：只桩 axios 这一个边界 ─────────────────────────────────────────────
const FAKE_AXIOS = `
// 假后端。\`window.__calls\` 记每一次请求，测试按它断言"该发的发了、没发的没发"。
const calls: any[] = (window as any).__calls = [];
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
// 信封照抄后端：**失败也是 HTTP 200**，靠 \`code\` 分。只看 status 的写法在这里会露馅。
const env = (data: any) => ({ status: 200, data: { code: 200, message: 'ok', data } });
const fail = (msg: string) => ({ status: 200, data: { code: 500, message: msg, data: null } });

// 四类混合命中。**字段名与后端逐字一致**（\`board\` 是单数、\`comments\` 是复数）——
// 这里写对了而真身写错，正是 \`hitsOf\` 那个映射要挡的事，两边都必须是真名。
const FIX = () => ({
  total: 6,
  counts: { note: 2, talk: 2, board: 1, comment: 1 },
  notes: [
    { type: 'note', key: 5, title: '文章甲', snippet: '正文里有 河灯 两个字', author: '站长',
      noteId: null, createTime: '2026-07-01 10:00:00' },
    { type: 'note', key: 6, title: '文章乙', snippet: '也提到 河灯', author: '站长',
      noteId: null, createTime: '2026-07-02 10:00:00' },
  ],
  talks: [
    { type: 'talk', key: 9, title: '说说甲', snippet: '河灯 很好看', author: '泠月喵',
      noteId: null, createTime: '2026-07-03 10:00:00' },
    { type: 'talk', key: 10, title: '说说乙', snippet: '河灯 之二', author: '泠月喵',
      noteId: null, createTime: '2026-07-04 10:00:00' },
  ],
  board: [
    { type: 'board', key: 8, title: '', snippet: '留言里也有 河灯', author: '留名甲',
      noteId: null, createTime: '2026-07-05 10:00:00' },
  ],
  comments: [
    { type: 'comment', key: 41, title: '文章甲', snippet: '评论里提到 河灯', author: '路人',
      noteId: 5, createTime: '2026-07-06 10:00:00' },
  ],
});

const http = async (cfg: any) => {
  const url = cfg.url as string;
  const method = (cfg.method || 'GET').toUpperCase();
  calls.push({ url, method, data: cfg.data });
  await delay(30);

  if (url === '/api/public/search') {
    // 竞态用例专用（\`__seqTest\`）：**回什么由关键词本身决定**，且指定某个关键词走慢通道。
    // 这样"最后画在屏幕上的是哪一次的结果"是一眼可读的（条数 = 关键词长度、标题里带关键词）。
    if ((window as any).__seqTest) {
      const kw = ((cfg.data || {}).keyword || '') as string;
      if (kw === (window as any).__slowKw) await delay(1500);
      const n = kw.length;
      return env({
        total: n, counts: { note: n, talk: 0, board: 0, comment: 0 },
        notes: Array.from({ length: n }, (_, i) => ({
          type: 'note', key: 100 + i, title: '№' + (i + 1) + '·' + kw, snippet: '正文 ' + kw,
          author: '站长', noteId: null, createTime: '2026-07-01 10:00:00' })),
        talks: [], board: [], comments: [],
      });
    }
    if ((window as any).__searchFail) return fail('查询失败，请稍后再试');
    if ((window as any).__searchEmpty) {
      return env({ total: 0, counts: { note: 0, talk: 0, board: 0, comment: 0 },
                   notes: [], talks: [], board: [], comments: [] });
    }
    if ((window as any).__searchNoNote) {
      const f = FIX();
      f.notes = []; f.counts.note = 0; f.total = 4;
      return env(f);
    }
    return env(FIX());
  }
  // 其余端点（头部挂载时那些 thunk、用户中心轮询）一律成功、数据为 null
  return env(null);
};

export default http;
`;

// ⚠️ 桩是**真模块表面的手抄副本**：`src/` 里从 react-router-dom 多 import 一个名字，
// 这里没跟着补 ⇒ esbuild 当场 `No matching export` 整包失败。
const STUB_ROUTER = `export const useLocation = () => ({ pathname: '/', search: '', hash: '' });
export const useNavigate = () => (to: string) => {(window as any).__nav = ((window as any).__nav || []).concat(to); };
// Head 本身还没用 useSearchParams（说说页才用，不在本沙箱里）——先备着，
// 免得日后谁把入口挂到 Head 上时这套件以"打包失败"的方式炸掉。
export const useSearchParams = () => [new URLSearchParams(''), () => {}];
`;

const STUB_REDUX = `const state: any = {
  categories: { categories: [] },
  tags: { tags: [] },
  note: { noteList: [] },
  user: { avatar: '/owner.png', blogTitle: 'Saudade' },
};
export const useSelector = (fn: any) => fn(state);
export const useDispatch = () => (_action: any) => Promise.resolve({ status: 200, data: { code: 200, data: null } });
export const Provider = ({ children }: any) => children;
export const connect = () => (C: any) => C;
`;

// 沙箱根 tsconfig：esbuild 的 paths 解析（替代原 CLI --alias）。
const TSCONFIG_PATHS = JSON.stringify({
  compilerOptions: {
    paths: {
      "react-router-dom": ["./stub-router.tsx"],
      "react-redux": ["./stub-redux.tsx"],
    },
  },
});

const HEAD_ENTRY = `
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import Head from './src/frontHome/Head/index.tsx';
(window as any).__mountHead = () => createRoot(document.getElementById('root')!).render(
  <Head setDark={() => {}} isDark={false} scrollHeight={0} />
);
`;

interface Opened {
  ctx: ReturnType<Browser["newContext"]> extends Promise<infer T> ? T : never;
  page: Page;
  errs: () => string[];
}

test("站内聚合搜索：防抖/竞态/四类混排/筛选/深链/失败空态/窄屏几何/遮罩可读性", async ({
  browser,
}) => {
  test.setTimeout(240_000);
  await withSandbox({}, async (sb) => {
    // 全站样式表（`src/main.tsx` 第一行就 import 它）：`--washi-*` 令牌与 `.frontDark`
    // 那几套都住在里面。沙箱只编译组件那份 .sass 的话，靠令牌上色的规则**根本不存在**，
    // 几何/颜色断言会把"规则没生效"读成"页面缺陷"（20260929 那批假红就是这么来的）。
    const css =
      compileSass(path.join(FE_DIR, "src/frontHome/Head/index.sass")) +
      readFileSync(path.join(FE_DIR, "src/index.css"), "utf-8");
    // 头像走**根相对路径**，必须走 HTTP 而不是 file://（copySrc 不带 public/，单拷这一张）
    await copyFile(
      path.join(FE_DIR, "public/default-avatar.png"),
      path.join(sb.dir, "default-avatar.png"),
    );

    await esbuildInSandbox(sb, {
      entry: "head-entry.tsx",
      copySrc: true,
      define: { "import.meta.env": DEFINE },
      loaders: { ".sass": "text" },
      outfile: "head-bundle.js",
      files: {
        "src/apis/axios.tsx": FAKE_AXIOS,
        "stub-router.tsx": STUB_ROUTER,
        "stub-redux.tsx": STUB_REDUX,
        "head-entry.tsx": HEAD_ENTRY,
        "tsconfig.json": TSCONFIG_PATHS,
      },
    });
    await sb.write(
      "head.html",
      htmlDoc(
        '<div id="root"></div>' +
          '<script src="head-bundle.js"></script>' +
          "<script>window.__mountHead();</script>",
        css,
      ),
    );
    const HEAD_URL = new URL("head.html", sb.url).toString();

    const searches = (pg: Page) =>
      pg
        .evaluate(() => (window as any).__calls || [])
        .then((cs) =>
          cs.filter(
            (c: { url: string }) => c.url === "/api/public/search",
          ),
        );

    /** 挂真 Head → 从**真入口**点开搜索弹窗。
     *
     * ⚠️ 两个入口，按视口分：`.homeRight` 在 ≤1200px 是 `display: none`（窄屏走抽屉），
     * 照抄桌面那套会在 `.homeRight > div` 上一直等到超时（这不是页面缺陷，是两套入口本来的分工）。
     *
     * 窄屏这里**直接点抽屉里的 `.mSearchInput`**，跳过"先点汉堡钮拉开抽屉"那一步：
     * 汉堡钮是个 iconfont 字形（`<i class="iconfont icon-bars">`），沙箱引不到那套字体
     * ⇒ 它是 0×0 的盒子，点不到；抽屉本身的几何又长在 `pages/Dashboard/Home/index.sass`
     * （本沙箱没编译它）。跳过的只是"拉开抽屉"这个动画，`.mSearchInput` 的 onClick
     * （`closePhoneBar(); showModal();`）与线上是**同一个**，弹窗那部分不经过任何简化。 */
    const openModal = async (
      init?: string,
      w = 1280,
      h = 900,
    ): Promise<Opened> => {
      const ctx = await browser.newContext({ viewport: { width: w, height: h } });
      const page = await ctx.newPage();
      const errs = collectPageErrors(page);
      if (init) await page.addInitScript(init);
      await page.goto(HEAD_URL);
      if (w > 1200) {
        await page.waitForSelector(".homeRight > div", { timeout: 15000 });
        await page.waitForTimeout(500);
        await page.locator(".homeRight > div").first().click();
      } else {
        await page.waitForSelector(".mSearchInput", { timeout: 15000 });
        await page.waitForTimeout(500);
        await page.locator(".mSearchInput").click();
      }
      await page.waitForSelector(".searchModalInput", { timeout: 10000 });
      await page.waitForTimeout(300);
      return { ctx, page, errs };
    };

    const typeSearch = async (pg: Page, kw = "河灯", settle = 800) => {
      await pg.fill(".searchModalInput", kw);
      await pg.waitForTimeout(settle);
    };

    const chipTexts = (pg: Page) =>
      pg.evaluate(() =>
        [...document.querySelectorAll(".search-chip")].map((e) =>
          (e.textContent || "").trim(),
        ),
      );
    const badges = (pg: Page) =>
      pg.evaluate(() =>
        [...document.querySelectorAll(".search-item .search-badge")].map((e) =>
          (e.textContent || "").trim(),
        ),
      );
    /** 结果行的标题文本（留言那一行没有标题，自然不在里面）——①d 判「屏幕上是谁的结果」用。 */
    const titles = (pg: Page) =>
      pg.evaluate(() =>
        [...document.querySelectorAll(".search-item .search-item-title")].map(
          (e) => (e.textContent || "").trim(),
        ),
      );
    const navLast = (pg: Page) =>
      pg.evaluate(() => ((window as any).__nav || []).slice(-1)[0] ?? null);

    /** 点了一条结果后弹窗会关掉（`openHit` 先关再跳）。再开一次继续点。 */
    const reopen = async (pg: Page) => {
      await pg.waitForTimeout(500);
      await pg.locator(".homeRight > div").first().click();
      await pg.waitForSelector(".searchModalInput", { timeout: 10000 });
      await pg.waitForTimeout(400);
    };

    const opened: Array<[Opened, string]> = [];
    const track = (o: Opened, name: string) => {
      opened.push([o, name]);
      return o;
    };
    const close = async (o: Opened) => {
      await o.ctx.close();
    };

    // ── ① 请求：防抖、端点、关键词 ────────────────────────────────────────────
    const s1 = track(await openModal(), "①");
    const pg = s1.page;
    await pg.fill(".searchModalInput", "河灯");
    await pg.waitForTimeout(200);
    expect
      .soft(
        (await searches(pg)).length,
        "刚敲完不立刻发请求（500ms 防抖）",
      )
      .toBe(0);
    await pg.waitForTimeout(700);
    const s = await searches(pg);
    expect.soft(s.length, "停手后自己发了一次").toBe(1);
    expect
      .soft(
        s.length > 0 &&
          s[0].url === "/api/public/search" &&
          s[0].method === "POST" &&
          (s[0].data || {}).keyword === "河灯",
        "打的是聚合端点、POST、带上关键词",
      )
      .toBe(true);

    // ── ①b 逐字符输入（用户 20261013 报的「输入内容时抖动」）────────────────────
    // ①节一直用 `fill()`，而 `fill()` 只发**一次** input 事件 ⇒ 它看不见"防抖器每次
    // render 换一个新的"这件事。真人是逐字符敲的，这里就必须逐字符敲（`keyboard.type`）。
    // 修复前的实测：敲 5 个字发 **5 次**请求（河 / 河灯 / 河灯留 / 河灯留言 / 河灯留言板），
    // 每个回包各 `setAgg` 一次 ⇒ 结果面随回包先后反复重画（抖动），且乱序时会显示错的词的结果。
    const s1b = track(await openModal(), "①b");
    const pn = s1b.page;
    await pn.click(".searchModalInput");
    await pn.keyboard.type("河灯留言板", { delay: 60 }); // 5 个字、共 ~300ms < 500ms 防抖
    await pn.waitForTimeout(1200);
    const sb1 = await searches(pn);
    expect
      .soft(sb1.length, "敲 5 个字只发一次请求（修复前 5 次）")
      .toBe(1);
    expect
      .soft(
        sb1.length > 0 && (sb1[0].data || {}).keyword === "河灯留言板",
        "发出去的是**整串**关键词，不是某个中间前缀",
      )
      .toBe(true);
    await close(s1b);

    // ── ①c 清空输入框 ───────────────────────────────────────────────────────
    // 防御的是"清空之后，先前沿途按键留下的那些防抖定时器一个个到点，用**已经不在框里**
    // 的旧关键词接着发请求"。修复前实测：敲两个字（河、河灯）后立刻清空，照样发出
    // **2 次**（`河`、`河灯`）——因为每次按键各建了一个防抖器，清空这条早退路径谁也没 cancel。
    // 注意症状在 DOM 里是**看不见**的：卡片整块的 display 由 `searchKeyword` 决定
    // （空 ⇒ 整块隐藏），所以在途回包就算把 agg 填回来也渲染不出来 ⇒ 判据只能落在
    // 请求本身（"清空后一次都不许发"），不能落在"列表是不是空的"（那恒真）。
    const s1c = track(await openModal(), "①c");
    const pc = s1c.page;
    await pc.click(".searchModalInput");
    await pc.keyboard.type("河灯", { delay: 40 });
    await pc.waitForTimeout(60); // 仍在 500ms 防抖窗口内
    await pc.fill(".searchModalInput", "");
    await pc.waitForTimeout(1000); // 足够让那次防抖到点（若没被 cancel）
    expect
      .soft(
        (await searches(pc)).length,
        "清空之后一次请求都没发（挂着的那次被 cancel 掉了）",
      )
      .toBe(0);
    await close(s1c);

    // ── ①d 乱序回包 ────────────────────────────────────────────────────────
    // 真网络上"慢的是前一次查询"是常态，本地假后端按调用顺序同步返回 ⇒ 只有**手造慢通道**
    // 才看得见。没有序号闸时，慢的旧回包最后落地、把新关键词的结果盖掉 —— 那不只是抖，
    // 是**显示错的搜索结果**（框里写着 A，列表里是 B 的结果）。
    const s1d = track(
      await openModal("window.__seqTest = true; window.__slowKw = '河';"),
      "①d",
    );
    const pd = s1d.page;
    await pd.click(".searchModalInput");
    await pd.keyboard.type("河", { delay: 40 });
    await pd.waitForTimeout(700); // 第一条（关键词「河」，慢通道 1.5s）已在途
    expect
      .soft((await searches(pd)).length, "这时确实有一条请求在途")
      .toBe(1);
    await pd.keyboard.type("灯", { delay: 40 }); // 值变成「河灯」→ 500ms 后再发一条（快）
    await pd.waitForTimeout(1000); // 快的那条先落地
    expect
      .soft(
        await pd.locator(".search-item").count(),
        "先看到的是新关键词「河灯」的结果（2 条）",
      )
      .toBe(2);
    await pd.waitForTimeout(1700); // 慢的那条（旧关键词「河」）此刻才落地
    expect
      .soft(await titles(pd), "旧关键词的慢回包落地后，列表仍是「河灯」的结果（没有被盖回 1 条）")
      .toEqual(["№1·河灯", "№2·河灯"]);
    expect
      .soft(
        (await searches(pd)).length,
        "两次请求都发出去了（判据是「谁画在屏幕上」，不是「省掉了一次请求」）",
      )
      .toBe(2);
    await close(s1d);

    // ── ② 标题行：总数 + 四枚计数 ────────────────────────────────────────────
    const total = await pg.locator(".searchTotal").innerText();
    expect
      .soft(total, "总数是全角括号的「搜索结果（6）」")
      .toBe("搜索结果（6）");
    expect
      .soft(await chipTexts(pg), "四枚计数按 文章→说说→留言→评论 的顺序、各带自己的命中数")
      .toEqual(["文章（2）", "说说（2）", "留言（1）", "评论（1）"]);
    expect
      .soft(
        await pg.locator(".search-chip.is-active").count(),
        "默认没有选中任何一枚（= 全部）",
      )
      .toBe(0);

    // ── ③ 列表：四类混排、每组相邻、行首有类型徽章 ────────────────────────────
    expect
      .soft(await pg.locator(".search-item").count(), "六条命中都在（四类之和）")
      .toBe(6);
    expect
      .soft(await badges(pg), "分组序 = 文章,文章,说说,说说,留言,评论")
      .toEqual(["文章", "文章", "说说", "说说", "留言", "评论"]);
    expect
      .soft(
        await pg
          .locator(".search-item", { hasText: "留言里也有 河灯" })
          .locator(".search-item-title")
          .count(),
        "留言那一行没有标题行（那一列的 title 是印章，后端给的是空串）",
      )
      .toBe(0);
    expect
      .soft(
        await pg
          .locator(".search-item", { hasText: "评论里提到 河灯" })
          .locator(".search-item-title")
          .innerText(),
        "评论那一行带的是**所属文章**的标题",
      )
      .toBe("文章甲");

    // ── ④ 筛选：单击选中、再点回到全部 ───────────────────────────────────────
    await pg.locator(".search-chip", { hasText: "说说" }).click();
    await pg.waitForTimeout(300);
    expect
      .soft(await pg.locator(".search-item").count(), "只剩说说的两条")
      .toBe(2);
    expect.soft(await badges(pg), "两行都是说说").toEqual(["说说", "说说"]);
    expect
      .soft(
        (await pg.locator(".search-chip.is-active").innerText()).startsWith("说说"),
        "选中态标在那一枚上（一眼看得出选中的是谁）",
      )
      .toBe(true);
    expect
      .soft(
        (await searches(pg)).length,
        "筛选是**本地**的，不再打一次请求",
      )
      .toBe(1);
    await pg.locator(".search-chip", { hasText: "说说" }).click();
    await pg.waitForTimeout(300);
    expect
      .soft(await pg.locator(".search-item").count(), "再点一次回到全部（六条）")
      .toBe(6);
    expect
      .soft(
        await pg.locator(".search-chip.is-active").count(),
        "回到全部后没有选中态",
      )
      .toBe(0);

    // ── ⑤ 每一条都点得动、各自跳到那一条自己 ────────────────────────────────
    const cases: Array<[string, string, string]> = [
      ["文章甲", "/article/5", "文章 → 文章详情"],
      ["河灯 很好看", "/talk?tk=9", "说说 → 说说列表定位到那一条"],
      ["留言里也有 河灯", "/guestbook?lid=8", "留言 → 留言板定位到那盏灯"],
      ["评论里提到 河灯", "/article/5?cid=41", "评论 → 所属文章 + 评论区定位到那条"],
    ];
    for (const [text, want, desc] of cases) {
      const row = pg.locator(".search-item", { hasText: text });
      expect.soft(await row.count(), `${desc}（找到那一行）`).toBeGreaterThan(0);
      if ((await row.count()) === 0) continue;
      await row.first().click();
      await pg.waitForTimeout(600);
      expect
        .soft(await navLast(pg), `${desc}（__nav 最后一项）`)
        .toBe(want);
      await reopen(pg);
    }

    // 点行之后弹窗应当关上（否则跳过去还压着一层）
    await pg.locator(".search-item").first().click();
    await pg.waitForTimeout(600);
    expect
      .soft(
        (await pg.locator(".searchModalInput").count()) === 0 ||
          !(await pg.locator(".searchModalInput").first().isVisible()),
        "点了一条之后弹窗自己关掉",
      )
      .toBe(true);
    await close(s1);

    // ── ⑥ 读失败 ≠ 没搜到 ───────────────────────────────────────────────────
    const s6 = track(await openModal("window.__searchFail = true;"), "⑥");
    const p6 = s6.page;
    await typeSearch(p6);
    const empty6 = await p6.locator(".searchEmpty").count();
    const empty6Text = empty6 ? await p6.locator(".searchEmpty").innerText() : "(没有空态)";
    expect
      .soft(
        empty6 === 1 && empty6Text.includes("搜索失败"),
        `说了「搜索失败，请稍后再试」→ ${empty6Text}`,
      )
      .toBe(true);
    expect
      .soft(
        await p6.locator(".searchEmpty", { hasText: "未找到" }).count(),
        "没有把它说成「未找到相关内容」",
      )
      .toBe(0);
    expect
      .soft(
        await p6.locator(".search-item").count(),
        "失败时列表是空的（没有半截结果压着）",
      )
      .toBe(0);
    await close(s6);

    // ── ⑦ 空态三种说法互不混淆 ──────────────────────────────────────────────
    const s7a = track(await openModal("window.__searchEmpty = true;"), "⑦a");
    const p7a = s7a.page;
    await typeSearch(p7a);
    expect
      .soft(
        (await p7a.locator(".searchEmpty").innerText()).includes("未找到相关内容"),
        "四类全空 → 未找到相关内容",
      )
      .toBe(true);
    expect
      .soft(await chipTexts(p7a), "全空时四枚计数照样显示（计数是事实，不是空就藏起来）")
      .toEqual(["文章（0）", "说说（0）", "留言（0）", "评论（0）"]);
    await close(s7a);

    const s7b = track(await openModal("window.__searchNoNote = true;"), "⑦b");
    const p7b = s7b.page;
    await typeSearch(p7b);
    expect
      .soft(
        await p7b.locator(".searchTotal").innerText(),
        "有的类有、有的类没有 → 总数仍是 4",
      )
      .toBe("搜索结果（4）");
    await p7b.locator(".search-chip", { hasText: "文章" }).click();
    await p7b.waitForTimeout(300);
    const empty7 = await p7b.locator(".searchEmpty").innerText();
    expect
      .soft(
        empty7.includes("文章") && !empty7.includes("未找到"),
        `点「文章」（0 命中）说的是「文章」里没有命中的内容，不是「未找到相关内容」→ ${empty7}`,
      )
      .toBe(true);
    await close(s7b);

    // ── ⑧ 窄屏：四枚计数不许把弹窗顶出视口 ──────────────────────────────────
    for (const w of [375, 390, 1440]) {
      const sx = track(await openModal(undefined, w), `⑧@${w}`);
      const px = sx.page;
      await typeSearch(px);
      const m = await px.evaluate(() => {
        const q = (s: string) => document.querySelector(s);
        const row = q(".searchTitleRow")!;
        const modal = q(".searchModal")!;
        const chips = [...document.querySelectorAll(".search-chip")];
        const card = q(".searchModal .ant-card")!;
        const rows = new Set(
          chips.map((c) => Math.round(c.getBoundingClientRect().top)),
        ).size;
        const r = (el: Element) => el.getBoundingClientRect();
        const input = q(".searchModalInput")!;
        return {
          rowOver: row.scrollWidth - row.clientWidth,
          modalOver: modal.scrollWidth - modal.clientWidth,
          chipRight: Math.max(...chips.map((c) => r(c).right)),
          chipLeft: Math.min(...chips.map((c) => r(c).left)),
          cardRatio: r(card).width / modal.clientWidth,
          chipRows: rows,
          inputFont: getComputedStyle(input).fontSize,
          vw: window.innerWidth,
        };
      });
      expect
        .soft(m.rowOver, `${w}：计数栏自身没有横向溢出（scrollWidth ≤ clientWidth）`)
        .toBeLessThanOrEqual(1);
      expect
        .soft(
          m.chipLeft >= 0 && m.chipRight <= m.vw + 1,
          `${w}：四枚计数全部落在视口内（left=${m.chipLeft} right=${m.chipRight} vw=${m.vw}）`,
        )
        .toBe(true);
      expect
        .soft(m.modalOver, `${w}：弹窗内容没有横向溢出`)
        .toBeLessThanOrEqual(1);
      if (w <= 768) {
        // 窄屏那档把 `.searchModalInput` 字号收到 1rem、卡片按 `width:100% !important`
        // 摊开（内联是 80%）。这两条是"媒体查询到底生效没有"最直接的读数。
        expect
          .soft(
            m.inputFont === "16px" && m.cardRatio >= 0.9,
            `${w}：窄屏媒体查询生效（输入框 16px、卡片摊满）→ font=${m.inputFont} card=${m.cardRatio.toFixed(2)}`,
          )
          .toBe(true);
      } else {
        expect
          .soft(
            m.inputFont === "24px" && m.cardRatio <= 0.85,
            `${w}：宽屏不吃窄屏那档覆盖（输入框仍是 1.5rem、卡片仍是 80% 上下）→ font=${m.inputFont} card=${m.cardRatio.toFixed(2)}`,
          )
          .toBe(true);
      }
      await close(sx);
    }

    // ── ⑩ 遮罩与药丸：背景压得够不够暗、字压在上面读不读得出来 ────────────────
    // 用户 20261013 原话：「检索框把背景暗度和迷糊度压得不够低，导致看不清检索框部分文本」。
    // 这个弹窗的**全部内容都没有自己的底**（`Modal.contentBg=transparent` + `.searchModal`
    // transparent），遮罩就是它的背景 ⇒ 底下那屏从遮罩的透明里透上来，字压在**忽明忽暗**的
    // 图案上。所以这里量两件东西：
    //   ① 遮罩这一层有没有真的被压暗/模糊（computed 值——这是**确定性**的读数）；
    //   ② 药丸里那行字底下的亮度**跳动幅度**（像素读数——"读起来累不累"的真身是它，
    //      不是平均对比度：修复前黑字压在 0.7 白药丸上本来就有 9.9:1）。
    //
    // 样板是**注入的纯黑白棋盘**（8px，约当正文的字级细节），不是沙箱里那点内容：
    // 沙箱 Head 后面本来是一片空白，量什么都是 0.01（实测），那种判据看着绿、其实什么都没测。
    // 棋盘是全对比度的最坏情况 ⇒ 读数是"上界"，只许比这更好。
    //
    // ⚠️ `backdrop-filter` 的**像素**读数在这个无头环境里不可用：实测 blur(2px) 生效
    //    （相邻跳变 6.59→2.72），而 blur(10px)/blur(30px) 反而退回**没有模糊**的样子
    //    （6.19 / 5.04，棋盘原样透出来）—— 这是渲染器的降级，不是页面的毛病。所以模糊只按
    //    computed 值判，"压暗"按像素判（像素那边把模糊临时摘掉，两臂都摘，读数才可比）。
    const s10 = track(await openModal(), "⑩");
    const p10 = s10.page;
    await p10.fill(".searchModalInput", "Hello world 123"); // 本机无中文字体 ⇒ 用 ASCII 才量得到真字形
    await p10.waitForTimeout(700);

    // ⚠️ 先读 computed、**再**注入样板与覆盖：下面那一段会把 `backdrop-filter` 内联成 none
    //    （像素两臂都摘掉模糊），读晚了就永远读到 'none' —— 这个顺序是判据的一部分。
    const cs = await p10.evaluate(() => {
      const m = document.querySelector(".ant-modal-mask")!;
      const st = getComputedStyle(m);
      const i = getComputedStyle(document.querySelector(".searchModalInput")!);
      return {
        cls: m.className,
        bg: st.backgroundColor,
        bf: st.backdropFilter || (st as unknown as { webkitBackdropFilter: string }).webkitBackdropFilter,
        pill: i.backgroundColor,
        ink: i.color,
      };
    });
    const alpha = cs.bg.includes(",")
      ? parseFloat((cs.bg.split(",")[3] || "1").replace(/[ )]/g, ""))
      : 1.0;
    expect
      .soft(cs.cls.includes("search-mask"), "遮罩挂上了 .search-mask（classNames.mask 真的落到那一层上）")
      .toBe(true);
    expect
      .soft(
        alpha >= 0.6,
        `遮罩底色比 antd 出厂值（0.45）更暗（alpha ≥ 0.6，且没被 antd 的运行时样式盖掉）→ ${cs.bg}`,
      )
      .toBe(true);
    const blurPx = cs.bf.includes("blur(")
      ? parseFloat(cs.bf.split("blur(")[1].split("px")[0])
      : 0;
    expect
      .soft(
        cs.bf.includes("blur(") && blurPx >= 8,
        `遮罩带模糊（backdrop-filter 里有 blur(≥8px)）→ ${cs.bf}`,
      )
      .toBe(true);
    const pillAlpha = parseFloat(cs.pill.split(",")[3].replace(/[ )]/g, ""));
    expect
      .soft(
        0.7 <= pillAlpha && pillAlpha < 1.0,
        `药丸仍是半透明（没被改成一坨实心白）→ ${cs.pill}`,
      )
      .toBe(true);

    // 遮罩底下铺一张纯黑白棋盘（8px）：位置固定、全对比度，量的是"背景能透上来多少"
    await p10.evaluate(() => {
      const d = document.createElement("div");
      d.id = "__checker";
      d.style.cssText =
        "position:fixed;left:0;top:0;right:0;height:600px;z-index:1;" +
        "background-image:repeating-conic-gradient(#000 0% 25%, #fff 0% 50%);background-size:8px 8px;";
      document.body.appendChild(d);
      // 模糊在这个渲染器里对大半径会降级（见上面注释）⇒ 像素那一半的两臂都摘掉它，
      // 免得"这一臂模糊生效、那一臂没生效"把读数搞乱。
      (document.querySelector(".ant-modal-mask") as HTMLElement).style.backdropFilter = "none";
    });
    await p10.waitForTimeout(250);

    const wcag = (v1: number, v2: number) => {
      const f = (v: number) => {
        const s = v / 255;
        return s > 0.03928 ? Math.pow((s + 0.055) / 1.055, 2.4) : s / 12.92;
      };
      const a = f(v1);
      const b = f(v2);
      return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    };

    interface Box {
      x: number;
      y: number;
      width: number;
      height: number;
    }
    const r = await p10.evaluate(() => {
      const b = document
        .querySelector(".searchModalInput")!
        .getBoundingClientRect();
      return { x: b.x, y: b.y, width: b.width, height: b.height };
    });
    /** 药丸里**没有字**的一条横带（避开文字中线与两端的圆角）。 */
    const bandBox = (): Box => ({
      x: Math.round(r.x + r.width * 0.15),
      y: Math.round(r.y + r.height * 0.78),
      width: Math.round(r.width * 0.7),
      height: Math.round(r.height * 0.12),
    });

    /** 整页截图灌进页面内 canvas（替代 Python/PIL 的 shot.getdata；
     * 弹窗页面 scrollY=0，viewport 坐标与整页截图坐标一致）。 */
    const reloadShot = async () => {
      const buf = await p10.screenshot({ fullPage: true });
      await p10.evaluate(
        (url) =>
          new Promise<void>((resolve, reject) => {
            const img = new Image();
            img.onload = () => {
              const c = document.createElement("canvas");
              c.width = img.width;
              c.height = img.height;
              const ctx = c.getContext("2d")!;
              ctx.drawImage(img, 0, 0);
              (window as any).__shot = ctx.getImageData(0, 0, c.width, c.height);
              resolve();
            };
            img.onerror = () => reject(new Error("shot load failed"));
            img.src = url;
          }),
        "data:image/png;base64," + buf.toString("base64"),
      );
    };
    /** box 内灰度（ITU-R 601-2，与 PIL convert("L") 同权）的排序统计。 */
    const grayStats = (box: Box) =>
      p10.evaluate((b) => {
        const shot = (window as any).__shot as ImageData;
        const grays: number[] = [];
        for (
          let y = Math.max(0, Math.floor(b.y));
          y < Math.min(shot.height, Math.ceil(b.y + b.height));
          y++
        ) {
          for (
            let x = Math.max(0, Math.floor(b.x));
            x < Math.min(shot.width, Math.ceil(b.x + b.width));
            x++
          ) {
            const i = (y * shot.width + x) * 4;
            grays.push(
              Math.round(
                shot.data[i] * 0.299 +
                  shot.data[i + 1] * 0.587 +
                  shot.data[i + 2] * 0.114,
              ),
            );
          }
        }
        grays.sort((a, b2) => a - b2);
        return {
          spread: grays.length
            ? grays[grays.length - 1] - grays[0]
            : 0,
          mid: grays.length ? grays[Math.floor(grays.length / 2)] : 0,
          ink: grays.length
            ? grays[Math.max(0, Math.floor(grays.length * 0.02))]
            : 0,
        };
      }, box);

    await reloadShot();
    const band = await grayStats(bandBox());
    // 字那一块：取最暗的 2% 当"墨"，与**同一张图**的中位色比 —— 字与底在同一张图里，
    // 不受"页面底色到底算哪一层"影响（这是 login-modal 那套 `__probe` 的教训）。
    const inkBox: Box = {
      x: Math.round(r.x + 30),
      y: Math.round(r.y + 8),
      width: Math.round(r.width - 60),
      height: Math.round(r.height - 16),
    };
    const inkStats = await grayStats(inkBox);
    const ratio = wcag(inkStats.ink, band.mid);
    expect
      .soft(ratio, `药丸里那行字的对比度 ≥ 4.5:1 → ${ratio.toFixed(2)}:1`)
      .toBeGreaterThanOrEqual(4.5);
    expect
      .soft(
        band.spread,
        `字底下的亮度跳动压住了（最坏样板下带宽 ≤ 22/255；修复前是 42）→ ${band.spread}/255`,
      )
      .toBeLessThanOrEqual(22);

    // 正控：把遮罩退回 antd 的出厂值 0.45（只改这一个属性），带宽**必须**变大——
    // 否则这个读数是死的（"改回去也照样绿"＝判据没接在这件事上）。
    await p10.evaluate(() => {
      (document.querySelector(".ant-modal-mask") as HTMLElement).style.background =
        "rgba(0,0,0,0.45)";
    });
    await p10.waitForTimeout(250);
    await reloadShot();
    const wCtl = (await grayStats(bandBox())).spread;
    expect
      .soft(
        wCtl > band.spread + 6,
        `正控：遮罩退回 0.45 时带宽明显变大（读数接在遮罩上，不是恒绿）→ 0.45 ${wCtl}/255 vs 0.62 ${band.spread}/255`,
      )
      .toBe(true);
    // 正控二：药丸退回 0.7（只改这一个属性）——它这一层对读数的贡献比遮罩还大
    await p10.evaluate(() => {
      (document.querySelector(".ant-modal-mask") as HTMLElement).style.background = "";
      (document.querySelector(".searchModalInput") as HTMLElement).style.background =
        "rgba(255,255,255,0.7)";
    });
    await p10.waitForTimeout(250);
    await reloadShot();
    const wCtl2 = (await grayStats(bandBox())).spread;
    expect
      .soft(
        wCtl2 > band.spread + 4,
        `正控：药丸退回 0.7 时带宽也变大 → 0.7 ${wCtl2}/255 vs 0.82 ${band.spread}/255`,
      )
      .toBe(true);
    await close(s10);

    // ── ⑨ 全程无 JS 报错 ────────────────────────────────────────────────────
    for (const [o, name] of opened) {
      expect.soft(o.errs(), `${name}没有页面异常`).toEqual([]);
    }
  });
});
