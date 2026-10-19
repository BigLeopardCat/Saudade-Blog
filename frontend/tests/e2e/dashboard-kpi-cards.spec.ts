import { test, expect, type Page } from "@playwright/test";
import path from "node:path";
import {
  FE_DIR,
  withSandbox,
  esbuildInSandbox,
  compileSass,
} from "./sandbox";

/**
 * 后台首页左栏三张统计条（文章 / 分类 / 标签）的布局验收
 * （原 tests/dashboard-kpi-cards.test.py，20261019 迁移）。
 *
 * 两轮用户意见叠在同一处，判据也叠在这一个脚本里：
 *
 * · **20260930**「文章总数分类总数，标签总数这三个卡片布局优化」。改之前那套是
 *   **三处百分比高度串成一条链**：`.analyticsCard{height:75%}` + 每张 `.akCard{height:22%}`
 *   + `.akCard{width:75%}`（≤1530px 干脆钉成 `width:210px`），而同一个盒子的
 *   `padding/height/display/flex` 又同时写在 TSX 的 `bodyStyle` 内联里 —— 最终高度是谁定的，
 *   读代码看不出来，列一变宽就宽窄对不齐、一变矮就把内容挤出去。那一轮把它收成
 *   "这一列是竖向 flex，三张卡等分、宽度 100% 跟着列走"。
 *
 * · **20261001**「改成书签的样式大小就是细条书签贴在边上不需要占这么大地方」。
 *   上一轮把"高度是谁定的"理清楚了，但**卡本身还是三张大卡**（实测吃掉左栏 ~380px）。
 *   这一轮换成**书签条**：每条 34px、左缘贴在列的左缘（不留圆角）、右端切一道燕尾
 *   （`clip-path` 挖 V 口），整组 ~122px。标签与数字也从**上下两行**并成**一条线**。
 *
 * · **20261006**「这三个书签太细长了」。第三轮压扁了，横向却还铺满整列（320px 列 ⇒
 *   一条 320px）—— 于是"书签"读起来像一道横线。这一轮**加高收窄**：56px 高、列宽的
 *   **78%**，徽章/字号各抬一档（燕尾跟着从 11px 加深到 14px，否则那道口读起来像缺角）。
 *   判据因此从"宽度 == 列宽"改成"宽度 == 列宽 × 0.78"——**只断言"变窄了"是不够的**：
 *   78% 与 60% 都"变窄了"，而用户要的是这个比例。
 *
 * 为什么值得单起一个脚本而不是靠眼睛：这个组件的缺陷**全是几何的**（等不等高、越没越界、
 * 内容有没有被裁、燕尾是不是真切出来了），而它在页面里长什么样取决于列有多高多宽 ——
 * 只在"某一档视口"下看过一次，换个高度就变了。所以这里量四档：常规 / 窄列 / 被压矮 /
 * 压到极限，外加一档 `.dark`，并且**带一个对照**（把"大卡"那套规则注入回去，验"判据真的
 * 会红"——判据没牙就等于没测）。
 *
 * 沿用 `dashboard-home.test.py` 那套装配手段（esbuild 打真组件 + 真 sass + 只桩边界）：
 * react / react-dom / antd 都是真的，react-redux 与 react-countup 是桩。
 *
 * （TS 迁移注：Python 版的 PIL 截图像素分析（燕尾深度 / 左缘直边 / 上下尖角）
 * 改为「page.screenshot → dataURL → 页面内 canvas getImageData」，同一套
 * 扫描口径与 26 容差，对着渲染结果量，不解析 clip-path。）
 */

const DEFINE_ENV =
  '{"VITE_HTTP_BASEURL":"","VITE_CDN_BASEURL":"","MODE":"production","DEV":false,"PROD":true,"BASE_URL":"/"}';

// 三个数**刻意取不同位数**（1 位 / 4 位带千分位 / 3 位）：CountUp 从 0 涨到真实值的
// 过程中数字宽度会跳，标签不能被挤出去 —— 用同一个位数就测不出这条。
const COUNTS = { noteCount: 1024, tagCount: 128, categoryCount: 9 };

