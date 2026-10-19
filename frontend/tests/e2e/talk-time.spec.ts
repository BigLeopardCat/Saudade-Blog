import { test, expect } from "@playwright/test";
import zlib from "node:zlib";
import path from "node:path";
import {
  FE_DIR,
  compileSass,
  withSandbox,
  collectPageErrors,
  esbuildInSandbox,
} from "./sandbox";

/**
 * 说说页（/talk）时间显示与卡片版式的无头验收（20260924 起，20261006 扩充）。
 * （原 tests/talk-time.test.py，20261019 迁移）
 *
 * 锁三件事：
 *   ① 日期链条上带**年份**——原来是只有 `MM.DD` 的单行，跨年的说说在列表里长得一模一样；
 *   ② 卡片上带精确 `HH:mm:ss`（20260924 起在卡片**左下角**，20261006 随署名行上移到**首行右侧**）；
 *   ③ **卡片版式**（20261006 用户第 4 条）：头像 → 署名同一行、标题另起一行、正文在标题下面。
 *      时刻的位置在 ② 与 ③ 之间来回动过一次，本文件同时钉住"挪到哪了"，避免下次静默漂走。
 *   ④ **深链定位**（20261006 站内聚合搜索）：`/talk?tk=<id>` 要落到那一条上。
 *      走的是**同一条路由内换地址**那条路（`window.__nav`）——"挂载时读一次地址栏"的实现在
 *      这里必然静默失效，而那正是留言板 `?lid=` 的写法、也是本轮最容易抄错的一处。
 *
 * 为什么值得单独一个沙箱：这两处都是"看着像对了、其实拿的是错值"的地方——
 * 年份若是从 `new Date()` 取（而不是从每条数据的 createTime），页面看起来完全正常，
 * 只有跨年那条会错。所以样本里刻意放一条**去年**的说说。
 *
 * 本机不能 vite build（3.7GB 内存会 OOM，见 CLAUDE.md §2），沿用既定替代手段：
 *   · sass 用 programmatic API 编译；
 *   · esbuild 把**真组件**打成一个 bundle，只桩边界（axios / react-redux / SEO 组件），
 *     **不桩 antd**——卡片几何要靠真 antd 的卡片内边距；**不桩 react-router-dom**——
 *     ⑦ 要的就是真 Router 上下文里响应式读地址栏；
 *   · 真 react-dom 渲染 → Playwright 断言。
 */

// `import.meta.env` 的替身（与其余沙箱同一个串）：esbuild 的 iife 输出里 `import.meta`
// 是空对象，组件链上任何 `import.meta.env.X` 都会当场抛 TypeError 白屏。
const DEFINE_ENV =
  '{"VITE_HTTP_BASEURL":"","VITE_CDN_BASEURL":"","MODE":"production","DEV":false,"PROD":true,"BASE_URL":"/"}';

/** 1×1 PNG 的 data URL。
 *
 * 头像是**必须真的加载得出来**的：antd 的 `Avatar` 在图片加载失败时会把 `<img>` 撤掉、
 * 换成默认图标——样本若指向一个 404 的路径，"img 的 src 对不对"这条断言会**恒定假红**
 * （与实现对不对无关）。两个不同的纯色让它同时满足"每行不同"与"都加载得出来"。
 */
const tinyPng = (rgb: [number, number, number]): string => {
  const chunk = (tag: string, data: Buffer): Buffer => {
    const body = Buffer.concat([Buffer.from(tag, "latin1"), data]);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(body) >>> 0, 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0); // width
  ihdr.writeUInt32BE(1, 4); // height
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolor
  const idat = zlib.deflateSync(
    Buffer.concat([Buffer.from([0]), Buffer.from(rgb)]),
  );
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ]);
  return "data:image/png;base64," + png.toString("base64");
};

// 样本：第 2 条刻意是**去年**的（跨年）。若年份取的是"当前年"，这条会当场露馅。
// 20261005 追加：每条带自己的 `nickname`/`avatar`（后端 `src=talk` 的列表现在带发布者
// 信息），且两条**刻意不同** —— 若实现回头去取"看的人自己"的头像（历史 bug），
// 两张卡会同时变成下面那个探针值，⑤ 的断言当场红。
const TALKS = [
  {
    talkKey: 1,
    talkTitle: "今天的说说",
    content: "第一条正文",
    createTime: "2026-09-24 12:34:56",
    updateTime: "2026-09-24 12:34:56",
    nickname: "Sora Saudade",
    avatar: tinyPng([220, 80, 80]),
  },
  {
    talkKey: 2,
    talkTitle: "去年的说说",
    content: "第二条正文",
    createTime: "2025-12-31 23:59:59",
    updateTime: "2025-12-31 23:59:59",
    nickname: "泠月喵",
    avatar: tinyPng([80, 120, 220]),
  },
];

