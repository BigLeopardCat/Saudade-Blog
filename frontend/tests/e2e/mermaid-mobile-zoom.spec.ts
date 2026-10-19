import { test, expect, type Browser } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  FE_DIR,
  compileSass,
  collectPageErrors,
  esbuildInSandbox,
  serveSandbox,
  type Sandbox,
} from "./sandbox";

/**
 * 手机档：mermaid 图真的能读（20261005）
 * （原 tests/mermaid-mobile-zoom.test.py，20261019 迁移）。
 *
 * 现场（用户报「移动端文章页有很大问题」后逐个量出来的第三条）：文章页在 390px 视口里，
 * mermaid 图被压到 **276px 宽、图上标签 ~5px 高**（`/article/19` 那张流程图，viewBox
 * 1112×598）——图还在、边框还在，就是**没人读得了**。两条路一起断：
 *
 *   ① 图上那枚「🔍 点击放大」角标写的是 `&:hover::after`（`index.sass`）。**触屏没有 hover**
 *      ⇒ 手机上一个入口提示都不出现，看图的人根本不知道能点。同族坑在本仓不是第一次
 *      （`Vitrine/index.sass` 的 `@media (hover: none)` 一段写着「触屏没有 hover：直接常亮，
 *      否则这个功能等于不存在」）。
 *   ② 就算他瞎点开了浮层，浮层起点是"整图适配"（`zoomOverlay.ts` 的 `fitScale`）：1112px 的
 *      图在 334px 舞台里适配成 **0.291** ⇒ 摊开还是 5px 的字，**点开放大与不点开一样看不清**，
 *      白点。
 *
 * 所以这一档把手机上的"点开"接成一条真能读的路：角标常亮（②）+ 窄屏起点让给"能读"
 * （③，折算 ≥720px 显示宽，标签 ≈12px），双击在「能读 ↔ 整图」之间切（④）。桌面档一字不动。
 *
 * 为什么要真浏览器：两条都只在**布局完成后**才成立（`getBoundingClientRect` / 媒体查询命中 /
 * 浮层的 `transform` 缩放）。夹具 = 真编译的 `.sass` + 真打包的 `zoomOverlay.ts`（esbuild，
 * 与 `favorites-sync.test.mjs` 同一个取法）+ 一份复现真 DOM 的 mermaid 图框。
 *
 * 锁五件：
 *   ① 前提：本套件用的"触屏"上下文真的把 `(hover: none)` 打开了（不成立则下面全绿也是假的）；
 *   ② 角标：触屏档常亮、桌面档仍藏着；**红基线**单独摘掉 `@media (hover: none)` 那一块 ⇒
 *      触屏档当场回到 `opacity: 0`；
 *   ③ 浮层起点：窄屏点开后图上标签 ≥10px（≈行内的 2 倍）；**红基线**换臂——把起点那一行
 *      逐字回退成改动前的 `fitScale()` 再跑同一个夹具，标签必须 ≤7px（证明 ③ 不是空断言，
 *      而是这次真的把 0.291 换掉了）；换臂不读 `git show HEAD:`（提交之后它就等于被测对象，
 *      见下面锚点那段注释）；
 *   ④ 双击的两个端点：窄屏「能读 ↔ 整图」来回切；桌面档仍是「适配 ↔ 2.5× 适配」；
 *   ⑤ 负空间：`index.tsx` 里那个点击委托还在（模块是好的、没接上照样没人能点开）、
 *      沙箱里行内那张图**确实**是小的（否则"放大后可读"在夹具里本来就成立，判据是空的）。
 */

