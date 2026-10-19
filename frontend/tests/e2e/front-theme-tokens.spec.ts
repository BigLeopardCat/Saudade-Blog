import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { cp } from "node:fs/promises";
import path from "node:path";
import {
  FE_DIR,
  compileSass,
  withSandbox,
  collectPageErrors,
  esbuildInSandbox,
} from "./sandbox";

/**
 * 前台内容页（归档 / 说说 / 分类 / 关于）＋首页轮播圆点：配色必须走和纸令牌，且深浅两档要真的分档
 * （原 tests/front-theme-tokens.test.py，20261019 迁移）。
 *
 * 20261014 配色专项的判据。用户原话：「归档页，说说等等风格也同步到博客主题配色风格」
 * —— 这三页（都是 frontHome/Content/* 下的列表页）一直没跟上 20261001 那批和纸改版，
 * 色值写死在样式里，于是有两个后果：① 与站点其余部分的粉紫天青不是一套；② **深浅两档
 * 拿到同一个值**，其中两条在白天/夜里直接是坏掉的：
 *   · 归档页时间轴的竖线 rgba(255,255,255,0.3) —— 白线压在浅色页面上 **白天等于看不见**；
 *   · 分类页 .articleFooter 的 rgba(31,41,55,.9) —— 夜间深灰字压在深底上，同样看不见。
 *
 * ## 为什么判据要真渲染（而不是读源码）
 * "半死最难自查"：令牌写对、选择器写错、被 antd 的运行时样式压过去 —— 这三种在源码里
 * **看着都是对的**。本套件因此只读 getComputedStyle。实测就抓到过一例：归档页
 * .ant-timeline-item-head-blue 那三条（color/border-color/background）写在那儿好几年，
 * **一次都没生效过**（computed 仍是 antd 的 #1677ff 与白点底）—— 因为 antd v5 的
 * cssinjs 是运行时注入的，同权重（0,1,0）时后写者赢。这一条只有渲染出来才看得见。
 *
 * ## 判据的形状：拿令牌当期望，不拿字面量当期望
 * 每条断言的期望值是**同场景下现场解析出来的令牌值**（expected = 渲染一个
 * color: var(--washi-x) 的元素再读它），不是写死的十六进制。这样调色板整体换了颜色，
 * 本套件仍然是绿的（它判的是"这个位置跟着令牌走"）；而有人把色值重新写死，它立刻红。
 * 配套一条**自证**：day 与 night 两档的读值必须**不相等** —— "写死"这件事的直接症状就是
 * 两档同值，这条比任何字面量比对都稳。反过来它也能自证套件本身没瞎：两档读数若相同，
 * 说明令牌没被解析（环境坏了），下面那些"等于令牌"的断言全是空转。
 *
 * 第五节量的是**内容页的整页底**，也是用户回话的那半条：
 * 「背景色对不上，一片白茫茫和灰色，说说卡片颜色白天米白色也不对」。这四页
 * （归档 / 说说 / 分类 / 关于）的容器底一直是 --container-background-color
 * （60% 白 / 60% 黑，压在 .frontRoot 那条老渐变上 ⇒ 白天叠成一片近白、夜间叠成
 * 一块 rgb(74,74,74) 的平灰），而首页首屏、登录页、文章页用的是 --washi-theme-bg
 * 那张粉紫天青的纸。修法与文章页 20261008 那次同源（见 ReadArticle/index.sass 头注）：
 * 四页容器底改走 --washi-page-bg（日 = var(--washi-theme-bg)、夜 = 墨紫近黑那一支，
 * 两档成对写在 src/index.css —— 夜里漏写就会"白天的粉紫纸配夜间的白字"，所以这一节
 * **专门判夜间臂在场**）。
 *
 * 这一节的量法与前面有一处不同：判的是 **background-image** 而不是 background-color
 * ——令牌值是 linear-gradient(...)，落到计算样式里只有 backgroundImage 有值。
 * backgroundColor **也判**（判它是不是 transparent）：那正是"底被换掉了"而不是
 * "又叠了一层半透明白"的证据，而这四页原来的毛病就在"叠加"。
 *
 * 第四节量的是**首页轮播的「当前圆点」** —— 同一批里最后一处写死的强调色
 * （#7880d1，与说说那个圆点同一个色值）。首页挂不起来（import 了 mp4/jpg，还拉进画布
 * 组件），所以取本仓对首页既有套件的老办法：**真 sass + 同形标记**、单独一份 dots.html
 * （不与那三个真页面共用一份 style —— 它们有 .post-date 这类同名选择器，串在一起会互相压）。
 */