// redux 桩里的"当前登录用户"。20261005 起组件**不该**再读它（头像/名字都该来自每行数据）；
// 留一个**可辨认、且真的加载得出来**的第三张图，就是为了让"又回去读登录用户"这件事
// 在断言里现形：给个 404 的路径的话，antd 会把 `<img>` 撤掉，红基线只能红出"没有 img"，
// 分不清"取错了头像"和"压根没渲染头像"（20261005 红基线第一版就踩了这个）。
const VIEWER_AVATAR = tinyPng([60, 180, 90]);

// 边界①：假后端。只回说说列表，形状 = 真接口的 ApiResponse。
const FAKE_AXIOS = `const http: any = () => Promise.resolve({ status: 200, data: { code: 200, data: ${JSON.stringify(TALKS)} } });
export default http;
`;

// 边界②：redux——只桩"读"。状态对象保持同一个实例（每次返回新对象会让 useSelector
// 判定"变了"而无限重渲染）。
const STUB_REDUX = `const state: any = { user: { avatar: ${JSON.stringify(VIEWER_AVATAR)}, name: 'Sora' } };
export const useSelector = (fn: any) => fn(state);
export const useDispatch = () => (_a: any) => undefined;
export const Provider = ({ children }: any) => children;
`;

const STUB_SEO = `const SeoHelmet = (_p: any) => null;
export default SeoHelmet;
`;

const ENTRY = `import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, useNavigate } from 'react-router-dom';
import TalkList from './src/frontHome/Content/Talk/index.tsx';

// ⑦ 深链那一节要能**在同一个 Router 里**换地址（'/talk → /talk?tk=2'），
// 所以这里把 navigate 借出来给外面用。**不能只桩 router**：useSearchParams 只有在
// 真 Router 上下文里才有值，桩掉它就等于把 ⑦ 要验的那件事（响应式读地址栏）一起验没了。
let nav: any = null;
const NavProbe = () => { nav = useNavigate(); return null; };
(window as any).__nav = (to: string) => nav(to);
(window as any).__mount = (url?: string) =>
  createRoot(document.getElementById('root')!).render(
    <MemoryRouter initialEntries={[url || '/talk']}>
      <NavProbe />
      <TalkList />
    </MemoryRouter>);
`;

// 沙箱根 tsconfig：esbuild 的 paths 解析（替代原 CLI --alias）。
const TSCONFIG_PATHS = JSON.stringify({
  compilerOptions: {
    paths: {
      "react-redux": ["./stub-redux.tsx"],
    },
  },
});

// 主题变量：真页面由全局样式给（浅色/夜间两套）。沙箱里给浅色那一套——
// 不就是 `var(--font-p-color)` 解析不出来、颜色断言无从谈起。
const THEME_CSS =
  ":root{--container-background-color:#fff;--font-p-color:#333;" +
  "--font-title-color:#111;--pic-background-cover:#f7f7f7;}\n";

interface Rect {
  l: number;
  r: number;
  t: number;
  b: number;
  w: number;
}
interface GeoRow {
  time: Rect;
  year: Rect;
  day: Rect;
  card: Rect;
  body: Rect;
  meta: Rect;
  clock: Rect;
  dotL: number;
  dotR: number;
  // 20261006 新增：署名行（.talk-head）与它里面的三个块、以及头像。
  // **缺元素给 null，不抛**（`rn`）：红基线上 `.talk-head`/`.talk-title` 根本不存在，
  // 抛异常会把整条 evaluate 连同后面所有检查一起带走 —— 那样只知道"红了"，
  // 不知道是结构没落地还是几何不对。
  av: Rect | null;
  head: Rect | null;
  who: Rect | null;
  title: Rect | null;
  content: Rect | null;
  // 颜色读 computed style：三行都住在 `description` 里，而描述块有一条
  // `color: var(--font-p-color) !important` —— 标题有没有被它一起染成
  // 正文色，只有真算一遍才知道（这条同时是"标题色是否与正文同色"的判据）。
  titleColor: string | null;
  contentColor: string | null;
  // 字号取 computed style（不是量高度）：高度会被 line-height 与
  // 字体自身的上下留白带偏，量出来不是字号本身。
  yearFs: string;
  dayFs: string;
  // 不透明度取的是元素自身的 `opacity`（不是颜色的 alpha 通道）：
  // 这里是 `.talkTime-year { opacity }` 压淡的，颜色本身仍是实色，
  // 读 color 的 alpha 会恒等于 1、断言变成永远通过。
  yearOpacity: string;
}

