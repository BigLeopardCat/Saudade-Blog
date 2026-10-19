import { test, expect } from "@playwright/test";
import path from "node:path";
import {
  FE_DIR,
  compileSass,
  htmlDoc,
  withSandbox,
  collectPageErrors,
  esbuildInSandbox,
} from "./sandbox";

/**
 * 首页展示柜「撕纸翻页」的无头验收（20261001 七轮，用户第 2 条）：真组件 + 真指针 + 真帧。
 * （原 tests/vitrine-tear.test.py，20261019 迁移）
 *
 * 为什么必须另起一个脚本（`home-hero.test.py` 第 ⑥b 组已经锁了形状）：
 *   · 那一组量的是**静置的几何与源码**——折角多大、缺口几个顶点、谁 portal 到 body。
 *     它答不了"拖一下会怎样"：`--k` 是不是跟手、松手弹不弹得回来、
 *     "拖一点再撒手"到底算不算扯断、掉下去的那张纸有没有在**加速**、掉完有没有被销毁、
 *     掉落期间**文档高度涨没涨**。
 *   · 这几条全是**时序 + 事件**的真问题，只有真的按下、真的移动、真的等帧才看得见。
 *     其中"拖一点再撒手会不会照样扯断"是本套件第一版就抓到的一个真 bug：
 *     指针起落落在同一个按钮上，浏览器**一律补发 click**（不管中间拖了多远），
 *     而 `onCornerClick` 就是"点一下 = 扯一下"的入口 ⇒ 弹回那条路根本走不到。
 *
 * 沿用 announcement-popup-mount.test.py 那套既定手段（本机不能 vite build，见 CLAUDE.md §2）：
 * esbuild 把**真组件**打成一个 bundle，只桩 `exhibits.ts`（真那份是 `lazy(...)` 拉整个图谱，
 * 与本套件无关且会把 bundle 撑大）。
 */

const DEFINE_ENV =
  '{"VITE_HTTP_BASEURL":"","VITE_CDN_BASEURL":"","MODE":"production","DEV":false,"PROD":true,"BASE_URL":"/"}';

// 展品桩：形状与真那份一致（key/title/hint/badge/Component），组件换成一个死字符串。
// ⚠️ 只留一件，与生产一致 —— `EXHIBITS.slice(1)` 那沓垫纸因此是 0 层，正是线上形态。
const STUB_EXHIBITS = `import * as React from 'react';
export const EXHIBITS = [{
  key: 'stub',
  title: '桩展品',
  hint: '桩',
  badge: async () => '2026年10月01日 UTC+8 00:00:00',
  // ⚠️ 这个桩文件的扩展名是 '.ts'（与真身同名），写不了 JSX —— 用 createElement。
  Component: () => React.createElement('span', { className: 'stub-exhibit' }, '桩'),
}];
`;

const ENTRY = `import * as React from 'react';
import { createRoot } from 'react-dom/client';
import Vitrine from './src/frontHome/Content/ContentHome/Vitrine/index.tsx';
const root = createRoot(document.getElementById('root')!);
(window as any).__mount = () => root.render(<Vitrine />);
`;

// 舞台：`#root` 给宽度（`.vitrine` 是 `width: 100%`），body 撑到 2400px 高 ——
// 有滚动条才谈得上"掉落期间文档高度涨没涨"（第 ⑦ 条）。
const STAGE_CSS =
  "html,body{margin:0}body{min-height:2400px;background:#f4f0ff}" +
  "#root{width:900px;margin:0 auto;padding-top:60px}" +
  ".stub-exhibit{color:#fff}";

interface VitRect {
  left: number;
  top: number;
  width: number;
  height: number;
  bottom: number;
}

interface VitState {
  k: string;
  earTf: string | null;
  cornerCenter: { x: number; y: number } | null;
  cornerRect: { left: number; bottom: number } | null;
  vitRect: VitRect;
  flipped: boolean;
  zoomed: boolean;
  peeling: boolean;
  coverVis: string | null;
  coverClip: string | null;
  panelClip: string | null;
  // 那片折角纸（`.vit-ear`）在不在场。**flipped 态它必须在场**：缺口（`.vit-panel`
  // 的 `clip-path`）与它是同一形状、同源于 `--k`，所以缺口被它填满、读作折角，它同时
  // 是"这一页还能扯"的把手。`display: none` 只出现在放大态（那边两张 face 都收掉了
  // 缺口，见本文件【九】）。`getComputedStyle` 对 `visibility: hidden` 照样返回原值
  // ⇒ 这里判的是 `display`，两者别混用。
  earDisplay: string | null;
  gripLabel: string | null;
  fallCount: number;
  fallParentIsBody: boolean | null;
  fallInline: {
    left: number;
    top: number;
    width: number;
    height: number;
  } | null;
  fallFaceClip: string | null;
  // 掉落中的那张纸：`matrix(a,b,c,d,tx,ty)` 的后两位就是位移（只动 transform）。
  fallTy: number | null;
  fallTx: number | null;
  now: number;
  docH: number;
}