const DEFINE_ENV =
  '{"VITE_HTTP_BASEURL":"","VITE_CDN_BASEURL":"","MODE":"production","DEV":false,"PROD":true,"BASE_URL":"/"}';

// vite.config.ts 的 define 那五项（站名/描述/作者/关键词/URL）。少一个就是
// `__SITE_TITLE__ is not defined` 的**载入期**异常：整个 bundle 停在那一句、
// window.__mount 根本没挂上，而报错信息里看不出跟本套件要判的东西有任何关系。
const SITE_DEFINES: Record<string, string> = {
  __SITE_URL__: '"https://example.invalid"',
  __SITE_AUTHOR__: '"探针"',
  __SITE_TITLE__: '"探针"',
  __SITE_DESCRIPTION__: '"探针"',
  __SITE_KEYWORDS__: '"探针"',
};

// 假后端：三个页面各要一份列表，字段取并集（归档要 noteTitle/createTime/noteKey，
// 说说要 talkKey/talkTitle/nickname/content/createTime，分类要 noteTitle/description/
// updateTime/isTop/cover）。`isTop: 1` 是**刻意**的 —— 分类页那颗置顶图钉只在置顶行渲染，
// 不给它就等于那一处配色（原来是写死的 red）没有判据。
const FAKE_AXIOS = `localStorage.setItem('tokenKey', 'x.y.z');
const ROWS = [
  { noteKey: 11, noteTitle: '第一篇文章', createTime: '2026-08-01 10:00:00',
    updateTime: '2026-08-01 10:00:00', description: '简介', contents: '正文', cover: '',
    status: 'public', categories: '编程', tags: 'React', readCount: 3, starCount: 1, isTop: 1,
    talkKey: 21, talkTitle: '第一条说说', nickname: '阿岚', avatar: '', content: '说说正文' },
  { noteKey: 12, noteTitle: '第二篇文章', createTime: '2026-08-02 10:00:00',
    updateTime: '2026-08-02 10:00:00', description: '简介', contents: '正文', cover: '',
    status: 'public', categories: '编程', tags: 'Asyncio', readCount: 4, starCount: 2, isTop: 0,
    talkKey: 22, talkTitle: '第二条说说', nickname: '阿岚', avatar: '', content: '说说正文' },
];
const env = (data: any) => ({ status: 200, data: { code: 200, message: 'ok', data } });
const http = async (cfg: any) => env(ROWS);   // 三个页面的读接口一律给这一份
export default http;
`;

const STUB_REDUX = `const state: any = {
  categories: { categories: [{ categoryKey: 2, categoryTitle: '编程', pathName: 'code', color: 'blue', icon: 'icon-bianji2' }] },
  tags: { tag: [] },
  note: { noteList: [] },
  user: { avatar: '', name: '管理员' },
};
export const useSelector = (fn: any) => fn(state);
export const useDispatch = () => (_a: any) => undefined;
export const Provider = ({ children }: any) => children;
export const connect = () => (C: any) => C;
`;

const STUB_RUNTIME_API = `export const runtimeBaseURL = '';
export const cdnBaseURL = '';
export const resolveApiAssetUrl = (url?: string) => (url || '');
`;

