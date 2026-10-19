import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { FE_DIR, compileSass, htmlDoc, withSandbox, collectPageErrors } from "./sandbox";

/**
 * 文章横幅「读数四件」= 2×2 的四个等大格子（20260926 起；20261001 改形态；20261003 改排布）
 * （原 tests/read-stats-cluster.test.py，20261019 迁移）。
 *
 * 沿革：本套件原名 `read-fav-vertical.test.py`，锁的是"收藏按钮竖排"那套（20260926）。
 * 20261001 用户第 1 条把那一版整体否了 ——「详情页三图标样式和布局太丑了，大小不一，
 * 排列奇怪」：
 *
 *     实测（1280×900，线上）            宽 × 高    内边距      字号   描边 α
 *     .readFavWrap  .readFavBtn        32 × 62    6px 8px     13    .55   ← 竖排
 *     .readViews                       59 × 24    2px 8px     12    .35
 *     .readLikeBtn                     64 × 30    4px 10px    13    .55
 *
 * 一件竖的、两件横的，高度差到 2.6 倍 —— 排在一行里怎么摆都对不齐。所以 20261001 改成
 * 一簇 `.readStats` + 三件共用几何 `.readStat`。此后这一簇的**排布**改过三次，`.readStat`
 * 那份几何**一次都没动**（"大小不一"的判据因此一直有效）：
 *
 *     20261001  一行三件      —— 治"大小不一"
 *     20261003a 竖排一列四件  —— 治"横排 260px 把标题挤偏"
 *     20261003b **2×2 四件**  —— 用户第 2 条「右侧是四个数据组件 2*2 排布」
 *
 * 为什么 2×2 之后就**不必再管簇的宽度**了：挤偏的成因是"中区吃余量 ⇒ 中区中线 =
 * 卡片中线 + (左区宽 − 右区宽)/2"，它成立的前提是`.readInfo` 是 **flex 行**。本轮改成
 * **三列车格**、两条侧轨写同一个变量（`.readInfo` 的 `--read-side`）⇒ 中区中线与卡片
 * 中线**结构上重合**，与两边装什么都无关。判据因此升级成一条更强的不变量：
 * **中区中线与卡片中线差 < 1px**（①c 与 ⑦ 两组都量它），且**左区与右区的宽度逐字相等**（②）。
 *
 * 为什么用无头浏览器而不是 node 桩：这是**布局**问题（行盒、等高、格子的宽高、绝对定位盒
 * 是否越出 overflow:hidden 的父盒），桩里算不出这些。真 CSS = node 侧真编译的 `.sass` +
 * 仓库里那份 `* { box-sizing: border-box }` 重置（`src/frontHome/main.css`），页面里手写与
 * `index.tsx` 同形的标记（不挂 React——类名与结构就是全部接口）。
 *
 * 锁十二组：
 *   ① **四件同形**（正面判据）：高度/圆角/描边宽/描边色/内边距/字号六项逐项相等，且换内容
 *      也不变（收藏 ⇄ 已收藏、数字一位 ⇄ 四位）；
 *      ①b 反向对照：把旧的三套几何内联写回去 ⇒ 高度当场不等（证明 ① 抓得住"大小不一"）；
 *      ①c ★**2×2**：横向中心恰好两个值、纵向中心恰好两个值、四个格子等大，且按 DOM 顺序
 *      落在左上/右上/左下/右下；**反向对照**：把列数写回 1 ⇒ ①c 当场不成立；
 *   ② ★**两条侧轨等宽**（结构性居中的唯一来源）：左区、右区宽度逐字相等，簇高 = 2×件高 +
 *      间距；**中区中线与卡片中线差 < 1px**；
 *      ②b 文案/数字变长时**件内内容**不挪（`.readFavLabel{min-width:3em}`、数字 `4ch`），
 *      且内容始终装得下格子（`scrollWidth ≤ clientWidth`）；**反向对照**：把两条定宽一起
 *      抹掉 ⇒ 文案当场宽 13px（图标跟着跳）；
 *   ③ **挤压回归**（20260926 那件事）：超长标题下四个格子与两条侧轨逐字不动；
 *      ③b 反向对照：把中区轨道写成 `1fr`（少了 `minmax(0, …)`）⇒ 一格长词当场把整行顶出卡片；
 *   ④ 图标：四件的 svg 同尺寸 14px、`aria-hidden`，文案仍在 `span.readFavLabel` 里；
 *   ⑤ 三态色一字未改；讨论数是**读数不是按钮**（字色与浏览同档、比两个按钮淡）；
 *   ⑥ ★手机档（327px / 768px 两档）：`.readInfo` 落成**单列**（手机的三列放不下）、
 *      四件收成 24px 高 / 4px 间距，**且整个信息盒不越出封面顶**；
 *      **反向对照**：把封面高撤回 200px ⇒ 上沿当场越界；
 *   ⑦ 布局锁死：四种标题长度下中区、右区、左区、卡片高的坐标逐字相同，且每次中区都居中；
 *      ⑦b 反向对照：把两条侧轨写成**不等宽** ⇒ 中区当场偏 40px（居中靠的就是"等宽"这一条）。
 */