// 折角当前值的来源有两处：`--k`（`.vitrine` 上的自定义属性，拖拽时是它被改写）与
// `.vit-ear` 算出来的 `transform`（静止档是 matrix(0.2, …)）。两个都读 ——
// 只读一个的话"变量没传到那片纸上"这类断链会被漏掉。
const STATE = (): VitState => {
  const vit = (document.getElementById("vit") ||
    document.querySelector(".vitrine")) as HTMLElement;
  const ear = document.querySelector(".vit-ear");
  const corner = document.querySelector(".vit-corner");
  const cover = document.querySelector(".vit-cover");
  const panel = document.querySelector(".vit-panel");
  const fall = document.querySelector("body > .vit-fall");
  const cs = (el: Element | null): CSSStyleDeclaration | null =>
    el ? getComputedStyle(el) : null;
  const b = corner ? corner.getBoundingClientRect() : null;
  const matrixNum = (el: Element, i: number): number | null => {
    const m = getComputedStyle(el).transform.match(/matrix\(([^)]+)\)/);
    return m ? Number(m[1]!.split(",")[i]!) : null;
  };
  const face = fall ? fall.querySelector(".vit-face") : null;
  const c = vit.getBoundingClientRect();
  return {
    k: getComputedStyle(vit).getPropertyValue("--k").trim(),
    earTf: ear ? getComputedStyle(ear).transform : null,
    cornerCenter: b
      ? { x: b.left + b.width / 2, y: b.bottom - b.height / 2 }
      : null,
    cornerRect: b
      ? { left: Math.round(b.left), bottom: Math.round(b.bottom) }
      : null,
    vitRect: {
      left: Math.round(c.left),
      top: Math.round(c.top),
      width: Math.round(c.width),
      height: Math.round(c.height),
      bottom: Math.round(c.bottom),
    },
    flipped: vit.classList.contains("is-flipped"),
    zoomed: vit.classList.contains("is-zoomed"),
    peeling: vit.classList.contains("is-peeling"),
    coverVis: cs(cover)?.visibility ?? null,
    coverClip: cs(cover)?.clipPath ?? null,
    panelClip: cs(panel)?.clipPath ?? null,
    earDisplay: cs(ear)?.display ?? null,
    gripLabel: corner ? corner.getAttribute("aria-label") : null,
    fallCount: document.querySelectorAll("body > .vit-fall").length,
    fallParentIsBody: fall ? fall.parentElement === document.body : null,
    fallInline:
      fall && (fall as HTMLElement).style
        ? {
            left: parseFloat((fall as HTMLElement).style.left),
            top: parseFloat((fall as HTMLElement).style.top),
            width: parseFloat((fall as HTMLElement).style.width),
            height: parseFloat((fall as HTMLElement).style.height),
          }
        : null,
    fallFaceClip: face ? getComputedStyle(face).clipPath : null,
    fallTy: fall ? matrixNum(fall, 5) : null,
    fallTx: fall ? matrixNum(fall, 4) : null,
    now: performance.now(),
    docH: document.documentElement.scrollHeight,
  };
};

interface Box {
  l: number;
  t: number;
  r: number;
  b: number;
  w?: number;
  h?: number;
}
interface Zoomed {
  zoomed: boolean;
  k: string;
  card: Box;
  tapeL: Box;
  tapeR: Box;
  close: Box | null;
  earOff: string;
  cornerOff: string;
  // 20261002：放大态**两张 face 都不许有缺口**。翻没翻页决定了哪一张在上面，
  // 所以两张都要量 —— 只量一张的话，另一个状态下的洞会漏网。
  coverClip: string;
  panelClip: string;
}