const ENTRY = `import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { HelmetProvider } from 'react-helmet-async';
import Times from './src/frontHome/Content/Times/index.tsx';
import Talk from './src/frontHome/Content/Talk/index.tsx';
import Categories from './src/frontHome/Content/Categories/index.tsx';
import AboutMe from './src/frontHome/Content/AboutMe/index.tsx';

const PAGES: any = { Times, Talk, Categories, AboutMe };
// 每页各自的初始地址 —— MemoryRouter 认的是**路径**，四个页面挂在同一套路由上时
// 只有第一条能匹配，另两个渲染成空（症状是 g(...) 读到 null 而不是判红，很难查）。
const AT: any = { Times: '/times', Talk: '/talk', Categories: '/categories/code', AboutMe: '/about' };
// 前台根节点的类名照抄 App.tsx：夜里是 frontDark frontRoot。令牌的夜间定义挂在
// .frontDark 上（index.css），不按这个类名挂就量不到夜间档 —— 整节会"全绿地空转"。
(window as any).__mount = (name: string, dark: boolean) => {
  const C = PAGES[name];
  createRoot(document.getElementById('root')!).render(
    <HelmetProvider>
      <div className={dark ? 'frontDark frontRoot' : 'frontRoot'}>
        <MemoryRouter initialEntries={[AT[name]]}>
          <Routes>
            <Route path="/times" element={<Times />} />
            <Route path="/talk" element={<Talk />} />
            <Route path="/categories/:id" element={<Categories />} />
            <Route path="/about" element={<AboutMe />} />
          </Routes>
        </MemoryRouter>
      </div>
    </HelmetProvider>
  );
};
`;

// 沙箱根 tsconfig：esbuild 的 paths 解析（替代原 CLI --alias，本套件只桩 redux）。
const TSCONFIG_PATHS = JSON.stringify({
  compilerOptions: {
    paths: {
      "react-redux": ["./stub-redux.tsx"],
    },
  },
});

// 量取脚本。expected() 是这套判据的关键：它把 var(--token) **在同一个级联里**渲染成
// 一个真实的计算色（挂进 .frontRoot，才拿得到夜间档），于是期望值与实测值同源同格式。
const MEASURE = ([name]: [string, boolean]) => {
  const host = document.querySelector(".frontRoot")!;
  const expected = (tok: string) => {
    const d = document.createElement("div");
    d.style.color = "var(" + tok + ")";
    host.appendChild(d);
    const c = getComputedStyle(d).color;
    d.remove();
    return c;
  };
  // 令牌值是整条 linear-gradient(...)，只有 background-image 接得住它（见文件头第五节）。
  const expectedImg = (tok: string) => {
    const d = document.createElement("div");
    d.style.backgroundImage = "var(" + tok + ")";
    host.appendChild(d);
    const c = getComputedStyle(d).backgroundImage;
    d.remove();
    return c;
  };
  const g = (sel: string, pseudo?: string) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const cs = getComputedStyle(el, pseudo || undefined);
    return { bg: cs.backgroundColor, color: cs.color, bl: cs.borderLeftColor };
  };
  const rootCs = getComputedStyle(host);
  // 元素缺席时给 null 而不是抛异常：**缺席本身就是一条判据**（下面第一节会判"都在场"），
  // 让它以"取不到值"的形式走到断言里，报出来的是"这一处没渲染"，而不是一条 TypeError。
  const pick = (sel: string, field: "bg" | "color" | "bl", pseudo?: string) => {
    const x = g(sel, pseudo);
    return x ? x[field] : null;
  };
  // 整页底的落点就是各页自己的那个容器。**别按页名拼类名**——关于页的组件叫 AboutMe、
  // 容器却叫 .AboutContainer（第一版就是这么写的，量到 null，四页里那一页全红）。
  const SEL: Record<string, string> = {
    Times: ".TimesContainer",
    Talk: ".TalkContainer",
    Categories: ".CategoriesContainer",
    AboutMe: ".AboutContainer",
  };
  const page = document.querySelector(SEL[name] || "." + name + "Container");
  const pageCs = page ? getComputedStyle(page) : null;
  return {
    got: {
      pageBg: pageCs ? pageCs.backgroundImage : null,
      pageBgColor: pageCs ? pageCs.backgroundColor : null,
      hrBg: pick(".TimesContainer hr", "bg"),
      tailBl: pick(".TimesContainer .ant-timeline-item-tail", "bl"),
      headColor: pick(".TimesContainer .ant-timeline-item-head", "color"),
      headBg: pick(".TimesContainer .ant-timeline-item-head", "bg"),
      talkCardBg: pick(".TalkContainer .talk", "bg"),
      talkLineBl: pick(".TalkContainer .talk", "bl", "::before"),
      talkDotBg: pick(".TalkContainer .talk", "bg", "::after"),
      catDateColor: pick(".CategoriesContainer .articleFooter .post-date", "color"),
      catMoreColor: pick(
        ".CategoriesContainer .articleFooter > span:last-child",
        "color",
      ),
      catTopColor: pick(".CategoriesContainer .icon-tuding", "color"),
    },
    want: {
      pinkDeep: expected("--washi-pink-deep"),
      line: expected("--washi-line"),
      paper: expected("--washi-paper"),
      paper2: expected("--washi-paper-2"),
      pageBg: expectedImg("--washi-page-bg"),
      // 反控用的旧值：这四页原来挂的就是它（main.css 里的半透明白/黑渐变）。
      // 它也是**渐变**，所以能跟上面那条同格式比对——"换成主题纸"与"还挂着旧的"
      // 在这条上是两个不同的字符串（旧的代码跑本套件，这条必红）。
      legacyPg: expectedImg("--container-background-color"),
      fontP: expected("--font-p-color"),
      transparent: "rgba(0, 0, 0, 0)",
    },
    // 撤掉的令牌不该还留在计算样式里（它是"零消费点"才被删的，回来就意味着有人在 main.css
    // 里又加了一条，而那条不会有任何消费方 ⇒ 又是一份"写了没人用"的配置）
    retired: rootCs.getPropertyValue("--category-hover-color").trim(),
    counts: {
      page: page ? 1 : 0,
      timeline: document.querySelectorAll(".TimesContainer .ant-timeline-item").length,
      talk: document.querySelectorAll(".TalkContainer .talk").length,
      footer: document.querySelectorAll(".CategoriesContainer .articleFooter").length,
      top: document.querySelectorAll(".CategoriesContainer .icon-tuding").length,
    },
  };
};

