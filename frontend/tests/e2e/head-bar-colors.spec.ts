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
 * 顶栏「原来的显示逻辑 + 白天换字色」的两态字色锁（20261001 六轮，用户第 6 条）
 * （原 tests/head-bar-colors.test.py，20261019 迁移）。
 *
 * 用户原话：「顶部栏依旧做回原来的显示逻辑，只不过字体颜色白天模式需要换色否则看不清。」
 *
 * "原来的显示逻辑" = 默认整条**透明**，只有「悬停」与「页面已滚动」（`.is-stuck`）两态
 * 才落 `rgba(0,0,0,0.66)` 深底（`d85311e` 之前的形态）。那两态是**两档主题共用一层黑**，
 * 所以字必须跟着换浅；而透明态压的是页底 —— 白天是淡彩首屏（白字 ≈ 1.2:1，就是主人说的
 * "看不清"），夜里是深色页底（浅字才对）。
 *
 * **为什么只能问浏览器**：这件事全是 CSS 层叠的结果，读代码看不出谁赢 ——
 *   · 字色是 `var(--washi-ink)` 走**令牌分档**（白天深墨紫 / 夜间浅色），令牌本身住
 *     `src/index.css`，浅色档在 `:root`、深色档在选择器列表里；
 *   · 深底态那条覆盖 `&:hover, &.is-stuck { .webTitle, .headBar li { color: … } }` 与
 *     `.headBar li:hover`（和纸 chip）是**同特异性 (0,3,1)**，靠源码顺序定胜负 ——
 *     谁在前谁在后，只有 computedStyle 说了算；
 *   · `.headContainer` 是 `z-index:-1`，没有外面那层 `position:sticky; z-index:999` 的
 *     `<header>` 它连 hover 都收不到（本脚本第一版就栽在这上，量出一片"悬停没生效"）。
 *
 * 取自真文件：`src/frontHome/Head/index.sass`（现编译）+ `src/index.css`（令牌）。
 * DOM 结构照抄 `Head/index.tsx:262` 那层 `<header>`。
 */

const HEAD_SASS = path.join(FE_DIR, "src/frontHome/Head/index.sass");
// 令牌（`--washi-ink` 两档都在 src/index.css 里；不复述它的值）
const TOKENS_CSS = readFileSync(path.join(FE_DIR, "src/index.css"), "utf-8");

// 结构照抄真页面（Head/index.tsx:262）：顶栏整条住在一条 `position:sticky;
// z-index:999` 的 <header> 里，`.frontDark` 挂在它身上。`.headContainer` 自己是
// `z-index:-1` + absolute —— 少了这层 header，它就被页底整个压住、连 hover 都收不到。
const STRUCT_CSS = `
 html,body{margin:0}
 body{min-height:220px;background:#efe7f2}
 header{display:flex;position:sticky;top:0;width:100%;z-index:999}
 header.frontDark{background:#1b1626}
`;

const BODY = `
<header id="hdr">
  <div class="headContainer" id="hc">
    <div class="webTitle"><h2><span class="firstTitle">林陌青川</span>Blog</h2></div>
    <div class="headBar"><ul><li>首页</li></ul></div>
  </div>
</header>
<script>
  window.__dark = (on) => {
    document.getElementById('hdr').classList.toggle('frontDark', on);
    document.body.style.background = on ? '#1b1626' : '#efe7f2';
  };
</script>`;

const READ = () => {
  const g = (s: string): string => {
    const e = document.querySelector(s);
    return e ? getComputedStyle(e).color : "";
  };
  return {
    title: g(".webTitle"),
    li: g(".headBar li"),
    chip: g(".firstTitle"),
    bg: getComputedStyle(document.getElementById("hc")!).backgroundColor,
  };
};
interface ReadResult {
  title: string;
  li: string;
  chip: string;
  bg: string;
}

/** 从 rgb()/rgba() 字符串取前三个数字。 */
function rgbOf(c: string): [number, number, number] {
  const parts = (c.match(/[\d.]+/g) ?? []).map(Number);
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
}