const ZOOMED = (): Zoomed => {
  const q = (sel: string): HTMLElement =>
    document.querySelector(sel) as HTMLElement;
  const box = (el: Element): Box => {
    const b = el.getBoundingClientRect();
    return {
      l: +b.left.toFixed(1),
      t: +b.top.toFixed(1),
      r: +b.right.toFixed(1),
      b: +b.bottom.toFixed(1),
      w: +b.width.toFixed(1),
      h: +b.height.toFixed(1),
    };
  };
  const vit = q(".vitrine");
  const close = document.querySelector(".vit-close");
  return {
    zoomed: vit.classList.contains("is-zoomed"),
    k: getComputedStyle(vit).getPropertyValue("--k").trim(),
    card: box(q(".vit-3d")),
    tapeL: box(q(".vit-tapeL")),
    tapeR: box(q(".vit-tapeR")),
    close: close ? box(close) : null,
    earOff: getComputedStyle(q(".vit-ear")).display,
    cornerOff: getComputedStyle(q(".vit-corner")).display,
    coverClip: getComputedStyle(q(".vit-cover")).clipPath,
    panelClip: getComputedStyle(q(".vit-panel")).clipPath,
  };
};

// 胶带骑在卡片上沿：盒顶 -14px、盒高 22px ⇒ 盒底落在卡片顶下方 8px（`TAPE_COVER`）。
// ⚠️ 量到的是**旋转后的外接框**：-5°/+4° 让框上下各胖出 2.5px 上下 ⇒ 判据给一条带，
// 不是钉死一个数（胶带盒本身量不到，`getBoundingClientRect` 只有 bbox）。
const onCard = (z: { card: Box; tapeL: Box; tapeR: Box }): boolean => {
  const c = z.card;
  return (
    [z.tapeL, z.tapeR].every(
      (t) =>
        c.t + 2 <= t.b && t.b <= c.t + 18 && c.t - 20 <= t.t && t.t <= c.t,
    ) &&
    z.tapeL.l >= c.l - 1 &&
    z.tapeL.l <= c.l + 80 &&
    z.tapeR.r <= c.r + 1 &&
    z.tapeR.r >= c.r - 80
  );
};

const closeInCard = (z: { card: Box; close: Box | null }): boolean => {
  const c = z.card;
  return (
    z.close !== null &&
    z.close.r <= c.r - 4 &&
    z.close.l >= c.r - 60 &&
    z.close.t >= c.t &&
    z.close.t <= c.t + 40
  );
};