interface Reading {
  got: Record<string, string | null>;
  want: Record<string, string>;
  retired: string;
  counts: Record<string, number>;
}

// 每一行 = 一条断言：页/档 → 取值路径、期望的令牌、人话。
// pinkDeep 那几处是"强调色"、line 是"线"、paper 是"面"、fontP 是"次要文字"。
const CASES: Array<[string, string, string, string]> = [
  // 整页底（第五节）：四页 × 两档。期望值 = 现场解析出来的 --washi-page-bg，
  // 于是"日间臂是不是主题纸、夜间臂在不在"这两件事都在这一条里判掉了。
  ["Times/day", "pageBg", "pageBg", "归档页整页底走 --washi-page-bg（白天 = 主题纸）"],
  ["Times/night", "pageBg", "pageBg", "归档页整页底走 --washi-page-bg（夜 = 墨紫近黑）"],
  ["Talk/day", "pageBg", "pageBg", "说说页整页底走 --washi-page-bg（白天 = 主题纸）"],
  ["Talk/night", "pageBg", "pageBg", "说说页整页底走 --washi-page-bg（夜 = 墨紫近黑）"],
  ["Categories/day", "pageBg", "pageBg", "分类页整页底走 --washi-page-bg（白天 = 主题纸）"],
  ["Categories/night", "pageBg", "pageBg", "分类页整页底走 --washi-page-bg（夜 = 墨紫近黑）"],
  ["AboutMe/day", "pageBg", "pageBg", "关于页整页底走 --washi-page-bg（白天 = 主题纸）"],
  ["AboutMe/night", "pageBg", "pageBg", "关于页整页底走 --washi-page-bg（夜 = 墨紫近黑）"],
  ["Times/day", "hrBg", "pinkDeep", "归档页分隔线走 --washi-pink-deep"],
  ["Times/night", "hrBg", "pinkDeep", "归档页分隔线走 --washi-pink-deep（夜）"],
  ["Times/day", "tailBl", "line", "归档页时间轴竖线走 --washi-line（白天可见）"],
  ["Times/night", "tailBl", "line", "归档页时间轴竖线走 --washi-line（夜）"],
  ["Times/day", "headColor", "pinkDeep", "归档页时间轴圆点走 --washi-pink-deep"],
  ["Times/night", "headColor", "pinkDeep", "归档页时间轴圆点走 --washi-pink-deep（夜）"],
  ["Times/day", "headBg", "transparent", "归档页时间轴圆点是空心的（原意就是 transparent）"],
  ["Times/night", "headBg", "transparent", "归档页时间轴圆点是空心的（夜）"],
  ["Talk/day", "talkCardBg", "paper2", "说说卡片走 --washi-paper-2（与首页文章卡片同源）"],
  ["Talk/night", "talkCardBg", "paper2", "说说卡片走 --washi-paper-2（夜）"],
  ["Talk/day", "talkLineBl", "line", "说说的日期链条竖线走 --washi-line"],
  ["Talk/night", "talkLineBl", "line", "说说的日期链条竖线走 --washi-line（夜）"],
  ["Talk/day", "talkDotBg", "pinkDeep", "说说的日期链条圆点走 --washi-pink-deep"],
  ["Talk/night", "talkDotBg", "pinkDeep", "说说的日期链条圆点走 --washi-pink-deep（夜）"],
  ["Categories/day", "catDateColor", "fontP", "分类页「发布于」走 --font-p-color"],
  ["Categories/night", "catDateColor", "fontP", "分类页「发布于」走 --font-p-color（夜）"],
  ["Categories/day", "catMoreColor", "pinkDeep", "分类页「阅读全文→」走 --washi-pink-deep"],
  ["Categories/night", "catMoreColor", "pinkDeep", "分类页「阅读全文→」走 --washi-pink-deep（夜）"],
  ["Categories/day", "catTopColor", "pinkDeep", "分类页置顶图钉走 --washi-pink-deep"],
  ["Categories/night", "catTopColor", "pinkDeep", "分类页置顶图钉走 --washi-pink-deep（夜）"],
];

