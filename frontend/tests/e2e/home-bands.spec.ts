import { test, expect, type Page } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
import { FE_DIR, withSandbox, compileSass, collectPageErrors } from "./sandbox";

/**
 * 首页「段落带」+ 页脚封底的验收（用户 20261001 第 4 条）。
 * （原 tests/home-bands.test.py，20261019 迁移）
 *
 * 原话：「不止第一页主页，下面包括脚页也做风格适配，主页段落感和配色搭配撞色感，
 * 不要一股脑一个首页顶部颜色配到底。」
 *
 * 改版前的实况：`.SelfDescription`（首屏）/ `.ContentContainer`（正文）/ `.footerContainer`
 * （页脚）三段的 `background` **都是 `var(--container-background-color)`**（半透明白铺在
 * 页面底图上）⇒ 从上到下没有一处换色。这正是"一个颜色配到底"，也是本套件要钉死的那条回归。
 *
 * 20261001 第二轮（用户第 3 条）在同一片区域改了两件事，判据也一并更新：
 *   · **页脚不再有接缝胶带**（「页脚不需要加胶带」）——原「页脚胶带骑缝（top < 0）」那条
 *     断言反了过来，现在是「`::before` 的 content 是 none」；
 *   · **赞助方 logo 换成不透明的浅色贴片**（「链接和图标字体是黑色，深色页脚看不清」）——
 *     旧值 `rgba(255,255,255,0.07)` 压在深底上仍是深色，新增"贴片浅且不透明 + 贴合 logo"两条。
 *
 * 为什么必须真跑浏览器：这条改造的正确性全在**渲染结果**里 —— 源码写着
 * `background-image: …, var(--band-content)` 不代表那条渐变真的画出来了（先写
 * `background: var(--band-content)` 再补 `background-image` 就会把它整条顶掉，
 * 两条声明改的是同一个属性）；页脚字色对封底的对比度、窄屏 logo 排有没有溢出，
 * 都只有量像素/量盒子才看得见。**源码锁只做补充，主判据是计算值与像素。**
 *
 * （TS 迁移注：Python 版用 PIL 读整页截图取像素，这里改为
 * `page.screenshot({fullPage:true})` → dataURL → 页面内 canvas `getImageData`，
 * 取样点与判据口径一致；WCAG 对比度的 P/lin/ratio/over 与
 * read-topbar-contrast.spec.ts 同一套公式。）
 */

const IDX_CSS = path.join(FE_DIR, "src/index.css");
const MAIN_CSS = path.join(FE_DIR, "src/frontHome/main.css");
const SECTIONS_SASS = path.join(
  FE_DIR,
  "src/frontHome/Content/ContentHome/sections.sass",
);
const HOME_SASS = path.join(
  FE_DIR,
  "src/frontHome/Content/ContentHome/index.sass",
);
const FOOT_SASS = path.join(FE_DIR, "src/frontHome/Footer/index.sass");
const FOOT_TSX = path.join(FE_DIR, "src/frontHome/Footer/index.tsx");
const HOME_TSX = path.join(
  FE_DIR,
  "src/frontHome/Content/ContentHome/index.tsx",
);