// 设计量（与 index.sass 是同一个数，改一处要改两处）。
const STRIP_H = 56; // 一条书签的高度（20261006：34 → 56，"太细长"那一轮）
const STRIP_W_PCT = 0.78; // 条宽占列宽的比例（20261006 新增：从前是铺满 100%）
const STRIP_GAP = 10; // 条间距
const GROUP_H = 3 * STRIP_H + 2 * STRIP_GAP; // 188
const BATCH = 30; // 徽章边长（22 → 30）
const NOTCH = 14; // 燕尾 V 口的深度（11 → 14，跟着条子加高）
const SLIM_MAX = STRIP_H + 8; // "细条"的上限：一档容差，别把 +2px 的微调判成"变回大卡"

// 边界①：react-redux。状态对象**同一实例**（每次返回新对象会让 useSelector 判定
// "变了"而无限重渲染）。
const STUB_REDUX = `const state: any = {notes: {noteCount: ${COUNTS.noteCount}, noteList: [], loading: false},
 tags: {tagCount: ${COUNTS.tagCount}, tagList: []},
 categories: {categoryCount: ${COUNTS.categoryCount}, categoryList: []}};
export const useSelector = (fn: any) => { try { return fn(state); } catch { return undefined; } };
export const useDispatch = () => (_a: any) => undefined;
export const Provider = ({children}: any) => children;
`;

// 边界②：react-countup。真的会从 0 缓动到 end（几十帧），断言会读到中间值 ⇒
// 桩成"直接给终值"。**千分位照真实现补上**（CountUp 的 `separator=","` 就是它干的），
// 否则"1,024"这条断言测的是桩而不是组件。
const STUB_COUNTUP = `const CountUp = ({end}: {end: number}) =>
  <span>{Number(end).toLocaleString('en-US')}</span>;
export default CountUp;
`;

// 边界③：react-router-dom（组件用 useNavigate 跳转；本沙箱只量几何）
const STUB_ROUTER = `export const useNavigate = () => (to: string) => { (window as any).__nav = ((window as any).__nav || []).concat([to]); };
export const Link = ({children}: any) => children;
export const Outlet = () => null;
export const useLocation = () => ({pathname: '/dashboard', search: ''});
`;

// 挂载壳：**照抄** Home/index.tsx 里 `.left` 那份内联样式（竖向 flex + 定高），
// 上面垫一个与 `.about_logo` 同高的空块 —— 三张条子拿到的就是真页面里那段剩余高度。
const ENTRY = `import * as React from 'react';
import { createRoot } from 'react-dom/client';
import ArticleAnalytics from './src/components/articleAnalytics/index.tsx';

(window as any).__mount = (o: any) => {
  const root = createRoot(document.getElementById('root')!);
  root.render(
    <div className={o.dark ? 'dark' : ''} style={{height: '100%'}}>
      <div className="home" style={{height: '100%'}}>
        <div className="left" style={{height: '100%', width: o.colWidth + 'px',
                                      display: 'flex', flexDirection: 'column'}}>
          <div className="about_logo" style={{flex: '0 0 auto', height: o.head + 'px'}} />
          <ArticleAnalytics />
        </div>
      </div>
    </div>
  );
};
`;

// 沙箱根 tsconfig：esbuild 的 paths 解析（替代原 CLI 的三个 --alias）。
const TSCONFIG_PATHS = JSON.stringify({
  compilerOptions: {
    paths: {
      "react-redux": ["./stub-redux.tsx"],
      "react-countup": ["./stub-countup.tsx"],
      "react-router-dom": ["./stub-router.tsx"],
    },
  },
});

const INDEX_HTML =
  '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">' +
  '<link rel="stylesheet" href="cards.css"></head><body>' +
  '<div id="root" style="height:100vh"></div>' +
  '<script src="bundle.js"></script>' +
  "</body></html>";

