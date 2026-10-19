import { test, expect } from "@playwright/test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  FE_DIR,
  compileSass,
  withSandbox,
  collectPageErrors,
  esbuildInSandbox,
} from "./sandbox";

/**
 * 后台夜间模式：11 个页面逐个量"字色 vs 它真正的底色"的 WCAG 对比度。
 * （原 tests/dark-mode-contrast.test.py，20261019 迁移）
 *
 * 为什么值得单起一个脚本：20260923 后台在壳上接了 antd 的 `darkAlgorithm`（页面文字由
 * **黑色 token 翻成白色**），而组件里那些**写死的浅色底**（内联 style / 普通类）不跟着变
 * ——于是"白字压浅底"，实测 1.26:1，等同看不见。这类问题：
 *
 *   · 读代码看不出来 —— 谁压谁取决于层叠（内联 > 类规则 > antd 的 `:where()` token），
 *     而 `.contentDark` 那层底又是**不透明渐变**（computed backgroundColor 恒透明），
 *     静态分析根本不知道它参与了合成；
 *   · lint / tsc / 单测全绿也照样漏；
 *   · 一个组件一个组件地"目视点过去"才是原来的做法，人一累就漏。
 *
 * 判据 = 每个文本元素与它**合成后**的底色对比度 ≥ 3:1（低于 3:1 谁都读不清）。
 * 排除两类 antd 刻意的低对比：占位符（`ant-select-selection-placeholder`）与禁用态。
 *
 * 已知项（会打出来但不判失败，见 KNOWN）**20261001 批 E 起为空**：
 *   · UserControl（站点设置）—— MUI 组件不吃 antd 深色 token。20261001 批 E 在
 *     `Dashboard/index.css` 里按 MUI 的语义类补了一层手账皮，已转绿、从 KNOWN 摘掉。
 *   · Analytics —— 20260930 报表重写时清掉（G2 主题那一项）。
 * 两页现在**都在判失败之列**：再变红就是真回归，别再往 KNOWN 里塞回去。
 *
 * 沿用 dashboard-sidebar.test.py 那套既定手段（本机不能 vite build，见 CLAUDE.md §2）：
 * esbuild 把**真组件**打成一个 bundle、只桩边界（axios / react-redux / react-router-dom），
 * antd / react / react-dom 全用真的；CSS = 仓库里那 11 份真 `.css` verbatim 拼接 + 真编译的 sass。
 */

const DEFINE_ENV =
  '{"VITE_HTTP_BASEURL":"","VITE_CDN_BASEURL":"","MODE":"production","DEV":false,"PROD":true,"BASE_URL":"/"}';

// 侧栏能到达的后台页面（= src/router/index.tsx 里 /dashboard 下的子路由）
const PAGES: Record<string, string> = {
  Home: "src/pages/Dashboard/Home/index.tsx",
  AllNotes: "src/pages/Dashboard/Notes/AllNotes/index.tsx",
  NewNotes: "src/pages/Dashboard/Notes/NewNotes/index.tsx",
  AllCategorize: "src/pages/Dashboard/Notes/AllCategorize/index.tsx",
  AllTag: "src/pages/Dashboard/Notes/AllTag/index.tsx",
  Talks: "src/pages/Dashboard/Talks/index.tsx",
  Albums: "src/pages/Dashboard/Albums/index.tsx",
  Users: "src/pages/Dashboard/Users/index.tsx",
  Analytics: "src/pages/Dashboard/Analytics/index.tsx",
  UserControl: "src/pages/Dashboard/UserControl/index.tsx",
  Announcement: "src/pages/Dashboard/Announcement/index.tsx",
};