function stripComments(text: string, lineComments = true): string {
  /** 剥注释再比拼子串。
   *
   * ⚠️ 必须剥：这两份文件里都有大段头注在**解释**这次改动，里面原文写着旧令牌名
   * （`--container-background-color`）与旧写法（`style={{…}}`）—— 不剥的话"不许
   * 出现 X"会被自己的说明文字判红（同族教训：全仓扫描的针会自命中）。
   * 剥掉之后剩下的才是**代码**，`style={{` 只可能出现在真 JSX 属性里。 */
  let t = text.replace(/\/\*.*?\*\//gs, "");
  if (lineComments) t = t.replace(/^[ \t]*\/\/.*$/gm, "");
  return t;
}

// ── 颜色工具（与 `tests/dark-mode-contrast.test.py` / read-topbar-contrast.spec.ts 同一套口径）──
/** `rgb(r, g, b)` / `rgba(r, g, b, a)` → 数字数组。 */
function P(s: string): number[] {
  return [...s.matchAll(/-?\d*\.?\d+/g)].map((m) => parseFloat(m[0]));
}

function srgb(v: number): number {
  const x = v / 255;
  return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
}

function lin(c: number[]): number {
  return 0.2126 * srgb(c[0]) + 0.7152 * srgb(c[1]) + 0.0722 * srgb(c[2]);
}

function ratio(fg: number[], bg: number[]): number {
  const a = lin(fg);
  const b = lin(bg);
  const hi = Math.max(a, b);
  const lo = Math.min(a, b);
  return (hi + 0.05) / (lo + 0.05);
}

/** 带 alpha 的前景压在**不透明**背景上。页脚两个字色令牌都是 rgba。 */
function over(fg: number[], bg: number[]): number[] {
  const a = fg.length > 3 ? fg[3] : 1;
  return [0, 1, 2].map((i) =>
    Math.round(fg[i] * a + bg[i] * (1 - a)),
  );
}

/** `background-image` 里**最后一层**渐变的第一个色标（= 那一层带子最上面的颜色）。
 *
 * 三层背景的 `background-image` 是一条逗号分隔的列表，`linear-gradient(` 里本身
 * 也带逗号 —— 按 `linear-gradient(` 切开再取最后一段，就绕开了"逗号也算层分隔符"
 * 这个坑。色标抽到的可能是 rgba（渐变常常带 alpha），只取前三位。 */
function lastGradFirstStop(bg: string): number[] {
  const layer = bg.split("linear-gradient(").pop()!;
  const m = layer.match(/rgba?\([^)]*\)/);
  return m ? P(m[0]).slice(0, 3) : [0, 0, 0];
}

/** 元素**真正画出来的那层色**：`background-color` 为空时退到最后一层渐变。 */
function deepestBg(el: ProbeResult): number[] {
  const c = P(el.bgc);
  if (c.length > 3 && c[3] === 0) return lastGradFirstStop(el.bg); // rgba(0,0,0,0) = 没设底色
  return c.slice(0, 3);
}

function dmax(a: number[], b: number[]): number {
  return Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]));
}

// ══ 二、沙箱夹具 ═════════════════════════════════════════════════════════
// 真 sass（三份）+ 真令牌（index.css / main.css）+ 真类名。页面底图在沙箱里换成一个
// 不透明的近白/近黑 —— 真站上它是 `--front-body-color`（33% 的白/黑）压在**已 404 的**
// 背景图上，纵向本来就没有变化，换成纯色只是把"底"这件事写得确定一点。
const GIF =
  "data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==";

const MARKUP = `
<div class="frontRoot" id="root">
  <div class="SelfDescription" id="hero">
    <div class="collageBg"><i class="blob blobA"></i><i class="blob blobB"></i><i class="blob blobC"></i></div>
    <div class="heroLeft"><h1 id="heroTitle">标题</h1></div>
  </div>
  <div class="ContentContainer" id="content">
    <div class="allContent" id="plate">文章</div>
  </div>
  <footer class="footerContainer" id="foot">
    <p class="footLine" id="l1">Copyright (c) 2024 LinMo. All rights reserved.</p>
    <p class="footNote" id="l2">Based on work refactored with <span class="footTech footTechRust">Rust</span> &amp; <span class="footTech footTechAxum">Axum</span>.</p>
    <em class="footPoem" id="l4"><p>诗一行</p></em>
    <p class="footBeian" id="l5"><a class="link" id="l5a" href="#">ICP备00000000号-1</a> | <span>公网安备00000000000000号</span></p>
    <p class="footLogos" id="logos">
      <a href="#" id="lg1"><img class="footLogoAli" src="GIF" alt=""></a>
      <a href="#" id="lg2"><img class="footLogoTx" src="GIF" alt=""></a>
      <a href="#" id="lg3"><img class="footLogoCf" src="GIF" alt=""></a>
      <a href="#" id="lg4"><img class="footLogoLive2d" src="GIF" alt=""></a>
    </p>
  </footer>
</div>
`.replaceAll("GIF", GIF);

/** 浅色档与夜间档各出一份：`var()` 是在**元素**上解析的，令牌换了档必须有肉眼可量的差别。
 * 夜间档把 `.frontRoot` 换成 `.frontDark frontRoot`（App.tsx 的真实类名组合），
 * 底色用一个近黑 —— 真站夜间页面底是 33% 的黑压出来的深灰。 */
