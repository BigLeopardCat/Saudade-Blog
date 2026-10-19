import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  FE_DIR,
  compileSass,
  htmlDoc,
  withSandbox,
  collectPageErrors,
} from "./sandbox";

/**
 * 文章详情页的顶部栏：导航字压在深色横幅上还读不读得出来（20261001，用户第 3 条）
 * （原 tests/read-topbar-contrast.test.py，20261019 迁移）。
 *
 * 现场（用户报的）：「文章详情页的顶部栏字体看不清」。
 *
 * 不是审美问题，是一处**合成**问题，读代码看不出来：
 *
 *   · `.headContainer` 默认 `background: transparent`，导航字吃 `var(--washi-ink)`
 *     （白天档 `#4a3550` 深墨紫）。这个值当初是压**淡彩首屏**选的，约 7:1，没问题。
 *   · 但文章详情页的首屏不是淡彩纸，是 `.readCover` —— 封面视频/大图，外加它自己
 *     顶缘那条 `rgba(0,0,0,.5)` 渐变。**实测横幅在导航那一带的中位亮度 = 58/255**。
 *   · 深墨紫压 58/255 ⇒ **1.0:1**。字和底是同一个亮度，肉眼完全分不开。
 *   · 夜间档本来就吃浅色令牌（`.frontDark` 把 `--washi-ink` 翻成 `#f3e8f6`），
 *     所以只有白天中招 —— 用户报的就是他白天看到的那一版。
 *
 * 修法（`index.sass` 的 `.over-dark`，类名由 `Head/index.tsx` 按路由挂）：
 * **字色 + 底色一起落**。只换字色不够——横幅是**视频**，最亮那 1% 的像素亮到 119/255，
 * 浅字压上去只剩 3.8:1；配一层 0.30 的黑纱才把它压到 5.4:1。
 *
 * 判据为什么落在这里而不是"截图看一眼"：这一族（[[sass-media-shadow-silent-failure]] 同源）
 * 的失效方式是**静默**的——类名没挂上、或者被同特异性的规则盖掉，页面照常渲染、
 * lint/tsc/单测全绿，只有字在深底上悄悄消失。所以：
 *
 *   ① 真编译 `Head/index.sass`（不是手抄选择器）+ 仓库里那份 `.css` 令牌与重置；
 *   ② 白天/夜间 × 中位亮度/最亮 1% 四种合成，逐个量**合成后**的对比度；
 *   ③ 反向对照：**摘掉 `.over-dark`** 时同一份标记必须读到 < 3.0 —— 证明上面那些
 *      判据不是空断言（否则"加了类"这件事根本没被验证到）；
 *   ④ 悬停/滚动态（`.is-stuck`）不受本次改动影响；
 *   ⑤ 源码契约：类名确实由 `/article/` 路由挂上去（sass 再好，没人挂也白搭）。
 */

const HEAD_SASS = path.join(FE_DIR, "src/frontHome/Head/index.sass");
const HEAD_TSX = path.join(FE_DIR, "src/frontHome/Head/index.tsx");
// 令牌（`--washi-ink` 两档都在 src/index.css 里；不复述它的值）+ 盒模型重置
const TOKENS_CSS = readFileSync(path.join(FE_DIR, "src/index.css"), "utf-8");
const MAIN_CSS = readFileSync(path.join(FE_DIR, "src/frontHome/main.css"), "utf-8");

// 实测的横幅亮度（`/article/54`，导航文字带 y 30..56 / x 290..1050，逐帧采样 8 帧同值）：
//   中位 58/255、p90 72、p99 119。取中位与最亮那 1% 两档当判据的两端。
const BANNER_MEDIAN = "rgb(58, 58, 59)";
const BANNER_BRIGHT = "rgb(119, 119, 119)";

// 与 Head/index.tsx 同形的标记。`.headContainer` 的类名按"透明态 / 悬停 / 滚动态 /
// 文章页"四种情形切换 —— 那正是被测对象。
const markup = (cls: string) => `
<div class="frontRoot">
  <header>
    <div class="headContainer${cls}">
      <div class="phoneBar"><i class="iconfont" id="burger">≡</i></div>
      <div class="webTitle"><h2><span class="firstTitle">Saudade</span>Blog</h2></div>
      <div class="headBar"><ul><li id="nav">首页</li><li id="nav2">留言板</li></ul></div>
    </div>
  </header>
</div>`;

interface PaintOpts {
  markup: string;
  dark: boolean;
  banner: string;
}

