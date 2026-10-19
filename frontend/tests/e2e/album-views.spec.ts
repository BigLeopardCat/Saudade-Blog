/**
 * 后台「图库」页的两种展示方式（20261001，用户第 2 条）无头验收。
 *
 * 用户原话：「后台图库提供两种展示方式，一种当前的直接展开，另一种以列表的方式展开，
 * 头部是略缩图后面跟着图片名。」
 *
 * 判据只有"真跑一遍"才看得见，所以本文件锁四组事：
 *
 *   · **两种方式真的互斥**（第一节）—— 切到列表时网格那批图必须**整个不在 DOM 里**。
 *     只断言"列表出来了"会被"两套叠着渲染"蒙过（真叠着时页面看着也对，只是白渲染一遍）。
 *   · **行 = 缩略图 + 图片名**（第二节）—— 缩略图 56×56、名字是**盘上名的展示名**
 *     （剥掉上传时压的 14 位时间戳前缀，规则与 Rust `strip_timestamp_prefix` 同形，
 *     由 `asset-name.test.mjs` 在纯函数层钉死；这里钉的是"列表真的用了它"）。这一节的
 *     两个几何断言是**反的**：缩略图**不许被挤小**（`flex: 0 0 auto`），名字那一格才是
 *     被截断的那个（超长名必须 `scrollWidth > clientWidth`）——只断言其中一个，
 *     "两个都让一让"的实现也能过。
 *   · **勾选与计数**（第三、四节）—— 行点击与勾选框点击都要能翻，且各只翻**一次**。
 *     第四节是**真负控**：另打一份把 `e.stopPropagation()` 抹掉的包，在同一个沙箱里跑
 *     同一次点击 —— 它必须复现"点了没反应"（勾选框的 change 与冒泡到行的 click 各翻一次，
 *     净效果归零）。没有这条负控，"点了勾上了"这个断言证明不了 `stopPropagation` 在起作用。
 *   · **展示方式记在本地**（第五节）—— 刷新后还是列表（`localStorage.albumViewMode`）。
 *   · **列表方式不打乱页面上原有的那条写路径**（第六节）—— 选中后走原样的删除弹窗，
 *     `DELETE /api/protect/delImg` 的 body 是被选中那张图的 URL。
 *   · **工具栏那条分隔线**（第七节）—— 线必须是工具栏**自己的下边框**（在流内、随几何走），
 *     不许是"按魔法数 `top: 90px` 落位"的绝对定位线；上传钮/删除钮里的图标槽必须 40px 且
 *     整个落在按钮框里（真凶是全局 `.icon{min-width:60px}`，所以这一节把 `pages/Dashboard/index.css`
 *     与真站的图标字体一并注入——少了任一个，这条几何断言都会**假绿**）。第七节自带负控：
 *     另打一份"把那条绝对定位线拼回去"的页面，上面那几条必须红。
 *   · **R2 那颗按钮是够到配置的唯一一条路**（第八节，20261006）——配置表单搬到站点设置
 *     （`#/dashboard/usercontrol` 的「图库存储」页签）之后，图库页只剩这颗按钮：它要没跳、
 *     或跳错页签，用户就永远改不了配置，而页面上不会有任何报错。所以这一节真点一次、
 *     读 Router 的 location（探针见 `ENTRY`）。⚠️ 挂载因此必须包在 `MemoryRouter` 里
 *     （`useNavigate()` 在 Router 外会当场抛 ⇒ 整页白屏、所有断言超时）。
 *   · **上传的两条通道各是一颗钮**（七之二节，20261006 用户第 1 条）——用户原话
 *     「不要让 R2 开启存储图片时服务器上传途径失效」。判据钉的是**那颗服务器钮不许被
 *     R2 的状态牵连**：本沙箱里 R2 是没配全的（假后端给 `configured: false`），正是从前
 *     会把唯一那颗钮灰掉的两种情形之一 —— 它必须照样可点，被灰的只该是 R2 那颗，
 *     且旁边要写清为什么。两颗钮的底色也必须不同（读**计算色**，不读源码）。
 *
 * 见 CLAUDE.md §2：本机不能 vite build。esbuild 把**真组件**打成 bundle，只桩一个边界
 * （`src/apis/axios.tsx`）；页面 sass 用 programmatic API 单独编译后注入（顺带过一遍编译，
 * 本机唯一拦得下构建级缺陷的环节）。两个必踩的坑：① `src/apis/ImageMethods.tsx` 调的是
 * `http({...})`（默认导出**当函数用**），所以桩必须是"可调用对象"，只给 `.get/.post`
 * 会 TypeError 并被组件里那个 `.catch` 静静吃掉（症状 = 列表永远是空的）；
 * ② 假响应一律深拷贝。本机无中文字体（汉字渲染成豆腐块），断言全走数值、条数与请求体。
 *
 * 用法：npx playwright test tests/e2e/album-views.spec.ts
 * 依赖：frontend/node_modules（esbuild/react/react-dom/antd/sass）、@playwright/test。
 */
import { cp, readFile, stat } from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { FE_DIR, compileSass, esbuildInSandbox, withSandbox } from "./sandbox";

const DEFINE = {
  "import.meta.env": JSON.stringify({
    VITE_HTTP_BASEURL: "",
    VITE_CDN_BASEURL: "",
    MODE: "production",
    DEV: false,
    PROD: true,
    BASE_URL: "/",
  }),
};

// ── 夹具（node 侧是期望值，JS 侧 ENTRY 里按同一份造数据；超长名那份由 node 注入，
//    保证两侧逐字相同）────────────────────────────────────────────────────────
// 超长名**刻意用 ASCII**：本机无中文字体（`fc-list :lang=zh` 为空），汉字在沙箱里渲染成
// 窄窄的缺字框——实测 124 个汉字只占 1039px，**比那一格还窄**。拿它量"溢出"等于在量字体、
// 不是在量布局。ASCII 有真实字宽：316 字符 ≈ 2200px，一定超出那一格（1440 视口下约 1255px）。
const LONG_TAIL = "very_long_screenshot_name_".repeat(12); // 312 字符 + ".png"
// (盘上的名字, 给人看的名字)
const NAMED: [string, string][] = [
  ["20260912013218_EMQX.png", "EMQX.png"],
  ["20200405101112_封面-夏日特别版.png", "封面-夏日特别版.png"],
  ["old_pic.png", "old_pic.png"], // 不是那个形状 ⇒ 原样显示
  ["20260930120000_笔记.png", "笔记.png"],
  ["20251231235959_末班车.png", "末班车.png"],
];
const LONG_URL = "/api/protect/download/20261001000000_" + LONG_TAIL + ".png";