const SASS_FILE = path.join(
  FE_DIR,
  "src/frontHome/Content/ReadArticle/index.sass",
);
// `.md-zoom-*` 那一套**不住在文章页的 sass 里**（20260901 搬去了全局 App.sass，因为看板娘
// 对话框也要复用）。夹具少了这一份，浮层就是一串没样式的 div：舞台塌成内容高、`fitScale`
// 里的 (r.height−72) 直接算出 0.886 ⇒ 桌面档"整图适配"看起来也对，判据却量在一个假舞台上
//（20261005 踩过：两条臂都是 0.886，双击也全无反应）。所以这份必须一起编译、一起加载。
const OVERLAY_SASS = path.join(FE_DIR, "src/App.sass");
const RESET_CSS = readFileSync(
  path.join(FE_DIR, "src/frontHome/main.css"),
  "utf-8",
);
const ZOOM_TS = path.join(
  FE_DIR,
  "src/frontHome/Content/ReadArticle/zoomOverlay.ts",
);
const MARKDOWN_TSX = path.join(
  FE_DIR,
  "src/frontHome/Content/ReadArticle/index.tsx",
);

// 与真 DOM 同形：`.readContent.markdown-body > .readBody > #content.markdown-body`，图框里那张
// svg 的 viewBox 与线上 `/article/19` 逐字相同（1111.99×597.81），`width="100%"` +
// 行内 `max-width` 也是 `@bytemd/plugin-mermaid` 真实写上去的那两条（见线上 outerHTML）。
// 图里放一条 19px 的文字：判据 ③/④ 量的就是**它渲染出来多高**——"能不能读"是用户可见面，
// 比量 svg 宽度更贴题（宽度只是同一件事的机制面，一起报出来便于读报告）。
const MARKUP = `
<div class="readContainer">
  <div class="readContent markdown-body">
    <div class="readBody"><div id="content" class="markdown-body">
      <div class="bytemd-mermaid" style="line-height: initial;">
        <svg width="100%" viewBox="-8 -8 1111.9921875 597.8068237304688"
             style="max-width: 1111.9921875px;" xmlns="http://www.w3.org/2000/svg">
          <rect x="0" y="0" width="1100" height="580" fill="#eef1f8"></rect>
          <text x="40" y="70" font-size="19">nginx :443/80</text>
        </svg>
      </div>
    </div></div>
  </div>
</div>
`;

const MOBILE_UA =
  "Mozilla/5.0 (Linux; Android 12; NOH-AN00) AppleWebKit/537.36 Chrome/114 Mobile Safari/537.36";
const DESKTOP_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120 Safari/537.36";

const HOVER_HEAD = "@media (hover: none)";

interface ZoomProbe {
  innerW: number;
  hoverNone: boolean;
  badge: string;
  inlineSvgW: number;
  stageW: number;
  stageH: number;
  innerWAfter: number;
  zoomSvgW: number;
  zoomTextH: number;
}
interface Measured extends ZoomProbe {
  errs: string[];
}

// 进浮层后量：图框里那条 19px 文字**渲染出来**多高（用户可见面）+ svg 渲染宽（机制面）
const PROBE = (): ZoomProbe => {
  const frame = document.querySelector(".bytemd-mermaid") as HTMLElement;
  const inline = frame.querySelector("svg")!.getBoundingClientRect();
  (window as unknown as { __openZoomOverlay: (e: HTMLElement) => void }).__openZoomOverlay(frame);
  const stage = document.querySelector(".md-zoom-stage")!.getBoundingClientRect();
  const svg = document.querySelector(".md-zoom-content svg")!.getBoundingClientRect();
  const text = document.querySelector(".md-zoom-content text")!.getBoundingClientRect();
  return {
    innerW: innerWidth,
    hoverNone: matchMedia("(hover: none)").matches,
    badge: getComputedStyle(frame, "::after").opacity,
    inlineSvgW: +inline.width.toFixed(1),
    stageW: +stage.width.toFixed(1),
    stageH: +stage.height.toFixed(1),
    innerWAfter: innerWidth,
    zoomSvgW: +svg.width.toFixed(1),
    zoomTextH: +text.height.toFixed(2),
  };
};