// 建这个探针时就已经存在、本轮不修的一项。列在这里是为了"探针别哑掉"——
// 它仍然会被打印出来，但不算失败；**任何别的页面**出现不可读文字一律判失败。
//
// Analytics（文章数据报表）**已于 20260930 摘掉**，两条原因都清了：
//   · 图表主题 —— 重写时从 `useIsDarkMode()` 显式传 `theme: {type:'classicDark'}`；
//   · ExpressionError —— 那个是**假后端喂空数组**喂出来的（这一页的读数全在一个对象里，
//     空数组等于整页只剩标题），stub 现在按 URL 给一份真实形状的报表（见 FAKE_AXIOS）。
//     **前提由此变了**：这一页能进普查，靠的是 stub 里有数据，改 stub 时别把它改回去。
// ⚠️ 本探针扫的是 DOM 文本，**G2 画在 canvas 上的字它看不见**（坐标轴、图例、tooltip）。
//    也就是说"图表内部在深色底上读不读得清"仍然没有判据，那部分只能人眼看——
//    不要因为这一行是绿的，就以为整页的配色都被守住了。
// 20261001 批 E 起**空**：原本唯一的一条是 UserControl（站点设置页是 MUI 写的，
// MUI 不吃 antd 的 darkAlgorithm ⇒ 深色页上 label 是纯黑 1.29:1）。那一批把
// `Dashboard/index.css` 的 ⑧⑨ 两节按 MUI 的语义类重写了一层（Fab / Button /
// InputLabel / OutlinedInput 描边），对比度回到 3:1 以上，这条已知项随之摘掉。
// ⚠️ 摘得掉是因为它真绿了，不是因为"看腻了"——下次要再往里塞，先确认那一页本地跑不绿。
const KNOWN: Record<string, string> = {};

// 边界①：假后端。返回的列表必须是**空数组**而不是 null —— 后台好几个组件拿到列表直接
// `.map()`，null 会让那棵子树整个抛异常 ⇒ 少渲染一块 ⇒ 普查"没扫全"，读数不可信。
//
// 唯一的例外是文章数据报表（20260930）：它整页的读数都在一个**对象**里，喂空数组等于
// 只渲染出标题栏 ⇒ 探针扫不到"卡片上的数字、图例在深色底上读不读得清"，那是假绿。
// 给一份最小可信样本（两行排行 + 后端那样补过零的 30 天），图表也就真被渲染出来了。
const FAKE_AXIOS = `const REPORT = {
  generatedAt: '2026-09-30 12:00:00',
  totalViews: 192,
  totalLikes: 12,
  topViewed: [
    { noteId: 1, title: '一篇标题长得足以触发截断的架构文章', views: 128, likes: 9 },
    { noteId: 2, title: '短标题', views: 64, likes: 3 },
  ],
  topLiked: [
    { noteId: 2, title: '短标题', views: 64, likes: 3 },
    { noteId: 1, title: '一篇标题长得足以触发截断的架构文章', views: 128, likes: 9 },
  ],
  daily: Array.from({ length: 30 }, (_, i) => ({
    date: '2026-09-' + String(i + 1).padStart(2, '0'), views: i * 3, likes: i,
  })),
};
// ⚠️ 桩的**形状**：必须同时是"可调用函数"和"带方法的对象"——真 \`axios.create()\`
// 实例两者都是，而这一页族两种写法都在用：
//   · \`apis/ProfileMethods.tsx\`（个人中心那一族）写 \`http({url, method})\`；
//   · 账号/留言/评论/额度四个页签写 \`http.get(...)\` / \`http.post(...)\`。
// 只做裸函数 ⇒ 方法形态是 \`TypeError: http.get is not a function\`，而组件里的
// try/catch 会把它吃掉 ⇒ **整页只剩空壳**，那条错只出现在 pageerror 里。20261003
// 的夜间沙箱正是这么红的：Users 页报"文本元素 0 / 页面异常 16"（16 条都是同一条
// TypeError），看着完全不像配色问题，而本探针判失败的正是"这一页扫不到字"。
// 同族的坑与两个方向的判据见 \`tests/users-page.test.py\` 里那段同源注释。
const ok = (d: any) => ({ status: 200, data: d });
const http: any = (cfg: any = {}) => {
  const url: string = (cfg && cfg.url) || '';
  if (url.indexOf('/stats/notes') >= 0) {
    return Promise.resolve(ok({ code: 200, data: REPORT }));
  }
  // \`/api/temp-users\` 回的是**裸数组**（不是 {code,message,data} 那层壳，见
  // \`Users/tempUsers.ts\` 的 TempUser 注释）——多套一层壳会让账号列表整块不渲染。
  if (url.indexOf('/api/temp-users') === 0) {
    return Promise.resolve(ok([]));
  }
  return Promise.resolve(ok({ code: 200, data: [] }));
};
// 方法形态（axios 实例上的 .get/.post/.put/.delete）。\`data\` 只在带 body 的动词上给，
// GET 的第二个参数是 config（\`{params}\` 那一类）——接错位置会把 config 当 body 发出去。
const asMethod = (method: string) => (url: string, a?: any, b?: any) =>
  http(method === 'GET' ? { url, method, ...(a || {}) }
                        : { url, method, data: a, ...(b || {}) });
http.get = asMethod('GET');
http.post = asMethod('POST');
http.put = asMethod('PUT');
http.delete = asMethod('DELETE');
export default http;
`;