// ── 第七节要的两份样式 ───────────────────────────────────────────────────────────
// ① 后台的**全局** CSS。它从来没进过这个沙箱，而上传按钮那件事故的真凶就住在这里：
//    `.icon{min-width:60px}`（以及 `.image,.icon` 那条同款）。只有把它拼进页面，
//    按钮里的 `<span class="icon">` 才会被撑成 60px、才会真的压出按钮右缘 ——
//    不注入它的话几何断言**必然假绿**（那正是这次要补的缺口）。
const DASH_CSS = readFileSync(
  path.join(FE_DIR, "src/pages/Dashboard/index.css"),
  "utf-8",
);

// ② 修复前的分隔线（字面量内嵌，负控专用，见沙箱构建尾注）：
//    `.action_img` 自己没有线，线是一条 `position:absolute; top:90px` 的伪元素
//    —— 它按 `.allin`（唯一带 `transform` 的祖先）定位，所以线落在"面板顶往下 90px"，
//    与工具栏的真实高度无关。
const OLD_DIVIDER_CSS = `
.action_img{position:static;padding-bottom:0;border-bottom:none}
.action_img::before{content:'';position:absolute;width:98%;height:3px;
  background-color:var(--washi-line,rgba(198,152,192,.42));top:90px;z-index:3;
  border-radius:5px;left:50%;transform:translateX(-50%)}
`;

const ALL_URLS = [
  ...NAMED.map(([n]) => "/api/protect/download/" + n),
  LONG_URL,
];
const N = ALL_URLS.length; // 6 张

const FAKE_AXIOS = `
const calls: any[] = (window as any).__calls = [];
(window as any).__axiosStub = true;

const env = (data: any) => ({ status: 200, data: { code: 200, message: 'ok', data } });
// ⚠️ 每次都必须回**深拷贝**：真 HTTP 每次都反序列化出一个新对象，而这里面的数组是同一个
// 引用 ⇒ \`setStaticDate(同一个引用)\` 会被 React 的 Object.is 判等拦下、**不触发重渲染**，
// 症状是"请求成功了但界面纹丝不动"。
const wire = (d: any) => (d == null ? d : JSON.parse(JSON.stringify(d)));
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

const req = async (cfg: any) => {
  const url = cfg.url as string;
  const method = (cfg.method || 'GET').toUpperCase();
  calls.push({ url, method, data: wire(cfg.data) });
  await delay(20);
  if (url === '/api/protect/images') return env(wire((window as any).__images));
  if (url === '/api/protect/delImg') return env('Deleted');
  return env(null);
};

// ⚠️ 必须是**可调用对象**：\`src/apis/ImageMethods.tsx\` 写的是 \`http({ url, method })\`
// （默认导出当函数用），而别的页面写 \`http.get(...)\`。只做其中一种，另一种就是
// \`undefined is not a function\`，且组件里那句 \`.catch((error) => { throw error })\`
// 之后没有任何提示 ⇒ 页面白屏或空列表，看日志也只有一条 Promise 报错。
const http: any = (cfg: any) => req(cfg);
http.get = (url: string, cfg?: any) => req({ ...(cfg || {}), url, method: 'GET' });
http.post = (url: string, data?: any, cfg?: any) => req({ ...(cfg || {}), url, data, method: 'POST' });
http.put = (url: string, data?: any, cfg?: any) => req({ ...(cfg || {}), url, data, method: 'PUT' });
http.delete = (url: string, cfg?: any) => req({ ...(cfg || {}), url, method: 'DELETE' });
export default http;
`;

const ENTRY = `
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, useLocation } from 'react-router-dom';
import Albums from './src/pages/Dashboard/Albums/index.tsx';

// ⚠️ 挂载必须包在 Router 里（20261006）。真站里这一页永远活在 Router 内
// （\`router/index.tsx\`），而图库页现在用 \`useNavigate()\` 跳去站点设置改 R2 配置 ——
// 少了 Router 上下文它会**当场抛**，表现是整页白屏、本文件每一条断言都超时。
// 第八节还靠下面这颗探针读路由（点那颗按钮必须真的换路由）。
const Probe = () => {
  const loc = useLocation() as any;
  return <div id="probe" data-path={loc.pathname} data-tab={(loc.state && loc.state.tab) || ''} />;
};

// 夹具与 node 侧同名同序（超长名那一条由 node 注入长名尾巴）。
// ⚠️ 注释这行本身就含那个占位符字样，而 JS 的 replace 只换**第一次**出现
// （Python 的 str.replace 换全部）—— 用 replace 会把注释里那次换掉、LONG 值里的原样
// 留下，症状是最后一行显示占位符本名且永远不溢出。必须 replaceAll。
const NAMED: [string, string][] = [
  ['20260912013218_EMQX.png', 'EMQX.png'],
  ['20200405101112_封面-夏日特别版.png', '封面-夏日特别版.png'],
  ['old_pic.png', 'old_pic.png'],
  ['20260930120000_笔记.png', '笔记.png'],
  ['20251231235959_末班车.png', '末班车.png'],
];
const LONG = '20261001000000___LONGTAIL__.png';
const LIST = [
  ...NAMED.map(([f]) => f),
  LONG,
].map((f, i) => ({ imageKey: 900 + i, imageUrl: '/api/protect/download/' + f }));
(window as any).__images = LIST;
(window as any).__mount = () => createRoot(document.getElementById('root')!).render(
  <MemoryRouter initialEntries={['/dashboard/albums']}>
    <Albums />
    <Probe />
  </MemoryRouter>
);
`;

/** 与 Python 版 write_html 同款：字体 + box-sizing + 页面样式（extra 排最后，负控档用）。 */
function htmlShell(bundle: string, css: string, extra = ""): string {
  return (
    '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">' +
    // 图标字体：**真站就是自托管的这三行**（index.html 的 `<link>` + `.iconfont` 内联块，
    // 20261001 起不再引 CDN）。沙箱里少了它，工具栏那个 `<i class="iconfont icon-xiangce">`
    // 就**没有字形**（空盒子、高 0）⇒ 工具栏比真站矮一截，而"分隔线压不压按钮"这件事
    // 只由工具栏高度决定（线钉在面板顶往下 90px）—— 少了字体就是那条几何断言假绿。
    '<link rel="stylesheet" href="/fonts/font_4335817_6gqxzh34cy.css">' +
    '<style>.iconfont{font-family:"iconfont" !important;font-size:24px;font-style:normal;' +
    "-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale}</style>" +
    "<style>html,body,#root{height:100%;margin:0}" +
    // 真站在 frontend/src/frontHome/main.css 里有全局 `*{box-sizing:border-box}`，
    // 后台页面同样吃它；不照搬的话几何断言会在沙箱里失真。
    "*{box-sizing:border-box;margin:0;padding:0}</style>" +
    `<style>${css}</style>` +
    (extra ? `<style>${extra}</style>` : "") +
    '</head><body><div id="root"></div>' +
    `<script src="${bundle}"></script></body></html>`
  );
}