test.describe("展示柜撕纸翻页", () => {
  test.setTimeout(180_000);

  test("静止档/拖拽/松手/扯断/掉落/键盘/放大态/减少动效（43 条判据）", async ({
    page,
  }) => {
    const vitrineCss = compileSass(
      path.join(FE_DIR, "src/frontHome/Content/ContentHome/Vitrine/index.sass"),
    );

    await withSandbox(
      {
        "index.html": htmlDoc(
          '<div id="root"></div><script src="bundle.js"></script>' +
            "<script>window.__mount();</script>",
          STAGE_CSS,
          vitrineCss,
        ),
      },
      async (sb) => {
        await esbuildInSandbox(sb, {
          entry: "entry.tsx",
          files: {
            "entry.tsx": ENTRY,
            "src/frontHome/Content/ContentHome/Vitrine/exhibits.ts":
              STUB_EXHIBITS,
          },
          copySrc: true,
          define: { "import.meta.env": DEFINE_ENV },
          loaders: { ".sass": "text" },
        });

        const state = (): Promise<VitState> => page.evaluate(STATE);
        const press = async (
          dx: number,
          dy: number,
          steps = 6,
          release = true,
        ): Promise<VitState> => {
          // 在折角中心按下，沿 45° 对角线拖 (dx, dy)（正 dx 向右、负 dy 向上 = 朝右上扯）。
          const s = await state();
          const x = s.cornerCenter!.x;
          const y = s.cornerCenter!.y;
          await page.mouse.move(x, y);
          await page.mouse.down();
          for (let i = 1; i <= steps; i++) {
            await page.mouse.move(x + (dx * i) / steps, y + (dy * i) / steps);
          }
          if (release) await page.mouse.up();
          return s;
        };

        await page.setViewportSize({ width: 1280, height: 900 });
        const errs = collectPageErrors(page);
        await page.goto(`${sb.url}?t=1`);
        await page.waitForTimeout(400);

        // ── 一、静止档 ──
        let s = await state();
        expect
          .soft(
            s.k === "0.2",
            `★ \`--k\` 静止值是 0.2（不是 0：0 等于纸面完好无损，没地方下手） → ${s.k}`,
          )
          .toBe(true);
        expect
          .soft(
            (s.earTf || "").startsWith("matrix(0.2,"),
            `★ 那片纸跟着缩到 0.2（\`--k\` 真的传到了 \`.vit-ear\` 的 transform 上） → ${s.earTf}`,
          )
          .toBe(true);
        expect
          .soft(
            s.cornerRect!.left >= s.vitRect.left - 1 &&
              s.cornerRect!.bottom <= s.vitRect.bottom + 1,
            `★ 折角**整个落在卡片里侧**（左缘不越过卡片左缘、下缘不越过卡片下缘）——` +
              `六轮那枚撇到纸外的三角就是用户说的「突兀」` +
              ` → corner ${JSON.stringify(s.cornerRect)} vs vit ${s.vitRect.left}/${s.vitRect.bottom}`,
          )
          .toBe(true);
        expect
          .soft(
            (s.coverClip || "").replace(/ /g, "").split(",").length === 5,
            `封面左下角缺口在（clip-path 5 顶点） → ${(s.coverClip || "").slice(0, 60)}`,
          )
          .toBe(true);

        // ── 二、拖拽：折角跟手长、缺口跟着深 ──
        s = await press(48, -48, 4, false);
        const mid = await state();
        // 48+48 = 96px 的对角位移 ÷ 2 = 48 ⇒ k = 0.2 + 48 / 卡片高（九轮起分母是卡片高本身，
        // 不再是写死的 160px —— 用户第 1 条「至少要撕到左侧胶带位置才能掉落」）。
        // 沙箱里 `#root{width:900px}`、卡片 16:7 ⇒ 高 = 900 × 7/16 = 393.75 ⇒ k ≈ 0.322。
        const H = (900 * 7) / 16;
        expect
          .soft(
            Math.abs(parseFloat(mid.k) - (0.2 + 48 / H)) < 0.02,
            `★ 拖到一半：\`--k\` 从 0.2 长到约 0.32（指针沿对角线走的距离 / 卡片高 ——` +
              `手指走满一个卡高才折到头，缺口那时正好够到左上角那张胶带） → ${mid.k}`,
          )
          .toBe(true);
        expect
          .soft(
            parseFloat(mid.earTf!.split(",")[0]!.slice(7)) > 0.3,
            `  · 那片纸跟着长（不是只有变量在变） → ${mid.earTf}`,
          )
          .toBe(true);
        expect
          .soft(
            mid.coverClip !== s.coverClip,
            `  · 封面左下角的缺口**跟着深**（同一个 \`--k\` 驱动两处） → ${mid.coverClip!.slice(0, 60)}`,
          )
          .toBe(true);
        expect
          .soft(mid.peeling === true, `  · 拖拽期间挂着 \`is-peeling\`（过渡被关掉，折角才跟得上指针）`)
          .toBe(true);
        expect
          .soft(mid.fallCount === 0, `  · 还没翻页（\`.vit-fall\` 一张都没有） → ${mid.fallCount}`)
          .toBe(true);
        await page.mouse.up(); // 补齐没松的那一下（Python 版借下一段 press 隐式复位，这里显式归位）

        // ── 三、松手弹回（这里藏着那个真 bug）──
        s = await press(24, -24, 3); // 只走一小段（Δp = 24 ⇒ k ≈ 0.4）
        await page.waitForTimeout(60);
        const after = await state();
        expect
          .soft(
            after.k === "0.2",
            `★ 松手后 \`--k\` 回到 0.2（交还 sass 的静止档，不是摊平成 0） → ${after.k}`,
          )
          .toBe(true);
        expect
          .soft(
            after.fallCount === 0 && after.flipped === false,
            `★ **没有**翻页（\`.vit-fall\` 仍是 0、\`is-flipped\` 仍是 false）——` +
              `浏览器对「起落同在按钮上」的手势一律补发 click，不拦的话「拖一点再松手」` +
              `会照样扯断，弹回那条路根本走不到（本套件第一版就是靠这条抓出它的）` +
              ` → fall ${after.fallCount} / flipped ${after.flipped}`,
          )
          .toBe(true);
        expect
          .soft(after.peeling === false, `  · \`is-peeling\` 已摘（过渡交还给 sass）`)
          .toBe(true);

        // ── 四、扯到头：这一页从胶带底下抽走、掉出屏幕 ──
        const before = await state();
        // Δp = 340 > 0.8 × 卡片高（393.75 × 0.8 = 315）⇒ k 到顶 ⇒ 断。
        // ⚠️ 九轮起行程变长了（分母从 160 换成卡片高）：以前 200 就够，现在得走满一个卡高。
        await press(340, -340, 6);
        await page.waitForTimeout(40);
        const torn = await state();
        expect
          .soft(
            torn.fallCount === 1 && torn.fallParentIsBody === true,
            `★ 扯断了：body 上出现一张 \`.vit-fall\`（portal 到 document.body）` +
              ` → count ${torn.fallCount} / parentIsBody ${torn.fallParentIsBody}`,
          )
          .toBe(true);
        expect
          .soft(
            torn.flipped === true && before.flipped === false,
            `★ 翻页照旧发生（用户原话：「虽然视觉上被扯下来，但是实际上翻页依然是页面循环」）`,
          )
          .toBe(true);
        expect
          .soft(
            torn.coverVis === "hidden",
            `★ 原地那一页**真的隐藏**（不隐藏就是同一页同时存在两张） → ${torn.coverVis}`,
          )
          .toBe(true);
        expect
          .soft(
            (torn.panelClip || "").replace(/ /g, "").split(",").length === 5,
            `★ 折角跟着搬到台面上那一页（谁在上面谁才有缺口）⇒ 永远还有地方下手` +
              ` → ${(torn.panelClip || "").slice(0, 60)}`,
          )
          .toBe(true);
        // 那片纸必须**留着**：缺口与纸是同一形状（两边同源于 `--k`），所以缺口被填满、读作折角。
        // 它同时是"这一页还能扯"的把手，也是下一段"掀折角"动画的载体 —— 20261002 排缺口那个
        // 缺陷时最先想到的就是"把 flipped 态的纸藏掉"，那条路会同时废掉这两件事（掀的动作变
        // 不可见、缺角变成真的一个洞）。真正的病根在放大态，见本文件【九】。
        expect
          .soft(
            torn.earDisplay !== "none",
            `★ 那片折角纸仍在场（它填着缺口，也是「还能扯」的把手） → ${torn.earDisplay}`,
          )
          .toBe(true);
        expect
          .soft(
            torn.k === "0.2",
            `  · 折角自己回到静止档 0.2（新露出来的那页也有它的把手） → ${torn.k}`,
          )
          .toBe(true);
        expect
          .soft(
            Math.abs(torn.fallInline!.width - before.vitRect.width) <= 1 &&
              Math.abs(torn.fallInline!.top - (before.vitRect.top + 8)) <= 1,
            `  · 克隆纸与卡片同宽、起点比卡片顶低 8px（= 从胶带下缘之下抽出来；` +
              `九轮把胶带抬高了 5px，压进卡片的那段由 11px 变 8px）` +
              ` → fall ${JSON.stringify(torn.fallInline)} / vit top ${before.vitRect.top}`,
          )
          .toBe(true);
        expect
          .soft(
            torn.fallFaceClip === "none",
            `  · 克隆纸**不带缺口**（被扯下来的是一整张纸） → ${torn.fallFaceClip}`,
          )
          .toBe(true);

        // ── 五、掉落：加速 + 不撑文档 ──
        const fa = await state();
        await page.waitForTimeout(220);
        const fb = await state();
        await page.waitForTimeout(220);
        const fc = await state();
        if (fa.fallTy === null || fb.fallTy === null || fc.fallTy === null) {
          expect
            .soft(
              false,
              `★ 采样点都在掉落过程中（三帧都还在） → ${JSON.stringify([fa.fallTy, fb.fallTy, fc.fallTy])}`,
            )
            .toBe(true);
        } else {
          const v1 = (fb.fallTy - fa.fallTy) / ((fb.now - fa.now) / 1000);
          const v2 = (fc.fallTy - fb.fallTy) / ((fc.now - fb.now) / 1000);
          expect
            .soft(
              v2 > v1 + 100,
              `★ 竖直速度**在变大**（重力在起作用，不是匀速平移） → ${v1.toFixed(0)} → ${v2.toFixed(0)} px/s`,
            )
            .toBe(true);
          expect
            .soft(
              fc.fallTx! > fa.fallTx!,
              `  · 横向也在走（初速取自甩手那一下，往右） → ${fa.fallTx!.toFixed(0)} → ${fc.fallTx!.toFixed(0)}`,
            )
            .toBe(true);
          expect
            .soft(
              fb.docH === before.docH && fc.docH === before.docH,
              `★ 掉落期间**文档高度一个像素都没涨**（\`position: fixed\` 不参与滚动溢出；` +
                `留在 \`.vitrine\` 里绝对定位掉，纸一边掉、页面一边长，滚动条会当众跳一下）` +
                ` → before ${before.docH} / 掉中 ${fb.docH}, ${fc.docH}`,
            )
            .toBe(true);
        }

        // ── 六、掉出视口后销毁 ──
        await page.waitForTimeout(2500);
        const gone = await state();
        expect
          .soft(gone.fallCount === 0, `★ 克隆纸被销毁（DOM 里不留残骸） → ${gone.fallCount}`)
          .toBe(true);
        expect
          .soft(
            gone.flipped === true && gone.cornerRect !== null,
            `  · 卡片与折角都还在、仍是翻过去那一页（掉的只是那张纸）`,
          )
          .toBe(true);

        // ── 七、点一下 = **先掀起折角**、再扯（键盘同理）──
        // 20261001 八轮（用户第 5 条：「单击没有掀起左下角动画直接掉下去了，而且我感觉动画
        // 扯起来的角的**终点**可以更大一些」）：原来 `onCornerClick` 直接 `tear(...)`，
        // 折角一步从静止档（0.2）跨到"纸已经没了"。现在先把它掀到 1、等过渡演完再脱落。
        expect
          .soft(
            (gone.gripLabel || "").startsWith("扯下这一页"),
            `  折角仍是个有名字的按钮 → ${gone.gripLabel}`,
          )
          .toBe(true);
        await page.evaluate(() =>
          (document.querySelector(".vit-corner") as HTMLElement).focus(),
        );
        await page.keyboard.press("Enter");
        await page.waitForTimeout(80);
        const lift = await state();
        // ⚠️ 判据要连着读两条：`--k` 是**未注册**的自定义属性、不参与插值 ⇒ 写下去就是 1，
        // 光看它证明不了"有动画"；而 `.vit-ear` 的 transform 走那条 0.3s 过渡 —— 80ms 时
        // 它该停在静止档与 1 之间。只读 `--k` 的话，"退化成没有过渡的瞬间跳变"照样能骗过它。
        expect
          .soft(
            lift.k === "1" &&
              lift.fallCount === 0 &&
              lift.flipped === gone.flipped,
            `★ 按下先**掀起折角**（\`--k\` 推到 1），这一页**还没掉**（原来这里直接就掉了 ——` +
              `\`flipped\` 仍是掀之前那一面、body 上没有克隆纸）` +
              ` → k ${lift.k} / fall ${lift.fallCount} / flipped ${lift.flipped}`,
          )
          .toBe(true);
        expect
          .soft(
            0.2 < parseFloat(lift.earTf!.split(",")[0]!.slice(7)) &&
              parseFloat(lift.earTf!.split(",")[0]!.slice(7)) < 0.99,
            `★ 掀起是**看得见的过程**（80ms 时那片纸停在静止档与 1 之间 —— 有过渡，不是跳变） → ${lift.earTf}`,
          )
          .toBe(true);
        await page.waitForTimeout(600); // 掀 = 0.34s（`LIFT_MS`），再等它掉起来
        const keyed = await state();
        expect
          .soft(
            keyed.fallCount === 1 && keyed.flipped === false,
            `★ 掀到头之后才脱落（回车也能扯，键盘用户不是二等公民）` +
              ` → fall ${keyed.fallCount} / flipped ${keyed.flipped}`,
          )
          .toBe(true);
        expect
          .soft(
            keyed.k === "0.2",
            `  · 折角交还静止档（掀的那一下不是把纸角永久改了） → ${keyed.k}`,
          )
          .toBe(true);
        await page.waitForTimeout(2600); // 等上一张纸掉完，两轮别混在一起
        // 真·鼠标**单击**（用户第 5 条的原话就是「**单击**没有掀起左下角动画」）。与回车走的是
        // 同一个 `onClick`，但它前面多了一对 pointerdown/pointerup —— 那一对会先按拖拽的起手/
        // 收手跑一遍（挂上又摘掉 `is-peeling`、`setEar(null)` 交还静止档）。只测回车的话，
        // "收手时把 `--k` 写死成 0.2、掀的动作再也起不来"这类断链会漏网。
        const cc = (await state()).cornerCenter!;
        await page.mouse.click(cc.x, cc.y);
        await page.waitForTimeout(80);
        const clicked = await state();
        expect
          .soft(
            clicked.k === "1" && clicked.fallCount === 0,
            `★ 鼠标单击同样**先掀起**（\`--k\` 推到 1、纸还没掉）——` +
              `前面那对 pointerdown/up 没把掀的动作吃掉` +
              ` → k ${clicked.k} / fall ${clicked.fallCount}`,
          )
          .toBe(true);
        await page.waitForTimeout(600);
        const done = await state();
        expect
          .soft(
            done.fallCount === 1 && done.flipped === true,
            `★ 掀到头之后脱落（单击翻页闭环） → fall ${done.fallCount} / flipped ${done.flipped}`,
          )
          .toBe(true);
        await page.waitForTimeout(2600);

        // ── 九、放大态：小件跟着**卡片**走，不是跟着视口 ──
        // 用户第 1 条原话「文章向量空间，个性签名，下翻按钮，键合胶带盖在上面了，关闭按钮太靠
        // 右上角了」。九轮前胶带/折角/关闭按钮挂在 `.vitrine` 上，而放大态 `.vitrine` 变成
        // `position: fixed; inset: 0` ⇒ 那三件的 `top/left` 全按**视口**算：两张胶带飞到视口
        // 左右上角（正好压在标题/签名/下翻按钮那一片）、关闭按钮落在站点头部的右上角
        // （实测 (1382, 18)）。判据：放大之后它们必须仍然贴着**卡片**的四条边。
        await page.mouse.click(640, 300); // 翻过页之后单击卡片 ⇒ 放大
        await page.waitForTimeout(150);
        const z = await page.evaluate(ZOOMED);
        expect
          .soft(
            z.zoomed && z.close !== null,
            `★ 单击卡片进放大态（\`is-zoomed\` 挂上、关闭按钮出现） → zoomed ${z.zoomed}`,
          )
          .toBe(true);
        expect
          .soft(
            onCard(z),
            `★ 两张胶带仍骑着卡片上沿（挂 \`.vitrine\` 上的话会按视口算 ⇒ 飞到视口左右上角）` +
              ` → 卡片 ${JSON.stringify(z.card)} / 左 ${JSON.stringify(z.tapeL)} / 右 ${JSON.stringify(z.tapeR)}`,
          )
          .toBe(true);
        expect
          .soft(
            closeInCard(z),
            `★ 关闭按钮落在**卡片**右上角（旧位置实测 (1382, 18) = 站点头部那排图标里）` +
              ` → 关闭 ${JSON.stringify(z.close)} / 卡片 ${JSON.stringify(z.card)}`,
          )
          .toBe(true);
        expect
          .soft(
            z.earOff === "none" && z.cornerOff === "none",
            `  · 放大态收起折角与抓手（只读：这一页没有得撕的地方） → ${z.earOff} / ${z.cornerOff}`,
          )
          .toBe(true);
        // ★ 20261002 用户报："向量空间页面打开左下角缺角了"。病根就在上面那一条与缺口的关系：
        // 缺口由 `.vit-face` 的 `clip-path` 切出来、靠 `.vit-ear` 那片纸补上；放大态纸被收起
        // ⇒ 缺口变成一个**真的洞**（翻过页时在深玻璃上、没翻页时在浅色封面上）。
        // 修法是放大态把两张 face 的 `clip-path` 一起收掉，理由与修法都写在
        // `Vitrine/index.sass` 的 `.vitrine.is-zoomed` 里。
        expect
          .soft(
            z.coverClip === "none" && z.panelClip === "none",
            `★ 放大态两张 face **都没有缺口**（收起那片纸之后，缺口就成了一个洞）` +
              ` → cover ${z.coverClip} / panel ${z.panelClip}`,
          )
          .toBe(true);

        await page.mouse.click(z.close!.l + 18, z.close!.t + 18);
        await page.waitForTimeout(150);
        const z3 = await page.evaluate(ZOOMED);
        expect
          .soft(
            !z3.zoomed && z3.close === null && onCard(z3),
            `★ 点关闭退回内联卡片：小件仍在卡片上（放大与内联是同一个包含块）` +
              ` → 卡片 ${JSON.stringify(z3.card)} / 左 ${JSON.stringify(z3.tapeL)}`,
          )
          .toBe(true);

        // 反向对照：**把 DOM 搬回九轮前的位置**（三件挂到 `.vitrine` 上，而不是 `.vit-3d`）。
        // 只改 CSS 复现不出来 —— `.vit-3d` 自带 `transform`（`perspective` 那一层），
        // `position: fixed` 在它里面会退化成"相对这个祖先"，量到的仍是卡片角落。
        // 新开一局，做完就 `goto` 走人（被搬过的 DOM 不再交给 React 渲染）。
        await page.goto(`${sb.url}?t=9`);
        await page.waitForTimeout(400);
        const cc2 = (await state()).cornerCenter!;
        await page.mouse.click(cc2.x, cc2.y); // 单击 = 掀 + 扯
        await page.waitForTimeout(900);
        await page.mouse.click(640, 300); // 翻过页之后放大
        await page.waitForTimeout(150);
        const zb = await page.evaluate(() => {
          const vit = document.querySelector(".vitrine") as HTMLElement;
          const q = (sel: string) => document.querySelector(sel) as HTMLElement;
          const box = (el: Element): Box2 => {
            const b = el.getBoundingClientRect();
            return {
              l: +b.left.toFixed(1),
              t: +b.top.toFixed(1),
              r: +b.right.toFixed(1),
              b: +b.bottom.toFixed(1),
            };
          };
          // 九轮前就是这个父子关系：胶带与关闭按钮都住在 `.vitrine` 里
          [q(".vit-tapeL"), q(".vit-tapeR"), q(".vit-close")].forEach((el) =>
            vit.appendChild(el),
          );
          const card = box(q(".vit-3d"));
          return {
            zoomed: vit.classList.contains("is-zoomed"),
            card: card,
            tapeL: box(q(".vit-tapeL")),
            tapeR: box(q(".vit-tapeR")),
            close: box(q(".vit-close")),
          };
        });
        expect
          .soft(
            zb.zoomed && !onCard(zb) && !closeInCard(zb),
            `★ 反向对照：把三件搬回 \`.vitrine\`（九轮前的父子关系）后两条判据当场失效` +
              ` → 坏档 卡片 ${JSON.stringify(zb.card)} / 左 ${JSON.stringify(zb.tapeL)} / 关闭 ${JSON.stringify(zb.close)}`,
          )
          .toBe(true);

        // ── 八、减少动效：纸不掉，但**页照翻** ──
        await page.emulateMedia({ reducedMotion: "reduce" });
        await page.goto(`${sb.url}?t=2`);
        await page.waitForTimeout(400);
        const r0 = await state();
        await press(340, -340, 6); // 与第四组同一个行程（分母是卡片高）
        await page.waitForTimeout(120);
        const r1 = await state();
        expect
          .soft(
            r0.fallCount === 0 && r1.fallCount === 0,
            `★ 减少动效档下**不生成**克隆纸（TSX 的 \`prefersReducedMotion()\` 直接跳过抛体）` +
              ` → ${r0.fallCount} → ${r1.fallCount}`,
          )
          .toBe(true);
        expect
          .soft(
            r0.flipped === false && r1.flipped === true,
            `★ 但翻页照旧发生（用户要的是「别晃」，不是「别翻」）`,
          )
          .toBe(true);
        // 「点一下」那条路在这一档里也**不掀**：要是照常掀，60ms 时 `--k` 会是 1（定时器还没
        // 到点），用户就白等 0.34 秒才看到纸掉 —— 减少动效档要的正是"别让我等"。
        await page.evaluate(() =>
          (document.querySelector(".vit-corner") as HTMLElement).focus(),
        );
        await page.keyboard.press("Enter");
        await page.waitForTimeout(60);
        const r2 = await state();
        expect
          .soft(
            r2.k === "0.2" && r2.flipped === false && r2.fallCount === 0,
            `★ 减少动效档下点一下**不掀**（\`--k\` 没被推到 1、页已经翻回去、纸不掉）` +
              ` → k ${r2.k} / flipped ${r2.flipped} / fall ${r2.fallCount}`,
          )
          .toBe(true);

        expect
          .soft(
            errs().length === 0,
            `全程无页面异常 → ${errs().slice(0, 3).join("; ")}`,
          )
          .toBe(true);
      },
    );
  });
});

// 反向对照探针的盒（不带宽高，与 ZOOMED 的 Box 兼容）。
interface Box2 {
  l: number;
  t: number;
  r: number;
  b: number;
}