// 标记与页面底色一次画好（`:hover` 得由真鼠标进，不能在这一步里造假）
const PAINT = (o: PaintOpts) => {
  document.documentElement.classList.toggle("frontDark", !!o.dark);
  document.body.style.background = o.banner;
  document.getElementById("root")!.innerHTML = o.markup;
};

interface RgbA {
  r: number;
  g: number;
  b: number;
  a: number;
}
interface ProbeEl {
  color: string;
  bg: RgbA;
  fs: string;
  fw: string;
}
interface ProbeAll {
  nav: ProbeEl;
  nav2: ProbeEl;
  burger: ProbeEl;
  title: ProbeEl;
}

// 量的是**合成后**的底色：从元素一路往上把 backgroundColor 叠到页面底（横幅）上。
// 只看 computed backgroundColor 会被"透明"骗过去——`.headContainer` 默认就是透明的。
const PROBE = (): ProbeAll => {
  const parse = (s: string | null): RgbA | null => {
    const m = (s || "").match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const p = m[1].split(",").map((x) => parseFloat(x));
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  };
  const over = (fg: RgbA, bg: RgbA): RgbA => ({
    r: fg.r * fg.a + bg.r * (1 - fg.a),
    g: fg.g * fg.a + bg.g * (1 - fg.a),
    b: fg.b * fg.a + bg.b * (1 - fg.a),
    a: 1,
  });
  const bgBehind = (el: Element): RgbA => {
    let acc = parse(getComputedStyle(document.body).backgroundColor) ?? {
      r: 0,
      g: 0,
      b: 0,
      a: 1,
    };
    const chain: Element[] = [];
    for (let n: Element | null = el; n && n !== document.documentElement; n = n.parentElement) {
      chain.push(n);
    }
    chain.reverse();
    for (const n of chain) {
      const c = parse(getComputedStyle(n).backgroundColor);
      if (c && c.a > 0) acc = over(c, acc);
    }
    return acc;
  };
  const probe = (sel: string): ProbeEl => {
    const el = document.querySelector(sel)!;
    const cs = getComputedStyle(el);
    return { color: cs.color, bg: bgBehind(el), fs: cs.fontSize, fw: cs.fontWeight };
  };
  return {
    nav: probe("#nav"),
    nav2: probe("#nav2"),
    burger: probe("#burger"),
    title: probe(".webTitle h2"),
  };
};

/** "rgb(r, g, b)" 字符串 → {r,g,b}（忽略 alpha，与原实现同口径）。 */
function rgbOf(s: string): RgbA {
  const nums = s
    .slice(s.indexOf("(") + 1, s.indexOf(")"))
    .split(",")
    .map(Number);
  return { r: nums[0], g: nums[1], b: nums[2], a: 1 };
}