// 边界②：路由。Outlet 渲染 URL 上 ?page= 指定的那一个后台页面；其余导出是给
// react-router-dom 的 import 兜底（缺一个 esbuild 就直接打包失败）。
const STUB_ROUTER = `import * as React from 'react';
import * as REG from './page-registry.tsx';
export const useNavigate = () => (to: string, opts?: any) => {
  const w = window as any;
  w.__nav = (w.__nav || []).concat([{ to, opts }]);
};
export const Outlet = () => {
  const name = new URLSearchParams(location.search).get('page') || 'Home';
  const C = (REG as any).PAGES[name] || REG.PAGES.Home;
  return <C />;
};
export const Link = ({ children }: any) => children;
export const NavLink = ({ children }: any) => children;
export const Navigate = () => null;
export const Routes = () => null;
export const Route = () => null;
export const useOutlet = () => null;
export const useParams = () => ({ id: '1' });
export const useSearchParams = () => [new URLSearchParams(location.search), () => {}] as any;
export const useLocation = () => ({ pathname: location.pathname, hash: location.hash,
                                    search: location.search, state: null, key: 'k' });
`;

// 边界③：redux。**只桩"读"**——状态对象每次返回同一个实例（返回新对象会让 useSelector
// 判定"变了"而无限重渲染）。useDispatch 返回 no-op ⇒ 页面挂载时那几个 thunk 不发请求。
const STUB_REDUX = `const state: any = {
  categories: { categories: [], categoryCount: 0 },
  tags: { tags: [], tag: [], tagCount: 0 },
  note: { noteList: [], noteCount: 0, tagList: [] },
  notes: { noteList: [], noteCount: 0 },
  user: { avatar: '', name: '管理员', blogTitle: 'Saudade' },
};
export const useSelector = (fn: any) => fn(state);
export const useDispatch = () => (_action: any) => undefined;
export const Provider = ({ children }: any) => children;
export const connect = () => (C: any) => C;
`;

const ENTRY = `import * as React from 'react';
import { createRoot } from 'react-dom/client';
import Dashboard from './src/pages/Dashboard/index.tsx';
(window as any).__mount = () => createRoot(document.getElementById('root')!).render(<Dashboard />);
`;

// page-registry.tsx：11 个后台页面静态 import 进一个映射（Outlet 按 ?page= 取）。
const pageRegistry = (): string => {
  const lines = ["import * as React from 'react';"];
  Object.values(PAGES).forEach((rel, i) => {
    lines.push(`import * as P${i} from './${rel}';`);
  });
  lines.push("export const PAGES: Record<string, any> = {");
  Object.keys(PAGES).forEach((name, i) => {
    lines.push(`  ${name}: (P${i}.default || (P${i} as any)),`);
  });
  lines.push("};");
  return lines.join("\n") + "\n";
};

// 沙箱根 tsconfig：esbuild 的 paths 解析（替代原 CLI --alias）。
const TSCONFIG_PATHS = JSON.stringify({
  compilerOptions: {
    paths: {
      "react-router-dom": ["./stub-router.tsx"],
      "react-redux": ["./stub-redux.tsx"],
    },
  },
});

// node 无内置 glob：递归收集 src 下全部文件（供 vendor.css / pages.css 两份清单用）。
const walk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : [p];
  });
const relOf = (abs: string) =>
  path.relative(FE_DIR, abs).split(path.sep).join("/");

const SRC_FILES = walk(path.join(FE_DIR, "src"));

// esbuild 的 `.css=text` 把 CSS 吞成字符串、**不会注入页面**，所以每一份
// "从 TSX import 进来的 .css"都得自己链进去，否则那些按钮是**裸 UA 样式**：
// 实测后果是 `<button>` 拿到 Chrome 默认脸 rgb(239,239,239)，配白色字被算成
// 1.40:1 的"浅底浅字"——一条彻头彻尾的假警报，差点去改一个没问题的组件。
// 逐份 verbatim 拼接（不过 sass，避免动到语义），顺序按路径定死。
const vendorCss = (): string =>
  SRC_FILES.filter((p) => relOf(p).endsWith(".css"))
    .sort()
    .map((p) => `/* ==== ${relOf(p)} ==== */\n${readFileSync(p, "utf-8")}`)
    .join("\n");