const GEO = (): GeoRow[] => {
  const r = (el: Element): Rect => {
    const b = el.getBoundingClientRect();
    return { l: b.left, r: b.right, t: b.top, b: b.bottom, w: b.width };
  };
  return [...document.querySelectorAll(".article")].map((node) => {
    const a = node as HTMLElement;
    const time = r(a.querySelector(".talkTime")!);
    const year = r(a.querySelector(".talkTime-year")!);
    const day = r(a.querySelector(".talkTime-day")!);
    const card = r(a.querySelector(".talk")!);
    const body = r(a.querySelector(".ant-card-body")!);
    const meta = r(a.querySelector(".ant-card-meta")!);
    const clock = r(a.querySelector(".talk-clock")!);
    const rn = (el: Element | null): Rect | null => (el ? r(el) : null);
    const av = rn(a.querySelector(".ant-avatar"));
    const head = rn(a.querySelector(".talk-head"));
    const who = rn(a.querySelector(".talk-who"));
    const title = rn(a.querySelector(".talk-title"));
    const content = rn(a.querySelector(".talk-content"));
    const cs = (sel: string): CSSStyleDeclaration | null => {
      const el = a.querySelector(sel);
      return el ? getComputedStyle(el) : null;
    };
    // 竖线上的圆点 = `.talk:after`（伪元素，只能用 computed style 反推几何）
    const csDot = getComputedStyle(a.querySelector(".talk")!, ":after");
    const dotL = card.l + parseFloat(csDot.left);
    const dotR = dotL + parseFloat(csDot.width);
    return {
      time,
      year,
      day,
      card,
      body,
      meta,
      clock,
      dotL,
      dotR,
      av,
      head,
      who,
      title,
      content,
      titleColor: cs(".talk-title")?.color ?? null,
      contentColor: cs(".talk-content")?.color ?? null,
      yearFs: getComputedStyle(a.querySelector(".talkTime-year")!).fontSize,
      dayFs: getComputedStyle(a.querySelector(".talkTime-day")!).fontSize,
      yearOpacity: getComputedStyle(a.querySelector(".talkTime-year")!)
        .opacity,
    };
  });
};