function pageHtml(theme: "light" | "dark", css: string): string {
  const pagebg = theme === "dark" ? "#141218" : "#fbfbfb";
  const root = theme === "dark" ? "frontDark frontRoot" : "frontRoot";
  const body = MARKUP.replaceAll('"frontRoot"', `"${root}"`);
  return (
    `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">` +
    `<style>html,body{margin:0;background:${pagebg};font-family:sans-serif}\n` +
    `.ContentContainer{min-height:520px}</style>` +
    `<style>${css}</style></head><body>${body}</body></html>`
  );
}

interface ProbeRect {
  l: number;
  t: number;
  w: number;
  h: number;
  b: number;
}
interface ProbeResult {
  rect: ProbeRect;
  bg: string;
  bgc: string;
  color: string;
  overflowY: string;
  before: { content: string; h: string; top: string; bg: string };
}

const probeSel = (page: Page, sel: string): Promise<ProbeResult | null> =>
  page.evaluate((s) => {
    const el = document.querySelector(s);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    const b = getComputedStyle(el, "::before");
    return {
      rect: { l: r.left, t: r.top, w: r.width, h: r.height, b: r.bottom },
      bg: cs.backgroundImage,
      bgc: cs.backgroundColor,
      color: cs.color,
      overflowY: cs.overflowY,
      before: {
        content: b.content,
        h: b.height,
        top: b.top,
        bg: b.backgroundImage,
      },
    };
  }, sel);

interface TextInfo {
  c: string;
  l: number;
  t: number;
  w: number;
  h: number;
}

const TEXT_SEL: Record<string, string> = {
  l1: ".footLine",
  l2: ".footNote",
  l3: ".footTechRust",
  l4: ".footPoem p",
  l5: ".footBeian",
  l5a: ".footBeian .link",
};