// sass 必须真编译（esbuild 只把它当文本吞掉）。三组 pattern 的结果依次拼接、
// 组内按路径排死 —— 与原 Python 沙箱 glob 的顺序完全一致。
const pagesCss = (): string => {
  const rels = [
    ...SRC_FILES.filter(
      (p) => relOf(p).startsWith("src/pages/Dashboard/") && p.endsWith(".sass"),
    ).sort(),
    ...SRC_FILES.filter((p) =>
      /^src\/components\/[^/]+\/[^/]+\.sass$/.test(relOf(p)),
    ).sort(),
    ...SRC_FILES.filter(
      (p) => relOf(p).startsWith("src/frontHome/") && p.endsWith(".sass"),
    ).sort(),
  ];
  return rels.map((p) => compileSass(p)).join("\n") + "\n";
};

interface Rgb {
  r: number;
  g: number;
  b: number;
}
interface ChainColor extends Rgb {
  a: number;
}
interface CensusItem {
  tag: string;
  cls: string;
  txt: string;
  fg: ChainColor | null;
  chain: ChainColor[];
  tags: string[];
  size: number;
  html: string;
  // 这两类是 antd 刻意的低对比（占位符 / 禁用态），单独归类，不算缺陷
  ph: boolean;
  dis: boolean;
}

// 普查探针：页面上每个可见文本元素 → 它的字色 + 「真正压在它底下」的那条底色链。
const CENSUS = (): CensusItem[] => {
  const P = (c: string): ChainColor | null => {
    const m = (c || "").match(/[\d.]+/g);
    if (!m) return null;
    return {
      r: +m[0]!,
      g: +m[1]!,
      b: +m[2]!,
      a: m.length > 3 ? +m[3]! : 1,
    };
  };
  const leaf = (el: Element): string | null => {
    if (!(el.textContent || "").trim()) return null;
    for (const c of el.childNodes) {
      if (c.nodeType === 1 && (c.textContent || "").trim()) return null;
    }
    return el.textContent!.trim();
  };
  const out: CensusItem[] = [];
  for (const el of [
    ...document.querySelectorAll<HTMLElement>(
      "h1,h2,h3,h4,label,td,th,p,span,a,button,li",
    ),
  ]) {
    if (!el.offsetParent) continue;
    const t = leaf(el);
    if (!t) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === "hidden") continue;
    const chain: ChainColor[] = [];
    const tags: string[] = [];
    let invisible = false;
    for (let n: HTMLElement | null = el; n; n = n.parentElement) {
      // `opacity: 0` 的字**渲染不出来**，量它的对比度是纯噪声。
      // 只认 opacity 一条，不看 visibility —— 前者是"叠上去的不透明度"，
      // 祖先里任何一层归零都等于这行字没画（MUI 的 notched-outline 就是
      // `<legend><span>标签</span></legend>` 配 `opacity: 0`：那行字是给
      // 外框留缺口用的量尺，用户一个像素也看不到，却在普查里冒出来当"深底深字"）。
      if (parseFloat(getComputedStyle(n).opacity) === 0) invisible = true;
      const b = P(getComputedStyle(n).backgroundColor);
      if (b && b.a > 0.01) {
        chain.push(b);
        tags.push(
          n.className ? n.className.toString().slice(0, 40) : n.tagName,
        );
      }
      // 走到 `.content` 就停：它是内容区的底，再往上（body 的 --body-color #E4E9F7）在
      // 后台不参与合成 —— 后台命中的是 `.contentDark` 那条**不透明渐变**（computed 恒
      // 透明），它把 body 盖死了。继续往上走会把浅色 body 当底 ⇒ 深色页上每个元素都
      // 被算成"浅底"，读数全反。
      if (n.classList && n.classList.contains("content")) break;
      if (n.tagName === "HTML") break;
    }
    if (invisible) continue;
    chain.reverse();
    tags.reverse();
    out.push({
      tag: el.tagName,
      cls: (el.className || "").toString().slice(0, 40),
      txt: t.slice(0, 24),
      fg: P(cs.color),
      chain: chain,
      tags: tags,
      size: parseFloat(cs.fontSize),
      html: el.outerHTML.slice(0, 200),
      ph: el.classList.contains("ant-select-selection-placeholder"),
      dis: !!el.closest(
        "[disabled],.ant-btn-disabled,.ant-select-disabled,.ant-pagination-disabled",
      ),
    });
  }
  return out;
};