test.describe("说说页时间显示与卡片版式", () => {
  test.setTimeout(180_000);

  test("日期链条/精确时刻/卡片版式/发布者身份/深链定位（45 条判据）", async ({
    page,
    browser,
  }) => {
    // sass 真编译（programmatic API）；.sass 的裸 import 被 text loader 吞掉，样式单独引入
    const talkCss = compileSass(
      path.join(FE_DIR, "src/frontHome/Content/Talk/index.sass"),
    );

    await withSandbox(
      {
        "index.html":
          '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">' +
          '<link rel="stylesheet" href="theme.css">' +
          '<link rel="stylesheet" href="talk.css"></head><body><div id="root"></div>' +
          '<script src="bundle.js"></script>' +
          "<script>window.__mount && window.__mount();</script>" +
          "</body></html>",
        "theme.css": THEME_CSS,
        "talk.css": talkCss,
      },
      async (sb) => {
        await esbuildInSandbox(sb, {
          entry: "entry.tsx",
          files: {
            "entry.tsx": ENTRY,
            "stub-redux.tsx": STUB_REDUX,
            "src/apis/axios.tsx": FAKE_AXIOS,
            "src/components/SeoHelmet.tsx": STUB_SEO,
            "tsconfig.json": TSCONFIG_PATHS,
          },
          copySrc: true,
          define: { "import.meta.env": DEFINE_ENV },
          loaders: { ".sass": "text", ".png": "dataurl", ".svg": "dataurl" },
        });

        await page.setViewportSize({ width: 1280, height: 900 });
        const errs = collectPageErrors(page);
        await page.goto(sb.url);
        // framer-motion 入场：第 n 条 delay = n*0.2s + 0.5s 动画。几何要在动画**结束**后量
        // （初始 y:-20 会把卡片和日期先挪上去 20px）。
        await page.waitForTimeout(1800);

        // ── ① 结构 ──
        expect.soft(errs().length === 0, `无 JS 运行时报错 → ${errs().slice(0, 2).join("; ")}`).toBe(true);
        expect
          .soft(
            (await page.locator(".talk").count()) === 2,
            `两条说说都渲染 → ${await page.locator(".talk").count()}`,
          )
          .toBe(true);
        expect
          .soft(
            (await page.locator(".talkTime .talkTime-year").count()) === 2 &&
              (await page.locator(".talkTime .talkTime-day").count()) === 2,
            `日期链条上每条都有年份与月日两个元素 → year=${await page.locator(".talkTime .talkTime-year").count()} day=${await page.locator(".talkTime .talkTime-day").count()}`,
          )
          .toBe(true);

        // ── ② 年份与月日（跨年那条证明年份取自数据，不是当前年）──
        const years = await page.$$eval(".talkTime-year", (els) =>
          els.map((e) => e.textContent!.trim()),
        );
        const days = await page.$$eval(".talkTime-day", (els) =>
          els.map((e) => e.textContent!.trim()),
        );
        expect
          .soft(
            years[0] === "2026" && days[0] === "09.24",
            `第一条 = 2026 / 09.24 → ${years[0]} ${days[0]}`,
          )
          .toBe(true);
        expect
          .soft(
            years[1] === "2025" && days[1] === "12.31",
            `跨年那条 = 2025 / 12.31（不是当前年） → ${years[1]} ${days[1]}`,
          )
          .toBe(true);
        expect
          .soft(
            await page.evaluate(() => {
              const t = document.querySelector(".talkTime")!;
              const y = t
                .querySelector(".talkTime-year")!
                .getBoundingClientRect();
              const d = t.querySelector(".talkTime-day")!.getBoundingClientRect();
              // 前面 = 年份右缘在月日左缘之前；同一行 = 两者的竖直区间有重叠
              return y.right <= d.left + 1 && y.top < d.bottom && d.top < y.bottom;
            }),
            `年份在月日**前面**、同一行（20260924 三轮：原来是年份一行压在月日上面）`,
          )
          .toBe(true);

        // ── ③ 卡片上的精确时刻（20261006 起在署名行右端）──
        const clocks = await page.$$eval(".talk-clock", (els) =>
          els.map((e) => e.textContent!.trim()),
        );
        expect
          .soft(
            JSON.stringify(clocks) === JSON.stringify(["12:34:56", "23:59:59"]),
            `两个时刻都在（H:M:S 各两位） → ${JSON.stringify(clocks)}`,
          )
          .toBe(true);
        expect
          .soft(
            await page.evaluate(
              () =>
                getComputedStyle(
                  document.querySelector(".talk-clock")!,
                ).fontVariantNumeric,
            ),
            `等宽数字（tabular-nums：列表里各条时刻上下对齐）`,
          )
          .toBe("tabular-nums");
        expect
          .soft(
            await page.evaluate(() => {
              const c = getComputedStyle(
                document.querySelector(".talk-clock")!,
              ).color;
              const m = c.match(/[\d.]+/g)!;
              return m.length < 4 || +m[3]! > 0.9;
            }),
            `时刻不透明（浅色主题下是实色字，不是继承来的空心）`,
          )
          .toBe(true);

        // ── ④ 几何（日期在卡片左侧、首行 = 头像｜署名｜时刻、标题与正文依次在下）──
        const geo = await page.evaluate(GEO);
        const g0 = geo[0]!;
        const g1 = geo[1]!;
        expect
          .soft(
            g0.time.r <= g0.card.l + 1,
            `日期块整体在卡片左侧（right ≤ 卡片 left） → 日期右缘 ${g0.time.r.toFixed(0)} / 卡片左缘 ${g0.card.l.toFixed(0)}`,
          )
          .toBe(true);
        expect
          .soft(
            g0.card.l - g0.time.r >= 20,
            `日期块与卡片之间留了缝（≥ 20px），不是贴着 → ${(g0.card.l - g0.time.r).toFixed(0)}px`,
          )
          .toBe(true);
        // 一轮修完当时的实测缺陷：日期块原来钉左缘（left:-120px），内容变宽后向右长、
        // 月日压到了竖线和圆点上（右缘 423 vs 竖线 391）。改成钉右缘后必须留在这条线**左边**。
        expect
          .soft(
            g0.time.r <= g0.dotL + 1,
            `日期块没压到竖线与圆点上（右缘 ≤ 圆点左缘） → 日期右缘 ${g0.time.r.toFixed(0)} / 圆点左缘 ${g0.dotL.toFixed(0)}`,
          )
          .toBe(true);
        // 竖直对齐是**已知旧偏差**（日期块比圆点低 ~8px：它的包含块是 .article 而不是卡片，
        // `top:50%` 落在卡片中线上方，h3 自带的 1em 默认外边距又压回来一部分）。本轮不动它，
        // 但要锁住"没变得更糟"：偏差仍在 12px 以内、且是往下偏（不是翻到上面去）。
        expect
          .soft(
            0 <=
              (g0.time.t + g0.time.b) / 2 - (g0.card.t + g0.card.b) / 2 &&
              (g0.time.t + g0.time.b) / 2 - (g0.card.t + g0.card.b) / 2 <= 12,
            `日期块与圆点的竖直偏差沿用旧值（≤12px、偏下，本轮未改动这一项）` +
              ` → 日期中心 ${((g0.time.t + g0.time.b) / 2).toFixed(0)} / 卡片中线 ${((g0.card.t + g0.card.b) / 2).toFixed(0)}`,
          )
          .toBe(true);
        // 20260924 四轮：年份 12px → 16px（主人嫌小），不透明度 .65 → .8。仍必须**严格小于**
        // 月日的 20px：两个数字一样大的话，"2026 09.24" 会被读成一串平铺的数字，看不出主次。
        expect.soft(g0.yearFs === "16px", `年份字号 = 16px（四轮从 12px 提上来） → ${g0.yearFs}`).toBe(true);
        expect.soft(g0.dayFs === "20px", `月日字号 = 20px（主次关系没被这轮改掉） → ${g0.dayFs}`).toBe(true);
        expect
          .soft(
            parseFloat(g0.yearFs) < parseFloat(g0.dayFs),
            `年份仍比月日小（16 < 20：年份是量级信息，不抢月日） → ${g0.yearFs} vs ${g0.dayFs}`,
          )
          .toBe(true);
        // 不透明度一起提上来之后别又倒回去（.65 → .8）：字号大了再压那么淡就只是发灰。
        expect
          .soft(
            g0.yearOpacity === "0.8",
            `年份不透明度 = 0.8（四轮从 .65 提上来，字号变大后不再压那么淡） → ${g0.yearOpacity}`,
          )
          .toBe(true);
        // 20261006：时刻从"卡片底部的独立一行"（`.talk-foot`）挪进了**正文块的首行**，
        // 与署名同一行右端。所以这里锁的不再是"在 Meta 下方"，而是"在 Meta 之内"。
        expect
          .soft(
            g0.meta.t - 1 <= g0.clock.t &&
              g0.clock.b <= g0.meta.b + 1 &&
              g0.clock.l >= g0.card.l &&
              g0.clock.r <= g0.card.r,
            `时刻进了正文块（Meta）内部，仍在卡片里` +
              ` → 时刻 ${g0.clock.t.toFixed(0)}..${g0.clock.b.toFixed(0)} / 正文块 ${g0.meta.t.toFixed(0)}..${g0.meta.b.toFixed(0)}`,
          )
          .toBe(true);
        expect
          .soft(
            0 <= g0.card.r - g0.clock.r && g0.card.r - g0.clock.r < g0.card.w / 2,
            `时刻靠右（距卡片右缘 < 半宽，即右端而非居中/左端） → 距右缘 ${(g0.card.r - g0.clock.r).toFixed(0)}px / 半宽 ${(g0.card.w / 2).toFixed(0)}px`,
          )
          .toBe(true);
        expect
          .soft(
            Math.abs(g0.body.r - g0.clock.r - (g0.body.r - g0.meta.r)) <= 1,
            `时刻右缘与正文块右缘对齐（右对齐没被这轮挪位改掉） → 时刻右缘 ${g0.clock.r.toFixed(0)} / 正文块右缘 ${g0.meta.r.toFixed(0)}`,
          )
          .toBe(true);
        // 旧的那一行整块撤了：`.talk-foot` 一旦被加回来，时刻就会被它拉回卡片底部（两条红线）。
        expect
          .soft(
            (await page.locator(".talk-foot").count()) === 0,
            `旧的那一行整块撤了（页面上不再有 .talk-foot） → ${await page.locator(".talk-foot").count()}`,
          )
          .toBe(true);

        // ── ⑥ 卡片版式（20261006 用户第 4 条）：头像 → 署名同一行、标题另起一行。──
        // 这是**新几何**：改动前 `.talk-head`/`.talk-title`/`.talk-content` 三个元素都不存在
        // （署名在卡片底部单独一行、标题在 `Card.Meta` 的 title 槽里），下面每条都会红。
        // 元素缺席时探针给 None ⇒ 先判结构，再判几何：分开才知道红的是"没落地"还是"位置不对"。
        const missing = (["av", "head", "who", "title", "content"] as const).filter(
          (k) => g0[k] === null,
        );
        const shapeOk = missing.length === 0;
        expect
          .soft(
            shapeOk,
            `三行结构齐备（头像 / .talk-head 署名行 / .talk-title / .talk-content）` +
              (missing.length ? ` 缺：${missing.join(",")}` : ""),
          )
          .toBe(true);

        // 打印用：元素缺席时打「—」，别在格式化里再抛一次。
        const at = (rect: Rect | null, side: keyof Rect): string =>
          rect ? rect[side].toFixed(0) : "—";

        expect
          .soft(
            shapeOk &&
              g0.who!.l >= g0.av!.r - 1 &&
              g0.who!.t < g0.av!.b &&
              g0.av!.t < g0.who!.b,
            `署名在头像**右侧**且与头像**同一行**（纵向区间重叠）` +
              ` → 署名 ${at(g0.who, "l")}..${at(g0.who, "r")} / 头像右缘 ${at(g0.av, "r")}，` +
              `署名 ${at(g0.who, "t")}..${at(g0.who, "b")} / 头像 ${at(g0.av, "t")}..${at(g0.av, "b")}`,
          )
          .toBe(true);
        expect
          .soft(
            shapeOk && Math.abs(g0.title!.l - g0.who!.l) <= 1,
            `署名左缘与标题左缘对齐（标题另起一行，但不缩进） → 署名 ${at(g0.who, "l")} / 标题 ${at(g0.title, "l")}`,
          )
          .toBe(true);
        expect
          .soft(
            shapeOk && g0.title!.t >= g0.head!.b - 1,
            `标题在署名行**下面**（另起一行，不是挤在同一行） → 标题顶 ${at(g0.title, "t")} / 署名行底 ${at(g0.head, "b")}`,
          )
          .toBe(true);
        expect
          .soft(
            shapeOk && g0.content!.t >= g0.title!.b - 1,
            `正文在标题**下面**（顺序没颠倒） → 正文顶 ${at(g0.content, "t")} / 标题底 ${at(g0.title, "b")}`,
          )
          .toBe(true);
        expect
          .soft(
            shapeOk &&
              g0.head!.t - 1 <= g0.clock.t &&
              g0.clock.b <= g0.head!.b + 1 &&
              g0.who!.l < g0.clock.l &&
              g0.who!.r <= g0.clock.l + 1,
            `时刻与署名同排（都在 .talk-head 这一行里）且署名在左、时刻在右` +
              ` → 署名行 ${at(g0.head, "t")}..${at(g0.head, "b")} / 时刻 ${at(g0.clock, "t")}`,
          )
          .toBe(true);
        expect
          .soft(
            g0.titleColor !== null &&
              g0.titleColor !== g0.contentColor &&
              g0.titleColor === "rgb(17, 17, 17)",
            `标题是标题色、正文是正文色（标题没被描述块的那条 !important 一起染成正文色）` +
              ` → 标题 ${g0.titleColor} / 正文 ${g0.contentColor}`,
          )
          .toBe(true);
        expect
          .soft(
            Math.abs(g0.time.r - g1.time.r) <= 1,
            `两条说说的日期块水平位置一致（链条是直的） → ${g0.time.r.toFixed(0)} vs ${g1.time.r.toFixed(0)}`,
          )
          .toBe(true);

        // ── ⑤ 发布者身份（20261005 用户报："不是以登录用户发的，说说卡片显示对应用户信息"）。──
        // 修之前这里取的是 `state.user.avatar`（**看的人自己**的头像）：未登录时它为空串，
        // 每张卡都是个空头像；登录了则每条都显示自己的脸。现在取每行的 `nickname`/`avatar`。
        // 头像 src 取的是属性里的原值（浏览器不会把相对路径补成绝对路径，读 attribute 稳妥）
        const avatarSrcs = await page.$$eval(".talk .ant-avatar img", (els) =>
          els.map((e) => e.getAttribute("src")),
        );
        expect
          .soft(
            avatarSrcs.length === 2,
            `两条说说各有一个头像 img（不是空头像） → ${JSON.stringify(avatarSrcs)}`,
          )
          .toBe(true);
        expect
          .soft(
            JSON.stringify(avatarSrcs) ===
              JSON.stringify([TALKS[0]!.avatar, TALKS[1]!.avatar]),
            `头像取的是**这一行**的 avatar → ${JSON.stringify(avatarSrcs)}`,
          )
          .toBe(true);
        expect
          .soft(
            !avatarSrcs.includes(VIEWER_AVATAR),
            `头像**不是**当前登录用户的（历史 bug：拿 state.user.avatar） → ${JSON.stringify(avatarSrcs)}`,
          )
          .toBe(true);
        const whos = await page.$$eval(".talk-who", (els) =>
          els.map((e) => e.textContent!.trim()),
        );
        expect
          .soft(
            JSON.stringify(whos) ===
              JSON.stringify([TALKS[0]!.nickname, TALKS[1]!.nickname]),
            `每条说说的卡片上有发布者展示名 → ${JSON.stringify(whos)}`,
          )
          .toBe(true);
        // 20261006：这条原来是"左右两端对齐（名字在卡片底、时刻在右下角）"，现在锁的是**同一行**
        // 里的左右关系 —— 与 ⑥ 的区别是它要求**每一条**都成立（⑥ 只看第一条），名字长短不同的
        // 两条都必须把时刻留在右边（长名字若没吃到 flex 的收缩，会把时刻挤出卡片）。
        expect
          .soft(
            await page.evaluate(() => {
              const rows = [...document.querySelectorAll(".article")];
              return (
                rows.length > 0 &&
                rows.every((row) => {
                  const whoEl = row.querySelector(".talk-who");
                  const clkEl = row.querySelector(".talk-clock");
                  // 缺元素要判**红**，不能让 `querySelector` 返回 null 后抛异常
                  // （红基线里老组件没有 .talk-who，抛异常会把后面几条一起带走）。
                  if (!whoEl || !clkEl) return false;
                  const who = whoEl.getBoundingClientRect();
                  const clk = clkEl.getBoundingClientRect();
                  // 左：署名右缘在时刻左缘之前；同一行：两者的竖直区间有重叠
                  return (
                    who.left < clk.left &&
                    who.right <= clk.left + 1 &&
                    who.top < clk.bottom &&
                    clk.top < who.bottom
                  );
                })
              );
            }),
            `每条都是署名在左、时刻在右，且在同一行（两端对齐，名字没把时刻挤走）`,
          )
          .toBe(true);
        // 空态与读失败态是两件事（20261005）：本样本有数据，两者都不该出现——
        // 这条同时钉住"正常路径没被新加的状态机误伤"。
        expect
          .soft(
            (await page.locator(".talkEmpty").count()) === 0,
            `有数据时不显示空态/读失败态 → ${await page.locator(".talkEmpty").count()}`,
          )
          .toBe(true);

        // ── ⑦ 深链定位（`?tk=`，20261006 站内聚合搜索）：点一条说说进来要落到那一条上并闪一下。──
        // **另开一页、视口压到 400 高**：本样本只有两张卡，900 高的视口里页面根本滚不动，
        // "有没有滚过去"这件事就无从断言（`scrollIntoView` 会是个静默的空操作）。
        // 压到 400 让页面真的溢出，几何断言才有内容。
        const ctx2 = await browser.newContext({
          viewport: { width: 1280, height: 400 },
        });
        const pg2 = await ctx2.newPage();
        const errs2 = collectPageErrors(pg2);
        await pg2.goto(sb.url);
        await pg2.waitForTimeout(600);
        expect
          .soft(
            await pg2.evaluate(
              () => document.documentElement.scrollHeight > innerHeight + 100,
            ),
            `页面可滚动（这条前提不成立的话，下面几条都是空断言） → ${await pg2.evaluate(() => `${document.documentElement.scrollHeight}/${innerHeight}`)}`,
          )
          .toBe(true);
        expect
          .soft(
            (await pg2.locator(".talk-hit").count()) === 0 &&
              (await pg2.evaluate(() => window.scrollY)) === 0,
            `没有 tk 时不高亮任何人、页面停在顶部 → hit=${await pg2.locator(".talk-hit").count()} scrollY=${await pg2.evaluate(() => window.scrollY)}`,
          )
          .toBe(true);

        // 导航前先把目标卡的位置量下来（"它本来被切在视口下缘"是"滚过去了"这条判据的前提）。
        // 取的是**到视口中心的距离**：本样本只有两张卡，页面滚到底也不足以把第二张正对中心
        // （文档高度 527、视口 400 ⇒ 最多只能滚 127，`scrollIntoView` 的居中要求被夹住了）。
        // 所以判据只能是"明显更靠近中心"，不能写"正好居中"——那是夹具给不出的位置。
        const centerDist = () =>
          pg2.evaluate(() => {
            const el = document.getElementById("t-2");
            if (!el) return -1;
            const b = el.getBoundingClientRect();
            return Math.abs((b.top + b.bottom) / 2 - innerHeight / 2);
          });

        await pg2.waitForTimeout(200); // 先等入场动画收尾（y:-20→0 走 transform，会进 rect）
        const distBefore = await centerDist();
        expect
          .soft(
            distBefore > 200,
            `导航前目标卡离视口中心很远（本判据的前提：它本来不在视野里） → ${distBefore.toFixed(0)}px`,
          )
          .toBe(true);

        // ★ 同一条路由内换地址 —— **正是"挂载时读一次 window.location.search"那种实现会静默
        // 失效的那一格**（组件不重挂载，那个实现一辈子看不到新参数）。留言板 `/guestbook?lid=`
        // 就是这么写的，所以这里必须走一次真导航，而不是直接带着 `?tk=2` 开页面。
        await pg2.evaluate(() => (window as unknown as { __nav: (to: string) => void }).__nav("/talk?tk=2"));
        await pg2.waitForTimeout(400);
        expect
          .soft(
            errs2().length === 0,
            `导航后无 JS 报错 → ${errs2().slice(0, 2).join("; ")}`,
          )
          .toBe(true);
        expect
          .soft(
            (await pg2.locator(".talk-hit").count()) === 1,
            `刚好一张卡被高亮（不是全部、也不是零张） → ${await pg2.locator(".talk-hit").count()}`,
          )
          .toBe(true);
        expect
          .soft(
            await pg2.evaluate(() => {
              const hit = document.querySelector(".talk-hit");
              const card = document.getElementById("t-2");
              if (!hit || !card) return false;
              // 同一个元素：高亮与锚点同层（挂在 motion.div 上的话这里会是 false）
              if (hit !== card) return false;
              // 锚点必须**是卡片**，不是外面那层 .article 包壳
              return card.classList.contains("talk") && card.closest(".article") !== card;
            }),
            `高亮的是 tk=2 那一张（锚点在卡片本身，不是外层动画盒）`,
          )
          .toBe(true);
        await pg2.waitForTimeout(300); // 等入场动画收尾再量几何
        const distAfter = await centerDist();
        expect
          .soft(
            distAfter >= 0 && distAfter <= distBefore - 100,
            `目标卡明显滚向视口中心（至少近了 100px——不滚动的话这个数一动不动） → ${distBefore.toFixed(0)} → ${distAfter.toFixed(0)}`,
          )
          .toBe(true);
        expect
          .soft(
            (await pg2.evaluate(() => window.scrollY)) > 0,
            `页面确实滚下去了（不是停在顶部） → ${await pg2.evaluate(() => window.scrollY)}`,
          )
          .toBe(true);

        // 高亮是**一闪而过**的：1.8s 后自己摘掉，不然列表里永远圈着一条。
        // 先把"摘掉之前确实亮着"记下来：只断言"1.8s 后没有高亮"的话，**从没亮过**也是绿的
        // （负控里这条就是靠这个假通过混过去的——高亮那条链整个没跑起来，它照样 ✅）。
        const litBeforeWait = await pg2.locator(".talk-hit").count();
        await pg2.waitForTimeout(2000);
        expect
          .soft(
            litBeforeWait === 1 &&
              (await pg2.locator(".talk-hit").count()) === 0,
            `高亮亮过、且 1.8s 后自己摘掉（不留一条永远圈着的卡） → 等待前 ${litBeforeWait} / 等待后 ${await pg2.locator(".talk-hit").count()}`,
          )
          .toBe(true);

        // 目标不在列表里（说说被删/被驳回）⇒ **安静兜底**：不报错、不高亮、页面留住。
        // 与 `CommentSection` 的 `?cid=`、留言板的 `?lid=` 同一条纪律：页面本身已经开对了，
        // 再弹一句"没找到"只会添乱。
        await pg2.evaluate(() => (window as unknown as { __nav: (to: string) => void }).__nav("/talk?tk=999"));
        await pg2.waitForTimeout(400);
        expect
          .soft(
            errs2().length === 0 &&
              (await pg2.locator(".talk-hit").count()) === 0,
            `指向不存在的说说：不报错、不高亮 → ${
              errs2().length
                ? errs2().slice(0, 2).join("; ")
                : String(await pg2.locator(".talk-hit").count())
            }`,
          )
          .toBe(true);

        await ctx2.close();
      },
    );
  });
});