/** 把 rgb(a, b, c) / rgba(a, b, c, d) 归一成 (r,g,b,a)。
 * **不写字面量比对**：同一个颜色浏览器可能回 rgba(0,0,0,0) 也可能回 transparent，
 * 而令牌那边给的是 hex/rgba() 原文 —— 只在数值上调，格式差异不该判红。 */
function norm(c: string | null): [number, number, number, number] | null {
  if (c === null) return null;
  const s = c.trim();
  if (s === "transparent") return [0, 0, 0, 0];
  if (s === "") return null;
  const n = (s.match(/[\d.]+/g) ?? []).map(Number);
  if (n.length < 3) return null;
  return [n[0], n[1], n[2], n.length >= 4 ? n[3] : 1];
}

function near(a: string | null, b: string | null, tol = 1): boolean {
  // null（元素缺席 / 值读不出来）**必须判红**，不能落进 norm 的空值分支变成
  // "transparent == transparent"。这条实测踩到过：路由没配好时三个页面里只有一页
  // 渲染出来，另外两页的每一条断言都在拿 None 跟自己比 —— 看着全绿，其实什么都没判。
  if (a === null || b === null) return false;
  const pa = norm(a);
  const pb = norm(b);
  if (!pa || !pb) return false;
  return pa.every((x, i) => Math.abs(x - pb[i]) <= tol);
}

// 页面 → 它的列表容器类名。与 entry.tsx 的 PAGES 一一对应，**不能按页名拼**：
// 关于页的组件叫 AboutMe，容器是 .AboutContainer（见 MEASURE 里同一处的注释）。
const CONT: Record<string, string> = {
  Times: ".TimesContainer",
  Talk: ".TalkContainer",
  Categories: ".CategoriesContainer",
  AboutMe: ".AboutContainer",
};