// 量一遍几何：容器、三条书签、标签/数字、以及"内容有没有被裁"的两个 scroll 读数。
interface Box {
  h: number;
  w: number;
  top: number;
  bottom: number;
  left: number;
  right: number;
}
interface CardRead extends Box {
  bg: string;
  clip: string;
  scrollH: number;
  clientH: number;
  scrollW: number;
  clientW: number;
  bodyScrollH: number;
  bodyClientH: number;
  label: string | null;
  labelTop: number;
  labelBottom: number;
  labelRight: number;
  labelClipped: boolean | null;
  labelColor: string | null;
  value: string | null;
  valueTop: number;
  valueLeft: number;
  badgeBox: Box | null;
}
interface ContainerRead extends Box {
  scrollH: number;
  clientH: number;
  overflowY: string;
  overflowX: string;
}
interface Measure {
  container: ContainerRead;
  col: Box | null;
  scroll: { x: number; y: number };
  cards: CardRead[];
}
const MEASURE = (): Measure => {
  const rect = (el: Element | null): DOMRect | null =>
    el ? el.getBoundingClientRect() : null;
  const box = (el: Element | null): Box | null => {
    const r = rect(el);
    if (!r) return null;
    return {
      h: r.height,
      w: r.width,
      top: r.top,
      bottom: r.bottom,
      left: r.left,
      right: r.right,
    };
  };
  const c = document.querySelector(".analyticsCard")!;
  const cards = Array.from(document.querySelectorAll(".akCard"));
  const cs = getComputedStyle(c);
  const cb = box(c)!;
  return {
    container: {
      ...cb,
      scrollH: c.scrollHeight,
      clientH: c.clientHeight,
      overflowY: cs.overflowY,
      overflowX: cs.overflowX,
    },
    col: box(document.querySelector(".left")),
    scroll: { x: window.scrollX, y: window.scrollY },
    cards: cards.map((el) => {
      const body = el.querySelector(".ant-card-body");
      const label = el.querySelector(".akLabel");
      const val = el.querySelector(".ant-statistic-content-value");
      const badge = el.querySelector(".akBadge");
      const ecs = getComputedStyle(el);
      return {
        ...box(el)!,
        bg: ecs.backgroundColor,
        clip: ecs.clipPath,
        scrollH: el.scrollHeight,
        clientH: el.clientHeight,
        scrollW: el.scrollWidth,
        clientW: el.clientWidth,
        bodyScrollH: body ? body.scrollHeight : 0,
        bodyClientH: body ? body.clientHeight : 0,
        label: label ? (label.textContent || "").trim() : null,
        labelTop: label ? rect(label)!.top : 0,
        labelBottom: label ? rect(label)!.bottom : 0,
        labelRight: label ? rect(label)!.right : 0,
        labelClipped: label ? label.scrollWidth > label.clientWidth + 1 : null,
        labelColor: label ? getComputedStyle(label).color : null,
        value: val ? (val.textContent || "").trim() : null,
        valueTop: val ? rect(val)!.top : 0,
        valueLeft: val ? rect(val)!.left : 0,
        badgeBox: box(badge),
      };
    }),
  };
};

interface MountOpts {
  colWidth: number;
  head: number;
  dark: boolean;
}
async function mount(
  page: Page,
  url: string,
  opts: Partial<MountOpts> = {},
): Promise<Measure> {
  const o: MountOpts = { colWidth: 320, head: 200, dark: false, ...opts };
  await page.goto(url);
  await page.evaluate(
    (oo) =>
      (
        window as unknown as { __mount: (o: MountOpts) => void }
      ).__mount(oo),
    o,
  );
  await page.waitForTimeout(350);
  return (await page.evaluate(MEASURE)) as Measure;
}

/** 把一条书签原样截下来（含它外面的页面底）→ dataURL，供页面内 canvas 像素判据用。
 *
 * ⚠️ 为什么不解析 `clip-path` 的计算值：Chromium 对它**保留百分比不解析** ——
 * 读回来是 `polygon(0px 0px, 100% 0px, calc(100% - 14px) 50%, 100% 100%, 0px 100%)`，
 * 要比顶点就得自己把 `100%` / `calc()` 再算一遍，那等于把被测的几何在测试里重写一份
 * （写错了两边一起错，还测不出来）。取像素是**对着渲染结果**量。
 */
async function cardShot(
  page: Page,
  r: Measure,
  card: CardRead,
): Promise<string> {
  const buf = await page.screenshot({
    clip: {
      x: card.left + r.scroll.x,
      y: card.top + r.scroll.y,
      width: Math.round(card.w),
      height: Math.round(card.h),
    },
  });
  return "data:image/png;base64," + buf.toString("base64");
}

/** `rgb(r, g, b)` → 元组（与 Python 版 card_color 同口径）。 */
function cardColor(bg: string): [number, number, number] {
  const m = bg.match(/\d+/g) ?? [];
  return [Number(m[0]), Number(m[1]), Number(m[2])];
}

function near(a: [number, number, number], b: [number, number, number], tol = 26): boolean {
  return (
    Math.max(
      Math.abs(a[0] - b[0]),
      Math.abs(a[1] - b[1]),
      Math.abs(a[2] - b[2]),
    ) <= tol
  );
}