// 链上取不到实底时的兜底基色：深色内容区 = `.contentDark` 的
// radial-gradient(ellipse at top left, #373434 50%, #321e5d 100%)，取其中**更亮**的那端
// #373434（对浅色文字最不利）⇒ 算出来的比值偏保守，不会把真问题放过去。
const BASE_DARK: ChainColor = { r: 55, g: 52, b: 52, a: 1 };

// 只有符号/表情的文本（✨️ ❤️️ 🎯 这类装饰 span）不进统计：它们的底色是刻意的半透明色块，
// 算出来的 1.1:1 是噪声，会把真问题挤出榜单。
const HAS_WORD = /[0-9A-Za-z一-鿿]/;

// 与 Python 原版同构：over 只读 fg 的 alpha（bg 只用 rgb），合成结果不带 a ——
// 后续 ratio/mean 也只用 rgb，类型上用 Rgb 表达这层"读不到 a"的事实。
const over = (fg: ChainColor, bg: Rgb): Rgb => ({
  r: fg.r * fg.a + bg.r * (1 - fg.a),
  g: fg.g * fg.a + bg.g * (1 - fg.a),
  b: fg.b * fg.a + bg.b * (1 - fg.a),
});

const lin = (c: number): number => {
  const x = c / 255.0;
  return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
};

const lum = (c: Rgb): number =>
  0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);

const ratio = (fg: Rgb, bg: Rgb): number => {
  const l1 = lum(fg);
  const l2 = lum(bg);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
};

const mean = (c: Rgb): number => (c.r + c.g + c.b) / 3.0;

const composite = (chain: ChainColor[]): Rgb =>
  chain.reduce<Rgb>((bg, layer) => over(layer, bg), { ...BASE_DARK });