test.describe("前台内容页和纸配色", () => {
  test.setTimeout(180_000);

  test("四页两档令牌配色 + 轮播圆点 + 整页底控制", async ({ browser }) => {
    // 真 sass：四页 + 首页轮播那份 dots（style: expanded 与原版一致）。
    const pages = ["Times", "Talk", "Categories", "AboutMe"];
    const cssParts = [
      readFileSync(path.join(FE_DIR, "src/index.css"), "utf-8"),
      readFileSync(path.join(FE_DIR, "src/frontHome/main.css"), "utf-8"),
    ];
    for (const name of pages) {
      cssParts.push(
        compileSass(
          path.join(FE_DIR, `src/frontHome/Content/${name}/index.sass`),
        ),
      );
    }
    const dotsCss = compileSass(
      path.join(FE_DIR, "src/frontHome/Content/ContentHome/index.sass"),
    );

    await withSandbox(
      {
        "index.html":
          '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">' +
          '<link rel="stylesheet" href="/fonts/font_4335817_6gqxzh34cy.css">' +
          '<link rel="stylesheet" href="/fonts/font_4466999_8sifudyyiw.css">' +
          // 页面底色给个中性浅灰：判的是元素自身的色，底色只影响观感，但留白方便人肉排障
          '<style>html,body,#root{margin:0;min-height:100%}body{background:#f3f3f3}</style>' +
          `<style>${cssParts.join("\n")}</style></head><body>` +
          '<div id="root"></div><script src="bundle.js"></script></body></html>',
        // 同形标记：轮播那颗「当前」圆点。.topDotsContainer 才是标记里真渲染的那层（另一份
        // .TopCover .topDots 在标记里没有对应物，是死规则，本套件不判它）。
        "dots.html":
          '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">' +
          '<style>html,body,#root{margin:0;min-height:100%}body{background:#f3f3f3}</style>' +
          `<style>${[...cssParts, dotsCss].join("\n")}</style></head><body>` +
          '<div class="frontRoot">' +
          '  <div class="ContentContainer"><div class="TopArticle">' +
          '    <div class="topDotsContainer">' +
          '      <div class="topDot"></div><div class="topDot dotCurrent" id="cur"></div>' +
          "    </div>" +
          "  </div></div>" +
          "</div></body></html>",
      },
      async (sb) => {
        // 真的 iconfont：分类页那三处的颜色长在 .iconfont 的 ::before 字形上，
        // 挂不上字体就只是一个空盒子（本套件判色，但空盒子的布局与真页面不同，别给自己留第二种差异）
        await cp(path.join(FE_DIR, "public/fonts"), path.join(sb.dir, "fonts"), {
          recursive: true,
        });

        await esbuildInSandbox(sb, {
          entry: "entry.tsx",
          files: {
            "entry.tsx": ENTRY,
            "stub-redux.tsx": STUB_REDUX,
            "src/apis/axios.tsx": FAKE_AXIOS,
            "src/utils/runtimeApi.ts": STUB_RUNTIME_API,
            "tsconfig.json": TSCONFIG_PATHS,
          },
          copySrc: true,
          define: { "import.meta.env": DEFINE_ENV, ...SITE_DEFINES },
          loaders: { ".sass": "text" },
        });

        // ── 【一】四个内容页的配色走和纸令牌（day + night 各量一遍）──
        const readings: Record<string, Reading> = {};
        const errsBy: Record<string, string[]> = {};
        for (const name of pages) {
          for (const dark of [false, true]) {
            const key = `${name}/${dark ? "night" : "day"}`;
            const ctx = await browser.newContext({
              viewport: { width: 1280, height: 900 },
            });
            const page = await ctx.newPage();
            const errs = collectPageErrors(page);
            await page.goto(sb.url);
            await page.evaluate(([n, d]) => (window as any).__mount(n, d), [
              name,
              dark,
            ] as [string, boolean]);
            await page.waitForSelector(CONT[name], { timeout: 10_000 }).catch(() => {});
            await page.waitForTimeout(600);
            readings[key] = (await page.evaluate(MEASURE, [name, dark] as [string, boolean])) as unknown as Reading;
            errsBy[key] = errs();
            await ctx.close();
          }
        }

        // 先把"环境是活的"钉住：三个页面都真渲染出了东西、且没有页面异常。
        // 少了这一段，**空页面在"两档读数相同"这条上也是绿的**（都读到默认值），整套会静默空转。
        for (const [key, m] of Object.entries(readings)) {
          const c = m.counts;
          expect(
            Math.max(c.page, c.timeline, c.talk, c.footer) > 0,
            `${key}：页面真渲染出来了（列表容器/时间轴/说说/列表至少有一处）→ ${JSON.stringify(c)}`,
          ).toBe(true);
          expect(errsBy[key], `${key}：无页面异常`).toEqual([]);
        }
        for (const key of ["Times/day", "Talk/day", "Categories/day", "AboutMe/day"]) {
          const c = readings[key].counts;
          expect(
            c.page > 0 &&
              (key !== "Talk/day" || c.talk > 0) &&
              (key !== "Categories/day" || (c.footer > 0 && c.top > 0)),
            `${key}：要判的那几处**都在场**（缺席的话对应断言无从谈起）→ ${JSON.stringify(c)}`,
          ).toBe(true);
        }

        // 自证：白天与夜间的读数必须**真的不同**。这条是整份判据的地基 ——
        // 写死色值的直接症状就是两档同值；反过来，若令牌没被解析（环境坏了），两档也会同值。
        // 无论哪种情形，下面那些"等于令牌"的断言都会失去意义，所以先把它判在前面。
        for (const [name, prop] of [
          ["Times", "hrBg"],
          ["Times", "tailBl"],
          ["Talk", "talkCardBg"],
          ["Talk", "talkDotBg"],
          ["Categories", "catDateColor"],
          ["Categories", "catMoreColor"],
        ] as const) {
          const d = readings[`${name}/day`].got[prop];
          const n = readings[`${name}/night`].got[prop];
          expect(
            JSON.stringify(norm(d)) !== JSON.stringify(norm(n)),
            `${name} 的 ${prop}：白天与夜间不是同一个值（写死色值的直接症状就是两档同值）→ day=${d} night=${n}`,
          ).toBe(true);
        }

        // ── 【二】逐处等于它该跟的那个令牌 ──
        for (const [key, prop, tok, desc] of CASES) {
          const m = readings[key];
          const got = m.got[prop];
          const want = m.want[tok];
          expect(near(got, want), `${desc} → ${got} vs ${want}`).toBe(true);
        }

        // ── 【三】撤掉的令牌保持撤掉 ──
        expect(
          readings["Categories/day"].retired,
          "--category-hover-color 已从计算样式里消失（它是零消费点才被撤的）",
        ).toBe("");

        // ── 【四】首页轮播的「当前圆点」（同批最后一处写死的强调色）──
        // 用户原话里的「等等」覆盖到了这里：.dotCurrent 写死 #7880d1（蓝紫）——**与说说那个
        // 圆点同一个色值**，也是深浅两档同一个颜色，而站里的强调色是 --washi-pink-deep。
        // 未选中那颗仍是白的（压在封面图上，白色才读得出），**不跟着改** —— 那条也判，免得日后
        // 有人"顺手统一"把两颗都染成粉的。
        const DOTS = () => {
          const host = document.querySelector(".frontRoot")!;
          const expected = (tok: string) => {
            const d = document.createElement("div");
            d.style.color = "var(" + tok + ")";
            host.appendChild(d);
            const c = getComputedStyle(d).color;
            d.remove();
            return c;
          };
          const cur = document.querySelector(".topDotsContainer .dotCurrent");
          const idle = document.querySelector(
            ".topDotsContainer .topDot:not(.dotCurrent)",
          );
          return {
            count: document.querySelectorAll(".topDotsContainer .topDot").length,
            cur: cur ? getComputedStyle(cur).backgroundColor : null,
            idle: idle ? getComputedStyle(idle).backgroundColor : null,
            want: expected("--washi-pink-deep"),
          };
        };
        const dots: Record<string, Awaited<ReturnType<typeof readDots>>> = {};
        async function readDots(dark: boolean): Promise<{
          count: number;
          cur: string | null;
          idle: string | null;
          want: string;
          errs: string[];
        }> {
          const ctx = await browser.newContext({
            viewport: { width: 1280, height: 900 },
          });
          const page = await ctx.newPage();
          const errs = collectPageErrors(page);
          await page.goto(new URL("dots.html", sb.url).toString());
          await page.evaluate(
            (d) =>
              document
                .querySelector(".frontRoot")!
                .classList.toggle("frontDark", d),
            dark,
          );
          await page.waitForTimeout(150);
          const r = {
            ...((await page.evaluate(DOTS)) as {
              count: number;
              cur: string | null;
              idle: string | null;
              want: string;
            }),
            errs: errs(),
          };
          await ctx.close();
          return r;
        }
        dots.day = await readDots(false);
        dots.night = await readDots(true);

        for (const key of ["day", "night"] as const) {
          const d = dots[key];
          expect(d.count, `${key}：轮播圆点渲染出来了（两颗：白点 + 当前点）`).toBe(2);
          expect(d.errs, `${key}：无页面异常`).toEqual([]);
          expect(
            near(d.cur, d.want),
            `${key}：当前圆点走 --washi-pink-deep → ${d.cur} vs ${d.want}`,
          ).toBe(true);
          // 反控：未选中那颗必须还是白的（background: white）。这条防的是"把两颗一起染粉"
          // ——那也能让上面两条变绿，但圆点在封面图上就分不出"当前"了。
          expect(
            JSON.stringify(norm(d.idle)),
            `${key}：未选中的圆点仍是白的（没被一起染成强调色）`,
          ).toBe(JSON.stringify([255, 255, 255, 1]));
        }
        // 与一·自证同一条理由：写死色值的直接症状就是两档同值。
        expect(
          JSON.stringify(norm(dots.day.cur)) !== JSON.stringify(norm(dots.night.cur)),
          "当前圆点：白天与夜间不是同一个值（写死的直接症状就是两档同值）",
        ).toBe(true);

        // ── 【五】内容页的整页底：两档成对、是换掉不是叠加 ──
        // 【二】已经钉住"这四页的底**等于**那支令牌"；三条控制各自堵一个具体的坏法：
        //   ① 白天与夜间不同 → 堵"夜间臂漏写"（漏了就是白天档继承下去，两档同值）。
        //      这条不是形式主义：--washi-theme-bg 那支**刻意只有白天档**，本支是它的
        //      成对版本，两者挨着放，下一个人很容易把夜间那行删掉"去掉重复"。
        //   ② background-color 是 transparent → 堵"又叠了一层"：原来那套毛病就是
        //      半透明白压在别处底色上叠出来的（白天近白、夜间平灰），叠加式修法同样能让
        //      ① 变绿而用户看到的还是一层灰。
        //   ③ 两档都真的挂上了图 → 堵"令牌解析不出来"（那种情形下 ①② 都可能空转绿）。
        for (const name of pages) {
          const dday = readings[`${name}/day`].got;
          const dnight = readings[`${name}/night`].got;
          expect(
            !!dday.pageBg && !!dnight.pageBg && dday.pageBg !== dnight.pageBg,
            `${name}：整页底白天与夜间不是同一张纸（堵夜间臂漏写）→ day=${dday.pageBg} night=${dnight.pageBg}`,
          ).toBe(true);
          for (const [arm, got] of [
            ["day", dday],
            ["night", dnight],
          ] as const) {
            expect(
              JSON.stringify(norm(got.pageBgColor)),
              `${name}/${arm}：整页底是 background-image（shorthand 把 background-color 重置成 transparent —— 不是又叠了一层半透明白）`,
            ).toBe(JSON.stringify([0, 0, 0, 0]));
            expect(
              (got.pageBg ?? "").trim() !== "" && (got.pageBg ?? "").trim() !== "none",
              `${name}/${arm}：整页底真的挂上了图（不是 none —— 否则上面的断言可能在空转）`,
            ).toBe(true);
          }
          // ④ 反控：不能还是那支旧令牌的值。这条是"本套件在改动前不是绿的"的**直接证据**
          //    （旧代码下四页都挂在 --container-background-color 上，这里逐字相等 ⇒ 全红）。
          const legacy = readings[`${name}/day`].want.legacyPg;
          expect(
            !!dday.pageBg && dday.pageBg !== legacy,
            `${name}：整页底已经不是 --container-background-color 那条半透明渐变（反控）`,
          ).toBe(true);
        }
      },
    );
  });
});