// 页面内像素分析（替代 Python/PIL）：右侧中线那条扫描线上**条子色最后出现的位置**距右缘
// 多少像素 = 燕尾深度；左缘 (2, h/2) 与右端上下两个尖角 (w-NOTCH/2-2, {2, h-3}) 的采样。
// ⚠️ 取样点不能贴到右缘：V 口的两条斜边在 y=2 处已经到了 x=w-1.3、在 y=h-3 处到了
// x=w-1.9（这条是斜向条子中线的），贴边的点会取到反锯齿的混合色 —— 本套件初版取
// x=w-2 就是这么假红的两条。
interface NotchInfo {
  depth: number;
  leftEdge: [number, number, number];
  top: [number, number, number];
  bottom: [number, number, number];
}
const ANALYZE_NOTCH = (opts: {
  dataUrl: string;
  rgb: [number, number, number];
  notchHalf: number;
}): Promise<NotchInfo> =>
  new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement("canvas");
      c.width = img.width;
      c.height = img.height;
      const ctx = c.getContext("2d")!;
      ctx.drawImage(img, 0, 0);
      const data = ctx.getImageData(0, 0, c.width, c.height).data;
      const get = (x: number, y: number): [number, number, number] => [
        data[(y * c.width + x) * 4],
        data[(y * c.width + x) * 4 + 1],
        data[(y * c.width + x) * 4 + 2],
      ];
      const nearPx = (a: [number, number, number]) =>
        Math.max(
          Math.abs(a[0] - opts.rgb[0]),
          Math.abs(a[1] - opts.rgb[1]),
          Math.abs(a[2] - opts.rgb[2]),
        ) <= 26;
      const w = c.width;
      const h = c.height;
      let depth = w;
      for (let x = w - 1; x >= 0; x--) {
        if (nearPx(get(x, Math.floor(h / 2)))) {
          depth = w - x;
          break;
        }
      }
      const px = w - opts.notchHalf - 2;
      resolve({
        depth,
        leftEdge: get(2, Math.floor(h / 2)),
        top: get(px, 2),
        bottom: get(px, h - 3),
      });
    };
    img.src = opts.dataUrl;
  });