/** 相对亮度（0..1）——只用来判"这字是深的还是浅的"。 */
function lum(c: string): number {
  const f = (v: number) => {
    v /= 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const [r, g, b] = rgbOf(c);
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

function contrast(fg: string, bg: string): number {
  const a = lum(fg);
  const b = lum(bg);
  const [hi, lo] = a >= b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}

const DAY_BG = "rgb(239, 231, 242)"; // #efe7f2 淡彩纸（透明态压的就是它）
const NIGHT_BG = "rgb(27, 22, 38)"; // #1b1626
const DARK_BAR = "rgb(0, 0, 0)"; // rgba(0,0,0,.66) 的等效观感（算对比度取极值）

test.describe("顶栏两态字色", () => {
  test.setTimeout(180_000);

  test("白天/夜间 × 透明/悬停/滚动：底色翻面时字色跟着翻", async ({ page }) => {
    // ── 编译真 sass：CLI（node_modules/.bin/sass）在本机是坏的（chokidar 的
    //    ERR_REQUIRE_ESM），走 node API —— 与 sass-media-shadow.test.mjs 同一条通路。
    const headCss = compileSass(HEAD_SASS);
    await withSandbox(
      { "index.html": htmlDoc(BODY, TOKENS_CSS, headCss, STRUCT_CSS) },
      async (sb) => {
        const errs = collectPageErrors(page);
        for (const dark of [false, true]) {
          const tag = dark ? "夜间" : "白天";
          const pageBg = dark ? NIGHT_BG : DAY_BG;
          await page.setViewportSize({ width: 1280, height: 300 });
          await page.goto(sb.url);
          if (dark) {
            await page.evaluate(() =>
              (window as unknown as { __dark: (on: boolean) => void }).__dark(true),
            );
          }
          await page.waitForTimeout(200);

          // ── ① 未滚动 = 透明态（这就是"原来的显示逻辑"） ──
          const v = (await page.evaluate(READ)) as ReadResult;
          expect(
            ["rgba(0, 0, 0, 0)", "transparent"].includes(v.bg),
            `${tag} 未滚动：整条是透明的（不是常驻纸底） → ${v.bg}`,
          ).toBe(true);
          if (dark) {
            expect(
              lum(v.title) > 0.5,
              `${tag} 未滚动：字是**浅色** —— 深色页底上要亮  ${v.title} → ${contrast(v.title, pageBg).toFixed(1)}:1`,
            ).toBe(true);
          } else {
            expect(
              lum(v.title) < 0.15,
              `${tag} 未滚动：字是**深色**（这正是主人要换的那一笔，原为白字）  ${v.title} → ${contrast(v.title, pageBg).toFixed(1)}:1`,
            ).toBe(true);
          }
          expect(
            contrast(v.title, pageBg) >= 3.0,
            `${tag} 未滚动：对比度 ≥ 3:1（页底 ${pageBg}） → ${contrast(v.title, pageBg).toFixed(2)}:1`,
          ).toBe(true);
          expect(
            v.li === v.title,
            `${tag} 未滚动：导航项与站名同色 → ${v.li} / ${v.title}`,
          ).toBe(true);

          // ── ② 悬停整条落深底 ──
          // 过渡 0.6s：读太早会量到中间帧（本脚本第一版就吃到过 rgba(0,0,0,0.19)）。
          await page.hover("#hc");
          await page.waitForTimeout(800);
          const vh = (await page.evaluate(READ)) as ReadResult;
          expect(
            vh.bg === "rgba(0, 0, 0, 0.66)",
            `${tag} 悬停：整条落深底 rgba(0,0,0,0.66) → ${vh.bg}`,
          ).toBe(true);
          expect(
            lum(vh.title) > 0.5,
            `${tag} 悬停：站名换成浅色  ${vh.title} → ${contrast(vh.title, DARK_BAR).toFixed(1)}:1`,
          ).toBe(true);
          expect(
            vh.li === vh.chip,
            `${tag} 悬停：被指到的导航项吃和纸 chip（与站名**故意**不同色 —— `
              + "`.headBar li:hover` 与深底那条同特异性 (0,3,1)，靠源码顺序让 chip 赢）"
              + ` → ${vh.li} / chip ${vh.chip}`,
          ).toBe(true);
          const [cr, cg, cb] = rgbOf(vh.chip);
          expect(
            cr > cg && cr > cb,
            `${tag} 悬停：站名那颗 chip 仍吃玫红（没被深底那组一起染白） → ${vh.chip}`,
          ).toBe(true);
          await page.mouse.move(0, 0);
          await page.waitForTimeout(800);

          // ── ③ 已滚动 = .is-stuck（贴满整幅、去圆角、深底） ──
          await page.evaluate(() =>
            document.getElementById("hc")!.classList.add("is-stuck"),
          );
          await page.waitForTimeout(800);
          const vs = (await page.evaluate(READ)) as ReadResult;
          expect(
            vs.bg === "rgba(0, 0, 0, 0.66)",
            `${tag} 滚动态：整条落深底 → ${vs.bg}`,
          ).toBe(true);
          expect(
            lum(vs.title) > 0.5,
            `${tag} 滚动态：站名是浅色  ${vs.title} → ${contrast(vs.title, DARK_BAR).toFixed(1)}:1`,
          ).toBe(true);
          expect(
            vs.li === vs.title,
            `${tag} 滚动态：导航项同色（这时没有 chip 覆盖） → ${vs.li} / ${vs.title}`,
          ).toBe(true);
          const geo = (await page.evaluate(() => {
            const hc = document.getElementById("hc")!;
            const b = hc.getBoundingClientRect();
            const s = getComputedStyle(hc);
            return {
              w: Math.round(b.width),
              left: Math.round(b.left),
              radius: s.borderTopLeftRadius,
              vw: window.innerWidth,
            };
          })) as { w: number; left: number; radius: string; vw: number };
          expect(
            geo.w === geo.vw && geo.left === 0 && geo.radius === "0px",
            `${tag} 滚动态：贴满整幅、去圆角（原内联 background/width/margin 的活） → ${JSON.stringify(geo)}`,
          ).toBe(true);
        }

        expect(errs(), "全程无页面异常").toEqual([]);
      },
    );
  });
});