const SASS_FILE = path.join(FE_DIR, "src/frontHome/Content/ReadArticle/index.sass");
const RESET_CSS = readFileSync(path.join(FE_DIR, "src/frontHome/main.css"), "utf-8");

// 与 index.tsx 同形的标记：三区并列（作者 / 标题 / 读数四件）。
// ⚠️ 这一版的结构**本身**就是判据的一部分：两条侧轨的宽度由 `.readInfo` 的列模板决定，
// 夹具少一个区（或把某区嵌进另一区）就会让"结构性居中"那条判据失去意义。
// 头像写死 40×40 的内联样式 —— 线上那件是 antd `Avatar size={40}`（尺寸来自它的内联样式），
// 夹具不挂 React，就把这个数写在这里（只有它影响左区的高度）。
function MARKUP(o: {
  author: string;
  title: string;
  faved: string;
  text: string;
  views: string;
  likes: string;
  liked: string;
  comments: string;
}): string {
  return `
<div class="readContainer">
  <div class="readCover" id="cover">
    <div class="readInfo" id="info">
      <div class="readAuthor" id="author">
        <div class="readAuthorRow" id="arow">
          <span class="frontAvatar" id="av" style="width:40px;height:40px;display:inline-block">头</span>
          <span class="readAuthorName" id="name">${o.author}</span>
        </div>
        <div class="readTimes" id="times">
          <span id="pub">发布于 2026-10-01</span>
          <span id="upd">更新于 2026-10-03</span>
        </div>
      </div>
      <div class="readMain" id="main">
        <h1 id="title">${o.title}</h1>
      </div>
      <div class="readStats" id="wrap">
        <button type="button" class="readStat readFavBtn${o.faved}" id="btn" title="收藏">
          <svg aria-hidden="true" width="14" height="14" id="star"></svg>
          <span class="readFavLabel" id="label">${o.text}</span>
        </button>
        <span class="readStat readViews" id="views" title="累计阅读量">
          <svg aria-hidden="true" width="14" height="14" id="eye"></svg>
          <span class="readViewsNum" id="viewsnum">${o.views}</span></span>
        <button type="button" class="readStat readLikeBtn${o.liked}" id="likebtn" aria-pressed="false">
          <svg aria-hidden="true" width="14" height="14" id="heart"></svg>
          <span class="readLikeNum" id="likenum">${o.likes}</span></button>
        <span class="readStat readComments" id="comments" title="讨论数">
          <svg aria-hidden="true" width="14" height="14" id="bubble"></svg>
          <span class="readCommentNum" id="commentnum">${o.comments}</span></span>
      </div>
    </div>
  </div>
</div>`;
}

const LONG_TITLE = "一篇标题特别长的文章：从零开始把站内对话助手接进个人博客的完整记录与踩坑清单（下篇）";

interface MkOpts {
  title?: string;
  faved?: string;
  text?: string;
  views?: string;
  likes?: string;
  liked?: string;
  comments?: string;
  author?: string;
}
function mk(o: MkOpts = {}): string {
  const {
    title = LONG_TITLE,
    faved = " isFaved",
    text = "已收藏",
    views = "128",
    likes = "7",
    liked = "",
    comments = "3",
    author = "泠月",
  } = o;
  return MARKUP({ author, title, faved, text, views, likes, liked, comments });
}

// 旧形态的三套几何（20261001 之前写死在 `.readFavBtn` / `.readViews` / `.readLikeBtn` 上）。
// 只在 ①b 反向对照里内联写回去——用 id 选择器（1,0,0）压过 `.readInfo .readStat`（0,4,0）。
const LEGACY_GEOM = `
#btn { height: 62px; width: 32px; flex-direction: column; padding: 6px 8px; }
#views { height: 24px; padding: 2px 8px; font-size: 12px;
         border-color: rgba(255, 241, 235, 0.35); }
#likebtn { height: 30px; padding: 4px 10px; }
`;

// ①c 的反向对照：把列数写回 1（= 20261003a 那一版竖排一列）。四条列宽判据当场不成立。
const LEGACY_ONE_COL = "#wrap { grid-template-columns: 1fr !important; }";

// ②b 的反向对照：把两件定宽一起抹掉（文案 3em + 数字 4ch）。判的是**件内内容**的宽度
// ——格子本身是定宽的，内容变宽不会再动格子，但图标会在胶囊里左右跳（这就是它俩存在的理由）。
const LEGACY_MINW =
  "#label { min-width: 0 !important; }" +
  "#viewsnum, #likenum, #commentnum { min-width: 0 !important; }";

// ⑦b 的反向对照：两条侧轨**不等宽**（左 180 / 右 260）⇒ 中区中线当场偏 40px。
// 这一条比"当年那套 flex 到底漂多少"更直接：居中靠的就是"等宽"这一条，不是别的。
const LEGACY_ASYM = "#info { grid-template-columns: 180px 1fr 260px !important; }";