test.describe("后台统计条布局", () => {
  test.setTimeout(180_000);

  test("四档列宽真几何：细书签 78% 列宽、燕尾像素切口、一条线排布，负控两连", async ({
    page,
  }) => {
    await withSandbox(
      {
        "index.html": INDEX_HTML,
        "cards.css": compileSass(
          path.join(FE_DIR, "src/components/articleAnalytics/index.sass"),
        ),
      },
      async (sb) => {
        await esbuildInSandbox(sb, {
          entry: "entry.tsx",
          files: {
            "entry.tsx": ENTRY,
            "stub-redux.tsx": STUB_REDUX,
            "stub-countup.tsx": STUB_COUNTUP,
            "stub-router.tsx": STUB_ROUTER,
            "tsconfig.json": TSCONFIG_PATHS,
          },
          copySrc: true,
          define: { "import.meta.env": DEFINE_ENV },
          loaders: {
            ".sass": "text",
            ".css": "text",
            ".png": "dataurl",
            ".svg": "dataurl",
          },
        });

        await page.setViewportSize({ width: 1600, height: 900 });
        const url = sb.url;

        // ── 【一】常规档：三条细书签、等长等高、贴列左缘、整组不再吃掉这一列 ──
        const r = await mount(page, url);
        const cards = r.cards;
        const cont = r.container;
        expect(
          cards.length === 3,
          `三条书签都渲染出来了 → count=${cards.length}`,
        ).toBe(true);
        if (cards.length === 3) {
          const hs = cards.map((c) => Math.round(c.h * 10) / 10);
          const ws = cards.map((c) => Math.round(c.w * 10) / 10);
          expect(
            Math.max(...hs) - Math.min(...hs) < 1,
            `三条等高 → [${hs}] max-min=${(Math.max(...hs) - Math.min(...hs)).toFixed(1)}`,
          ).toBe(true);
          expect(
            Math.max(...ws) - Math.min(...ws) < 1,
            `三条等宽 → [${ws}] max-min=${(Math.max(...ws) - Math.min(...ws)).toFixed(1)}`,
          ).toBe(true);
          // 20261006：宽度的判据从"跟着列走（== 列宽）"改成"**列宽的 78%**"。
          // 只断言"比列窄"是不够的 —— 78% 与 60% 都通过，而用户要的是这个比例。
          expect(
            Math.abs(ws[0] - 320 * STRIP_W_PCT) < 1,
            `宽度是列宽的 ${STRIP_W_PCT * 100}%（列 320px ⇒ 条 ${320 * STRIP_W_PCT}px，不再是铺满整列、也不再是 75% / 固定 210px） → card=${ws[0].toFixed(1)}`,
          ).toBe(true);
          // 「书签大小」= 这一轮的题目本身。56px 是设计的量，不跟内容走。
          expect(
            Math.max(...hs) <= SLIM_MAX,
            `每条都是细条（高 ≤ ${SLIM_MAX}） → [${hs}]`,
          ).toBe(true);
          const group =
            Math.max(...cards.map((c) => c.bottom)) -
            Math.min(...cards.map((c) => c.top));
          expect(
            Math.abs(group - GROUP_H) < 2,
            `整组高 ${GROUP_H}px（三条 + 两道 10px 缝） → ${group.toFixed(1)}`,
          ).toBe(true);
          // 用户原话是「不需要占这么大地方」。旧版三张大卡实测吃掉左栏 ~380px，
          // 这里把它钉住：整组必须**远小于**列高。
          const colH = cont.bottom - cont.top;
          expect(
            group <= 220,
            `整组只占列高的一小块 → ${group.toFixed(0)}/${colH.toFixed(0)}px`,
          ).toBe(true);
          // 「贴在边上」：条子左缘与容器左缘齐平（左边缘不留圆角，是"夹进纸里"的那一头）
          expect(
            cards.every((c) => Math.abs(c.left - cont.left) < 1) &&
              cards.every((c) => Math.abs(c.left - cards[0].left) < 1),
            `三条左缘与容器左缘齐平（贴在边上） → 条[${cards[0].left.toFixed(0)}] 容器[${cont.left.toFixed(0)}]`,
          ).toBe(true);
          expect(
            Math.max(...cards.map((c) => c.bottom)) <= cont.bottom + 1,
            `整组没溢出容器 → 最低 ${Math.max(...cards.map((c) => c.bottom)).toFixed(0)} ≤ 容器底 ${cont.bottom.toFixed(0)}`,
          ).toBe(true);
          expect(
            cont.scrollH <= cont.clientH + 1,
            `容器没被撑出滚动条 → scrollH=${cont.scrollH} clientH=${cont.clientH}`,
          ).toBe(true);
          cards.forEach((c, i) => {
            expect(
              c.bodyScrollH <= c.bodyClientH + 1,
              `第 ${i + 1} 条：内容没被裁（body ${c.bodyScrollH} ≤ ${c.bodyClientH}）`,
            ).toBe(true);
            expect(
              c.scrollW <= c.clientW + 1,
              `第 ${i + 1} 条：文字没被挤出条子`,
            ).toBe(true);
          });
        }

        // ── 【二】右端燕尾：`clip-path` 真的切出那个 V 口（对着像素量，不解析 clip-path）──
        // 手势读法：左缘直边（贴纸边）+ 右端挖一道 V。与置顶缎带 `.TopTape`（右端收成
        // 箭头**尖**）是同族两种收尾 —— 不许退回"两头一样圆的胶囊"。
        if (cards.length === 3) {
          const dataUrl = await cardShot(page, r, cards[0]);
          const col = cardColor(cards[0].bg);
          const info = (await page.evaluate(ANALYZE_NOTCH, {
            dataUrl,
            rgb: col,
            notchHalf: Math.floor(NOTCH / 2),
          })) as NotchInfo;
          expect(
            Math.abs(info.depth - NOTCH) <= 2,
            `右端中线被切掉 ${NOTCH}px（V 口底的深度与设计值一致） → 实测 ${info.depth}px  条色[${col}]`,
          ).toBe(true);
          expect(
            near(info.leftEdge, col),
            `左缘是直边（书签「夹进纸里」的那一头，没被切） → [${info.leftEdge}]`,
          ).toBe(true);
          // 燕尾留下的上下两个尖角。**这两条把"右端收成一个箭头尖"与"斜切一刀"都
          // 排除了** —— 那两种形状在这两行上的边界都落在 x = w-7 的左边。
          expect(
            near(info.top, col),
            `右端上尖角还在（不是收成一个箭头尖、也不是斜切） → [${info.top}]`,
          ).toBe(true);
          expect(
            near(info.bottom, col),
            `右端下尖角还在 → [${info.bottom}]`,
          ).toBe(true);
        }

        // ── 【三】一条线排布：标签在左、数字在右，同一行（这一轮从两行并成一行） ──
        const want: Array<[string, string]> = [
          ["文章总数", "1,024"],
          ["分类总数", "9"],
          ["标签总数", "128"],
        ];
        want.forEach(([label, value], i) => {
          if (i >= cards.length) return;
          expect(
            cards[i].label === label,
            `第 ${i + 1} 条：标签「${label}」 → ${cards[i].label}`,
          ).toBe(true);
          expect(
            cards[i].value === value,
            `第 ${i + 1} 条：数值 ${value}（千分位由 CountUp 的 separator 给） → ${cards[i].value}`,
          ).toBe(true);
        });
        if (cards.length === 3) {
          const c0 = cards[0];
          // `+22` 是数字那一档的字号（20261006 从 18 抬到 22）：`valueTop` 是行盒顶，
          // 加一个字号约等于它的下缘；用旧字号配新字号会在容差里慢慢漂到红。
          expect(
            Math.abs(c0.valueTop + 22 - c0.labelBottom) < 12 &&
              c0.valueTop < c0.labelBottom,
            `数字与标签在同一行（条子放不下两行） → valueTop=${c0.valueTop.toFixed(0)} labelBottom=${c0.labelBottom.toFixed(0)}`,
          ).toBe(true);
          expect(
            c0.valueLeft >= c0.labelRight - 1,
            `数字排在标签右边（不是上下两行） → valueLeft=${c0.valueLeft.toFixed(0)} labelRight=${c0.labelRight.toFixed(0)}`,
          ).toBe(true);
          expect(
            Math.abs(c0.badgeBox!.h - c0.badgeBox!.w) < 1 &&
              Math.abs(c0.badgeBox!.h - BATCH) < 1,
            `徽章是正方形（${BATCH}×${BATCH}） → ${JSON.stringify(c0.badgeBox)}`,
          ).toBe(true);
        }

        // ── 【四】窄列档：列只有 240px 宽 ⇒ 标签省略号，但谁也不许横向溢出 ──
        const r2 = await mount(page, url, { colWidth: 240 });
        const c2 = r2.cards;
        expect(
          c2.length === 3,
          `窄列下仍是三条 → count=${c2.length}`,
        ).toBe(true);
        if (c2.length === 3) {
          expect(
            Math.abs(c2[0].w - 240 * STRIP_W_PCT) < 1,
            `条子宽度跟着缩（列 240px ⇒ 条 ${240 * STRIP_W_PCT}px） → card=${c2[0].w.toFixed(1)}`,
          ).toBe(true);
          expect(
            c2.every((c) => c.scrollW <= c.clientW + 1),
            `横向没有溢出（labelClipped 记录被省略的那个） → [${c2.map((c) => Math.round((c.scrollW - c.clientW) * 10) / 10)}]`,
          ).toBe(true);
        }

        // ── 【五】被压矮档：这条子**本来就矮**，所以常规的矮列根本压不着它 ──
        // 900 视口 - 660 = 剩约 240px，仍大于整组的 188px ⇒ 不该出现滚动条。
        // （旧版三张 76px 下限的大卡在这里刚好会溢出 —— 这条断言就是"变小了"的收益。）
        const r3 = await mount(page, url, { head: 660 });
        const cont3 = r3.container;
        const c3 = r3.cards;
        expect(
          cont3.scrollH <= cont3.clientH + 1,
          `列只剩 ~240px 时也不再需要滚动（整组 ${GROUP_H}px 装得下） → scrollH=${cont3.scrollH} clientH=${cont3.clientH}`,
        ).toBe(true);
        expect(
          c3.length === 3,
          `三条都还在 → count=${c3.length}`,
        ).toBe(true);

        // ── 【六】压到极限：列矮到装不下三条 ⇒ 在这一组内滚动，而不是探出列外 ──
        const r3b = await mount(page, url, { head: 840 }); // 900 - 840 = 只剩约 60px
        const cont3b = r3b.container;
        expect(
          cont3b.scrollH > cont3b.clientH + 1,
          `整组被压到装不下（容器真出现纵向滚动） → scrollH=${cont3b.scrollH} clientH=${cont3b.clientH}`,
        ).toBe(true);
        expect(
          cont3b.overflowY === "auto" && cont3b.overflowX === "hidden",
          `它真的是纵向滚动容器（并且横向裁掉 ⇒ 条子出不去） → ${cont3b.overflowY}/${cont3b.overflowX}`,
        ).toBe(true);
        // 溢出的是**滚动内容**（getBoundingClientRect 报的是未经裁剪的位置），
        // 所以判据不是"卡底 ≤ 容器底"，而是：容器自己没出列 + 三条都滚得到。
        expect(
          cont3b.bottom <= r3b.col!.bottom + 1,
          `这一组自己没探出左栏（容器底 ≤ 列底） → 容器底${cont3b.bottom.toFixed(0)} 列底${r3b.col!.bottom.toFixed(0)}`,
        ).toBe(true);
        expect(
          Math.abs(cont3b.scrollH - GROUP_H) < 2,
          `三条都滚得到（scrollHeight = 整组的 ${GROUP_H}px） → scrollH=${cont3b.scrollH}`,
        ).toBe(true);

        // ── 【七】夜间档：条面/标签换色（浅底浅字那类事故的同族） ──
        const r4 = await mount(page, url, { dark: true });
        const c4 = r4.cards;
        expect(
          c4.length === 3,
          `夜间仍是三条 → count=${c4.length}`,
        ).toBe(true);
        if (c4.length === 3 && cards.length === 3) {
          expect(
            c4[0].bg !== cards[0].bg,
            `条面底色与浅色档不同（.dark 分支真生效） → ${c4[0].bg} vs ${cards[0].bg}`,
          ).toBe(true);
          expect(
            c4[0].bg !== "rgba(0, 0, 0, 0)" && c4[0].bg !== "transparent",
            `条面底色不是透明的（transparent 会让浅字直接消失） → ${c4[0].bg}`,
          ).toBe(true);
          expect(
            c4[0].labelColor !== cards[0].labelColor,
            `标签字色与浅色档不同 → ${c4[0].labelColor} vs ${cards[0].labelColor}`,
          ).toBe(true);
          const h4 = c4.map((c) => Math.round(c.h * 10) / 10);
          const w4 = c4.map((c) => Math.round(c.w * 10) / 10);
          expect(
            Math.max(...h4) - Math.min(...h4) < 1 &&
              Math.max(...w4) - Math.min(...w4) < 1,
            `夜间三条仍等长等高 → [${h4}]`,
          ).toBe(true);
        }

        // ── 【八】对照：把「大卡」那套规则注入回去，判据必须变红（判据没牙 = 没测） ──
        // 注入：条子交回 `flex:1 1 0` 均分整列 + 去掉燕尾。若"细条""燕尾"两条还全绿，
        // 说明上面量错了地方。
        await page.goto(url);
        await page.evaluate(
          (o) =>
            (window as unknown as { __mount: (o: MountOpts) => void }).__mount(
              o,
            ),
          { colWidth: 320, head: 200, dark: false },
        );
        await page.waitForTimeout(200);
        await page.addStyleTag({
          content:
            ".analyticsCard{flex:1 1 auto!important;overflow:visible!important}" +
            ".analyticsCard .akCard{height:auto!important;flex:1 1 0!important;" +
            "clip-path:none!important}",
        });
        await page.waitForTimeout(200);
        const legacy = (await page.evaluate(MEASURE)) as Measure;
        const lc = legacy.cards;
        const legH = lc.map((c) => Math.round(c.h * 10) / 10);
        // 阈值跟着设计量走（`SLIM_MAX`）：旧规则下这一组会撑满整列（几百 px），
        // 这里写死 44 反而会在条子加高之后变成"永远绿"——那样这条负控就没牙了。
        expect(
          Math.max(...legH) > SLIM_MAX,
          `注入旧规则后条子不再是细条 ⇒「细条」这条判据有牙 → [${legH}]`,
        ).toBe(true);
        const legDataUrl = await cardShot(page, legacy, lc[0]);
        const legInfo = (await page.evaluate(ANALYZE_NOTCH, {
          dataUrl: legDataUrl,
          rgb: cardColor(lc[0].bg),
          notchHalf: Math.floor(NOTCH / 2),
        })) as NotchInfo;
        expect(
          legInfo.depth <= 1,
          `注入旧规则后燕尾没了 ⇒「燕尾」这条判据有牙 → 实测 ${legInfo.depth}px（设计值 ${NOTCH}）`,
        ).toBe(true);
      },
    );
  });
});
