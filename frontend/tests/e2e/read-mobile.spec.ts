/**
 * 文章阅读页手机档真的生效（20261001）。
 *
 *   python3 tests/read-mobile.test.py   →   npx playwright test tests/e2e/read-mobile.spec.ts
 *
 * 现场：`ReadArticle/index.sass` 末尾那段 `@media (max-width:768px)` 从写下那天
 * （`f207b6d`，commit message 写着「移动端正文全宽显示、封面/标题瘦身」）**一次都没生效过**
 * ——媒体查询不改特异性，块里裸写的 `.readContent`(0,1,0) 输给桌面那条
 * `.readContainer .readContent`(0,2,0)。375px 真机上量的结果是：正文 300px 宽（＝桌面的
 * 80%）、封面 400px 高、内边距 20px，与这一档想要的 100%/200px/12px 全不一样。
 * **它是"半死"**：同块里 `.readInfo h1` 的 `font-size` 没有桌面规则跟它抢，是活的 ⇒ 肉眼看
 * "字确实变小了"，会以为整块都在工作——所以判据只能是量几何，不能靠读代码。
 *
 * 为什么用无头浏览器而不是 node 桩：这是布局（百分比宽度、绝对定位、媒体查询命中），
 * 真 CSS = node 侧真编译的 `.sass` + 仓库那份 `* { box-sizing: border-box }` 重置。
 *
 * 锁五件：
 *   ① 编译产物里那几条**确实带着 `!important`**（这一档能不能赢全靠它——判据 ④ 的反向对照
 *      会证明没有它就回落）；
 *   ② 375px：正文满宽（= 视口）且内边距 12px 10px、封面 260px、描述卡满宽、`.readInfo`
 *      bottom 12px 且**宽度 343px（视口 − 32）居中**、`.markdown-body` max-width 100%；
 *   ③ 768/769 边界：媒体档只到 768px（769 起必须回到桌面值，否则是"溢出到桌面上"的另一种病）；
 *   ④ **反向对照**：把编译产物里这一段的 `!important` 剥掉再量一次 ⇒ 正文**确实**掉回
 *      80%（300px）、封面掉回 400px、`.readInfo` 掉回 880px（宽出屏幕）。证明 ② 不是空断言。
 *   ⑤ 1200px 桌面档一字未动：正文 880px / 内边距 20px / 封面 400px / 描述卡内边距 25px；
 *   ⑥ **正文包裹层不被宽原子顶出视口**（20261005 新档，与媒体档无关、病根在基础层那条
 *      `display:flex; flex-direction:column; align-items:center`）——夹具复现真 DOM 的三层
 *      嵌套 + 一整行不折行的代码，量包裹层宽度与 `documentElement.scrollWidth`；**红基线**
 *      单独摘掉 `.readBody` 那条规则（它没有 `!important`，④ 的剥法够不到它），必须当场
 *      顶到 2000px 以外。线上根因与实测数字写在 ⑥ 的小节头注里。
 *
 * ⚠️ 20261003：`.readInfo` 那三条（宽 880 → `calc(100% - 32px)`、三列 → 单列、bottom 45 → 12）
 * 是**顺带修掉的既有缺陷**：它从来就没有宽度覆盖，`left: 50%` + 横向 −50% 让这个 880px 的
 * 定宽盒在 375px 上两边各伸出屏幕 236px/540px —— 三列时屏幕上"剩的正好是中间那条标题"所以
 * 看不出来，改成单列（20261003 用户第 2 条）就全露馅了。本套件因此多量一条**盒子宽度**。
 *
 * （判据 ④ 之所以连"剥掉之后掉到哪"都钉住：剥完必须**恰好**回到 `.readContainer` 那条的值，
 * 说明压死它的是那条规则、而不是别的什么。根因的形状由 CI 的
 * `sass-media-shadow.test.mjs`（特异性档）全仓盯着，这一份只管"渲染出来是什么"。）
 *
 * 20261005 加了两节（同一处两个不同的病，见各自小节头注）：
 *   ⑦ 正文列内边距只留一处 + 手机档那三条死声明的**渲染值**（⑦b 是字面删规则的反向对照）；
 *   ⑧ 阅读面底色**两档**（20261008 换：白天 = 主题底 `--washi-theme-bg`（粉紫天青那张，
 *      首页首屏/登录页同一支）、夜间 = 不透明 `#121a27`）/ 正文补 0.2px 描边且**不重排**
 *      （摘掉描边那条后同段落的宽/高/行数必须逐项相同）。白天那支读的是 `var(--washi-theme-bg)`
 *      （出处 `src/index.css`，沙箱拷成 tokens.css）⇒ 夹具外面要套一层 `.frontRoot`
 *      （那两条规则的祖先选择器），暗色档另用 `.frontRoot.frontDark` 臂。本节另有一臂**反向
 *      对照**（⑧c）：把夜间那支按行为改回 `transparent`（旧写法）⇒ "不透明"那条判据当场红。
 *
 * 迁移注（TS 版）：原版 8 个沙箱变体（fixed/legacy/nobody/nopad/cmt/theme/bare/oldnight）
 * 改为同一静态服务下的 8 份 html（CSS 按 Python 版 link 次序内联，次序即特异性的一部分）。
 * Python 基线 74/0 全绿（20261019 本机），TS 版无环境差异借口。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test, type Browser } from "@playwright/test";
import { FE_DIR, compileSass, htmlDoc, withSandbox } from "./sandbox";

const SASS_FILE = path.join(
  FE_DIR,
  "src/frontHome/Content/ReadArticle/index.sass",
);
const RESET_CSS = readFileSync(path.join(FE_DIR, "src/frontHome/main.css"), "utf-8");
// 沙箱里**必须**有第三张表：编辑器那份（`components/Editor/index.css`，被 router 静态引入
// ⇒ 线上对每一个 `.markdown-body` 都生效）。第 ⑦ 节量的那种缺陷**就是它漏进来的**
//（`.markdown-body{padding:45px}` + 媒体档 15px，打在正文那两层嵌套上 ⇒ 桌面 45+45、
// 手机 15+15 全叠）——不把它放进沙箱，判据测的是一个"没有编辑器样式表的世界"，
// 上一轮那句"手机档内边距 12px 10px 已经对了"就是这么落在空处的。
// 次序照线上：编辑器表在前、本仓 sass 在后（产物里 `components/Editor` 在 ReadArticle 之前）。
const EDITOR_CSS = readFileSync(
  path.join(FE_DIR, "src/components/Editor/index.css"),
  "utf-8",
);
const TOKENS_CSS = readFileSync(path.join(FE_DIR, "src/index.css"), "utf-8");

// 与 index.tsx 同形：.readContainer > (.readCover > .readInfo) + .readDescription
// + .readContent.markdown-body（正文那两个类在同一个元素上，见 index.tsx:622）
// `.readInfo` 里只渲染中区（标题那一格）：本套件量的是正文/描述卡/封面的几何与标题字号，
// 左区（作者+时间）与右区（读数四件）不参与任何一条判据 —— 它们的几何在
// `read-stats-cluster.test.py` 里是主角，那边有完整的三区夹具。
// 20261005 起夹具里补上了真 DOM 的**三层嵌套**（`.readContent > .readBody > #content`）：
// 正文包裹层那一条（判据 ⑥）只有在子项真的挂在 `.readContent` 下面时才量得出来。
// 旧夹具把 `<p>正文</p>` 直接挂在 `.readContent` 上，`.readBody` 整层不存在 ⇒ 那一类
// 缺陷它一条都看不见。②–⑤ 量的是 `.readContent`/`.readDescription`/`.readCover`/`.readInfo`
// 自己的盒子，加一层 `width:100%` 的包裹不影响它们。
const MARKUP = `
<div class="readContainer">
  <div class="readCover">
    <div class="readInfo"><div class="readMain"><h1>标题</h1></div></div>
  </div>
  <div class="readDescription"><p>摘要</p></div>
  <div class="readContent markdown-body">
    <div class="readBody"><div id="content" class="markdown-body">
      <div class="markdown-body"><p>正文</p></div>
    </div></div>
  </div>
</div>
`;

// 判据 ⑥ 的夹具：一个**宽原子**（一整行不折行的代码）。真页面上 `code` 的
// `white-space: pre` 来自 bytemd/hljs（线上实测 computed：`pre` = pre-wrap、`code` = pre），
// 本沙箱只加载本仓那份 sass + 复位表，所以这一条由夹具自己写 —— 这是**补沙箱缺的那张表**，
// 不是给被测规则开后门：`.readBody` 与 `pre` 那两条都不碰 `code` 的 white-space。
const WIDE_ATOM = `<pre><code style="white-space: pre">${"abcdefghij".repeat(60)}</code></pre>`;
const MARKUP_WIDE = `
<div class="readContainer">
  <div class="readCover"><div class="readInfo"><div class="readMain"><h1>标题</h1></div></div></div>
  <div class="readContent markdown-body">
    <div class="readBody"><div id="content" class="markdown-body">
      <div class="markdown-body">${WIDE_ATOM}</div>
    </div></div>
    <div class="navigation" id="toc"></div>
  </div>
</div>
`;

// 判据 ⑦ 的夹具：正文那两层嵌套里放齐"会被手机档那几条声明改到"的三种块
//（h1 / p / pre），量它们的**渲染值**。h1 与 p 是 20261005 之前"写了但被压死"的那几条，
// pre 是只有 `overflow-x` 活着的那一条。
const MARKUP_TEXT = `
<div class="readContainer">
  <div class="readContent markdown-body">
    <div class="readBody"><div id="content" class="markdown-body">
      <div class="markdown-body">
        <h1>正文里的一级标题</h1>
        <p>第一段正文，用来量字号与行距。</p>
        <p>第二段正文，用来量段间距。</p>
        <pre><code>echo hello</code></pre>
      </div>
    </div></div>
  </div>
</div>
`;

const MQ = "@media only screen and (max-width: 768px)";

// 判据 ⑧ 的夹具：底色 + 描边。比 ⑦ 多两件东西 ——
//   ① 外面套一层 `.frontRoot`：底色那两条规则的祖先选择器就是它
//     （`.frontRoot:not(.frontDark) &` / `.frontDark &`），夹具里没有它，这两条**一条都不命中**，
//      量到的永远是"没有背景"（上一版沙箱就是这样，"白天底色"这个缺陷它根本看不见）；
//   ② 一只**会折行的长段落** + 一只 `li` + 一段行内 `code` + 一个 `pre > code`：
//      描边要覆盖正文（含列表），要**避开**代码；而"不重排"这一条必须有会折行的段落才量得出来
//      —— 单行段落摘掉描边也还是单行，行数判据恒真。段落里混排中英，让断行点不是某个整数。
const COLOR_MARKUP = `
<div class="frontRoot">
  <div class="readContainer">
    <div class="readContent markdown-body">
      <div class="readBody"><div id="content" class="markdown-body">
        <div class="markdown-body">
          <h1>正文里的标题</h1>
          <p>这是一段会折行的正文，用来量描边会不会改变字形的前进宽度。汉字与 Latin 混排，
             line wrapping 的断点落在哪里由字体度量决定，只要前进宽度一个像素都不变，
             段落的高度、宽度与行数就应当逐像素相同。这段要够长，长到在 836 的列宽里
             至少折成三行，否则行数判据没有分辨力。再补一句让它更长一些，再多补两句：
             正文列 20261010 从 660 撑到 836 之后，同样的字数会少折一行，所以夹具的长度
             必须跟着版面的有效宽走——改宽了它就要重新量一遍，否则这条不重排判据没有
             分辨力。这里再多写一点，确保在三行以上稳定成立。</p>
          <ul><li>列表项也要被描边覆盖</li></ul>
          <p>行内代码 <code>npm test</code> 应当被清零。</p>
          <pre><code>echo hello</code></pre>
        </div>
      </div></div>
    </div>
  </div>
</div>
`;

// 这一段里该有的 !important 条数（`.readContent` / `.readDescription` 各宽+内边距 4 条、
// 封面高 1、`.readInfo` 的列数/行距/宽/max-width/横向居中/bottom/内边距 7 条、
// 正文 max-width 1、pre 的 overflow-x 1）。反向对照剥的就是它们。
const N_IMPORTANT = 14;
const STRIP = [
  "width: 100% !important", // 出现两次（正文与描述卡各一，字面相同）
  "padding: 12px 10px !important",
  "padding: 12px !important",
  "height: 260px !important",
  "grid-template-columns: 1fr !important",
  "row-gap: 10px !important",
  "width: calc(100% - 32px) !important",
  "max-width: calc(100% - 32px) !important",
  "transform: translateX(-50%) !important",
  "bottom: 12px !important",
  "padding: 12px 16px !important",
  "max-width: 100% !important",
  // 20261005：`pre` 这条由 `hidden` 改成 `auto`（长代码行改成可横向滑，理由见 sass 同处
  // 注释）。反向对照要剥的仍然是**这一条**，只是取的值变了。
  "overflow-x: auto !important",
];

const CSS = compileSass(SASS_FILE);

// 这一段媒体档在产物里的**字面区间**：反向对照只剥它里面的 !important（别处的 !important
// 一概不动，否则对照证明不了"压死它的就是桌面那条"）。用花括号配对找结尾，不靠猜缩进。
function blockRegion(css: string, header: string): [number, number] {
  const i = css.lastIndexOf(header);
  if (i < 0) throw new Error(`产物里找不到媒体档头 ${header}`);
  const k = css.indexOf("{", i);
  let depth = 1;
  let j = k + 1;
  while (depth > 0) {
    if (css[j] === "{") depth += 1;
    else if (css[j] === "}") depth -= 1;
    j += 1;
  }
  return [i, j];
}

const [START, END] = blockRegion(CSS, MQ);
const BLOCK = CSS.slice(START, END);
const LEGACY = CSS.slice(0, START) + BLOCK.replaceAll(" !important", "") + CSS.slice(END);

// 判据 ⑥ 的反向对照：**单独**摘掉 `.readBody` 那条（它写的是基础层、没有 `!important`，
// 上面那份 LEGACY 剥不到它）。摘掉之后正文包裹层回到"由 fit-content 定尺"，宽原子当场
// 把整层顶出去 —— 这条对照是 ⑥ 的全部意义所在。
const mBody = CSS.match(/\.readContainer \.readContent \.readBody \{[^}]*\}/);
if (mBody === null)
  throw new Error(
    "编译产物里没有 `.readContainer .readContent .readBody` 规则 ——" +
      " 类名（index.tsx 的 className='readBody'）与 sass 对不上了",
  );
const NO_BODY =
  CSS.slice(0, mBody.index!) + CSS.slice(mBody.index! + mBody[0].length);

// 判据 ⑦b 的反向对照：**删掉** 20261005 新加的那两条内边距规则，其余一字不动
//（编辑器表在、手机档的 !important 也全在）⇒ 手机档正文列必须掉回 310px。
// 这是"改动前那一臂"的取法：按**字面**删本次新增的规则，**不读 `git show HEAD:`**
//（提交之后它取到的就是改动后那份，两条臂逐字相同、红基线恒真 —— 同族教训见
// `mermaid-mobile-zoom.test.py` 的换臂注释）。
function dropRules(css: string, sel: string): string {
  const needle = sel + " {";
  const n = css.split(needle).length - 1;
  if (n === 0)
    throw new Error(`编译产物里找不到 \`${needle}\` —— 内边距那两条改名了，⑦b 要先对齐`);
  let out = css;
  for (let i = 0; i < n; i++) {
    const at = out.indexOf(needle);
    out = out.slice(0, at) + out.slice(at).replace(/^[^}]*}/, "");
  }
  return out;
}

const NO_PAD = dropRules(
  dropRules(
    CSS,
    ".readContainer .readContent .readBody > .markdown-body > .markdown-body",
  ),
  ".readContainer .readContent .readBody > .markdown-body",
);

// ⑧ 的不重排对照臂：按**字面**把描边摘掉（1 处，锚点命中数先断言），其余一字不动。
// 与 ⑦b 同一取法：不读 `git show HEAD:`（提交之后两条臂会逐字相同、红基线恒真）。
const STROKE = "-webkit-text-stroke: 0.2px currentColor;";
const strokeCount = CSS.split(STROKE).length - 1;
if (strokeCount !== 1)
  throw new Error(
    `编译产物里 \`${STROKE}\` 出现 ${strokeCount} 次（应为 1）` +
      " —— 描边那条改名/挪窝了，⑧ 的不重排对照要先对齐",
  );
const NO_STROKE = CSS.replace(STROKE, "-webkit-text-stroke: 0;");

// ⑧c 的反向对照：把夜间那支**按行为**改回旧写法（transparent）⇒ 判据必须当场红。
// 为什么非要这一臂：本轮修的病**全在"不透明"这三个字上**，而"不透明"在源码文本里
// 看不出来（`background: transparent` 与 `background: #121a27` 都是一行合法 sass，
// 而前者在脱离泄漏之后会静默变成浅灰底）。剥掉行为、量到的也必须是行为。
// 取法是锚点（正则命中那一块 + 块内那条 background）而不是写死字符串：dart-sass
// 对 `#121a27` 的输出形式（hex 还是 rgb()）不是本套件该钉的东西。
const mNight = CSS.match(/\.frontDark \.readContainer\s*\{([^}]*)\}/);
if (mNight === null)
  throw new Error(
    "编译产物里找不到 `.frontDark .readContainer{}` —— 夜间底色挪窝了，⑧c 的反向对照要先对齐",
  );
const mNightBg = mNight[0].match(/background:\s*[^;]+;/);
if (mNightBg === null)
  throw new Error(`夜间那一块里没有 background：${mNight[0]}`);
const NIGHT_OLD = CSS.replace(
  mNight[0],
  mNight[0].replace(mNightBg[0], "background: transparent;"),
);

// ── 浏览器侧测量函数（与 Python 版逐字对应的计算语义）──────────────────────

interface Box {
  w: number;
  h: number;
  left: number;
  right: number;
  padL: string;
  maxW: string;
  bottom: string;
}
interface MeasureM {
  vw: number;
  mq: boolean;
  h1fs: string;
  content: Box;
  desc: Box;
  cover: Box;
  info: Box;
}

function measureIn(browser: Browser, errs: string[], url: string, width: number) {
  return async (markup: string): Promise<MeasureM> => {
    const pg = await browser.newPage({ viewport: { width, height: 900 } });
    pg.on("pageerror", (e) => errs.push(String(e)));
    await pg.goto(url);
    await pg.waitForTimeout(120);
    const out = await pg.evaluate(
      (m: string) => {
        document.getElementById("root")!.innerHTML = m;
        const box = (s: string): Box => {
          const e = document.querySelector(s)!;
          const r = e.getBoundingClientRect();
          const cs = getComputedStyle(e);
          return {
            w: r.width,
            h: r.height,
            left: r.left,
            right: r.right,
            padL: cs.paddingLeft,
            maxW: cs.maxWidth,
            bottom: cs.bottom,
          };
        };
        return {
          vw: window.innerWidth,
          mq: window.matchMedia("(max-width: 768px)").matches,
          h1fs: getComputedStyle(document.querySelector(".readInfo h1")!).fontSize,
          content: box(".readContent"),
          desc: box(".readDescription"),
          cover: box(".readCover"),
          info: box(".readInfo"),
        };
      },
      markup,
    );
    await pg.close();
    return out;
  };
}

interface WideM {
  w: number;
  l: number;
  r: number;
  docScrollW: number;
  clientW: number;
  // 代码块自己能不能横向滑（`pre` 那条 20261005 由 hidden 改成 auto）
  preScrollW: number | null;
  preClientW: number | null;
}

interface CsBox {
  padL: string;
  padR: string;
  w: number;
  lh: string;
  fs: string;
  x: number;
}
interface LayoutM {
  vw: number;
  mq: boolean;
  outer: CsBox;
  inner: CsBox;
  p: CsBox;
  h1: CsBox;
  pre: CsBox;
  pW: number[];
}

interface ColorCs {
  bg: string;
  bi: string;
  sw: string;
  sc: string;
  color: string;
  w: number;
  h: number;
  fs: string;
}
interface ColorM {
  light: ColorCs;
  p: ColorCs;
  li: ColorCs;
  h1: ColorCs;
  pre: ColorCs;
  code: ColorCs;
  inlineCode: ColorCs;
  lines: number;
  tile: string;
  themebg: string;
}

test.describe("文章阅读页手机档", () => {
  test.setTimeout(120_000);

  test("媒体档生效 + 边界 + 三组反向对照 + 描边不重排（74 条）", async ({
    browser,
  }) => {
    const errs: string[] = [];

    await withSandbox({}, async (sb) => {
      // 8 份变体 html：CSS 按 Python 版 link 次序内联（次序即特异性的一部分）。
      // theme/bare/oldnight 与其余的差别 = 多内联一张 tokens.css（`src/index.css`，
      // 底色那支 20261008 第二轮起读 `--washi-theme-bg`，出处就是这张表——少一张
      // 就量不出东西：令牌没定义时 `var()` 整条 background 落空，白天那支会变成透明
      //（而"透明"正好是旧写法，判据会以为改回去了））。
      const doc = (...css: string[]) => htmlDoc('<div id="root"></div>', ...css);
      await sb.write("fixed.html", doc(RESET_CSS, EDITOR_CSS, CSS));
      await sb.write("legacy.html", doc(RESET_CSS, EDITOR_CSS, LEGACY));
      await sb.write("nobody.html", doc(RESET_CSS, EDITOR_CSS, NO_BODY));
      await sb.write("nopad.html", doc(RESET_CSS, EDITOR_CSS, NO_PAD));
      const cmtCss = compileSass(
        path.join(FE_DIR, "src/components/CommentSection/index.sass"),
      );
      await sb.write("cmt.html", doc(RESET_CSS, EDITOR_CSS, cmtCss));
      await sb.write("theme.html", doc(RESET_CSS, TOKENS_CSS, EDITOR_CSS, CSS));
      await sb.write("bare.html", doc(RESET_CSS, TOKENS_CSS, EDITOR_CSS, NO_STROKE));
      await sb.write(
        "oldnight.html",
        doc(RESET_CSS, TOKENS_CSS, EDITOR_CSS, NIGHT_OLD),
      );
      const u = (name: string) => new URL(name, sb.url).toString();

      // ── ① 编译产物里这几条确实带 !important（这一档能赢全靠它） ──
      expect
        .soft(
          BLOCK.split("!important").length - 1 === N_IMPORTANT,
          `这一段媒体档里有 ${N_IMPORTANT} 条 !important（剥掉它们就是判据 ④ 的对照） → ${BLOCK.split("!important").length - 1}`,
        )
        .toBe(true);
      for (const s of STRIP) {
        expect
          .soft(BLOCK.includes(s), `  \`${s}\` 在这段里 → ${s.replace(" !important", "")}`)
          .toBe(true);
      }

      // ── ② 375px：这一档真的生效 ──
      const PAGE_URL = u("fixed.html");
      const measure = (url: string, width: number) =>
        measureIn(browser, errs, url, width)(MARKUP);
      const m = await measure(PAGE_URL, 375);
      expect.soft(m.mq === true, `媒体档命中（判据的前提） → ${m.mq}`).toBe(true);
      expect
        .soft(
          Math.abs(m.content.w - 375) < 1,
          `正文满宽 = 视口 375（不是桌面的 80%＝300） → w=${m.content.w}`,
        )
        .toBe(true);
      expect
        .soft(
          Math.abs(parseFloat(m.content.padL) - 10) < 0.5,
          `正文内边距 12px 10px（不是 20px） → ${m.content.padL}`,
        )
        .toBe(true);
      expect
        .soft(
          Math.abs(m.cover.h - 260) < 1,
          `封面高 260px（不是 400） → h=${m.cover.h}`,
        )
        .toBe(true);
      expect
        .soft(
          Math.abs(parseFloat(m.info.bottom) - 12) < 0.5,
          `封面信息条 bottom 12px（不是 45） → ${m.info.bottom}`,
        )
        .toBe(true);
      // ★ 20261003 顺带修掉的那条既有缺陷：`.readInfo` 基础规则写死 880px（桌面三列的账），
      // 手机档从来没有宽度覆盖 ⇒ `left: 50%` + 横向 −50% 让这个 880px 的盒子两边各伸出屏幕
      // 一大截，靠 `overflow: hidden` 裁掉。三列时屏幕上剩的正好是中间那条标题（看不出来），
      // 改成单列之后左区/右区会全部跑到屏幕外 —— 所以单列必须与这条宽度一起改。
      expect
        .soft(
          Math.abs(m.info.w - 343) < 1,
          `★信息条宽 = 视口 − 32（343px，不是桌面的 880） → w=${m.info.w}`,
        )
        .toBe(true);
      expect
        .soft(
          Math.abs(m.info.left - 16) < 1 && Math.abs(m.info.right - 359) < 1,
          `  且两侧各留 16px 居中（左缘 16 / 右缘 359） → left ${m.info.left.toFixed(1)} / right ${m.info.right.toFixed(1)}`,
        )
        .toBe(true);
      expect
        .soft(
          Math.abs(m.desc.w - 375) < 1 && Math.abs(parseFloat(m.desc.padL) - 12) < 0.5,
          `描述卡满宽 375 且内边距 12px（不是 25） → w=${m.desc.w} pad=${m.desc.padL}`,
        )
        .toBe(true);
      expect
        .soft(
          m.content.maxW === "100%",
          `.markdown-body max-width 100%（不是 880px） → ${m.content.maxW}`,
        )
        .toBe(true);

      // ── ③ 边界：媒体档到 768px 为止 ──
      const m768 = await measure(PAGE_URL, 768);
      const m769 = await measure(PAGE_URL, 769);
      expect
        .soft(
          Math.abs(m768.content.w - 768) < 1,
          `768px 仍在这档里（正文满宽） → w=${m768.content.w}`,
        )
        .toBe(true);
      expect
        .soft(
          Math.abs(m769.content.w - 769 * 0.8) < 1.5,
          `769px 回到桌面档（正文 80%，需要时受 880 上限约束） → w=${m769.content.w}`,
        )
        .toBe(true);
      expect
        .soft(
          Math.abs(m769.cover.h - 400) < 1,
          `  769px 封面回到 400px → h=${m769.cover.h}`,
        )
        .toBe(true);

      // ── ④ 反向对照：剥掉这段的 !important ⇒ 真的掉回桌面值（证明 ② 不是空断言） ──
      const l = await measure(u("legacy.html"), 375);
      expect
        .soft(l.mq === true, `媒体档仍命中（对面不是靠「没命中」取胜的） → ${l.mq}`)
        .toBe(true);
      expect
        .soft(
          Math.abs(l.content.w - 300) < 1.5,
          `  正文掉回 300px（＝375×80%，就是 \`.readContainer .readContent\` 那条） → w=${l.content.w}`,
        )
        .toBe(true);
      expect
        .soft(
          Math.abs(parseFloat(l.content.padL) - 22) < 0.5,
          `  正文内边距掉回 22px → ${l.content.padL}`,
        )
        .toBe(true);
      expect
        .soft(
          Math.abs(l.cover.h - 400) < 1,
          `  封面掉回 400px → h=${l.cover.h}`,
        )
        .toBe(true);
      expect
        .soft(
          Math.abs(parseFloat(l.info.bottom) - 45) < 0.5,
          `  封面信息条掉回 45px → ${l.info.bottom}`,
        )
        .toBe(true);
      // 顺带把"手机上原来是什么样"钉住：880px 的定宽盒在 375px 视口里左缘 −252.5px
      //（= 187.5 − 440），两边各伸出屏幕一大截 —— 这就是 20261003 顺带修掉的那条缺陷。
      expect
        .soft(
          Math.abs(l.info.w - 880) < 1 && l.info.left < -200,
          `  信息条掉回 880px 宽、左缘 −252.5px（整块宽出屏幕，靠裁切才看得见） → w=${l.info.w} left=${l.info.left.toFixed(1)}`,
        )
        .toBe(true);
      // "半死"的证据：同一块里 h1 的字号没有任何桌面规则跟它抢 ⇒ 剥不剥 !important 都不变，
      // 所以肉眼看"字变小了"会以为整块在干活。这条同时是②的陪衬：不是所有声明都靠 !important 活着。
      expect
        .soft(
          l.h1fs === m.h1fs,
          `  同一次对照里 \`.readInfo h1\` 字号**一个像素没变**（它是这块里本来就没被压的那条） → legacy ${l.h1fs} / fixed ${m.h1fs}`,
        )
        .toBe(true);

      // ── ⑤ 桌面档一字未动（1200px） ──
      const d = await measure(PAGE_URL, 1200);
      expect.soft(d.mq === false, `媒体档不命中 → ${d.mq}`).toBe(true);
      expect
        .soft(
          Math.abs(d.content.w - 880) < 1,
          `正文 880px（max-width 生效） → w=${d.content.w}`,
        )
        .toBe(true);
      expect
        .soft(
          Math.abs(parseFloat(d.content.padL) - 22) < 0.5,
          `正文内边距 22px → ${d.content.padL}`,
        )
        .toBe(true);
      expect
        .soft(Math.abs(d.cover.h - 400) < 1, `封面 400px → h=${d.cover.h}`)
        .toBe(true);
      expect
        .soft(
          Math.abs(parseFloat(d.desc.padL) - 25) < 0.5,
          `描述卡内边距 25px → ${d.desc.padL}`,
        )
        .toBe(true);

      // ── ⑥ 正文包裹层：宽原子不许把整层顶出视口（20261005 新档） ──
      // 现场：手机档文章页正文被左右切开。根因**不在媒体档**，在基础规则那条
      // `.readContent { display:flex; flex-direction:column; align-items:center }` ——
      // flex 竖列 + 居中 ⇒ 子项在**交叉轴**上按 fit-content 定尺，而 fit-content 的下限是
      // min-content。正文里只要有**一个** min-content 超过视口的原子，这一层就被顶宽、
      // 左右对称溢出；`html { overflow-x: hidden }` 把两边裁掉 ⇒ 症状是"正文被切了"，
      // 不是"能左右滑"（浏览器连滚动条都不给）。
      // 线上实测（20261005 05:5x，`/article/16`，390×844 DPR2 移动 UA）：
      //   `.readContent` = 390px(x=0)，**它的子项 = 658.7px(x=−134.4)**，`window.innerWidth`
      //   被撑到 524（视觉视口缩小）。触发它的原子就是 `<pre><code>`——`code` 拿到
      //   `white-space: pre` 之后，**最长那一行代码的宽度就是这一层的 min-content**
      //   （该文最长行 69 字符 ⇒ 598.7px > 370px 可用宽度）。
      // 修法 = 基础层给包裹层一条 `width: 100%`（`.readBody`，见 sass 同处注释）。
      const measureWide = async (url: string): Promise<WideM> => {
        const pg = await browser.newPage({ viewport: { width: 390, height: 844 } });
        pg.on("pageerror", (e) => errs.push(String(e)));
        await pg.goto(url);
        await pg.waitForTimeout(120);
        const out = await pg.evaluate(
          (m: string) => {
            document.getElementById("root")!.innerHTML = m;
            const w = document.querySelector(".readBody")!;
            const r = w.getBoundingClientRect();
            const pre = document.querySelector("pre");
            return {
              w: +r.width.toFixed(1),
              l: +r.left.toFixed(1),
              r: +r.right.toFixed(1),
              docScrollW: document.documentElement.scrollWidth,
              clientW: document.documentElement.clientWidth,
              preScrollW: pre ? pre.scrollWidth : null,
              preClientW: pre ? pre.clientWidth : null,
            };
          },
          MARKUP_WIDE,
        );
        await pg.close();
        return out;
      };

      // 夹具自检：宽原子真的挂在 `.readBody` 里、`pre` 真的超宽 —— 少了这一条，下面
      // "没有溢出"在夹具根本没造出宽原子时也是绿的。
      const fx = await measureWide(PAGE_URL);
      expect
        .soft(
          fx.preScrollW !== null &&
            fx.preClientW !== null &&
            fx.preScrollW > 3000 &&
            fx.preScrollW > fx.preClientW * 5,
          `★夹具自检：代码块内容宽 ${fx.preScrollW}px 远大于其可见宽 ${fx.preClientW}px（宽原子真的造出来了，否则下面的判据是空的） → ${JSON.stringify(fx)}`,
        )
        .toBe(true);
      expect
        .soft(
          Math.abs(fx.w - 370) < 1 && Math.abs(fx.l - 10) < 1 && Math.abs(fx.r - 380) < 1,
          `★正文包裹层 = 视口 − 左右内边距（370px，左缘 10 / 右缘 380） → w=${fx.w} l=${fx.l} r=${fx.r}`,
        )
        .toBe(true);
      expect
        .soft(
          fx.docScrollW <= 390,
          `★页面级没有横向溢出（documentElement.scrollWidth ≤ 视口 390） → scrollW=${fx.docScrollW} clientW=${fx.clientW}`,
        )
        .toBe(true);
      expect
        .soft(
          fx.preScrollW !== null &&
            fx.preClientW !== null &&
            fx.preScrollW > fx.preClientW,
          `  超长代码行由**代码块自己**横向滑（\`pre\` scrollWidth > clientWidth） → ${fx.preScrollW} / ${fx.preClientW}`,
        )
        .toBe(true);

      // ── ⑥b 反向对照：单独摘掉 `.readBody` 那条 ⇒ 整层当场被顶出去（证明 ⑥ 不是空断言） ──
      const nb = await measureWide(u("nobody.html"));
      expect
        .soft(
          nb.w > 2000 && nb.l < -2000,
          `★对照组里包裹层被顶到 min-content（> 2000px）且左缘远在屏幕外 → w=${nb.w} l=${nb.l}`,
        )
        .toBe(true);
      expect
        .soft(
          nb.docScrollW > 390,
          `★对照组里页面级横向溢出确实存在（这正是「被切开」的成因） → scrollW=${nb.docScrollW}`,
        )
        .toBe(true);
      expect
        .soft(
          nb.preScrollW === fx.preScrollW,
          `  对照组与修好那版**只差那一条**（两边 \`pre\` 都是 auto、都在滑） → ${nb.preScrollW} vs ${fx.preScrollW}`,
        )
        .toBe(true);

      // ── ⑦ 正文列的内边距只留一处 + 手机档那三条死声明真的活了（20261005 新档） ──
      // 现场：正文是**两层** `.markdown-body` 嵌套（`#content` + bytemd Viewer 自己那层），
      // 而编辑器样式表那两条 padding 是 class 选择器 —— 不管你在第几层都命中
      // ⇒ 桌面 45+45、手机 15+15 **全部叠加**。用户报的「左右两侧空白还多」就是它：
      // 线上实测 390px 左右各 40px，正文列只剩 310px。
      // 同一族的另一副面孔：媒体档里 `.markdown-body h1/p/pre` 那几条 (0,1,x) 被基础层的
      // (0,2,1)/(0,3,1) 压死，**一条都没生效过**（头注却写着"它们是干净的"）。所以本节
      // 只读 computed 值 —— "源码里写着"与"渲染成这样"在这一族里根本不是一回事。
      const measureLayout = async (url: string, width: number): Promise<LayoutM> => {
        const pg = await browser.newPage({ viewport: { width, height: 900 } });
        pg.on("pageerror", (e) => errs.push(String(e)));
        await pg.goto(url);
        await pg.waitForTimeout(120);
        const out = await pg.evaluate(
          (m: string) => {
            document.getElementById("root")!.innerHTML = m;
            const cs = (s: string): CsBox => {
              const e = document.querySelector(s)!;
              const c = getComputedStyle(e);
              const r = e.getBoundingClientRect();
              return {
                padL: c.paddingLeft,
                padR: c.paddingRight,
                w: +r.width.toFixed(1),
                lh: c.lineHeight,
                fs: c.fontSize,
                x: +r.left.toFixed(1),
              };
            };
            return {
              vw: innerWidth,
              mq: matchMedia("(max-width: 768px)").matches,
              outer: cs(".readBody > .markdown-body"),
              inner: cs(".readBody > .markdown-body > .markdown-body"),
              p: cs(".readBody p"),
              h1: cs(".readBody h1"),
              pre: cs(".readBody pre"),
              pW: [...document.querySelectorAll(".readBody p")].map((e) =>
                +e.getBoundingClientRect().width.toFixed(1),
              ),
            };
          },
          MARKUP_TEXT,
        );
        await pg.close();
        return out;
      };

      const t = await measureLayout(PAGE_URL, 390);
      expect.soft(t.mq === true, `前提：这一节量的就是手机档 → ${t.mq}`).toBe(true);
      expect
        .soft(
          t.outer.padL === "12px" && t.inner.padL === "0px",
          `★两层都不再吃编辑器那 15px（外层 12 / 内层 0） → 外 ${t.outer.padL} / 内 ${t.inner.padL}`,
        )
        .toBe(true);
      expect
        .soft(
          Math.abs(t.pW[0] - 346) < 1,
          `★正文列 ${t.pW[0]}px（= 390 − 2×10 − 2×12 = 346；改动前是 310） → ${JSON.stringify(t.pW)}`,
        )
        .toBe(true);
      expect
        .soft(
          t.p.fs === "17px" && Math.abs(parseFloat(t.p.lh) - 28.9) < 0.2,
          `  正文 17px / 行高 ${t.p.lh}（= 1.7 × 17 = 28.9px；这条原来被压死，手机档一直吃的是桌面那个行高） → ${JSON.stringify(t.p)}`,
        )
        .toBe(true);
      expect
        .soft(
          t.h1.fs === "25.6px",
          `  \`h1\` = ${t.h1.fs}（1.6rem；基础档 3.5rem = 56px，手机档原来也是它） → ${t.h1.fs}`,
        )
        .toBe(true);
      expect
        .soft(
          t.pre.fs === "13px",
          `  \`pre\` = ${t.pre.fs}（手机档那一条原来同样没生效） → ${t.pre.fs}`,
        )
        .toBe(true);

      const dl = await measureLayout(PAGE_URL, 1440);
      expect
        .soft(
          Math.abs(dl.pW[0] - 836) < 1 &&
            dl.outer.padL === "0px" &&
            dl.inner.padL === "0px",
          `★桌面档正文列 836px（＝880 − 2×22，与讨论区正文列同宽，20261010 改） → p=${dl.pW[0]} 外 ${dl.outer.padL} / 内 ${dl.inner.padL}`,
        )
        .toBe(true);
      expect
        .soft(
          dl.p.fs === "17px" && Math.abs(parseFloat(dl.p.lh) - 31.45) < 0.3,
          `  桌面档正文 17px / 行高 ${dl.p.lh}（= 1.85 × 17 ≈ 31.45px） → ${JSON.stringify(dl.p)}`,
        )
        .toBe(true);
      expect
        .soft(
          dl.h1.fs === "56px",
          `  桌面档 \`h1\` 仍是 3.5rem = ${dl.h1.fs}（媒体档没有漏到桌面） → ${dl.h1.fs}`,
        )
        .toBe(true);

      // 20261010 补：这一条钉的是**跨组件**的不变量——正文列与讨论区（`CommentSection`）
      // 正文列同宽。它靠的是"两边容器横向内边距同值（各 22px）"，而讨论区是**另一个组件**
      // 的 sass，本套件默认不编译它。只钉自己这侧的 836 是钉不住的：哪天讨论区把 22 改成
      // 别的一档，两栏就悄悄错开、而上面那条判据照样全绿。所以现场编译那份 sass，量它
      // **渲染后**的内容盒宽（`clientWidth` 已去掉卡片那 1px 边框，再减左右内边距）。
      {
        const pg = await browser.newPage({ viewport: { width: 1440, height: 900 } });
        await pg.goto(u("cmt.html"));
        await pg.waitForTimeout(80);
        const c = await pg.evaluate(() => {
          document.getElementById("root")!.innerHTML =
            '<div class="commentSection"><div class="commentThread"><div class="commentRow">' +
            '<img class="commentAvatar" alt=""><div class="commentMain">' +
            '<div class="commentBody markdown-body"><p>讨论区正文</p></div>' +
            "</div></div></div></div>";
          const sec = document.querySelector(".commentSection")!;
          const cs = getComputedStyle(sec);
          const p = document.querySelector(".commentMain p")!.getBoundingClientRect();
          return {
            inner:
              sec.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight),
            padL: parseFloat(cs.paddingLeft),
            mainW: p.width,
          };
        });
        await pg.close();
        expect
          .soft(
            Math.abs(c.inner - dl.pW[0]) < 3 && Math.abs(c.padL - 22) < 0.5,
            `★讨论区内容盒 ${c.inner.toFixed(0)}px 与正文列 ${dl.pW[0].toFixed(0)}px 同宽（两边容器横向内边距都是 22px；讨论区另吃卡片那 1px×2 边框，故差 2px） → 讨论区 inner=${c.inner.toFixed(1)} padL=${c.padL} / 正文 p=${dl.pW[0]}`,
          )
          .toBe(true);
      }

      // ── ⑦b 反向对照：字面删掉新加的那两条内边距规则 ⇒ 手机档正文列当场掉回 310px ──
      const nl = await measureLayout(u("nopad.html"), 390);
      expect
        .soft(
          nl.outer.padL === "15px",
          `★对照里外层的左内边距回到编辑器那 15px（缺陷本体） → ${nl.outer.padL}`,
        )
        .toBe(true);
      expect
        .soft(
          nl.pW[0] <= 320,
          `★正文列掉回 ${nl.pW[0]}px（≤320：两层 15px 全叠才会是这个数） → ${JSON.stringify(nl.pW)}`,
        )
        .toBe(true);

      // ── ⑧ 阅读面底色两档（20261008 换底）+ 正文补 0.2px 描边（20261005 第二轮） ──
      // 同一处几轮反馈、两个不同的病：
      //   ① 底色。20261008 用户：「夜间模式什么时候改的文章详情页的背景颜色，文本都看不清了，
      //      该回去，白天模式背景也改成博客主题背景」——两档一起改，改掉的其实是同一个病：
      //      这一支从前**夜间写 transparent**，等于把阅读面的底抵押给了 `body`；而 `body` 上
      //      那张深色底是登录页一条裸 `body` 规则漏出来的。ca6b9b0（20261006）把它收成
      //      `body.login-route` ⇒ 泄漏断了，`body` 退回后台模板的 #E4E9F7 ⇒ 夜间阅读面成了
      //      33% 黑压在浅紫蓝上的 rgb(153,156,165)（白字 2.76:1）。成因全在 sass 那段注释里。
      //      本节钉**渲染值**：白天那支必须是主题底那条渐变（两端色值都在 computed 里）、
      //      **且不再等于站内内容页那支**（用户第二轮就是否掉了那支："白天怎么文章详情页是
      //      纯白，不是博客主题色系背景"——半透明白遮罩叠出来是 rgb(246,248,251) 的近白，
      //      铺满一篇长文就是一整幅白）；夜间那支必须**不透明**且是 rgb(18,26,39)。"不透明"
      //      是夜间那条判据的关键：旧写法 transparent 的 computed 值是 rgba(0,0,0,0) ⇒ 当场红
      //      （⑧c 的反向对照证明这一点）。另加一条**可读性**判据：深色正文与渐变**每一个色停**
      //      的对比度都要 ≥4.5:1 —— 主题底可以花，但不能把字压到看不清。
      //   ② 描边（20261005 第二轮「文章页字体还是看起来比讨论区细」）——正文与讨论区正文是
      //      **同一条字体栈、同一个字重(400)、同一种颜色**，差别只有字号（17 vs 14.72px）。
      //      DPR2 下量中心扫描线上的墨迹宽，两者都是 1 CSS px：CJK 在小字号被格点吸附、
      //      大字号不吸附 ⇒ 相对笔画 0.0588 vs 0.0679，字越大反而显得越细。`font-weight`
      //      在微软雅黑上推不动（只有 Light/Regular/Bold），只剩描边这一根杠杆。
      //      不重排是"能上"的前提：描边若参与排版，全站行数/分页都会动。
      const measureColor = async (
        url: string,
        dark: boolean,
      ): Promise<ColorM> => {
        const markup = dark
          ? COLOR_MARKUP.replace('class="frontRoot"', 'class="frontRoot frontDark"')
          : COLOR_MARKUP;
        const pg = await browser.newPage({ viewport: { width: 1440, height: 900 } });
        pg.on("pageerror", (e) => errs.push(String(e)));
        await pg.goto(url);
        await pg.waitForTimeout(120);
        const out = await pg.evaluate(
          (m: string) => {
            document.getElementById("root")!.innerHTML = m;
            const cs = (s: string): ColorCs => {
              const e = document.querySelector(s)!;
              const c = getComputedStyle(e) as unknown as Record<string, string>;
              const r = e.getBoundingClientRect();
              return {
                bg: c.backgroundColor,
                bi: c.backgroundImage,
                sw: c.webkitTextStrokeWidth,
                sc: c.webkitTextStrokeColor,
                color: c.color,
                w: +r.width.toFixed(2),
                h: +r.height.toFixed(2),
                fs: c.fontSize,
              };
            };
            const inner = ".readBody > .markdown-body > .markdown-body";
            const p = document.querySelector(inner + " > p")!;
            // 行数用 Range 数**行框**：段落折了几行是"有没有重排"最直接的证据
            //（宽高在 836 这种定宽列里可能因为最后一行断点位置而凑巧相等，行数不会）。
            const rg = document.createRange();
            rg.selectNodeContents(p);
            return {
              light: cs(".readContainer"),
              p: cs(inner + " > p"),
              li: cs(".readBody li"),
              h1: cs(".readBody h1"),
              pre: cs(".readBody pre"),
              code: cs(".readBody pre code"),
              inlineCode: cs(inner + " > p > code"),
              lines: rg.getClientRects().length,
              tile: getComputedStyle(document.documentElement)
                .getPropertyValue("--container-background-color")
                .trim(),
              themebg: getComputedStyle(document.documentElement)
                .getPropertyValue("--washi-theme-bg")
                .trim(),
            };
          },
          markup,
        );
        await pg.close();
        return out;
      };

      const cl = await measureColor(u("theme.html"), false);
      const cd = await measureColor(u("theme.html"), true);
      const co = await measureColor(u("oldnight.html"), true);
      // 归一化空白后再比字面
      const nz = (s: string) => (s || "").replace(/\s+/g, "");
      // 令牌的**声明值**是 `#fff6fa` 这种十六进制，浏览器把它**算**成 `rgb(255, 246, 250)`
      // 才放进 background-image。要比"渲染出来的就是那一支"，就得先归一到同一种写法，
      // 否则比的是"十六进制 ≠ rgb()"这种格式差异（20261008 当场踩到，两条判据假红）。
      const normBg = (s: string) =>
        nz(
          (s || "")
            .toLowerCase()
            .replace(
              /#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/g,
              (_m, r, g, b) =>
                `rgb(${parseInt(r, 16)},${parseInt(g, 16)},${parseInt(b, 16)})`,
            ),
        );

      expect
        .soft(
          cl.tile.includes("255, 255, 255") &&
            cl.tile.includes("0.6") &&
            normBg(cl.themebg).includes("rgb(255,246,250)") &&
            normBg(cl.themebg).includes("rgb(233,244,255)"),
          `前提：两支令牌都解析出来了（少一支下面量的是空/落空） → 内容页那支 ${cl.tile} / 主题底 ${cl.themebg}`,
        )
        .toBe(true);
      expect
        .soft(
          normBg(cl.light.bi) === normBg(cl.themebg),
          `★白天档 = **主题底**：\`.readContainer\` 的 background-image 就是 \`--washi-theme-bg\`（粉紫天青那张，与首页首屏/登录页同源） → 读到 ${cl.light.bi} / 令牌 ${cl.themebg}`,
        )
        .toBe(true);
      expect
        .soft(
          normBg(cl.light.bi) !== normBg(cl.tile) &&
            cl.light.bi.includes("233, 244, 255"),
          `★白天档**不再**是站内内容页那支半透明白遮罩（20261008 第二轮用户否掉的就是它：铺满一篇长文是一整幅白，看不出主题色） → 读到 ${cl.light.bi}`,
        )
        .toBe(true);
      // 可读性：主题底可以花，但不能把字压到看不清。渐变里最亮的那个色停是最坏情况。
      const lum = (c: number[]) => {
        const f = (v: number) => {
          const x = v / 255;
          return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
        };
        return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
      };
      const ratio = (c1: number[], c2: number[]) => {
        const a = lum(c1);
        const b = lum(c2);
        return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
      };
      const stops = [...cl.light.bi.matchAll(/rgb\((\d+), (\d+), (\d+)\)/g)].map(
        (mm) => [Number(mm[1]), Number(mm[2]), Number(mm[3])] as number[],
      );
      const inkM = cl.p.color.match(/rgba?\((\d+), (\d+), (\d+)/)!;
      const ink = [Number(inkM[1]), Number(inkM[2]), Number(inkM[3])];
      const worst = stops.length ? Math.min(...stops.map((s) => ratio(ink, s))) : 0;
      expect
        .soft(
          stops.length >= 2 && worst >= 4.5,
          `★正文压在这条渐变上仍然看得清：与每个色停的对比度都 ≥4.5（最差 ${worst.toFixed(1)}:1） → 色停 ${JSON.stringify(stops)} / 字色 ${cl.p.color}`,
        )
        .toBe(true);
      expect
        .soft(
          cd.light.bg === "rgb(18, 26, 39)",
          `★夜间档 = 不透明深墨蓝 rgb(18,26,39)（= 20261006 之前屏幕上的那一档；computed 值不带 alpha，就是「不透明」这个判据本身） → ${cd.light.bg}`,
        )
        .toBe(true);
      const coBg: string = co.light.bg;
      const coIsTransparent = coBg === "rgba(0, 0, 0, 0)";
      const coIsNight = coBg === "rgb(18, 26, 39)";
      expect
        .soft(
          coIsTransparent && !coIsNight,
          `★⑧c 反向对照：同一份产物把夜间那支按行为改回 transparent ⇒ 当场不是那个色（旧写法在泄漏断掉之后就会静默变成浅灰底，这条对照证明上面那条判据咬得住） → ${coBg}`,
        )
        .toBe(true);
      expect
        .soft(
          cl.p.sw === "0.2px" &&
            cl.li.sw === "0.2px" &&
            cl.h1.sw === "0.2px" &&
            cl.p.sc === cl.p.color,
          `★正文（含列表、标题）带 0.2px 描边，颜色 = 当前字色（\`currentColor\`） → p ${cl.p.sw} / li ${cl.li.sw} / h1 ${cl.h1.sw}，描边色 ${cl.p.sc} vs 字色 ${cl.p.color}`,
        )
        .toBe(true);
      expect
        .soft(
          cl.pre.sw === "0px" &&
            cl.code.sw === "0px" &&
            cl.inlineCode.sw === "0px",
          `★代码清零：\`pre\`/\`pre code\`/行内 \`code\` 三处都是 0px（深底浅字描边会失衡） → pre ${cl.pre.sw} / pre code ${cl.code.sw} / 行内 ${cl.inlineCode.sw}`,
        )
        .toBe(true);
      expect
        .soft(cl.p.fs === "17px", `  描边没有改字号（正文仍 ${cl.p.fs}） → ${cl.p.fs}`)
        .toBe(true);

      const cn = await measureColor(u("bare.html"), false);
      expect
        .soft(cn.p.sw === "0px", `  对照臂的前提：描边真的没了（正文 0px） → ${cn.p.sw}`)
        .toBe(true);
      expect
        .soft(
          cl.p.w === cn.p.w && cl.p.h === cn.p.h && cl.lines === cn.lines,
          `★不重排：同段落的宽 ${cl.p.w} / 高 ${cl.p.h} / 行数 ${cl.lines} 与摘掉描边那臂（${cn.p.w} / ${cn.p.h} / ${cn.lines}）逐项相同 → 带描边 ${cl.p.w}×${cl.p.h} ${cl.lines} 行 / 不带 ${cn.p.w}×${cn.p.h} ${cn.lines} 行`,
        )
        .toBe(true);
      expect
        .soft(
          cl.lines >= 3,
          `  夹具自检：那一段真的折成了多行（${cl.lines} 行 ≥ 3，否则行数判据无分辨力） → ${cl.lines}`,
        )
        .toBe(true);

      // 负空间一：主题底那张纸是**跨文件同源**的（ReadArticle / 首页首屏 `.collageBg` /
      // 登录页两条），20261008 收成 `--washi-theme-bg` 一支。只量这一页，量得再对也不代表
      // 那三处还牵着手 ⇒ 这里按**源码**数：三处都只写 `var(--washi-theme-bg)`、都不再写那张
      // 渐变的字面值（写着字面值就是"改一处必须同步另一处"的形状，那正是收令牌要治的病）。
      // 只有 `src/index.css` 该出现字面值，且只出现一次。
      const CONSUMERS = [
        "src/pages/Login/index.sass",
        "src/frontHome/Content/ContentHome/index.sass",
        "src/frontHome/Content/ReadArticle/index.sass",
      ];
      const LIT = "linear-gradient(160deg, #fff6fa";
      const litBad = CONSUMERS.filter((p) =>
        readFileSync(path.join(FE_DIR, p), "utf-8").includes(LIT),
      );
      const varMissing = CONSUMERS.filter(
        (p) =>
          !readFileSync(path.join(FE_DIR, p), "utf-8").includes("var(--washi-theme-bg)"),
      );
      const tok = readFileSync(path.join(FE_DIR, "src/index.css"), "utf-8");
      expect
        .soft(
          litBad.length === 0 &&
            varMissing.length === 0 &&
            tok.split("--washi-theme-bg:").length - 1 === 1,
          `★主题底三处同源、值只写一份：首页首屏/登录页/文章阅读面都写 \`var(--washi-theme-bg)\`，都不再抄那张渐变的字面值（字面值只该在 \`src/index.css\` 里出现一次） → 仍写字面值的 ${JSON.stringify(litBad)} / 没写 var 的 ${JSON.stringify(varMissing)} / index.css 里定义 ${tok.split("--washi-theme-bg:").length - 1} 次`,
        )
        .toBe(true);
      // 负空间一之二：这一支**不许有夜间档**。`.frontDark, .dark, .washiDark` 那档也挂在 body 上
      //（后台/浮层用），而 var() 是继承来的 —— 一旦给它一个暗值，白天臂会被一个挂在 body 上的
      // `.washiDark` 悄悄翻黑（令牌不看你自己那支是不是夜间臂）。
      const nightblock = tok.match(/\.frontDark,\s*\.dark,\s*\.washiDark\s*\{([\s\S]*?)\n\}/);
      // 比之前先**剥掉块内注释**：这条判的是"夜间档里不许**定义/引用**这一支"，不是"不许
      // 提它的名字"。20261014 实测踩到——给 `--washi-page-bg` 写夜间臂那轮，紧随其后的
      // 警告注释（"别把两者合并，那一支刻意不给夜间档"）里提到了这个令牌名 ⇒ 判据在**注释处
      // 假红**（同族教训：注释会关掉断言/在注释处截断，见 sass-media-shadow 那条）。
      const nb2 = nightblock ? nightblock[1] : null;
      const nbCode = nb2 === null ? null : nb2.replace(/\/\*[\s\S]*?\*\//g, "");
      expect
        .soft(
          nbCode !== null && !nbCode.includes("--washi-theme-bg"),
          `★主题底**只定义在这一档**（\`.frontDark, .dark, .washiDark\` 那档里不许出现它） → ${nightblock ? "夜间档里也定义了它" : "找不到夜间令牌块"}`,
        )
        .toBe(true);

      // 负空间二：米白那个令牌 20261008 随它的唯一用处一起删了。判据同样只认编译产物。
      expect
        .soft(
          !CSS.includes("--washi-paper-warm"),
          `★\`--washi-paper-warm\` 在编译产物里一次都不出现（零引用的令牌不许留） → 还在`,
        )
        .toBe(true);

      // 负空间：这个类名是 JSX 与 sass 之间**唯一的**接缝，改名一边就是静默失效
      //（`className='readBody'` 还在、sass 那边没规则 ⇒ 上面两组判据全绿而线上照旧）。
      const tsx = readFileSync(
        path.join(FE_DIR, "src/frontHome/Content/ReadArticle/index.tsx"),
        "utf-8",
      );
      expect
        .soft(
          tsx.includes("className='readBody'"),
          `★\`index.tsx\` 里那个 motion.div 挂着 className='readBody'（同名接缝） → 找不到这个字面`,
        )
        .toBe(true);
    });

    expect.soft(errs.length === 0, `无 JS 运行时报错 → ${errs.slice(0, 3).join("；")}`).toBe(true);
  });
});