function lum(c: RgbA): number {
  const f = (v: number) => {
    v /= 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
}

function contrast(fg: string, bg: RgbA): number {
  const a = lum(rgbOf(fg));
  const b = lum(bg);
  const [hi, lo] = a >= b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}

test.describe("文章页顶栏对比度", () => {
  test.setTimeout(180_000);

  test(".over-dark 四档合成 ≥ 4.5:1；摘掉即 < 3.0；悬停/滚动不受影响", async ({
    page,
  }) => {
    const headCss = compileSass(HEAD_SASS);
    await withSandbox(
      {
        "index.html": htmlDoc(
          '<div id="root"></div>',
          TOKENS_CSS,
          MAIN_CSS,
          headCss,
        ),
      },
      async (sb) => {
        const errs = collectPageErrors(page);
        await page.setViewportSize({ width: 1280, height: 900 });
        await page.goto(sb.url);
        await page.waitForTimeout(150);

        const run = async (
          cls = "",
          dark = false,
          banner = BANNER_MEDIAN,
          hover = false,
        ): Promise<ProbeAll> => {
          await page.evaluate(PAINT, {
            markup: markup(cls),
            dark,
            banner,
          } satisfies PaintOpts);
          if (hover) {
            // 真鼠标进 —— `:hover` 没法用 JS 造假。**停在 `.webTitle` 上**而不是某一项
            // 导航上：`li:hover` 还有它自己的和纸胶带 chip（粉底粉字，是既定的悬停外观，
            // 与本条判据无关），停在标题上量到的才是 `.headContainer:hover` 那一层。
            await page.hover(".webTitle");
            await page.waitForTimeout(80); // 那条规则带 `transition: 0.6s`，等底色落定
          }
          return (await page.evaluate(PROBE)) as ProbeAll;
        };

        // ── ① 文章详情页（.over-dark）：四种合成逐档 ≥ 4.5:1 ──
        for (const [label, banner] of [
          ["中位亮度 58/255", BANNER_MEDIAN],
          ["最亮 1% 119/255", BANNER_BRIGHT],
        ] as const) {
          const r = await run(" over-dark", false, banner);
          for (const [name, key] of [
            ["首页", "nav"],
            ["留言板", "nav2"],
          ] as const) {
            const cr = contrast(r[key].color, r[key].bg);
            expect(
              cr >= 4.5,
              `白天 · ${label} · 导航「${name}」对比度 ≥ 4.5 → ${cr.toFixed(2)}:1  color=${r[key].color}`,
            ).toBe(true);
          }
          const cbr = contrast(r.burger.color, r.burger.bg);
          expect(
            cbr >= 4.5,
            `白天 · ${label} · 窄屏汉堡钮 ≥ 4.5 → ${cbr.toFixed(2)}:1`,
          ).toBe(true);
        }
        const rn = await run(" over-dark", true);
        const crn = contrast(rn.nav.color, rn.nav.bg);
        expect(
          crn >= 4.5,
          `夜间 · 导航「首页」对比度 ≥ 4.5 → ${crn.toFixed(2)}:1`,
        ).toBe(true);

        // ── ② 反向对照：摘掉 .over-dark（= 用户看到的那一版）必须读不出来 ──
        const r0 = await run();
        const cr0 = contrast(r0.nav.color, r0.nav.bg);
        expect(
          cr0 < 3.0,
          `白天 · 透明态 · 导航对比度 < 3.0（这就是「看不清」本身） → ${cr0.toFixed(2)}:1  color=${r0.nav.color} bg=(${Math.round(r0.nav.bg.r)}, ${Math.round(r0.nav.bg.g)}, ${Math.round(r0.nav.bg.b)})`,
        ).toBe(true);
        // 再证一条：读不出来是因为**字是深的**而底也是深的（不是"底太亮"那种相反的情形）
        expect(
          lum(rgbOf(r0.nav.color)) < 0.1,
          `  · 那一版的字色确实是深墨紫（亮度 < 0.1） → ${r0.nav.color}`,
        ).toBe(true);

        // ── ③ 悬停 / 滚动态（本次改动不许弄坏；悬停用真鼠标进） ──
        for (const [cls, label, hv] of [
          [" is-stuck", "已滚动", false],
          ["", "悬停", true],
        ] as const) {
          const r = await run(cls, false, BANNER_BRIGHT, hv);
          const cr = contrast(r.nav.color, r.nav.bg);
          expect(
            cr >= 4.5,
            `白天 · ${label} 态 · 导航 ≥ 4.5 → ${cr.toFixed(2)}:1`,
          ).toBe(true);
        }
        // 悬停时 `.headContainer:hover`（0.66）与 `.over-dark`（0.30）同特异性 ⇒ 源码顺序
        // 决定谁赢。这条量的是**悬停真的比常驻态更暗**（顺序写反了会反着来）。
        const stuckBg = (await run(" is-stuck", false, BANNER_BRIGHT)).nav.bg;
        const overBg = (await run(" over-dark", false, BANNER_BRIGHT)).nav.bg;
        expect(
          lum(stuckBg) < lum(overBg) - 0.01,
          `悬停/滚动的 0.66 深底比 .over-dark 的 0.30 更暗（同特异性规则的顺序没写反） → stuck ${lum(stuckBg).toFixed(3)} vs over-dark ${lum(overBg).toFixed(3)}`,
        ).toBe(true);

        // ── ④ 源码契约：类名真的由路由挂上去（sass 再好，没人挂也白搭） ──
        const tsx = readFileSync(HEAD_TSX, "utf-8");
        expect(
          tsx.includes("useLocation") && tsx.includes('from "react-router-dom"'),
          "引了 useLocation（判据是路由，不是别的东西）",
        ).toBe(true);
        expect(
          tsx.includes("/article/") && tsx.includes("pathname.startsWith("),
          "判据是 /article/ 开头（文章详情页）",
        ).toBe(true);
        expect(tsx.includes("' over-dark'"), "类名里拼了 ' over-dark'").toBe(true);
        const sassSrc = readFileSync(HEAD_SASS, "utf-8");
        expect(
          sassSrc.includes(".headContainer.over-dark") ||
            sassSrc.includes("&.over-dark"),
          "sass 里真有 .over-dark 这一支",
        ).toBe(true);

        expect(errs(), "无 JS 运行时报错").toEqual([]);
      },
    );
  });
});