test.describe("手机档 mermaid 放大", () => {
  test.setTimeout(180_000);

  test("角标常亮、窄屏起点可读、双击两端点、桌面档不动", async ({ browser }) => {
    const CSS = compileSass(SASS_FILE);
    const OVERLAY_CSS = compileSass(OVERLAY_SASS);

    // 判据 ② 的红基线：**单独**摘掉那段 `@media (hover: none)`。用花括号配对找边界，
    // 不靠猜缩进（同 `read-mobile.test.py` 的 block_region）。
    expect(
      CSS.includes(HOVER_HEAD),
      `夹具前置：编译产物里有 \`@media (hover: none)\` —— 角标那条规则没了（或写法变了，见 index.sass 的 mermaid 图框一段）`,
    ).toBe(true);
    const blockRegion = (css: string, header: string): [number, number] => {
      const i = css.indexOf(header);
      const k = css.indexOf("{", i);
      let depth = 1;
      let j = k + 1;
      while (depth > 0) {
        if (css[j] === "{") depth += 1;
        else if (css[j] === "}") depth -= 1;
        j += 1;
      }
      return [i, j];
    };
    const [hi, hj] = blockRegion(CSS, HOVER_HEAD);
    const NO_HOVER = CSS.slice(0, hi) + CSS.slice(hj);

    // 判据 ③ 的红基线 = **换臂**：改动前那一版模块，同一个夹具同一套判据。与
    // `saudade-golden-ab-interleave-method` 同一取法：读**计数/几何**，不读"看起来对"。
    //
    // 换臂的方式是**逐字回退那处分歧**（把起点从「能读」改回 `fitScale()`），不是
    // `git show HEAD:` —— 后者在改动**提交之后**取到的就是改动后的那份文件，两条臂逐字
    // 相同、红基线当场失效（20261005 实测：提交前绿，提交后两条臂都量到 698.6px）。
    // 换臂的判据必须钉在**时间**上（一个写在测试里的逆变换），不能钉在"当前提交"上。
    const ZOOM_SRC = readFileSync(ZOOM_TS, "utf-8");
    const PREV_ANCHOR = "scale = readableScale()";
    const PREV_BEFORE = "scale = fitScale()";
    // 必须**恰好命中一处**：`readableScale()` 在改后那份模块里出现三次（起点 / 提示语 /
    // 双击分支），只有 `reset()` 里那一条是"起点"。命中数一变就说明源码动了、该重看一眼，
    // 直接停在这里比"换臂换了个半截"强。
    expect(
      ZOOM_SRC.split(PREV_ANCHOR).length - 1 === 1,
      `夹具前置：换臂锚点 \`${PREV_ANCHOR}\` 在 zoomOverlay.ts 里出现 ${ZOOM_SRC.split(PREV_ANCHOR).length - 1} 次（应为 1）—— 起点那条写法变了，红基线要先对齐再跑`,
    ).toBe(true);
    const OLD_SRC = ZOOM_SRC.replace(PREV_ANCHOR, PREV_BEFORE);

    // ⚠️ 这条不能省：`isMobile=True` 时 Chromium 按 **viewport meta** 定布局宽度，
    // 没有它就落回 980px 的移动默认值 —— 那时 `window.innerWidth` = 980、
    // 宽档判据（`> 768`）把窄屏分支整条绕过去，于是"新臂与旧臂一模一样"而没有任何报错。
    // 判据 ① 里那条 innerWidth 就是盯它的（先踩过一次，见本文件头的实测记录）。
    const indexHtml =
      '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">' +
      '<meta name="viewport" content="width=device-width, initial-scale=1">' +
      '<link rel="stylesheet" href="main.css"><link rel="stylesheet" href="read.css">' +
      '<link rel="stylesheet" href="overlay.css">' +
      '</head><body><div id="root">' +
      MARKUP +
      '</div><script src="zoom.js"></script></body></html>';

    const buildArm = async (
      readCss: string,
      zoomSrc: string,
    ): Promise<Sandbox> => {
      const sb = await serveSandbox({
        "index.html": indexHtml,
        "main.css": RESET_CSS,
        "read.css": readCss,
        "overlay.css": OVERLAY_CSS,
      });
      await esbuildInSandbox(sb, {
        entry: "zoom.ts",
        files: { "zoom.ts": zoomSrc },
        outfile: "zoom.js",
      });
      return sb;
    };

    const measure = async (
      br: Browser,
      url: string,
      mobile: boolean,
    ): Promise<Measured> => {
      const ctx = mobile
        ? await br.newContext({
            viewport: { width: 390, height: 844 },
            isMobile: true,
            hasTouch: true,
            deviceScaleFactor: 2,
            userAgent: MOBILE_UA,
          })
        : await br.newContext({
            viewport: { width: 1440, height: 900 },
            userAgent: DESKTOP_UA,
          });
      const pg = await ctx.newPage();
      const errs = collectPageErrors(pg);
      await pg.goto(url);
      await pg.waitForTimeout(150);
      const out = (await pg.evaluate(PROBE)) as ZoomProbe;
      const errsCopy = errs();
      await ctx.close();
      return { ...out, errs: errsCopy };
    };

    // 三个沙箱各打一次（同一沙箱重复 esbuild 会 EEXIST）：fixed / 摘角标块 / 旧臂。
    const sbFixed = await buildArm(CSS, ZOOM_SRC);
    const sbNoHover = await buildArm(NO_HOVER, ZOOM_SRC);
    const sbPrev = await buildArm(CSS, OLD_SRC);
    try {
      // ── ① 前提：这套「触屏」上下文真的把 `(hover: none)` 打开了、宽度也真的是 390 ──
      const m = await measure(browser, sbFixed.url, true);
      expect(
        m.hoverNone === true,
        `触屏档 \`(hover: none)\` 命中（不命中则下面几条全绿也是假的） → ${m.hoverNone}`,
      ).toBe(true);
      expect(
        m.innerW === 390,
        `★触屏档布局宽度就是 390（实测 ${m.innerW}；缺 viewport meta 时 Chromium 落回 980，窄屏分支会被整条绕过去而一声不吭） → ${m.innerW}`,
      ).toBe(true);

      // ── ② 角标：触屏常亮，桌面仍藏着（红基线：摘掉那一块 ⇒ 触屏当场回到 opacity 0） ──
      expect(
        m.badge === "1",
        `★触屏档角标常亮（opacity 1） → ${m.badge}`,
      ).toBe(true);
      const d = await measure(browser, sbFixed.url, false);
      expect(
        d.badge === "0",
        `  桌面档仍是藏在 hover 后面（opacity 0） → ${d.badge}`,
      ).toBe(true);
      const nh = await measure(browser, sbNoHover.url, true);
      expect(
        nh.badge === "0",
        `★红基线：摘掉 \`@media (hover: none)\` 那块 ⇒ 触屏档角标回到 0 → opacity=${nh.badge}`,
      ).toBe(true);

      // ── ③ 浮层起点：窄屏点开就**能读**（红基线：换臂到改动前那版模块） ──
      expect(
        m.inlineSvgW < 400,
        `夹具自检：行内那张 svg 只有 ${m.inlineSvgW}px 宽（图确实被压小了，否则下面判据是空的） → ${m.inlineSvgW}`,
      ).toBe(true);
      expect(
        m.stageW === 390 && m.stageH === 844,
        `★夹具自检：浮层舞台铺满视口（${m.stageW}×${m.stageH}）——不是一串没样式的 div（\`.md-zoom-*\` 住在 App.sass 里，漏加载时舞台塌成内容高、fitScale 跟着算错，桌面档会"看起来也对"）`,
      ).toBe(true);
      expect(
        m.zoomTextH >= 10,
        `★窄屏点开后图上标签 ${m.zoomTextH}px 高（≥10px；行内是 5px 量级） → ${JSON.stringify(m)}`,
      ).toBe(true);
      // svg 盒 = 1112（viewBox 宽；图框那 34px padding/border 在它外面），窄屏起点 0.6283
      // ⇒ 698.6px 显示宽。桌面档同一张图是 1112（比例 clamp 到 1）。
      expect(
        Math.abs(m.zoomSvgW - 698.6) < 12,
        `  浮层里图宽 ${m.zoomSvgW}px（= 1112 × 0.628，可读起点；舞台 ${m.stageW}px）`,
      ).toBe(true);
      // 「窄屏」这个判据**只能**读舞台宽：浮层那份未缩放的 content 有 1146px 宽（缩放走
      // transform、不进布局），文档一溢出，移动端 Chromium 的 innerWidth 就跟着涨。写这条
      // 是为了把那个坑钉在报告里——用 innerWidth 的实现在这条断言下会当场退回整图适配。
      expect(
        m.stageW === 390,
        `★窄屏判据读的是舞台宽 ${m.stageW}px，不是被浮层自己撑到 ${m.innerWAfter}px 的 \`innerWidth\`（用后者就静默退回整图适配）`,
      ).toBe(true);
      const pv = await measure(browser, sbPrev.url, true);
      expect(
        pv.zoomTextH <= 7,
        `★红基线：改动前那版模块点开后标签只有 ${pv.zoomTextH}px（≤7px，与行内同量级） → ${JSON.stringify(pv)}`,
      ).toBe(true);
      expect(
        pv.zoomSvgW < m.zoomSvgW * 0.5,
        `  两条臂只差这一处：图宽 ${pv.zoomSvgW}px（旧＝整图适配）vs ${m.zoomSvgW}px（新）`,
      ).toBe(true);

      // ── ④ 双击的两个端点 + 桌面档一字未动 ──
      {
        const ctx = await browser.newContext({
          viewport: { width: 390, height: 844 },
          isMobile: true,
          hasTouch: true,
          deviceScaleFactor: 2,
          userAgent: MOBILE_UA,
        });
        const pg = await ctx.newPage();
        await pg.goto(sbFixed.url);
        await pg.waitForTimeout(150);
        await pg
          .locator(".bytemd-mermaid")
          .evaluate(
            (e) =>
              (window as unknown as { __openZoomOverlay: (el: HTMLElement) => void }).__openZoomOverlay(
                e as HTMLElement,
              ),
          );
        await pg.waitForTimeout(100);
        const svgW = () =>
          pg.evaluate(() =>
            +document
              .querySelector(".md-zoom-content svg")!
              .getBoundingClientRect()
              .width.toFixed(1),
          );
        const start = await svgW();
        const stageBox = await pg.locator(".md-zoom-stage").boundingBox();
        const cx = stageBox!.x + stageBox!.width / 2;
        const cy = stageBox!.y + stageBox!.height / 2;
        await pg.mouse.dblclick(cx, cy);
        await pg.waitForTimeout(150);
        const after1 = await svgW();
        await pg.mouse.dblclick(cx, cy);
        await pg.waitForTimeout(150);
        const after2 = await svgW();
        expect(
          Math.abs(after1 - 324.1) < 12,
          `★窄屏双击第 1 下 ⇒ 回到「整图适配」（${start}px → ${after1}px，= 1112 × 0.2915）`,
        ).toBe(true);
        expect(
          Math.abs(after2 - 698.6) < 12,
          `★再双击一下 ⇒ 回到「能读」（${after1}px → ${after2}px，= 1112 × 0.628）`,
        ).toBe(true);
        await ctx.close();
      }

      const dc = await measure(browser, sbFixed.url, false);
      expect(
        Math.abs(dc.zoomSvgW - 1112) < 5,
        `  桌面档点开仍是"整图适配"且比例 clamp 到 1（${dc.zoomSvgW}px = 图 svg 全长）`,
      ).toBe(true);
      expect(
        dc.zoomTextH >= 19,
        `  桌面档图上标签 ${dc.zoomTextH}px（与从前一致，没有被这次改动带动）`,
      ).toBe(true);

      // ── ⑤ 负空间：模块是好的，还得**接上** ──
      const tsx = readFileSync(MARKDOWN_TSX, "utf-8");
      expect(
        tsx.includes("initZoomDelegation"),
        `★\`index.tsx\` 里那个点击委托还在（没接上 ⇒ 模块再对也没人能点开） → 找不到 initZoomDelegation`,
      ).toBe(true);
      expect(
        m.errs.length === 0 && d.errs.length === 0,
        `无 JS 运行时报错 → ${JSON.stringify(m.errs.concat(d.errs))}`,
      ).toBe(true);
    } finally {
      await sbFixed.teardown();
      await sbNoHover.teardown();
      await sbPrev.teardown();
    }
  });
});