// ⑥ 的反向对照：把手机档那三条覆盖撤回 20261003 之前的 200px 那一版
// （封面高、`.readInfo` 的 bottom/内边距、四件的 24px/4px）。
// 全部用 id 选择器 + `!important`：与 sass 里那几条同是 `!important`，靠**特异性**取胜。
const LEGACY_MOBILE = `
#cover { height: 200px !important; }
#info { bottom: 25px !important; padding: 16px 24px !important; }
#wrap { gap: 6px !important; }
#wrap .readStat { height: 30px !important; font-size: 13px !important; padding: 0 10px !important; }
`;

interface Box {
  w: number;
  h: number;
  left: number;
  right: number;
  cx: number;
  cy: number;
  top: number;
  bottom: number;
  sw: number;
  cw: number;
  radius: string;
  bw: string;
  bc: string;
  pad: string;
  fs: string;
  dir: string;
  bg: string;
  color: string;
  iconW: number;
  iconHidden: string | null;
}
interface PaintResult {
  btn: Box;
  views: Box;
  like: Box;
  com: Box;
  wrap: Box;
  cover: Box;
  info: Box;
  main: Box;
  author: Box;
  arow: Box;
  av: Box;
  name: Box;
  times: Box;
  label: Box;
  viewsnum: Box;
  wrapGap: number;
  labelText: string;
  labelLines: number;
  titleLines: number;
  titleW: number;
  titleH: number;
  infoH: number;
}

// `o.legacy` 是**反向对照**：把某一组判据的前提手动破坏掉，证明那组判据不是空断言。
const PAINT = (o: { markup: string; legacy?: string; css?: string }): PaintResult => {
  // 反向对照的样式表是**累加**在页面上的，每次重画先清掉上一张（只清我们加的那些）。
  for (const s of [...document.querySelectorAll('style[id^="legacy"]')]) s.remove();
  document.getElementById("root")!.innerHTML = o.markup;
  if (o.css) {
    const s = document.createElement("style");
    s.id = o.legacy || "legacy";
    s.textContent = o.css;
    document.head.appendChild(s);
  }
  const box = (id: string): Box => {
    const el = document.getElementById(id)!;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    const icon = el.querySelector('[aria-hidden="true"]');
    return {
      w: r.width,
      h: r.height,
      left: r.left,
      right: r.right,
      cx: r.left + r.width / 2,
      cy: r.top + r.height / 2,
      top: r.top,
      bottom: r.bottom,
      sw: el.scrollWidth,
      cw: el.clientWidth,
      radius: cs.borderTopLeftRadius,
      bw: cs.borderTopWidth,
      bc: cs.borderTopColor,
      pad: cs.padding,
      fs: cs.fontSize,
      dir: cs.flexDirection,
      bg: cs.backgroundColor,
      color: cs.color,
      iconW: (icon || { getBoundingClientRect: () => ({ width: -1 }) }).getBoundingClientRect().width,
      iconHidden: icon ? icon.getAttribute("aria-hidden") : null,
    };
  };
  const rng = (id: string): number => {
    const g = document.createRange();
    g.selectNodeContents(document.getElementById(id)!);
    return g.getClientRects().length;
  };
  return {
    btn: box("btn"),
    views: box("views"),
    like: box("likebtn"),
    com: box("comments"),
    wrap: box("wrap"),
    cover: box("cover"),
    info: box("info"),
    main: box("main"),
    author: box("author"),
    arow: box("arow"),
    av: box("av"),
    name: box("name"),
    times: box("times"),
    label: box("label"),
    viewsnum: box("viewsnum"),
    wrapGap: parseFloat(getComputedStyle(document.getElementById("wrap")!).gap) || 0,
    labelText: document.getElementById("label")!.textContent!,
    labelLines: rng("label"),
    titleLines: rng("title"),
    titleW: document.getElementById("title")!.getBoundingClientRect().width,
    titleH: document.getElementById("title")!.getBoundingClientRect().height,
    infoH: document.querySelector(".readInfo")!.getBoundingClientRect().height,
  };
};

const paint = (pg: Page, o: { markup: string; legacy?: string; css?: string }) =>
  pg.evaluate(PAINT, o);

type ItemKey = "btn" | "views" | "like" | "com";
const ITEMS: ItemKey[] = ["btn", "views", "like", "com"];
const NAMES: Record<ItemKey, string> = {
  btn: "收藏按钮",
  views: "浏览读数",
  like: "点赞按钮",
  com: "讨论读数",
};

const r1 = (x: number) => Math.round(x * 10) / 10;