test.describe("后台夜间模式逐页对比度", () => {
  test.setTimeout(180_000);

  test("11 页普查 + Users 页 ?tab= 深链（15 条判据）", async ({ page }) => {
    const cssVendor = vendorCss();
    const cssPages = pagesCss();

    await withSandbox(
      {
        "index.html":
          '<!doctype html><html><head><meta charset="utf-8">' +
          '<link rel="stylesheet" href="vendor.css">' +
          '<link rel="stylesheet" href="pages.css"></head><body><div id="root"></div>' +
          '<script src="bundle.js"></script>' +
          "<script>window.__mount();</script>" +
          "</body></html>",
        "vendor.css": cssVendor,
        "pages.css": cssPages,
      },
      async (sb) => {
        await esbuildInSandbox(sb, {
          entry: "entry.tsx",
          files: {
            "entry.tsx": ENTRY,
            "stub-router.tsx": STUB_ROUTER,
            "stub-redux.tsx": STUB_REDUX,
            "page-registry.tsx": pageRegistry(),
            "src/apis/axios.tsx": FAKE_AXIOS,
            "tsconfig.json": TSCONFIG_PATHS,
          },
          copySrc: true,
          define: { "import.meta.env": DEFINE_ENV },
          loaders: {
            ".css": "text",
            ".sass": "text",
            ".scss": "text",
            // 全量页面会拖进 UploadButton 之类的图片资源；esbuild 默认没有
            // .png 的 loader，会直接判打包失败（dataurl 只为过编译，不参与判据）
            ".png": "dataurl",
            ".jpg": "dataurl",
            ".jpeg": "dataurl",
            ".gif": "dataurl",
            ".webp": "dataurl",
            ".svg": "dataurl",
          },
        });

        await page.setViewportSize({ width: 1440, height: 900 });
        await page.addInitScript(
          "localStorage.setItem('tokenKey','x.y.z');" +
            "localStorage.setItem('isDarkMode','true');" +
            "localStorage.setItem('announcement_seen_id','99999999');",
        );

        // ── 【一】11 页逐页普查：字色 vs 合成底色的 WCAG 对比度 ──
        const badPages: string[] = [];
        let totalRows = 0;
        let totalBad = 0;

        for (const name of Object.keys(PAGES)) {
          const errs = collectPageErrors(page);
          await page.goto(`${sb.url}?page=${name}`);
          await page.waitForTimeout(1800);
          const items = await page.evaluate(CENSUS);
          const rows: Array<{
            r: number;
            it: CensusItem;
            bg: Rgb;
            fg: Rgb;
          }> = [];
          for (const it of items) {
            if (!it.fg || !HAS_WORD.test(it.txt)) continue;
            const bg = composite(it.chain);
            const fg = over(it.fg, bg);
            rows.push({ r: ratio(fg, bg), it, bg, fg });
          }
          rows.sort((a, b) => a.r - b.r);
          // 判据 = 对比度 < 3:1（谁都读不清了）。比起"只看浅底浅字"，这条不会漏掉"深底深字"
          // ——浅色模式下写死的深色文字到了深色页面上就是黑压黑，与浅底浅字是同一个病、
          // 相反的方向。
          const bad = rows.filter(
            (row) => row.r < 3.0 && !row.it.ph && !row.it.dis,
          );
          totalRows += rows.length;
          totalBad += bad.length;
          const errsNow = errs();
          const ok =
            (bad.length === 0 && errsNow.length === 0) || name in KNOWN;
          if (!ok) badPages.push(name);
          const detail =
            bad
              .map((row) => {
                const tone =
                  mean(row.bg) > 150 && mean(row.fg) > 150
                    ? "浅底浅字"
                    : mean(row.bg) < 100 && mean(row.fg) < 100
                      ? "深底深字"
                      : "低对比";
                const chainTxt = row.it.tags
                  .map(
                    (t, i) =>
                      `${t} rgba(${row.it.chain[i]!.r.toFixed(0)},` +
                      `${row.it.chain[i]!.g.toFixed(0)},` +
                      `${row.it.chain[i]!.b.toFixed(0)},` +
                      `${row.it.chain[i]!.a.toFixed(2)})`,
                  )
                  .join(" → ");
                return (
                  ` ⚠️ ${row.r.toFixed(2)}:1 [${tone}] ${row.it.tag}.${row.it.cls.slice(0, 26)}` +
                  ` ${JSON.stringify(row.it.txt)} 字色 ${JSON.stringify(row.it.fg)}` +
                  ` 底链：${chainTxt}` +
                  ` DOM：${row.it.html.replace(/\n/g, " ")}`
                );
              })
              .join("") +
            (errsNow.length
              ? ` 首个异常：${errsNow[0]!.split("\n")[0]!.slice(0, 150)}`
              : "");
          expect
            .soft(
              ok,
              `${name} 页无不可读文字且无页面异常（文本元素 ${rows.length}，` +
                `低于 3:1 的 ${bad.length}` +
                (errsNow.length ? `，页面异常 ${errsNow.length}` : "") +
                `）${detail}`,
            )
            .toBe(true);
        }

        // ── 【二】附加（20260924 三轮）：Users 页认 ?tab=review ──
        // 后台首页待办卡上那行"3 条留言待人工审核"点过来就落到这里；这个沙箱是**唯一**
        // 会渲染真 Users 页的地方，所以这条接线断言寄在这里（它不关心配色，关心落点）。
        const activeTab = () =>
          page.evaluate(() => {
            const t = document.querySelector(".ant-tabs-tab-active");
            return t ? t.textContent!.trim() : null;
          });

        await page.goto(`${sb.url}?page=Users&tab=review`);
        await page.waitForTimeout(1800);
        expect
          .soft(
            (await activeTab()) === "留言管理",
            `Users 页认 ?tab=review（待审留言那行跳过来直接落在「留言管理」上）` +
              ` → ${JSON.stringify(await activeTab())}`,
          )
          .toBe(true);
        // 20261002：第四个页签（评论管理）同样认深链。**必须与上面那条分开跑**——两条都写成
        // 看 active_tab 的话，一次 goto 只能验一个取值，而这里正是"白名单漏一项"最可能发生的地方。
        await page.goto(`${sb.url}?page=Users&tab=comment`);
        await page.waitForTimeout(1800);
        expect
          .soft(
            (await activeTab()) === "评论管理",
            `Users 页认 ?tab=comment（落在「评论管理」上，不是落回账号管理）` +
              ` → ${JSON.stringify(await activeTab())}`,
          )
          .toBe(true);
        await page.goto(`${sb.url}?page=Users`);
        await page.waitForTimeout(1800);
        expect
          .soft(
            (await activeTab()) === "账号管理",
            `不带参数时仍落在「账号管理」（原来的默认没被动过）` +
              ` → ${JSON.stringify(await activeTab())}`,
          )
          .toBe(true);

        // ── 【三】总判据 ──
        expect
          .soft(
            badPages.length === 0,
            `没有页面出现不可读文字（KNOWN 已空，11 页全在判失败之列；` +
              `合计 ${Object.keys(PAGES).length} 个页面 / ${totalRows} 个文本元素，` +
              `低于 3:1 的 ${totalBad} 处） → ${badPages.join("; ")}`,
          )
          .toBe(true);
      },
    );
  });
});