test.describe("首页段落带 + 页脚封底", () => {
  test.setTimeout(180_000);

  test("源码锁防合回去 + 浅色/夜间两档三段配色与对比度 + 几何（胶带/logo 贴片/窄屏 logo 排）", async ({
    page,
  }) => {
    // ── 【一】源码锁：三段不许再合回去 ──
    // 这几条不是"渲染对不对"，是"别把这次拆开的三段又合回去"。合回去的写法每次都很自然
    // （把色值直接写进组件、把 import 挪回一行、给 logo 排去掉 flex-wrap），所以钉住。
    const footTsxCode = stripComments(await fs.readFile(FOOT_TSX, "utf-8"));
    const homeTsx = await fs.readFile(HOME_TSX, "utf-8");
    const footSass = stripComments(await fs.readFile(FOOT_SASS, "utf-8"));
    const sectionsSass = stripComments(await fs.readFile(SECTIONS_SASS, "utf-8"));
    const idxCss = await fs.readFile(IDX_CSS, "utf-8");

    const nInline = footTsxCode.split("style={{").length - 1;
    expect(
      nInline === 0,
      `页脚 TSX 零行内样式（\`style={{\` 出现 0 次） → ${nInline} 处`,
    ).toBe(true);

    // 每个类名都要在 TSX 里真的挂着 —— sass 里写好了但 TSX 没写上，等于整块没样式。
    // （`.footerContainer` 是既有挂点，一并列上：它是"这一整套只作用于页脚"的边界。）
    for (const cls of [
      "footerContainer",
      "footLine",
      "footNote",
      "footTech",
      "footTechRust",
      "footTechAxum",
      "footPoem",
      "footBeian",
      "footBeianIcon",
      "footLogos",
      "footLogoAli",
      "footLogoTx",
      "footLogoCf",
      "footLogoLive2d",
    ]) {
      expect(footTsxCode.includes(cls), `页脚 TSX 挂着 .${cls}`).toBe(true);
    }

    expect(
      footSass.includes("var(--band-foot)") &&
        !footSass.includes("--container-background-color"),
      `页脚底色改走 \`--band-foot\`（不再共用 \`--container-background-color\`）`,
    ).toBe(true);

    // 正文带的底色必须是 `background-image` 的**第三条**。写成 `background: var(--band-content)`
    // 再补 `background-image` 的话，后者把前者整条顶掉（同一个属性）—— 底下的带子就没了。
    expect(
      /background-image:.*,\s*var\(--band-content\)/.test(sectionsSass) &&
        !sectionsSass.includes("--container-background-color"),
      `正文带底色是 background-image 的第三条（不是另起一条 background）`,
    ).toBe(true);

    // 同特异度下后写者赢：`sections.sass` 必须排在 `index.sass` 之后，否则整份没写。
    const iBase = homeTsx.indexOf("'./index.sass'");
    const iBand = homeTsx.indexOf("'./sections.sass'");
    expect(
      iBase >= 0 && iBase < iBand,
      `ContentHome/index.tsx 里 sections.sass 排在 index.sass 之后 → index.sass@${iBase} sections.sass@${iBand}`,
    ).toBe(true);

    // 深浅两档必须成对（`src/index.css` 头注立的规矩）：四个令牌各出现两次。
    // ⚠️ 数的时候带冒号：`--band-foot-ink` 是 `--band-foot-ink-2` 的前缀，不带冒号会多算。
    for (const tok of [
      "--band-content:",
      "--band-foot:",
      "--band-foot-ink:",
      "--band-foot-ink-2:",
    ]) {
      const n = idxCss.split(tok).length - 1;
      expect(n === 2, `令牌 ${tok.slice(0, -1)} 深浅各一档 → ${n} 次`).toBe(true);
    }

    expect(
      footSass.includes("flex-wrap: wrap"),
      `页脚 logo 排能换行（窄屏不探出容器）`,
    ).toBe(true);

    // 页脚的接缝胶带 20261001 已删（用户：「页脚不需要加胶带」）——胶带是"两张内页相接"
    // 的道具，封底不贴。这条**反断言**防的是"哪天看着空又贴回去"。
    expect(
      !footSass.includes("&::before"),
      `页脚 sass 里没有胶带规则（\`&::before\` 整块删除）`,
    ).toBe(true);

    // 赞助方贴片：封底深浅两档都是深色，而这四张图里阿里云百炼是深藏青字、Live2D 是黑字，
    // 压在深底上等于没有字（用户：「赞助方链接和图标字体是黑色，深色页脚看不清字体了」）。
    // 旧值 `rgba(255, 255, 255, 0.07)` 是**压在深底上的半透明白**，算出来仍是深色 ——
    // 注释写着"极淡的浅色贴片"、值却是深色，这就是那一次的缺陷本体。
    expect(
      !footSass.includes("rgba(255, 255, 255, 0.07)") &&
        footSass.includes("#f7f3fb"),
      `logo 贴片是实体浅色（旧的 \`rgba(255, 255, 255, 0.07)\` 不许回来）`,
    ).toBe(true);

    // ── 【二】沙箱：浅色档与夜间档各出一份 ──
    const css = [
      idxCss,
      await fs.readFile(MAIN_CSS, "utf-8"),
      compileSass(HOME_SASS),
      compileSass(SECTIONS_SASS),
      compileSass(FOOT_SASS),
    ].join("\n");

    await withSandbox(
      {
        "light.html": pageHtml("light", css),
        "dark.html": pageHtml("dark", css),
      },
      async (sb) => {
        const urlOf = (f: string) => sb.url.replace(/index\.html$/, f);

        for (const theme of ["light", "dark"] as const) {
          // Python 版每档开一个新 page；这里复用同一个 page，先摘掉旧档的
          // pageerror 监听，让两档的「无 JS 报错」各自独立。
          page.removeAllListeners("pageerror");
          const errs = collectPageErrors(page);
          await page.setViewportSize({ width: 1280, height: 900 });
          await page.goto(urlOf(`${theme}.html`));
          await page.waitForTimeout(300);

          const hero = (await probeSel(page, "#hero"))!;
          const content = (await probeSel(page, "#content"))!;
          const foot = (await probeSel(page, "#foot"))!;

          // ① 正文带的底色真的画出来了：`background-image` 里应当**解析出** `--band-content`
          //    那一组色标（浅色档是薄荷 #eaf7f1 → 淡紫 #f1edff）。计算值会把 `var()` 展开，
          //    所以这里比的是展开后的 rgb()，比"源码里有没有那串字"硬得多。
          const want =
            theme === "light"
              ? ["rgb(234, 247, 241)", "rgb(241, 237, 255)"]
              : ["rgb(19, 38, 42)", "rgb(32, 26, 49)"];
          expect(
            want.every((w) => content.bg.includes(w)),
            `正文带的 background-image 里解析出分段带的两个色标 → ${content.bg.slice(-90)}`,
          ).toBe(true);
          expect(
            !content.bg.includes("rgba(255, 255, 255, 0.6)") &&
              !content.bg.includes("rgba(0, 0, 0, 0.6)"),
            `正文带不再是那层半透明白/黑（--container-background-color）`,
          ).toBe(true);

          // ② 页脚底色是 `--band-foot`（不透明渐变）。
          const footBand =
            theme === "light" ? "rgb(58, 49, 84)" : "rgb(47, 39, 69)";
          expect(
            foot.bg.includes(footBand),
            `页脚的 background-image 里解析出封底色 → ${foot.bg.slice(0, 70)}`,
          ).toBe(true);
          expect(
            !foot.bg.includes("rgba(255, 255, 255, 0.6)") &&
              !foot.bg.includes("rgba(0, 0, 0, 0.6)"),
            `页脚不再共用 \`--container-background-color\``,
          ).toBe(true);

          // ③ 三段**互不相同** = "不要一股脑一个颜色配到底"的字面判据。
          //    首屏那张纸是半透明的（`--container-background-color` 铺在拼贴底上），
          //    真正看得见的是 `.collageBg` 那一层，所以拿它代表首屏。
          const heroC = deepestBg((await probeSel(page, "#hero .collageBg"))!);
          const contentC = deepestBg(content);
          const footC = deepestBg(foot);
          expect(
            Math.min(
              dmax(heroC, contentC),
              dmax(contentC, footC),
              dmax(heroC, footC),
            ) >= 8,
            `首屏 / 正文带 / 封底 三段底色两两不同 → 首屏[${heroC}] 正文[${contentC}] 封底[${footC}]`,
          ).toBe(true);
          // 浅色档：封底是深色、上面两段是浅色（"两张内页 + 一张封底"）。
          // 夜间档：三段**都**是深色（这是刻意的），能判的是**封底比正文带亮一档** ——
          // 它是封底不是内页，夜里也该与上面拉开（`src/index.css` 头注写明了这一点）。
          if (theme === "light") {
            expect(
              lin(footC) < 0.3 && lin(contentC) > 0.55 && lin(heroC) > 0.55,
              `封底是深色、首屏与正文带是浅色（截面上真的分了两段）` +
                ` → L(首屏)=${lin(heroC).toFixed(3)} L(正文)=${lin(contentC).toFixed(3)} L(封底)=${lin(footC).toFixed(3)}`,
            ).toBe(true);
          } else {
            expect(
              lin(footC) < 0.35 && lin(footC) > lin(contentC) && lin(contentC) > lin(heroC),
              `夜间三段仍是深色，但封底比正文带亮一档` +
                ` → L(首屏)=${lin(heroC).toFixed(3)} L(正文)=${lin(contentC).toFixed(3)} L(封底)=${lin(footC).toFixed(3)}`,
            ).toBe(true);
          }

          // ④ 像素判据：上面比的是**声明的色标**，这一条比的是**渲染出来的像素** ——
          //    "背景层被后一条声明顶掉"这类事故只有像素看得出来（声明还在，画不出来）。
          //    取样点全取在各段左缘、且**贴着接缝**（首屏贴下沿、正文带贴上沿、封底贴上沿）：
          //    这是最严的位置 —— 相邻两段在别处拉开、在接缝处却同色，等于没有分段。
          //    先量字色（下一步要把文字调成透明，之后就读不到真字色了）。
          const info: Record<string, TextInfo> = {};
          for (const [name, sel] of Object.entries(TEXT_SEL)) {
            info[name] = await page.evaluate((s) => {
              const e = document.querySelector(s) as HTMLElement;
              const c = getComputedStyle(e).color;
              const r = e.getBoundingClientRect();
              return { c, l: r.left, t: r.top, w: r.width, h: r.height };
            }, sel);
          }
          // ⚠️ 连 `transition` 一起关掉：`.link` 有 `transition: color .25s`，只把颜色改成
          // `transparent` 的话那一刻它正**过渡到一半**，截到的仍是灰字 —— 量出来的对比度
          // 只有 2.4:1（Python 版初版就被这个假红骗过一次）。
          await page.addStyleTag({
            content:
              ".footerContainer *{color:transparent !important;transition:none !important}",
          });
          // 整页截图 → 页面内 canvas（替代 Python/PIL 的 shot.getpixel；scrollY=0 时
          // getBoundingClientRect 的 viewport 坐标与整页截图坐标一致）。
          const shotBuf = await page.screenshot({ fullPage: true });
          await page.evaluate(
            (url) =>
              new Promise<void>((resolve, reject) => {
                const img = new Image();
                img.onload = () => {
                  const c = document.createElement("canvas");
                  c.width = img.width;
                  c.height = img.height;
                  const ctx = c.getContext("2d")!;
                  ctx.drawImage(img, 0, 0);
                  (window as unknown as { __shot: ImageData }).__shot =
                    ctx.getImageData(0, 0, c.width, c.height);
                  resolve();
                };
                img.onerror = () => reject(new Error("shot load failed"));
                img.src = url;
              }),
            "data:image/png;base64," + shotBuf.toString("base64"),
          );
          const getPixel = (x: number, y: number): Promise<number[]> =>
            page.evaluate(([xx, yy]) => {
              const shot = (window as unknown as { __shot: ImageData }).__shot;
              const i = (Math.floor(yy) * shot.width + Math.floor(xx)) * 4;
              return [shot.data[i], shot.data[i + 1], shot.data[i + 2]];
            }, [x, y] as [number, number]);

          const probes: Record<string, [number, number]> = {
            首屏: [hero.rect.l + 40, hero.rect.b - 40],
            正文带: [content.rect.l + 40, content.rect.t + 60],
            封底: [foot.rect.l + 40, foot.rect.t + 60],
          };
          const px: Record<string, number[]> = {};
          for (const [k, [x, y]] of Object.entries(probes)) {
            px[k] = await getPixel(x, y);
          }
          expect(
            Math.min(
              dmax(px["首屏"], px["正文带"]),
              dmax(px["正文带"], px["封底"]),
              dmax(px["首屏"], px["封底"]),
            ) >= 8,
            `三段**渲染出来的像素**两两不同（且取的是接缝附近） → ` +
              Object.entries(px)
                .map(([k, v]) => `${k}${v}`)
                .join(" "),
          ).toBe(true);

          // ⑤ 页脚字压在这一段上的对比度（WCAG AA 4.5:1）。取样读的是**这一行字下面**的
          //    真实底色 —— 渐变、贴片、`|` 分隔符都不会算错（文字已在前一步调成透明）。
          for (const [name, sel] of Object.entries(TEXT_SEL)) {
            const el = info[name];
            const fg = P(el.c);
            const xs = [el.l + 3, el.l + el.w * 0.5, el.l + el.w - 3];
            const y = el.t + el.h * 0.5;
            let worst: { r: number; bg: number[]; x: number } | null = null;
            for (const x of xs) {
              const bg = await getPixel(x, y);
              const r = ratio(over(fg, bg), bg);
              if (worst === null || r < worst.r) {
                worst = { r, bg, x: Math.floor(x) };
              }
            }
            // 报最差那一点的位置与底色：对照度判红时，先要分清是"字色不行"还是"取样点
            // 落在了一块浅色装饰上"（页脚那排 logo 贴片就吃过这个误判）。
            expect(
              worst!.r >= 4.5,
              `对比度 ≥ 4.5:1  ${sel} → ${worst!.r.toFixed(2)}:1  底色[${worst!.bg}] @x=${worst!.x}`,
            ).toBe(true);
          }

          expect(
            errs().length === 0,
            `${theme}：无 JS 报错 → ${errs().slice(0, 1)}`,
          ).toBe(true);
        }

        // ── 【三】几何：接缝胶带 / logo 贴片 / 窄屏 logo 排 ──
        await page.setViewportSize({ width: 1280, height: 900 });
        await page.goto(urlOf("light.html"));
        await page.waitForTimeout(300);
        const content = (await probeSel(page, "#content"))!;
        const foot = (await probeSel(page, "#foot"))!;

        // `.ContentContainer` 有 `overflow-x: hidden` ⇒ 按规范 `overflow-y` 计算成 `auto`
        // ⇒ 它是个**裁剪盒**。胶带一旦探出上沿（`top: -8px`）就会被裁掉，只剩贴着上沿的
        // 一条横杠（20261001 出图核对时抓到的）。所以这里同时钉住"是裁剪盒"与"胶带没探出去"。
        expect(
          content.overflowY === "auto",
          `正文带是裁剪盒（overflow-y 计算成 auto）——胶带不许骑缝 → ${content.overflowY}`,
        ).toBe(true);
        expect(
          parseFloat(content.before.top) >= 0 && content.before.h === "15px",
          `正文带胶带贴在上沿（top ≥ 0）且真有 15px 高 → top=${content.before.top} h=${content.before.h}`,
        ).toBe(true);
        // 页脚的胶带已删。判据取伪元素的计算 `content`：删掉整条规则后它是默认的 `none`
        // （**不是空串**）—— 「`top` 读不出来」那种写法分不清"压根没有伪元素"与"伪元素没写 top"。
        expect(
          foot.before.content === "none" || foot.before.content === "",
          `页脚没有接缝胶带（::before 的 content 是 none） → ${foot.before.content}`,
        ).toBe(true);

        // 赞助方贴片：**不透明的浅色**，且**贴合**——不是盖在 logo 外面的大白块。
        const plate = await page.evaluate((sel) => {
          const a = document.querySelector(sel) as HTMLElement;
          const img = a.querySelector("img") as HTMLElement;
          const ra = a.getBoundingClientRect();
          const ri = img.getBoundingClientRect();
          return {
            bg: getComputedStyle(a).backgroundColor,
            w: ra.width,
            h: ra.height,
            iw: ri.width,
            ih: ri.height,
          };
        }, "#lg1");
        const pc = P(plate.bg);
        expect(
          pc.length === 3 || (pc.length === 4 && pc[3] >= 0.95),
          `logo 贴片是不透明色（半透明会与深底混成深色） → ${plate.bg}`,
        ).toBe(true);
        expect(
          lin(pc) > 0.6,
          `logo 贴片是浅色（相对亮度 > 0.6）——深底上这几张深色 logo 才看得见 → L=${lin(pc).toFixed(3)}`,
        ).toBe(true);
        // 贴片宽 = 图宽 + 左右各 8px。宽出太多就是"一排大白块"（旧注释怕的那种），
        // 贴不住就是 logo 压在贴片边上。
        expect(
          Math.abs(plate.w - plate.iw - 16) < 1.5,
          `贴片贴合 logo（左右各只留 8px 呼吸边） → 贴片${plate.w.toFixed(0)}px 图${plate.iw.toFixed(0)}px`,
        ).toBe(true);

        for (const w of [320, 375]) {
          await page.setViewportSize({ width: w, height: 800 });
          await page.waitForTimeout(200);
          const r = await page.evaluate(() => {
            const f = document.querySelector("#foot")!.getBoundingClientRect();
            const l = document.querySelector("#logos")!.getBoundingClientRect();
            return {
              fl: f.left,
              fr: f.right,
              ll: l.left,
              lr: l.right,
              sw: document.documentElement.scrollWidth,
              iw: window.innerWidth,
            };
          });
          expect(
            r.ll >= r.fl - 0.5 && r.lr <= r.fr + 0.5,
            `${w}px 下 logo 排没探出页脚 → 页脚[${r.fl.toFixed(0)},${r.fr.toFixed(0)}] logo[${r.ll.toFixed(0)},${r.lr.toFixed(0)}]`,
          ).toBe(true);
          expect(
            r.sw <= r.iw,
            `${w}px 下没有横向滚动条 → scrollWidth=${r.sw}`,
          ).toBe(true);
        }
      },
    );
  });
});