const LOADERS = {
  ".sass": "text",
  // 上传按钮里有一张 `assets/uploadImg.png`（Vite 会把它变成 URL）：
  // 不配 loader 时 esbuild 直接报错退出——这是**打包期**的失败，
  // 比渲染期的失败好定位得多，所以这里只补 loader、不绕过这个组件。
  ".png": "dataurl",
  ".svg": "dataurl",
} as const;

// ── 浏览器侧 GEO（与 Python 版逐字对应的计算语义）────────────────────────────

interface Rect4 {
  l: number;
  t: number;
  w: number;
  h: number;
  rt: number;
  b: number;
}
interface BarInfo {
  bar: Rect4;
  lineY: number | null;
  barBorderBottom: string;
  barPosition: string;
  btn: Rect4 | null;
  icon: Rect4 | null;
  img: Rect4 | null;
  iconMinW: string | null;
  iconW: string | null;
  iconH: string | null;
  iconPos: string | null;
  imgW: string | null;
  beforeContent: string | null;
  beforePos: string | null;
  beforeTop: string | null;
  del: { btn: Rect4; icon: Rect4 | null; iconMinW: string | null; iconPos: string | null } | null;
}
interface RowInfo {
  name: string | null;
  alt: string | null;
  thumb: Rect4 | null;
  nameRect: Rect4 | null;
  nameOverflow: number | null;
  checked: boolean;
  box: boolean;
  mark: Rect4 | null;
}
interface GeoM {
  rows: number;
  bar: BarInfo | null;
  gridImgs: number;
  listWrap: boolean;
  thumb: Rect4 | null;
  selCount: string;
  selRect: Rect4 | null;
  selOpacity: string | null;
  selPosition: string | null;
  segRect: Rect4 | null;
  delRect: Rect4 | null;
  rowInfo: RowInfo[];
}

interface Call {
  url: string;
  method: string;
  body?: unknown;
}
interface ProbeM {
  path: string | null;
  tab: string | null;
}