test.describe("文章横幅读数四件", () => {
  test.setTimeout(180_000);

  test("四件同形 + 2×2 排布 + 侧轨等宽 + 手机档单列 + 布局锁死（67 条判据）", async ({ page }) => {
    const css = compileSass(SASS_FILE);
    await withSandbox(
      { "index.html": htmlDoc('<div id="root"></div>', RESET_CSS, css) },
      async (sb) => {
        await page.setViewportSize({ width: 1280, height: 900 });
        const errs = collectPageErrors(page);
        await page.goto(sb.url);
        await page.waitForTimeout(150);

        // ── ① 四件同形：六项几何逐项相等，且换内容也不变（20261001 用户第 1 条「大小不一」） ──
        // ⚠️ 这一组必须量**未选中态**：`.isFaved` / `.isLiked` 是**故意**改底色与描边色的
        // （已收藏＝河灯金实心），拿选中态去比"四件颜色相同"必然不等 —— 那是断言写错了，
        // 不是样式错了。选中态本身由 ⑤ 组单独锁。
        const r = await paint(page, { markup: mk({ faved: "", text: "收藏" }) });
        const parts = ITEMS.map((k) => [NAMES[k], r[k]] as const);
        for (const [prop, label] of [
          ["h", "高度"],
          ["radius", "圆角"],
          ["bw", "描边宽"],
          ["bc", "描边色"],
          ["pad", "内边距"],
          ["fs", "字号"],
        ] as const) {
          const vals = parts.map(([, b]) => b[prop]);
          expect.soft(
            new Set(vals).size === 1,
            `${label} 四件相同（${vals[0]}） → ${JSON.stringify(Object.fromEntries(parts.map(([n], i) => [n, vals[i]])))}`,
          ).toBe(true);
        }
        // 换内容：文案两字 ⇄ 三字、数字一位 ⇄ 四位 —— 高度都不许动（定高的意义就在这里）
        const hs = new Set<string>();
        for (const [f, t, v, lk, cm] of [
          ["", "收藏", "7", "0", "0"],
          [" isFaved", "已收藏", "1234", "9999", "1234"],
        ] as const) {
          const rr = await paint(page, { markup: mk({ faved: f, text: t, views: v, likes: lk, comments: cm }) });
          hs.add(ITEMS.map((k) => r1(rr[k].h)).join(","));
        }
        expect.soft(
          hs.size === 1,
          `换内容（收藏⇄已收藏、数字 1 位⇄4 位）后四件高度仍逐件不变 → ${[...hs].join(" | ")}`,
        ).toBe(true);

        // ── ①b 反向对照：把旧的三套几何写回去 ⇒ 高度当场不等（证明 ① 不是空断言） ──
        const rlg = await paint(page, { markup: mk(), legacy: "legacy-geom", css: LEGACY_GEOM });
        const old = ITEMS.map((k) => r1(rlg[k].h));
        expect.soft(
          new Set(old).size === 3,
          `旧几何下四件高度是三个不同的值（${JSON.stringify(old)}）——这就是用户看到的那一版`,
        ).toBe(true);
        expect.soft(
          Math.max(...old) / Math.min(...old) > 2.4,
          `且最高/最矮是 2.6 倍上下（竖排胶囊 62 / 读数 24） → ${Math.max(...old)} / ${Math.min(...old)}`,
        ).toBe(true);

        // ── ①c ★2×2（20261003 用户第 2 条「右侧是四个数据组件 2*2 排布」） ──
        const cx = ITEMS.map((k) => r1(r[k].cx));
        const cy = ITEMS.map((k) => r1(r[k].cy));
        expect.soft(
          new Set(cx).size === 2,
          `四件横向中心恰好两个值（落成两列） → ${JSON.stringify(cx)}`,
        ).toBe(true);
        expect.soft(
          new Set(cy).size === 2,
          `四件纵向中心恰好两个值（落成两行） → ${JSON.stringify(cy)}`,
        ).toBe(true);
        // DOM 顺序 = 阅读顺序：收藏→浏览→点赞→讨论 应落在 左上→右上→左下→右下。
        // 具体地：奇偶配对（第 1/3 件同列、第 2/4 件同列）且第 1 件在第 2 件左边。
        expect.soft(
          cx[0] === cx[2] && cx[1] === cx[3] && cy[0] === cy[1] && cy[2] === cy[3]
          && cx[0] < cx[1] && cy[0] < cy[2],
          `按 DOM 顺序落在 左上 → 右上 → 左下 → 右下 → ${JSON.stringify(ITEMS.map((k) => [k, r1(r[k].cx), r1(r[k].cy)]))}`,
        ).toBe(true);
        expect.soft(
          new Set(ITEMS.map((k) => r1(r[k].w))).size === 1
          && new Set(ITEMS.map((k) => r1(r[k].h))).size === 1,
          `四个格子等宽等高（\`1fr 1fr\` + grid 默认 stretch） → ${JSON.stringify(ITEMS.map((k) => [r1(r[k].w), r1(r[k].h)]))}`,
        ).toBe(true);
        // ★ 用户第 2 条第一句就是「现在标题没有居中」。这条判据量的是**结构**：
        // 中区的中线是不是落在这张卡的中线上。旧 flex 版这里偏 ±30px 都算"看着还行"
        // （因为靠"两边碰巧差不多宽"），所以阈值从 30px 收到 1px。
        const off = r.main.cx - r.info.cx;
        expect.soft(
          Math.abs(off) < 1,
          `★中区中线与卡片中线差 ${off.toFixed(1)}px（< 1px —— 结构性居中，不是「看着还行」）`,
        ).toBe(true);

        // ── ①c′ 反向对照：把列数写回 1 ⇒ ①c 的四条判据当场不成立 ──
        const r1c = await paint(page, { markup: mk(), legacy: "legacy-onecol", css: LEGACY_ONE_COL });
        const one_cx = ITEMS.map((k) => r1(r1c[k].cx));
        expect.soft(
          new Set(one_cx).size === 1,
          `一列时横向中心只剩一个值（①c「恰好两个值」当场不成立） → ${JSON.stringify(one_cx)}`,
        ).toBe(true);
        expect.soft(
          new Set(ITEMS.map((k) => r1(r1c[k].cy))).size === ITEMS.length,
          `且四件的竖直中心各不相同（①c「恰好两个值」当场不成立） → ${JSON.stringify(ITEMS.map((k) => r1(r1c[k].cy)))}`,
        ).toBe(true);
        // ⚠️ 这里曾经有一条"整簇变窄 ⇒ 标题归位"的因果判据。**现在没有了**：簇的宽度由
        // 侧轨定死（180px），它在列里怎么排都不影响中区。这正是本轮的结构性改善——
        // 标题的居中不再依赖"簇有多宽"，所以也没有"簇一变宽标题就偏"这条回归路径。
        expect.soft(
          Math.abs(r1c.wrap.w - r.wrap.w) < 0.5 && Math.abs(r1c.wrap.left - r.wrap.left) < 0.5,
          `一列时整簇的宽度/左缘逐字不变（标题居中不再受簇的排布影响） → `
          + `${r1(r1c.wrap.w)}@${r1(r1c.wrap.left)} vs ${r1(r.wrap.w)}@${r1(r.wrap.left)}`,
        ).toBe(true);

        // ── ② ★两条侧轨等宽（结构性居中的唯一来源）+ 整簇 = 2×2 的格数账 ──
        expect.soft(
          Math.abs(r.author.w - r.wrap.w) < 0.5,
          `★左区与右区宽度逐字相等（同一个 \`--read-side\` 写两遍，实得 ${r.wrap.w.toFixed(0)}px） → `
          + `${r1(r.author.w)} vs ${r1(r.wrap.w)}`,
        ).toBe(true);
        expect.soft(
          Math.abs(r.wrap.w - 180) < 0.5,
          `侧轨 = 180px（左区里那行「发布于 2026-10-01」@12px 定出来的） → ${r1(r.wrap.w)}`,
        ).toBe(true);
        // 中区拿到的是 880 − 2×24（卡片内边距）− 2×180（侧轨）− 2×24（列间距）= 424px。
        // 这是"标题有多少余量"的唯一一处锁：改 `--read-side` / 卡片宽 / 间距都会动它。
        expect.soft(
          Math.abs(r.main.w - 424) < 0.5,
          `中区轨道宽 ${r.main.w.toFixed(0)}px = 880 − 2×24 − 2×180 − 2×24 = 424 → ${r1(r.main.w)}`,
        ).toBe(true);
        const expect_h = 2 * r.btn.h + r.wrapGap;
        expect.soft(
          Math.abs(r.wrap.h - expect_h) < 0.5,
          `整簇高 = 两行 + 一道间距（${expect_h.toFixed(1)}px，不是四行） → ${r1(r.wrap.h)} vs ${expect_h.toFixed(1)}`,
        ).toBe(true);
        expect.soft(
          Math.abs(r.wrap.w - (2 * r.btn.w + r.wrapGap)) < 0.5,
          `整簇宽 = 两格 + 一道间距（同一条 \`1fr 1fr\` 列宽，实得 2×87 + 6 = 180） → `
          + `${r1(r.wrap.w)} vs ${r1(2 * r.btn.w + r.wrapGap)}`,
        ).toBe(true);

        // ── ②b 文案/数字变长时件内内容**不挪位**，且内容始终装得下格子 ──
        // ⚠️ 判据从"整簇的宽/左缘"改成了"**件内内容**的宽"。格子现在是定宽的
        // （(180−6)/2 = 87px，由轨道算出来），文案变长只会在胶囊里把图标挤来挤去
        // ——那正是 `3em` / `4ch` 这两条定宽存在的理由。
        const two = await paint(page, {
          markup: mk({ faved: "", text: "收藏", views: "7", likes: "0", comments: "0" }),
        });
        const r4 = await paint(page, {
          markup: mk({ faved: " isFaved", text: "已收藏", views: "1234", likes: "9999", comments: "1234" }),
        });
        expect.soft(
          Math.abs(two.label.w - r4.label.w) < 0.5,
          `收藏（两字）⇄ 已收藏（三字）：\`3em\` 兜住 ⇒ 文案盒宽度逐字不变 → ${r1(two.label.w)} vs ${r1(r4.label.w)}`,
        ).toBe(true);
        // 4ch 的覆盖范围就是 1–4 位（`min-width` 兜底不封顶，5 位会变宽——那是刻意的，
        // 见 sass 里那段注释）。判据取 4 位正是那道坎：999 → 1000。
        expect.soft(
          Math.abs(two.viewsnum.w - r4.viewsnum.w) < 0.5,
          `数字 1 位 ⇄ 4 位：\`4ch\` 兜住 ⇒ 数字盒宽度逐字不变 → ${r1(two.viewsnum.w)} vs ${r1(r4.viewsnum.w)}`,
        ).toBe(true);
        expect.soft(
          ITEMS.every((k) => Math.abs(two[k].w - r4[k].w) < 0.5 && Math.abs(two[k].h - r4[k].h) < 0.5)
          && Math.abs(two.wrap.left - r4.wrap.left) < 0.5,
          `换内容后四件的盒子（宽/高）与整簇位置都不动（格子是定宽的） → `
          + JSON.stringify(ITEMS.map((k) => [k, r1(two[k].w), r1(r4[k].w)])),
        ).toBe(true);
        // 格子只有 87px 宽，内容再宽就会画出胶囊之外（`.readStats` 的 `min-width: 0`
        // 只保证"不让格子顶宽"，不保证"内容装得下"）——所以这一条要单独量。
        for (const [tag, rr] of [["最窄（收藏 / 一位数字）", two], ["最宽（已收藏 / 四位数字）", r4]] as const) {
          expect.soft(
            ITEMS.every((k) => rr[k].sw <= rr[k].cw + 0.5),
            `${tag}：四件的内容都装得下格子（scrollWidth ≤ clientWidth） → `
            + JSON.stringify(ITEMS.map((k) => [k, rr[k].sw, rr[k].cw])),
          ).toBe(true);
        }
        const rmin = await paint(page, {
          markup: mk({ faved: "", text: "收藏", views: "7", likes: "0", comments: "0" }),
          legacy: "legacy-minw",
          css: LEGACY_MINW,
        });
        expect.soft(
          rmin.label.w < two.label.w - 10,
          `反向对照：把两条定宽抹掉后文案盒**确实**缩了 13px（②b 不是空断言） → `
          + `${r1(two.label.w)} → ${r1(rmin.label.w)}`,
        ).toBe(true);

        // ── ③ 超长标题下四个格子与两条侧轨逐字不动 ──
        const rnat = await paint(page, { markup: mk({ title: "短标题" }) });
        expect.soft(
          [r1(r.main.w), r1(r.main.left), r1(r.wrap.left), r1(r.author.w), r1(r.infoH)].join()
          === [r1(rnat.main.w), r1(rnat.main.left), r1(rnat.wrap.left), r1(rnat.author.w), r1(rnat.infoH)].join(),
          `与短标题时（中区宽/左缘、整簇左缘、左区宽、卡片高）逐字相等 → ${r.infoH.toFixed(1)} / ${rnat.infoH.toFixed(1)}`,
        ).toBe(true);
        expect.soft(
          r.titleW > 300,
          `标题确实占掉了空间（否则这个场景没被复现） → ${r.titleW}`,
        ).toBe(true);
        expect.soft(
          r.labelLines === 1,
          `文案只有一个行盒（没折成两行） → ${r.labelLines}`,
        ).toBe(true);

        // ── ④ 图标：四件同尺寸 14px、aria-hidden，文案仍在 span.readFavLabel ──
        for (const [name, part] of parts) {
          expect.soft(
            Math.abs(part.iconW - 14) < 0.5,
            `${name} 的图标是 svg 且 14px（与同一列另三件同源） → ${part.iconW}`,
          ).toBe(true);
          expect.soft(
            part.iconHidden === "true",
            `${name} 的图标 aria-hidden = true（读屏不念图形） → ${part.iconHidden}`,
          ).toBe(true);
        }
        const rfav0 = await paint(page, { markup: mk() });
        expect.soft(
          rfav0.labelText === "已收藏",
          `收藏文案仍在 span.readFavLabel 里（图标与文案是两个子元素） → ${rfav0.labelText}`,
        ).toBe(true);

        // ── ⑤ 三态色一字未改；讨论数与浏览同属「读数」档 ──
        expect.soft(
          rfav0.btn.bg === "rgb(255, 204, 124)",
          `已收藏 = 河灯金 #ffcc7c 实心 → ${rfav0.btn.bg}`,
        ).toBe(true);
        expect.soft(
          r.btn.bg === "rgba(0, 0, 0, 0)" || r.btn.bg === "transparent",
          `未收藏 = 透明底 + 浅色描边（第一件就是这一态） → ${r.btn.bg}`,
        ).toBe(true);
        expect.soft(
          r.btn.bc.includes("255, 241, 235"),
          `描边仍在（rgba(255,241,235,.55)） → ${r.btn.bc}`,
        ).toBe(true);
        expect.soft(
          r.labelText === "收藏",
          `未收藏文案 = 收藏（两字） → ${r.labelText}`,
        ).toBe(true);
        const liked = await paint(page, { markup: mk({ liked: " isLiked" }) });
        expect.soft(
          liked.like.bg === "rgb(255, 179, 198)",
          `已点赞 = 暖粉 #ffb3c6（与收藏的金区分开） → ${liked.like.bg}`,
        ).toBe(true);
        expect.soft(
          r.views.color !== r.btn.color,
          `浏览是读数不是按钮：字色比两个按钮淡一档 → ${r.views.color} / ${r.btn.color}`,
        ).toBe(true);
        expect.soft(
          r.com.color === r.views.color,
          `讨论数同属读数档：字色与浏览逐字相同（不给它一个「能点」的外观） → ${r.com.color} / ${r.views.color}`,
        ).toBe(true);
        expect.soft(
          new Set(ITEMS.map((k) => r[k].bc)).size === 1,
          `四件的描边色本来就相同（20261001 把它统一成一条） → ${JSON.stringify(ITEMS.map((k) => [k, r[k].bc]))}`,
        ).toBe(true);

        // ── ⑥ ★手机档（327px / 768px）：三区落成单列，四件仍 2×2 并收成 24px/4px ──
        await page.setViewportSize({ width: 768, height: 900 });
        const r6 = await paint(page, { markup: mk() });
        expect.soft(
          r6.labelLines === 1,
          `文案仍是一个行盒 → ${r6.labelLines}`,
        ).toBe(true);
        expect.soft(
          new Set(ITEMS.map((k) => r1(r6[k].h))).size === 1 && Math.abs(r6.btn.h - 24) < 0.5,
          `四件仍同高、且收成 24px（不是桌面档的 30px） → ${JSON.stringify(ITEMS.map((k) => r1(r6[k].h)))}`,
        ).toBe(true);
        expect.soft(
          Math.abs(r6.wrapGap - 4) < 0.5,
          `间距收成 4px → ${r6.wrapGap}`,
        ).toBe(true);
        expect.soft(
          new Set(ITEMS.map((k) => r1(r6[k].cx))).size === 2
          && new Set(ITEMS.map((k) => r1(r6[k].cy))).size === 2,
          `四件仍是 2×2（列变窄了，排布不跟着改） → ${JSON.stringify(ITEMS.map((k) => [k, r1(r6[k].cx), r1(r6[k].cy)]))}`,
        ).toBe(true);
        // ★ 手机档三区**必须回落成单列**：`.readInfo` 宽 = 100% − 32px ≈ 343px（768px 档
        // 也才 736px），三条 180px 的轨道根本摆不下。单列的判据 = 三区同左同宽 + 依次向下。
        expect.soft(
          Math.abs(r6.author.left - r6.main.left) < 0.5
          && Math.abs(r6.main.left - r6.wrap.left) < 0.5
          && Math.abs(r6.author.w - r6.wrap.w) < 0.5
          && r6.author.bottom <= r6.main.top + 0.5
          && r6.main.bottom <= r6.wrap.top + 0.5,
          `★三区落成单列（同左缘、同宽、依次向下） → `
          + JSON.stringify((["author", "main", "wrap"] as const).map((k) => [k, r1(r6[k].left), r1(r6[k].top)])),
        ).toBe(true);
        // ★ 这条是 20261003 把封面从 200 抬到 260 的全部理由：`.readInfo` 是
        // `bottom: B` + `translateX(-50%)` 的绝对定位盒，`.readCover` 又是 `overflow: hidden`
        // ⇒ 上沿 = 封面高 − B − 盒高（三区竖着叠起来之后盒高从 68 涨到 226）。
        expect.soft(
          r6.wrap.top >= 0 && r6.info.top >= 0,
          `★整个信息盒不越出封面顶（信息盒上沿 ${r6.info.top.toFixed(0)} / 封面 top 0） → `
          + `info top ${r6.info.top.toFixed(1)} / wrap top ${r6.wrap.top.toFixed(1)}`,
        ).toBe(true);
        let rw = r6;
        for (const w of [327, 768]) {
          await page.setViewportSize({ width: w, height: 800 });
          rw = await paint(page, { markup: mk() });
          expect.soft(
            rw.info.top >= 0 && rw.wrap.top >= 0,
            `${w}px 档同样不越界（上沿 ${rw.info.top.toFixed(0)}、簇 ${rw.wrap.top.toFixed(0)}） → `
            + `info ${rw.info.top.toFixed(1)} / wrap ${rw.wrap.top.toFixed(1)}`,
          ).toBe(true);
        }
        expect.soft(
          Math.abs(r6.wrap.w - rw.wrap.w) < 0.5 && Math.abs(r6.wrap.h - rw.wrap.h) < 0.5,
          `327px 与 768px 同属手机档：四件几何逐字相同 → `
          + `${r1(r6.wrap.w)}x${r1(r6.wrap.h)} vs ${r1(rw.wrap.w)}x${r1(rw.wrap.h)}`,
        ).toBe(true);

        // ── ⑥b 反向对照：把手机档那三条覆盖撤回 200px 那一版 ⇒ 上沿当场越界 ──
        const rm = await paint(page, { markup: mk(), legacy: "legacy-mobile", css: LEGACY_MOBILE });
        expect.soft(
          rm.info.top < -5,
          `撤回后整盒上沿 = ${rm.info.top.toFixed(0)}px（负 = 被 \`overflow: hidden\` 裁掉）——⑥ 那条判据确实有牙 → `
          + `info top ${rm.info.top.toFixed(1)}`,
        ).toBe(true);
        // 绝对定位盒是**底边锚定**的：越界时被裁掉的是**最上面那一区**（作者行），
        // 不是读数簇（它在最下面，反而还在页面里）。这条断言与上一版正好相反——
        // 上一版三区还并排、读数簇贴着上边。
        expect.soft(
          rm.author.top < 0,
          `裁掉的正好是最上面那一区（作者行 top ${rm.author.top.toFixed(0)}px） → ${rm.author.top.toFixed(1)}`,
        ).toBe(true);

        // ── ⑦ 布局锁死：四种标题长度下三区几何逐字相同，且每次都居中（20261001 第 4 条） ──
        await page.setViewportSize({ width: 1280, height: 900 });
        const titles = [
          "短文",
          "一篇中等长度的文章标题",
          "一篇标题特别长的文章：从零开始把站内对话助手接进个人博客的完整记录与踩坑清单（下篇）",
          "一篇标题特别长的文章：从零开始把站内对话助手接进个人博客的完整记录与踩坑清单（下篇）"
          + "——再补一段足够长的副标题把这一行彻底撑满看看会发生什么",
        ];
        const got: PaintResult[] = [];
        for (const t of titles) {
          got.push(await paint(page, { markup: mk({ title: t }) }));
        }
        const key = (x: PaintResult) =>
          [r1(x.main.left), r1(x.main.w), r1(x.wrap.left), r1(x.author.left), r1(x.infoH)].join();
        expect.soft(
          new Set(got.map(key)).size === 1,
          `★ 四档标题下（中区左缘/宽、整簇左缘、左区左缘、卡片高）逐字相同 → ${JSON.stringify(got.map(key))}`,
        ).toBe(true);
        expect.soft(
          got.every((x) => Math.abs(x.main.cx - x.info.cx) < 1),
          `★四档都是居中的（中区中线 = 卡片中线，与标题多长无关） → ${JSON.stringify(got.map((x) => r1(x.main.cx - x.info.cx)))}`,
        ).toBe(true);
        // ⚠️ `Range` 数的是**排版出来的**行盒，被 `-webkit-line-clamp` 裁掉的那几行仍在
        // 布局里 ⇒ 超长标题这里读到 4 而不是 2。这正是我们要的证据：标题远超两行，
        // 而盒高被上面那条判据钉死在两行。
        expect.soft(
          got[0].titleLines === 1 && got[got.length - 1].titleLines >= 3,
          `· 标题确实长出来了（否则这个场景没被复现）：一行 → 四行 → ${got[0].titleLines} → ${got[got.length - 1].titleLines}`,
        ).toBe(true);
        expect.soft(
          got[got.length - 1].titleH <= got[0].titleH + 0.5,
          `· 三行标题被截到两行（高度封顶，卡片不会被拉高） → ${got[0].titleH} vs ${got[got.length - 1].titleH}`,
        ).toBe(true);
        expect.soft(
          Math.abs(got[0].titleH - got[got.length - 1].titleH) < 0.5,
          `· 一行的标题也占两行的高度（高度恒定靠的是预留，不是靠标题别太长） → ${got[0].titleH} vs ${got[got.length - 1].titleH}`,
        ).toBe(true);

        // ── ⑦b 反向对照：两条侧轨写成不等宽 ⇒ 中区当场偏 40px（居中靠的就是「等宽」） ──
        const asym = await paint(page, {
          markup: mk({ title: titles[0] }),
          legacy: "legacy-asym",
          css: LEGACY_ASYM,
        });
        const off_asym = asym.main.cx - asym.info.cx;
        expect.soft(
          Math.abs(off_asym) > 30,
          `左 180 / 右 260 时中区偏 ${off_asym.toFixed(1)}px（①c 与 ⑦ 的 < 1px 确实有牙）`,
        ).toBe(true);
        // 顺带说明**为什么**这一条是"结构性"的：偏的正是两条轨道宽度差的一半
        // （(260 − 180) / 2 = 40），与标题多长、四件多宽都无关。
        expect.soft(
          Math.abs(Math.abs(off_asym) - 40) < 1,
          `偏移量 = 两轨宽度差的一半（(260 − 180)/2 = 40）——与内容无关 → ${Math.abs(off_asym).toFixed(1)}`,
        ).toBe(true);

        expect.soft(
          errs().length === 0,
          `无 JS 运行时报错 → ${errs().slice(0, 2).join("; ")}`,
        ).toBe(true);
      },
    );
  });
});