test.describe("图库两种展示方式", () => {
  test.setTimeout(240_000);

  test("互斥/行内容/勾选计数/负控/本地记忆/删除路径/工具栏/双上传钮/R2 入口（72 条）", async ({
    browser,
  }) => {
    await withSandbox({}, async (sb) => {
      // 图标字体照搬真站那三份（CSS 里的 `src` 是同目录相对路径，所以整目录一起拷）
      await cp(path.join(FE_DIR, "public/fonts"), path.join(sb.dir, "fonts"), {
        recursive: true,
      });

      // 主包：真组件 + axios 桩。
      await esbuildInSandbox(sb, {
        entry: "entry.tsx",
        copySrc: true,
        define: DEFINE,
        loaders: LOADERS,
        files: {
          "src/apis/axios.tsx": FAKE_AXIOS,
          "entry.tsx": ENTRY.replaceAll("__LONGTAIL__", LONG_TAIL),
        },
      });
      // 组件级的 .css（CheckButton 的 `.Check_container{font-size:1.5rem}` 等）由 esbuild
      // 从 JS 里抽到 bundle.css —— 那份必须一起进页面，否则"勾选框在行内被调小"这件事
      // 根本没有可比对的基线。
      try {
        await stat(path.join(sb.dir, "bundle.css"));
      } catch {
        throw new Error("esbuild 没产出 bundle.css：.css 的导入链断了（勾选框样式将无从比对）");
      }
      // 页面自己的 sass：单独编译（loader:.sass=text 只是把样式吞成一个字符串，不进页面）
      const pageCss = compileSass(
        path.join(FE_DIR, "src/pages/Dashboard/Albums/index.sass"),
      );
      const baseCss =
        pageCss +
        "\n" +
        (await readFile(path.join(sb.dir, "bundle.css"), "utf-8")) +
        "\n" +
        DASH_CSS;
      await sb.write("index.html", htmlShell("bundle.js", baseCss));

      // ── 负控（第四节）：另打一份**把 `e.stopPropagation()` 抹掉**的包 ────────────────
      const srcTsx = readFileSync(
        path.join(FE_DIR, "src/pages/Dashboard/Albums/index.tsx"),
        "utf-8",
      );
      const ANCHOR = "onClick={(e) => e.stopPropagation()}";
      const nAnchor = srcTsx.split(ANCHOR).length - 1;
      if (nAnchor !== 1)
        throw new Error(
          `负控锚点失配：\`onClick={(e) => e.stopPropagation()}\` 命中 ${nAnchor} 处（应为 1）` +
            "——组件里的写法变了，本节的负控要先跟着改，否则它证明不了任何事",
        );
      await esbuildInSandbox(sb, {
        subdir: "bad",
        entry: "entry.tsx",
        copySrc: true,
        define: DEFINE,
        loaders: LOADERS,
        files: {
          "entry.tsx": ENTRY.replaceAll("__LONGTAIL__", LONG_TAIL),
          "src/pages/Dashboard/Albums/index.tsx": srcTsx.replace(
            "(e) => e.stopPropagation()",
            "() => {}",
          ),
        },
      });
      await sb.write("bad/index.html", htmlShell("bundle.js", baseCss));

      // ── 负控（第七节）：另打一份**把工具栏分隔线还原成修复前形态**的包 ──────────────
      // 目的：第七节那几条几何断言必须**能红**。这里不是"再打一份会挂的包"，而是把
      // **修复前那条规则**原样拼回去（`OLD_DIVIDER_CSS` 是内嵌字面量，**不读 `git show HEAD`**
      // ——测试的红基线不许钉在某次提交上）。
      // 覆盖分两半，缺一不可：① `.action_img` 自己那条 `border-bottom` 要去掉（修复前工具栏
      // 自己没有线），② 把那条绝对定位的 `::before` 加回来。
      await esbuildInSandbox(sb, {
        subdir: "olddiv",
        entry: "entry.tsx",
        copySrc: true,
        define: DEFINE,
        loaders: LOADERS,
        files: { "entry.tsx": ENTRY.replaceAll("__LONGTAIL__", LONG_TAIL) },
      });
      await sb.write(
        "olddiv/index.html",
        htmlShell("bundle.js", baseCss, OLD_DIVIDER_CSS),
      );

      const MAIN_URL = sb.url;
      const BAD_URL = new URL("bad/index.html", sb.url).toString();
      const OLDDIV_URL = new URL("olddiv/index.html", sb.url).toString();

      // ⚠️ 「已选中 N 张」那格挂着 `transition: 0.3s`（切透明/切回）——写完立刻量到的还是
      // **动画中间档**（实测点了之后 250ms 量到 0.98）。量透明度必须等过这个时长。
      const WAIT_ANIM = 500;

      async function geo(pg: Page): Promise<GeoM> {
        return pg.evaluate(() => {
          const nzB = (s: unknown) =>
            String(s == null ? "" : s).replace(/\s+/g, "");
          const R = (el: Element | null): Rect4 | null => {
            if (!el) return null;
            const r = el.getBoundingClientRect();
            return {
              l: Math.round(r.left),
              t: Math.round(r.top),
              w: Math.round(r.width),
              h: Math.round(r.height),
              rt: Math.round(r.right),
              b: Math.round(r.bottom),
            };
          };
          const rows = [...document.querySelectorAll(".albumRow")];
          // ── 第七节：工具栏、上传按钮、以及"那条线到底在哪" ─────────────────────────
          const bar = document.querySelector(".action_img");
          const btn = bar && bar.querySelector(".select");
          const icon = btn && btn.querySelector(".icon");
          const img = icon && icon.querySelector("img");
          const allin = document.querySelector(".allin");
          const bcs = bar ? getComputedStyle(bar) : null;
          const before = bar ? getComputedStyle(bar, "::before") : null;
          // 分隔线的位置只有两种形态，这里统一折算成**视口 y**：
          //   · 修复后 = 工具栏自己的 `border-bottom`（流内）⇒ 它的上缘 = bottom - 宽度
          //   · 修复前 = `.action_img::before` 那条绝对定位的线 ⇒ 相对 `.allin`（唯一带
          //     `transform` 的祖先，也就是它的包含块）的 top 值 + `.allin` 的视口位置
          // 归一之后，"线在按钮下面吗"这一条断言在两档上问的是同一个问题。
          const lineY = (() => {
            if (!bar || !bcs) return null;
            const bw = parseFloat(bcs.borderBottomWidth) || 0;
            if (
              before &&
              before.content !== "none" &&
              before.position === "absolute" &&
              before.top !== "auto"
            ) {
              return Math.round(
                (allin ? allin.getBoundingClientRect().top : 0) +
                  parseFloat(before.top),
              );
            }
            return bw > 0 ? Math.round(bar.getBoundingClientRect().bottom - bw) : null;
          })();
          const barInfo: BarInfo | null = bar
            ? {
                bar: R(bar)!,
                lineY,
                barBorderBottom: bcs!.borderBottomWidth,
                barPosition: bcs!.position,
                btn: R(btn),
                icon: R(icon),
                img: R(img),
                iconMinW: icon ? getComputedStyle(icon).minWidth : null,
                iconW: icon ? getComputedStyle(icon).width : null,
                iconH: icon ? getComputedStyle(icon).height : null,
                iconPos: icon ? getComputedStyle(icon).position : null,
                imgW: img ? getComputedStyle(img).width : null,
                beforeContent: before ? before.content : null,
                beforePos: before ? before.position : null,
                beforeTop: before ? before.top : null,
                // 同一根 `.icon` 泄漏也照到旁边那颗删除钮（`.noselect .icon`）—— 一并量出来，
                // 免得只修一半、两颗按钮长得不一样
                del: (() => {
                  const d = document.querySelector(".albumActions .noselect");
                  const di = d && d.querySelector(".icon");
                  return d
                    ? {
                        btn: R(d)!,
                        icon: R(di),
                        iconMinW: di ? getComputedStyle(di).minWidth : null,
                        iconPos: di ? getComputedStyle(di).position : null,
                      }
                    : null;
                })(),
              }
            : null;

          const sel = document.querySelector(".albumSelCount");
          const seg = document.querySelector(".ant-segmented");
          const del = document.querySelector(".albumActions .noselect");
          return {
            rows: rows.length,
            bar: barInfo,
            gridImgs: document.querySelectorAll(".imgShade").length,
            listWrap: !!document.querySelector(".albumList"),
            thumb: R(document.querySelector(".albumThumb")),
            selCount: nzB(sel && sel.textContent),
            selRect: R(sel),
            selOpacity: sel ? getComputedStyle(sel).opacity : null,
            selPosition: sel ? getComputedStyle(sel).position : null,
            segRect: R(seg),
            delRect: R(del),
            rowInfo: rows.map((r) => {
              const nm = r.querySelector(".albumName");
              const th = r.querySelector(".albumThumb");
              return {
                name: nm ? nm.textContent : null,
                alt: th ? th.getAttribute("alt") : null,
                thumb: R(th),
                nameRect: R(nm),
                // > 0 = 这个名字真的被截断了（在被压的那一格上）
                nameOverflow: nm ? nm.scrollWidth - nm.clientWidth : null,
                checked: r.classList.contains("is-checked"),
                box: !!r.querySelector("input:checked"),
                mark: R(r.querySelector(".checkmark")),
              };
            }),
          };
        });
      }

      async function writeCalls(pg: Page): Promise<Call[]> {
        // 本页发出的**写请求**（非 GET）。"禁用/空选时一个请求都不发"这类断言用它。
        return pg.evaluate(() =>
          (
            (window as unknown as Record<
              string,
              { url: string; method: string; data?: unknown }[]
            >).__calls ?? []
          )
            .filter((c) => c.method !== "GET")
            .map((c) => ({ url: c.url, method: c.method, body: c.data })),
        );
      }

      async function probe(pg: Page): Promise<ProbeM | null> {
        // 当前路由（ENTRY 里那颗探针印出来的）。第八节用。
        return pg.evaluate(() => {
          const el = document.getElementById("probe");
          return el
            ? { path: el.getAttribute("data-path"), tab: el.getAttribute("data-tab") }
            : null;
        });
      }

      const toList = async (pg: Page) => {
        // 切到「列表」那一档（Segmented 的第 2 个选项）。
        await pg.locator(".ant-segmented-item").nth(1).click();
        await pg.waitForTimeout(400);
      };
      const toGrid = async (pg: Page) => {
        await pg.locator(".ant-segmented-item").nth(0).click();
        await pg.waitForTimeout(400);
      };
      const clickRow = async (pg: Page, idx: number) => {
        // 点行的**名字那一格**（不是勾选框）：走的是行的 onClick。
        await pg.locator(".albumRow").nth(idx).locator(".albumName").click();
        await pg.waitForTimeout(WAIT_ANIM);
      };
      const clickBox = async (pg: Page, idx: number) => {
        // 点行内的勾选框本体（label 中心 = 那个圆点）。
        await pg.locator(".albumRow").nth(idx).locator(".Check_container").click();
        await pg.waitForTimeout(WAIT_ANIM);
      };

      /** 挂载图库页。view 预置 localStorage 里的展示方式（undefined = 一次都没选过）。 */
      async function mount(
        opts: { url?: string; view?: string; size?: [number, number] } = {},
      ): Promise<{ page: Page; errs: string[] }> {
        const size = opts.size ?? [1440, 900];
        const page = await browser.newPage({
          viewport: { width: size[0], height: size[1] },
        });
        const errs: string[] = [];
        page.on("pageerror", (e) => errs.push(String(e)));
        if (opts.view) {
          await page.goto(MAIN_URL); // 先落一个同源页面，才能写 localStorage
          await page.evaluate(
            (v) => localStorage.setItem("albumViewMode", v),
            opts.view,
          );
        }
        await page.goto(opts.url ?? MAIN_URL);
        await page.evaluate(() => (window as unknown as { __mount: () => void }).__mount());
        try {
          await page.waitForSelector(".imgShade, .albumRow", { timeout: 10000 });
        } catch (e) {
          // 等不到就别只说"超时"：把关键节点、请求记录与页面异常一起打出来。
          const seen = await page.evaluate(() =>
            JSON.stringify({
              root: document.getElementById("root")!.children.length,
              grid: document.querySelectorAll(".imgShade").length,
              rows: document.querySelectorAll(".albumRow").length,
              axiosStub:
                (window as unknown as Record<string, unknown>).__axiosStub === true,
              calls: (
                (window as unknown as Record<string, { method: string; url: string }[]>)
                  .__calls ?? []
              ).map((c) => c.method + " " + c.url),
            }),
          );
          console.error(`  ⚠ 等不到图片节点，现场：\n    ${seen}\n    页面异常：${errs.slice(0, 3).join("; ") || "（无）"}`);
          throw e;
        }
        await page.waitForTimeout(600);
        return { page, errs };
      }

      // ── 一、默认是「平铺」，两种方式互斥 ──────────────────────────────────────
      {
        const { page: pg, errs } = await mount();
        let g = await geo(pg);
        expect
          .soft(g.gridImgs === N, `默认档渲染出 ${N} 张图（假后端那一份） → ${g.gridImgs}`)
          .toBe(true);
        expect
          .soft(
            g.listWrap === false && g.rows === 0,
            `默认档列表容器不存在（\`.albumList\` 没进 DOM） → wrap=${g.listWrap} rows=${g.rows}`,
          )
          .toBe(true);

        await toList(pg);
        g = await geo(pg);
        expect.soft(g.rows === N, `切到列表后是 ${N} 行 → ${g.rows}`).toBe(true);
        expect
          .soft(
            g.gridImgs === 0,
            `  且网格那批图**整个不在 DOM 里**（不是叠在下面/漏了卸载） → ${g.gridImgs}`,
          )
          .toBe(true);

        await toGrid(pg);
        g = await geo(pg);
        expect
          .soft(
            g.gridImgs === N && g.listWrap === false && g.rows === 0,
            `  切回平铺：网格回来、列表整个撤掉（双向都要验，否则只证明了单向不变量） → grid=${g.gridImgs} rows=${g.rows}`,
          )
          .toBe(true);
        expect
          .soft(errs.length === 0, `第一节无页面异常 → ${errs.slice(0, 3).join("; ")}`)
          .toBe(true);
        await pg.close();
      }

      // ── 二、行 = 缩略图 + 图片名 ─────────────────────────────────────────────
      {
        const { page: pg, errs } = await mount({ view: "list" });
        const g = await geo(pg);
        const names = g.rowInfo.map((r) => r.name);
        const expectNames = [...NAMED.map(([, v]) => v), LONG_TAIL + ".png"];
        expect
          .soft(
            JSON.stringify(names) === JSON.stringify(expectNames),
            `列表里每一行的名字就是假后端那一份的展示名（剥前缀 / 原样两种都在） → ${JSON.stringify(names.slice(0, 3))} …`,
          )
          .toBe(true);
        expect
          .soft(names[0] === "EMQX.png", `  \`20260912013218_EMQX.png\` 显示成 \`EMQX.png\` → ${names[0]}`)
          .toBe(true);
        expect
          .soft(
            names[2] === "old_pic.png",
            `  不是那个形状的（\`old_pic.png\`）原样显示 → ${names[2]}`,
          )
          .toBe(true);
        expect
          .soft(
            JSON.stringify(g.rowInfo.map((r) => r.alt)) === JSON.stringify(expectNames),
            `缩略图的 alt 也是同一个展示名（读屏与图裂时看到的是名字，不是盘上那串） → ${JSON.stringify(g.rowInfo.map((r) => r.alt).slice(0, 2))}`,
          )
          .toBe(true);

        const thumbs = g.rowInfo;
        expect
          .soft(
            thumbs.every((r) => r.thumb && r.thumb.w === 56 && r.thumb.h === 56),
            `每一行的缩略图都是 56×56（含超长名那一行） → ${JSON.stringify(thumbs.map((r) => r.thumb?.w))}`,
          )
          .toBe(true);
        expect
          .soft(
            thumbs[thumbs.length - 1].thumb!.w === 56,
            `  缩略图**没有被名字挤小**（\`flex: 0 0 auto\`：最坏的那一行也一样宽） → ${JSON.stringify(thumbs[thumbs.length - 1].thumb)}`,
          )
          .toBe(true);
        expect
          .soft(
            thumbs[thumbs.length - 1].nameOverflow! > 0,
            `被压的是名字那一格：超长名真的溢出了（\`scrollWidth > clientWidth\`） → ${thumbs[thumbs.length - 1].nameOverflow}`,
          )
          .toBe(true);
        expect
          .soft(
            g.rowInfo.slice(0, N - 1).every((r) => r.nameOverflow! <= 0),
            `  反过来，短名那几行**没有**溢出（证明上一条不是「这一格永远溢出」） → ${JSON.stringify(g.rowInfo.map((r) => r.nameOverflow))}`,
          )
          .toBe(true);
        expect
          .soft(
            !!g.rowInfo[0].mark && g.rowInfo[0].mark!.h >= 20 && g.rowInfo[0].mark!.h <= 25,
            `行内勾选框比默认那档小（\`.Check_container\` 自带 1.5rem ⇒ 行内 1.1rem 要写在它自己那层） → ${JSON.stringify(g.rowInfo[0].mark)}`,
          )
          .toBe(true);
        expect
          .soft(errs.length === 0, `第二节无页面异常 → ${errs.slice(0, 3).join("; ")}`)
          .toBe(true);
        await pg.close();
      }

      // ── 三、行点击 ⇒ 勾选 + 计数；「已选中」那格只变淡、不消失 ──────────────────
      {
        const { page: pg, errs } = await mount({ view: "list" });
        let g = await geo(pg);
        expect
          .soft(
            g.selCount === "已选中0张图片" && g.selOpacity === "0",
            `前置：未选中时计数是 0 且那格是**透明的** → ${g.selCount} opacity=${g.selOpacity}`,
          )
          .toBe(true);
        expect
          .soft(
            !!g.selRect && g.selRect.w > 50,
            `  但那格照旧**占着位置**（宽度 > 50px）——透明不等于被摘掉 → ${JSON.stringify(g.selRect)}`,
          )
          .toBe(true);
        expect
          .soft(
            g.selPosition === "static",
            `  且它是**流内**元素（\`position: static\`），不是绝对定位 → ${g.selPosition}`,
          )
          .toBe(true);
        expect
          .soft(
            !!g.selRect &&
              !!g.segRect &&
              !!g.delRect &&
              g.selRect.rt <= g.segRect.l &&
              g.segRect.rt <= g.delRect.l,
            `  切换器与删除钮都在计数右边（一行三件，次序对） → ${JSON.stringify([g.selRect, g.segRect, g.delRect])}`,
          )
          .toBe(true);

        await clickRow(pg, 0);
        g = await geo(pg);
        expect
          .soft(
            g.rowInfo[0].checked && g.rowInfo[0].box,
            `点第 1 行的名字 ⇒ 那一行被勾上（行高亮 + 勾选框真选中） → ${JSON.stringify(g.rowInfo[0])}`,
          )
          .toBe(true);
        expect
          .soft(
            g.selCount === "已选中1张图片",
            `  计数变成「已选中1张图片」 → ${g.selCount}`,
          )
          .toBe(true);
        expect
          .soft(g.selOpacity === "1", `  那格同时变可见（opacity 1） → ${g.selOpacity}`)
          .toBe(true);
        expect
          .soft(
            g.rowInfo.filter((r) => r.checked).length === 1,
            `  只有这一行被勾上 → ${JSON.stringify(g.rowInfo.map((r) => r.checked))}`,
          )
          .toBe(true);

        await clickRow(pg, 0);
        g = await geo(pg);
        expect
          .soft(
            !g.rowInfo[0].checked && g.selCount === "已选中0张图片",
            `再点同一行 ⇒ 取消勾选、计数归 0（是开关，不是单向置位） → ${g.rowInfo[0].checked} ${g.selCount}`,
          )
          .toBe(true);
        expect
          .soft(errs.length === 0, `第三节无页面异常 → ${errs.slice(0, 3).join("; ")}`)
          .toBe(true);
        await pg.close();
      }

      // ── 四、勾选框自己点：只翻一次（含真负控）──────────────────────────────────
      {
        const { page: pg, errs } = await mount({ view: "list" });
        await clickBox(pg, 1);
        let g = await geo(pg);
        expect
          .soft(
            g.rowInfo[1].checked && g.selCount === "已选中1张图片",
            `点第 2 行的勾选框 ⇒ 勾上，且计数是 **1**（不是 2——两处回调各翻一次会变成 2） → ${g.rowInfo[1].checked} ${g.selCount}`,
          )
          .toBe(true);
        expect
          .soft(
            g.rowInfo.filter((r) => r.checked).length === 1,
            `  别的行没被带上 → ${JSON.stringify(g.rowInfo.map((r) => r.checked))}`,
          )
          .toBe(true);
        await clickBox(pg, 1);
        g = await geo(pg);
        expect
          .soft(
            !g.rowInfo[1].checked && g.selCount === "已选中0张图片",
            `再点一次 ⇒ 取消，计数归 0 → ${g.rowInfo[1].checked} ${g.selCount}`,
          )
          .toBe(true);
        expect
          .soft(errs.length === 0, `第四节（正档）无页面异常 → ${errs.slice(0, 3).join("; ")}`)
          .toBe(true);
        await pg.close();
      }

      // 负控：同一份代码、只把 `e.stopPropagation()` 换成空函数 —— 必须复现缺陷
      {
        const { page: pg } = await mount({ url: BAD_URL, view: "list" });
        const g0 = await geo(pg);
        expect
          .soft(
            g0.rows === N && g0.rowInfo.every((r) => !r.checked),
            `负控前置：坏档也是 6 行、默认都没勾 → ${g0.rows}`,
          )
          .toBe(true);
        await clickBox(pg, 0);
        const gb = await geo(pg);
        expect
          .soft(
            gb.rowInfo[0].checked === false,
            `负控：抹掉 \`stopPropagation\` 后**同一次点击不再生效**（行没勾上） → checked=${gb.rowInfo[0].checked} count=${gb.selCount}`,
          )
          .toBe(true);
        expect
          .soft(
            gb.selCount !== "已选中1张图片",
            `  （计数同步失真：${gb.selCount} ⇒ 正档断言确实在钉这一处） → ${gb.selCount}`,
          )
          .toBe(true);
        await pg.close();
      }

      // ── 五、展示方式记在本地，刷新后还在 ──────────────────────────────────────
      {
        const { page: pg } = await mount();
        expect
          .soft((await geo(pg)).listWrap === false, `前置：一次都没选过时是平铺`)
          .toBe(true);
        await toList(pg);
        await pg.goto(MAIN_URL);
        await pg.evaluate(() => (window as unknown as { __mount: () => void }).__mount());
        await pg.waitForSelector(".albumRow", { timeout: 10000 });
        await pg.waitForTimeout(500);
        let g = await geo(pg);
        expect
          .soft(
            g.rows === N && g.gridImgs === 0,
            `切到列表后刷新 ⇒ 仍是列表（localStorage \`albumViewMode\`） → rows=${g.rows} grid=${g.gridImgs}`,
          )
          .toBe(true);
        await toGrid(pg);
        await pg.goto(MAIN_URL);
        await pg.evaluate(() => (window as unknown as { __mount: () => void }).__mount());
        await pg.waitForSelector(".imgShade", { timeout: 10000 });
        await pg.waitForTimeout(500);
        g = await geo(pg);
        expect
          .soft(
            g.gridImgs === N && g.rows === 0,
            `再切回平铺后刷新 ⇒ 也记住（不是只有 list 那一档被写进本地） → rows=${g.rows} grid=${g.gridImgs}`,
          )
          .toBe(true);
        await pg.close();
      }

      // ── 六、列表方式不打乱原有的删除路径 ─────────────────────────────────────
      {
        const { page: pg, errs } = await mount({ view: "list" });
        // ① 未选中就点删除：一个写请求都不许发
        await pg.locator(".albumActions .noselect").click();
        await pg.waitForTimeout(400);
        expect
          .soft(
            (await writeCalls(pg)).length === 0,
            `未选中时点删除 ⇒ 零写请求（弹窗都不该出现） → ${JSON.stringify(await writeCalls(pg))}`,
          )
          .toBe(true);
        // ② 选中第 3 行再删
        await clickRow(pg, 2);
        await pg.locator(".albumActions .noselect").click();
        await pg.waitForTimeout(400);
        expect
          .soft(
            (await pg.locator(".ant-modal-wrap:visible").count()) >= 1 &&
              (await writeCalls(pg)).length === 0,
            `选中一张再点删除 ⇒ 弹窗出现、还没发请求 → ${JSON.stringify(await writeCalls(pg))}`,
          )
          .toBe(true);
        await pg
          .locator(".ant-modal-wrap:visible .ant-modal-footer .ant-btn-primary")
          .click();
        await pg.waitForTimeout(600);
        const w = await writeCalls(pg);
        expect
          .soft(
            w.length === 1 &&
              w[0].method === "DELETE" &&
              w[0].url === "/api/protect/delImg",
            `确定 ⇒ 恰好一条 DELETE /api/protect/delImg → ${JSON.stringify(w)}`,
          )
          .toBe(true);
        expect
          .soft(
            w.length > 0 && JSON.stringify(w[0].body) === JSON.stringify([ALL_URLS[2]]),
            `  body 就是被选中那张图的 URL（列表方式的勾选接回了同一条路径） → ${w.length ? JSON.stringify(w[0].body) : "null"}`,
          )
          .toBe(true);
        const g = await geo(pg);
        expect
          .soft(
            g.selCount === "已选中0张图片" && g.rowInfo.every((r) => !r.checked),
            `  删完勾选清空、计数归 0（留着勾选会让人以为「点了没生效」） → ${g.selCount}`,
          )
          .toBe(true);
        expect
          .soft(errs.length === 0, `第六节无页面异常 → ${errs.slice(0, 3).join("; ")}`)
          .toBe(true);
        await pg.close();
      }

      // ── 七、工具栏分隔线与按钮里的图标（20261006，用户第 2 条）─────────────────
      // 这一节的**真凶住在全局 CSS 里**（`pages/Dashboard/index.css` 的 `.icon{min-width:60px}`，
      // 那是给侧栏导航写的），而这个沙箱此前从不注入它 ⇒ 断言会假绿。两个补丁一起做的：
      //   · 沙箱构建把那份全局 CSS 拼进页面（连同真站的图标字体，见 `htmlShell` 注释）；
      //   · 下面第一条守卫读源码，确认那条规则**还在**（它被删/改名时，这一节就失去了
      //     它存在的理由，得自己红 —— 而不是在缺少真凶的页面上继续"通过"）。
      expect
        .soft(
          /\.icon\s*\{[^}]*min-width:\s*60px/.test(DASH_CSS),
          `前置守卫：\`pages/Dashboard/index.css\` 里那条 \`.icon{min-width:60px}\` 还在（沙箱要靠它复现真凶；哪天它没了，本节断言等于没在测东西）`,
        )
        .toBe(true);

      {
        const { page: pg, errs } = await mount();
        const g = (await geo(pg)).bar!;

        // ① 线 = 工具栏自己的下边框（在流内）。旧形态是"一条按魔法数 90px 落位的绝对定位线"，
        //    它与工具栏的真实几何无关 —— 判据取"线到工具栏底边的距离"，而不是取某个具体像素值。
        expect
          .soft(
            g.barBorderBottom === "3px" && g.bar.b - g.lineY! >= 0 && g.bar.b - g.lineY! <= 3,
            `分隔线就是工具栏自己的下边框（3px，且在工具栏底边沿上） → border-bottom=${g.barBorderBottom} bar.bottom=${g.bar.b} lineY=${g.lineY}`,
          )
          .toBe(true);
        expect
          .soft(
            g.beforeContent === "none",
            `  没有别的线了（\`.action_img::before\` 不再存在 —— 它才是那个会横穿按钮的东西） → ${g.beforeContent}`,
          )
          .toBe(true);
        expect
          .soft(
            g.barPosition === "relative",
            `  工具栏成了定位容器（\`position: relative\`） → ${g.barPosition}`,
          )
          .toBe(true);
        expect
          .soft(
            g.lineY! >= g.btn!.b,
            `线整体在按钮**下面**（任何字体/宽度下都不可能与自己的子元素重叠） → lineY=${g.lineY} btn.bottom=${g.btn!.b}`,
          )
          .toBe(true);

        // ② 上传钮里的图标槽：全局 `.icon{min-width:60px}` 会把它撑成 60px（min-width 恒胜 width），
        //    实测槽的右缘 180 > 按钮右缘 170 —— 图标被推出按钮框、整体右移 10px。
        expect
          .soft(
            g.btn!.w === 150 && g.btn!.h === 50,
            `上传钮仍是 150×50 → ${JSON.stringify(g.btn)}`,
          )
          .toBe(true);
        expect
          .soft(
            g.iconMinW === "0px" && g.icon!.w === 40,
            `  图标槽真的被 \`min-width:0\` 收回了 40px（全局那条 min-width 不再生效） → min-width=${g.iconMinW} w=${g.icon!.w}`,
          )
          .toBe(true);
        expect
          .soft(
            g.icon!.rt <= g.btn!.rt && g.icon!.l >= g.btn!.l,
            `  图标槽**整个**在按钮里（右缘不许越出按钮框） → icon=${JSON.stringify(g.icon)} btn=${JSON.stringify(g.btn)}`,
          )
          .toBe(true);
        expect
          .soft(
            g.imgW === "18px" && !!g.img && g.img.w === 18 && g.img.h === 18,
            `  槽内的图标本体给了明确尺寸 18×18（源图 30×30，原样渲染会大过旁边的删除图标） → css=${g.imgW} rect=${JSON.stringify(g.img)}`,
          )
          .toBe(true);

        // ③ 同一根泄漏也照到旁边那颗删除钮（同一套皮、同一个 `.icon` 类）
        const d = g.del!;
        expect
          .soft(
            !!d &&
              d.iconMinW === "0px" &&
              d.icon!.w === 40 &&
              d.icon!.rt <= d.btn.rt,
            `删除钮的图标槽同样收回了 40px、且整个在按钮里（两颗按钮不许长得不一样） → ${JSON.stringify(d)}`,
          )
          .toBe(true);

        // ④ 悬停那一下（图标槽展开铺满按钮）不许被上面的 min-width 改动弄坏。
        //    ⚠️ 20261006 起工具栏有**两颗** `.select`（传到本站 / 传到 R2），`querySelector`
        //    取的是第一颗（= 传到本站，与上面 `g.btn` 量的同一颗），但 playwright 的
        //    locator 在 strict 模式下会为"两个都命中"直接抛错 ⇒ 这里必须点名一颗。
        await pg.locator(".action_img .select").first().hover();
        await pg.waitForTimeout(400);
        const h = (await geo(pg)).bar!.icon!;
        expect
          .soft(
            h.w === 150 && h.l === g.btn!.l,
            `悬停：图标槽展开到整个按钮宽（150）且与按钮左缘齐平 → ${JSON.stringify(h)}`,
          )
          .toBe(true);
        expect
          .soft(errs.length === 0, `第七节无页面异常 → ${errs.slice(0, 3).join("; ")}`)
          .toBe(true);
        await pg.close();
      }

      // ── 七之二、上传的两条通道各是一颗钮（20261006，用户第 1 条）───────────────
      // 用户原话：「将上传服务器和上传R2做两个按钮分别上传，不要让R2开启存储图片时
      // 服务器上传途径失效」。所以这一节的判据是**那颗服务器钮不许被 R2 的状态牵连**：
      // 这个沙箱里 R2 是**没配全**的（假后端给 `configured: false`）—— 正是从前会把
      // 唯一那颗钮灰掉的两种情形之一。它必须照样可点；被灰的只该是 R2 那颗，且旁边
      // 要写清为什么（只藏在 title 里、触屏看不见，等于没说）。
      {
        const { page: pg, errs } = await mount();
        const ups = pg.locator(".action_img button.select");
        expect
          .soft(
            (await ups.count()) === 2,
            `工具栏里正好两颗上传钮（分别传本站与 R2） → ${await ups.count()}`,
          )
          .toBe(true);
        expect
          .soft(
            (await ups.nth(0).innerText()).trim() === "传到本站",
            `  第一颗是「传到本站」 → ${(await ups.nth(0).innerText()).trim()}`,
          )
          .toBe(true);
        expect
          .soft(
            (await ups.nth(1).innerText()).trim() === "传到 R2",
            `  第二颗是「传到 R2」 → ${(await ups.nth(1).innerText()).trim()}`,
          )
          .toBe(true);
        expect
          .soft(
            await ups.nth(0).isEnabled(),
            `  **服务器那颗没被灰**（R2 没配全时它必须照旧可点 —— 这就是本轮要修的事） → disabled`,
          )
          .toBe(true);
        expect
          .soft(await ups.nth(1).isDisabled(), `  R2 那颗被灰掉了 → enabled`)
          .toBe(true);
        const reason = pg.locator(".albumR2Blocked");
        expect
          .soft(
            (await reason.count()) === 1 &&
              (await reason.innerText()).trim().length > 0,
            `  且被灰时旁边写着原因（不是只有 title） → ${(await reason.count()) ? (await reason.innerText()) : "（没有那颗说明）"}`,
          )
          .toBe(true);
        // 两颗钮的皮必须不同色（并排时一眼分得出谁是谁）：量计算色，不读源码
        const colors = await pg.evaluate(() =>
          [...document.querySelectorAll(".action_img button.select")].map(
            (b) => getComputedStyle(b).backgroundColor,
          ),
        );
        expect
          .soft(
            colors[0] !== colors[1],
            `  两颗钮底色不同（服务器=手账粉 / R2=墨色那一档） → ${JSON.stringify(colors)}`,
          )
          .toBe(true);
        expect
          .soft(errs.length === 0, `第七之二节无页面异常 → ${errs.slice(0, 3).join("; ")}`)
          .toBe(true);
        await pg.close();
      }

      // 负控：把分隔线还原成修复前那条绝对定位的线（字面量内嵌，不读 git 历史）—— 必须复现
      {
        const { page: pg } = await mount({ url: OLDDIV_URL });
        const ob = (await geo(pg)).bar!;
        expect
          .soft(
            ob.beforeContent !== "none" &&
              ob.beforePos === "absolute" &&
              ob.barBorderBottom === "0px",
            `负控前置：旧形态的线真的回来了（\`::before\` + \`position:absolute\`、工具栏自己没有线） → content=${ob.beforeContent} pos=${ob.beforePos} border-bottom=${ob.barBorderBottom}`,
          )
          .toBe(true);
        expect
          .soft(
            !(ob.bar.b - ob.lineY! >= 0 && ob.bar.b - ob.lineY! <= 3),
            `负控：'线到工具栏底边 0..3px' 这条断言在旧形态上**不成立**（旧线钉在面板顶 +90px，工具栏一长高就切进按钮） → bar.bottom=${ob.bar.b} lineY=${ob.lineY}`,
          )
          .toBe(true);
        // 旧的线是**绝对定位**的，它的包含块是 `.allin`（唯一带 transform 的祖先）：
        // 线到按钮底边的距离 = 60 - (工具栏高 + 50)/2 ⇒ 工具栏高过 70px 就翻负、横穿按钮。
        // 把这条关系写进负控，是为了说明"为什么这不是换个数字（90→110）的事"。
        const gap = ob.lineY! - ob.btn!.b;
        expect
          .soft(
            Math.abs(gap - (60 - (ob.bar.h + 50) / 2)) <= 1,
            `  且这条距离由工具栏高度决定（实测间距 ${gap}px = 60 - (高 ${ob.bar.h} + 50)/2，工具栏一长高就翻负） → ${gap}`,
          )
          .toBe(true);
        await pg.close();
      }

      // ── 八、R2 那颗按钮是「去站点设置改配置」的真入口（20261006，用户第 3 条）──────
      // 20261006 用户拍板「配置挪到站点设置，单一入口」⇒ 图库页从此**没有** R2 表单，
      // 只剩这颗按钮。于是它成了从图库够到配置的**唯一一条路**：它要是没跳（或跳错页签），
      // 用户就永远改不了配置，而页面上不会有任何报错 —— 这正是必须真跑一遍才看得见的东西。
      {
        const { page: pg, errs } = await mount();
        expect
          .soft(
            (await probe(pg))?.path === "/dashboard/albums",
            `前置：起始路由是图库页 → ${JSON.stringify(await probe(pg))}`,
          )
          .toBe(true);
        const r2btn = pg.locator(".albumActions button.ant-btn:has-text('R2')");
        expect
          .soft(
            (await r2btn.count()) === 1,
            `前置：工具栏那颗 R2 按钮在（没被挪走/改名） → ${await r2btn.count()}`,
          )
          .toBe(true);
        await r2btn.click();
        await pg.waitForTimeout(300);
        const p = (await probe(pg)) ?? { path: null, tab: null };
        expect
          .soft(
            p.path === "/dashboard/usercontrol",
            `点它 ⇒ 路由换成 /dashboard/usercontrol → ${JSON.stringify(p)}`,
          )
          .toBe(true);
        expect
          .soft(
            p.tab === "4",
            `  且带上了 tab=4（不带就落在「站点信息」上，看着像按钮没生效） → ${JSON.stringify(p)}`,
          )
          .toBe(true);
        expect
          .soft(
            (await pg.locator(".ant-modal-wrap:visible").count()) === 0,
            `  这一页**没有**开任何弹窗（配置表单已不在这里 —— 单一入口） → ${await pg.locator(".ant-modal-wrap:visible").count()}`,
          )
          .toBe(true);
        expect
          .soft(errs.length === 0, `第八节无页面异常 → ${errs.slice(0, 3).join("; ")}`)
          .toBe(true);
        await pg.close();
      }
    });
  });
});
