import { test, expect } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
import {
  FE_DIR,
  withSandbox,
  compileSass,
  collectPageErrors,
} from "./sandbox";

/**
 * z-index 阶梯：两份值逐值相等 + 四层真实堆叠次序（20261002，用户第 5 条）。
 * （原 tests/z-index.test.py，20261019 迁移）
 *
 * 用户原话：「首页手账贴纸打开后要在最顶层否者会被遮挡视线，向量空间页面打开左下角缺角了，
 * 不需要锁定功能和按钮了。个人中心打开时也是在最顶层不要被agent对话框遮挡，当然他们都在
 * 公告的层级下，不能遮挡公告弹窗。」
 *
 * **为什么只能问浏览器**：这件事全是层叠上下文算出来的，读源码看不出谁赢。
 *   · 前台整站被 `.frontRoot { isolation: isolate }` 封在 body 层级的一个层叠上下文里 ⇒
 *     里面写的 z-index 再大也只跟层内元素比大小，跟挂在 body 上的 `#waifu` 不是一个牌桌；
 *   · 看板娘原先写死 `z-index: 2147483000`（agent 仓 widget.css）——它不是"最高"，
 *     是"比谁都大"，个人中心与公告（两个 antd Modal，默认 `zIndexPopupBase=1000`）一律被压死；
 *   · 改完之后 `#waifu` 是 `var(--z-agent, 1000)`：**值来自本仓**（agent 仓那份只是兜底），
 *     所以"看板娘到底在第几层"这件事只有把两份文件一起加载起来才算得出来。
 *
 * 四组判据：
 *   ① **两份值逐值相等**：`src/index.css` 的 `:root` 阶梯 vs `src/zIndex.ts` 的 `Z`。
 *      antd 只认 `zIndex` prop、CSS 只认 `var()`，同一个数必须有两个人写 —— 这是本批
 *      唯一的新约定，也就是唯一会漂移的地方（漂了之后界面上什么异常都看不出来）。
 *   ② **真实堆叠次序**：把真 `index.css` + 真 `App.sass`（编译后）+ 真 `widget.css`
 *      （`public/live2d-widgets/`，由 pin 取回）一起加载，用 `document.elementFromPoint`
 *      问"这一个像素点上谁在最上面"。四层各问一次。
 *   ③ `.frontRoot` 的抬升是**开关式**的：`body.exhibit-zoomed` 挂着时它是
 *      `position: relative; z-index: 1100`，摘掉之后必须回到 `static/auto`
 *      —— 平时保持 static 是刻意的，定位元素会给所有 absolute 后代换包含块。
 *   ④ 首页整列抬升：向量空间放大时不许被置顶缎带 / 接缝胶带盖住（20261003 用户第 6 条）。
 *
 * （TS 迁移注：①节在 Node 里直接读文件做正则，与 Python 版相同；②③④节的沙箱改用
 * sandbox.ts 的 withSandbox/compileSass，夹具 HTML 与内嵌 script 逐字照抄；
 * ④b 红基线「摘掉抬升再编译」用沙箱目录里落一个 _home.flat.sass 实现。）
 */

const readFe = (rel: string): Promise<string> =>
  fs.readFile(path.join(FE_DIR, rel), "utf-8");

const APP_SASS = path.join(FE_DIR, "src/App.sass");
const HOME_SASS = path.join(
  FE_DIR,
  "src/frontHome/Content/ContentHome/index.sass",
);
const SECTIONS_SASS = path.join(
  FE_DIR,
  "src/frontHome/Content/ContentHome/sections.sass",
);
const VITRINE_SASS = path.join(
  FE_DIR,
  "src/frontHome/Content/ContentHome/Vitrine/index.sass",
);

// ══ ① 两份值逐值相等（纯文本，不需要浏览器）══════════════════════════════
const LADDER_RE = /^\s*--z-([a-z-]+):\s*(\d+);/gm;
const TS_RE = /^\s*([a-z-]+):\s*(\d+),/gm;

// ══ ②③ 四层堆叠夹具 ══════════════════════════════════════════════════════
// DOM 的**结构**照抄真页面，盒子尺寸只求"都在同一个点上重叠"：
//   · `.frontRoot` 是整站那层（App.tsx），里面放一张写满视口的页；
//   · `#waifu` 是 agent 仓的根节点（`position:fixed; height:300px`，left 由那份
//     widget.css 说了算——20261011 回退后是 15px，本套件**不抄这个数**）。
//     两处夹具补偿，都写在夹具的 <style>/DOM 里，真 widget.css 一字未改：
//     ① `bottom:-500px` 是收起态（滑出屏外），覆盖成 0 —— 本套件量的是层级不是位置；
//     ② 它没有 `width`，真页面里宽度由子节点（canvas / 对话面板）撑出来，
//        夹具里塞一个 60×47 的子块，否则盒子宽 0、指针永远命不中它。
//   · 个人中心与公告都是 antd Modal ⇒ portal 到 body、铺满视口的 wrap + mask；
//     这里用同样形状的 fixed 满屏 div 代替，`z-index` 取**阶梯变量**（和 tsx 里
//     `zIndex={Z.panel}` 同源，antd 写的就是这个数）。
const STACK_HTML = `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="index.css">
<link rel="stylesheet" href="app.css">
<link rel="stylesheet" href="widget.css">
<style>
 html,body{margin:0;height:100%}
 .frontRoot{min-height:100%}          /* 真规则只给背景，高度由内容撑 */
 #page{height:400px;background:#cfe8ff}
 #waifu{bottom:0 !important}          /* 夹具覆盖：见上面注释，只改位置不改层级 */
 .layer{position:fixed;inset:0;display:none}
 .layer[data-on="1"]{display:block}
</style></head><body>
<div class="frontRoot" data-layer="front"><div id="page" data-layer="page"></div></div>
<div id="waifu" data-layer="waifu"><div style="width:60px;height:47px;background:#333"></div></div>
<div class="md-zoom-overlay" data-layer="lightbox" style="display:none"></div>
<div class="layer" data-layer="panel" style="z-index:var(--z-panel)"></div>
<div class="layer" data-layer="modal" style="z-index:var(--z-modal)"></div>
<script>
 window.__set = (spec) => {
   // spec: { zoomed:bool, page:bool, waifu:bool, lightbox:bool, panel:bool, modal:bool }
   document.body.classList.toggle('exhibit-zoomed', !!spec.zoomed);
   document.getElementById('page').style.display = spec.page === false ? 'none' : '';
   document.getElementById('waifu').style.display = spec.waifu === false ? 'none' : '';
   document.querySelector('[data-layer=lightbox]').style.display = spec.lightbox ? 'block' : 'none';
   for (const k of ['panel', 'modal'])
     document.querySelector('[data-layer=' + k + ']').dataset.on = spec[k] ? '1' : '0';
 };
 window.__top = (x, y) => {
   const el = document.elementFromPoint(x, y);
   const hit = el && el.closest('[data-layer]');
   return hit ? hit.dataset.layer : (el ? el.tagName : null);
 };
 window.__root = () => {
   const cs = getComputedStyle(document.querySelector('.frontRoot'));
   return { z: cs.zIndex, pos: cs.position };
 };
</script></body></html>`;

interface LayerSpec {
  zoomed?: boolean;
  page?: boolean;
  waifu?: boolean;
  lightbox?: boolean;
  panel?: boolean;
  modal?: boolean;
}

// ══ ④ 首页整列抬升夹具（两份：正常 / 红基线摘抬升）════════════════════════
//
// 用户原话：「打开文章向量空间，发现窗口被置顶的标签，粉色和薄荷色交接处胶带遮挡了，
// 层级不对」。根因**不在** `.vitrine.is-zoomed` 的 1200 上：`.heroRight` 自己带
// `z-index: 3` ⇒ 它**就是一个层叠上下文**，里面那个 1200 只在**本列之内**比大小；外面的
// `.Top`（置顶缎带，10）与 `.ContentContainer::before`（粉/薄荷交界那道接缝胶带，3、
// 且 DOM 更靠后）跟它根本不在一个牌桌上。修法 = `body.exhibit-zoomed .heroRight` 整列抬到
// 200（高于整页前台内容、低于头部 998）。
//
// 这一组用**真的** `ContentHome/index.sass` + `sections.sass` + `Vitrine/index.sass`
// （`.Top` 的 10、`.ContentContainer::before` 的 3、`.vitrine.is-zoomed` 的 1200 全是
// 原样从产物里来的），夹具只把那两张纸**挪进视口** ——层级跟位置无关，而真页面里它们
// 在小半屏之外，`elementFromPoint` 够不着。两个探针点也**在页面里按实测盒子现算**
// （缎带取 `.TopTape` 的中心、胶带取 `.ContentContainer` 上沿往下 7px），
// 并当场断言它们落在放大窗口 `.vit-3d` 的矩形之内 —— 否则量的是窗口外面，判据是空的。
//
// **红基线**：第二份沙箱把那两行抬升摘掉，同样两个点必须改判成 ribbon / seam。
// 没有它，"放大态没被盖住"在元素根本不存在时也是绿的。

const ZOOM_RAISE = "    body.exhibit-zoomed &\n      z-index: 200\n";

const ZOOM_HTML = `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="index.css">
<link rel="stylesheet" href="app.css">
<link rel="stylesheet" href="home.css">
<link rel="stylesheet" href="sections.css">
<link rel="stylesheet" href="vitrine.css">
<style>
 html,body{margin:0}
 .ContentContainer{position:absolute !important;top:120px !important;left:0 !important;
   right:0 !important;height:60px !important;min-height:0 !important}
 .ContentContainer .TopArticle{position:absolute !important;top:150px !important;
   left:40px !important;width:220px !important;height:40px !important}
 /* 真页面上那道接缝胶带是 \`pointer-events: none\`（纯装饰，不挡滚动）。
    \`pointer-events\` 只影响**命中测试**、与**绘制次序**无关 ⇒ 夹具把它打开，
    好让 \`elementFromPoint\` 问得出"谁画在上面"这件事。层级属性一个没动。 */
 .ContentContainer::before{pointer-events:auto !important}
</style></head><body>
<div class="frontRoot">
  <section class="SelfDescription">
    <div class="SayWords"></div>
    <div class="heroRight" id="right">
      <figure class="heroPanel"></figure>
      <section class="vitrine" id="vit" data-layer="zoom">
        <div class="vit-3d"><div class="vit-face vit-panel"></div></div>
      </section>
    </div>
  </section>
  <div class="ContentContainer" id="cc" data-layer="seam">
    <div class="TopArticle" id="ta">
      <span class="Top" id="top"><span class="TopTape" id="tape"
        data-layer="ribbon">置顶</span></span>
    </div>
  </div>
</div>
<script>
 // 放大态的那两个动作在真页面里是同生共死的（Vitrine/index.tsx 的同一个 effect）：
 // \`body.exhibit-zoomed\` 抬整站、\`is-zoomed\` 把卡片换成满屏浮层。这里也一起切。
 window.__zoom = (on) => {
   document.body.classList.toggle('exhibit-zoomed', !!on);
   document.getElementById('vit').classList.toggle('is-zoomed', !!on);
 };
 // 命中的是谁：往上找最近的带 \`data-layer\` 的祖先。放大窗口整个标着 \`zoom\`；
 // 胶带在 pseudo 上 ⇒ \`elementFromPoint\` 回到它的宿主 \`.ContentContainer\`（\`seam\`）。
 window.__hit = (x, y) => {
   const el = document.elementFromPoint(x, y);
   if (!el) return null;
   const l = el.closest('[data-layer]');
   return l ? l.dataset.layer : (el.className || el.tagName);
 };
 window.__colZ = () => getComputedStyle(document.getElementById('right')).zIndex;
 // 两个探针点**现算**：缎带取 \`.TopTape\` 的中心，胶带取 \`.ContentContainer\` 上沿往下 7px
 // （\`::before\` 是 top:0、高 15px）。同时报出它们是否落在放大窗口 \`.vit-3d\` 的矩形里
 // —— 在窗口外面的话这一问是空的。
 window.__probes = () => {
   const c = (el) => { const r = el.getBoundingClientRect();
     return [Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)]; };
   const t = document.querySelector('.TopTape');
   const cc = document.querySelector('.ContentContainer');
   if (!t || !cc) return null;
   const v3 = document.querySelector('.vit-3d').getBoundingClientRect();
   const inV3 = (p) => p[0] >= v3.left && p[0] <= v3.right && p[1] >= v3.top && p[1] <= v3.bottom;
   const p1 = c(t), p2 = [Math.round(cc.getBoundingClientRect().left + cc.getBoundingClientRect().width / 2),
                          Math.round(cc.getBoundingClientRect().top + 7)];
   return {ribbon: {xy: p1, inV3: inV3(p1)}, seam: {xy: p2, inV3: inV3(p2)}};
 };
</script></body></html>`;

interface ProbePoint {
  xy: [number, number];
  inV3: boolean;
}
interface Probes {
  ribbon: ProbePoint;
  seam: ProbePoint;
}

test.describe("z-index 阶梯", () => {
  test.setTimeout(180_000);

  test("两份阶梯逐值相等 + 同一点四层堆叠实测 + 放大态整列抬升（红基线对照）", async ({
    page,
  }) => {
    // ── 【①】两份值逐值相等（index.css 的 :root vs zIndex.ts 的 Z）──
    // 只取那一张阶梯：`:root` 里还有一堆 `--washi-*`（不是数字，正则本来也捞不到），
    // 但 TS 那边得先把 `export const Z = { … } as const;` 那段切出来，否则会把注释里的
    // "1000" 之类也当成一项。
    const cssText = await readFe("src/index.css");
    const tsText = await readFe("src/zIndex.ts");
    const ladder: Record<string, number> = {};
    for (const m of cssText.matchAll(LADDER_RE)) ladder[m[1]] = Number(m[2]);
    const zBlock = tsText.match(/export const Z = \{(.*?)\n\} as const;/s);
    const tsVals: Record<string, number> = {};
    if (zBlock)
      for (const m of zBlock[1].matchAll(TS_RE)) tsVals[m[1]] = Number(m[2]);

    const cssKeys = Object.keys(ladder);
    const tsKeys = Object.keys(tsVals);
    expect(
      cssKeys.length > 0 &&
        tsKeys.length === cssKeys.length &&
        cssKeys.every((k) => k in tsVals),
      `两份都解析出来了、键集合相同 → css键[${cssKeys}] / ts键[${tsKeys}]`,
    ).toBe(true);
    // 逐键报出差异：整块比对只说"不相等"，改的人还得自己二分
    const keys = [...new Set([...cssKeys, ...tsKeys])].sort();
    for (const k of keys) {
      if (k in ladder && k in tsVals) {
        expect(
          ladder[k] === tsVals[k],
          `  · --z-${k} 两边都是 ${ladder[k]} → css ${ladder[k]} / ts ${tsVals[k]}`,
        ).toBe(true);
      }
    }
    expect(
      (ladder.effect ?? 0) < (ladder.agent ?? 0) &&
        (ladder.agent ?? 0) < (ladder.exhibit ?? 0) &&
        (ladder.exhibit ?? 0) < (ladder.lightbox ?? 0) &&
        (ladder.lightbox ?? 0) < (ladder.panel ?? 0) &&
        (ladder.panel ?? 0) < (ladder.modal ?? 0) &&
        (ladder.modal ?? 0) < (ladder.toast ?? Number.MAX_SAFE_INTEGER),
      `跨层的三档次序正确（effect < agent < exhibit < lightbox < panel < modal < toast）` +
        ` → ${ladder.effect} / ${ladder.agent} / ${ladder.exhibit} / ${ladder.lightbox} / ${ladder.panel} / ${ladder.modal} / ${ladder.toast}`,
    ).toBe(true);
    // 特效那一档还有个**消费面**：effects.js 里三个容器写的是 `var(--z-effect, 950)`，
    // 兜底值必须与阶梯同值，否则脱离本站加载时是另一个数（"文档里 950、代码里是别的"）。
    const effectsJs = await readFe("public/effects.js");
    const effFb = [...effectsJs.matchAll(/var\(--z-effect,\s*(\d+)\)/g)].map(
      (m) => m[1],
    );
    expect(
      effFb.length > 0 && effFb.every((v) => Number(v) === ladder.effect),
      `effects.js 读 --z-effect 且兜底值与阶梯同值 → effects.js ${[...new Set(effFb)].sort()} / 阶梯 ${ladder.effect}`,
    ).toBe(true);
    expect(
      effectsJs.split("z-index:99999").length - 1 === 0 &&
        effectsJs.split("${EFFECT_Z}").length - 1 === 3,
      `effects.js 三个特效容器都不再写死 99999 → 99999×${effectsJs.split("z-index:99999").length - 1} / EFFECT_Z×${effectsJs.split("${EFFECT_Z}").length - 1}`,
    ).toBe(true);

    // ── 【②】四层堆叠：同一个点上谁在最上面（elementFromPoint 实测）──
    // 看板娘那份是**pin 取回来的真文件**（`npm run fetch:widget` 落位）。少了它这个套件
    // 应该直接报错而不是静默降级 —— 它记的是跨仓契约，缺了就等于没验。
    const widgetCssPath = path.join(FE_DIR, "public/live2d-widgets/widget.css");
    const indexCss = await readFe("src/index.css");
    const widgetCss = await fs
      .readFile(widgetCssPath, "utf-8")
      .catch(() => {
        throw new Error(`缺 ${widgetCssPath}：先跑 \`npm run fetch:widget\`（它不在 git 里）`);
      });

    await withSandbox(
      {
        "index.html": STACK_HTML,
        "index.css": indexCss,
        "app.css": compileSass(APP_SASS),
        "widget.css": widgetCss,
      },
      async (sb) => {
        await page.setViewportSize({ width: 900, height: 400 });
        const errs = collectPageErrors(page);
        await page.goto(sb.url);
        await page.waitForTimeout(200);

        // 探针点**按实测盒子现算**，不硬写坐标：硬写的那版是 (40, 375)，靠 "#waifu 在
        // left:15px" 才成立——20261003 把它挪到 165px（= 板块半宽）、再收到 145px 之后，
        // 那个点当场落到了页面层上，而断言只会红一句、看不出是探针自己失效。
        // （20261011 位置回退到 15px，硬写那版**碰巧**又能命中了；照样不用它——现算这条
        //  路的价值就在于与位置解耦，下次它再挪去哪儿都不必回来改这个探针。）
        // 现算：横向取盒子中心，纵向取盒底往上 25px（盒子 300px 高、贴视口底缘）。
        const probe = (await page.evaluate(() => {
          const r = document.getElementById("waifu")!.getBoundingClientRect();
          return [r.left + r.width / 2, r.top + r.height - 25];
        })) as [number, number];
        // 红基线：这个点必须真在 `#waifu` 盒内。少了它，"看板娘压得住页面"在探针点
        // 根本没碰到看板娘时也是绿的（本次改动就是这么把它弄红的）。
        const inside = await page.evaluate(([x, y]) => {
          const r = document.getElementById("waifu")!.getBoundingClientRect();
          return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
        }, probe);
        expect(
          inside,
          `★ 探针点落在 #waifu 盒内（否则下面那组量的是别的东西） → (${probe[0].toFixed(0)}, ${probe[1].toFixed(0)})`,
        ).toBe(true);

        const top = async (spec: LayerSpec): Promise<string> => {
          await page.evaluate(
            (s) =>
              (
                window as unknown as { __set: (s: LayerSpec) => void }
              ).__set(s),
            spec,
          );
          return page.evaluate(
            ([x, y]) =>
              (
                window as unknown as { __top: (x: number, y: number) => string }
              ).__top(x, y),
            probe,
          );
        };

        const base: LayerSpec = { page: true, waifu: true };
        let t = await top(base);
        expect(
          t === "waifu",
          `★ 看板娘压得住前台页面（#waifu 的 var(--z-agent,1000) 生效 —— 兜底值取不到就说明这份 widget.css 的 var() 没解析出来） → ${t}`,
        ).toBe(true);

        t = await top({ ...base, zoomed: true });
        expect(
          t === "page",
          `★ 向量空间放大态：整站抬到看板娘之上（body.exhibit-zoomed ⇒ .frontRoot 到 1100） → ${t}`,
        ).toBe(true);

        t = await top({ ...base, lightbox: true });
        expect(
          t === "lightbox",
          `  图片查看器（1150）压得住页面与看板娘 → ${t}`,
        ).toBe(true);

        t = await top({ ...base, lightbox: true, panel: true });
        expect(
          t === "panel",
          `★ 个人中心（1200）压得住看板娘 —— 用户原话「个人中心打开时也是在最顶层不要被 agent 对话框遮挡」 → ${t}`,
        ).toBe(true);
        expect(
          t === "panel",
          `  个人中心也压得住图片查看器（1150 < 1200） → ${t}`,
        ).toBe(true);

        t = await top({ ...base, panel: true, modal: true });
        expect(
          t === "modal",
          `★ 公告（1300）压得住个人中心 —— 用户原话「他们都在公告的层级下，不能遮挡公告弹窗」 → ${t}`,
        ).toBe(true);

        t = await top({ ...base, lightbox: true, panel: true, modal: true });
        expect(
          t === "modal",
          `  四层同开时仍是公告在最上（不是「谁的 portal 后插入谁赢」） → ${t}`,
        ).toBe(true);

        // ── 【③】抬升是开关式的：类一摘就回到 static/auto ──
        await top({ page: true, waifu: true });
        const rootRead = () =>
          page.evaluate(() => {
            const cs = getComputedStyle(
              document.querySelector(".frontRoot") as Element,
            );
            return { z: cs.zIndex, pos: cs.position };
          });
        const r0 = await rootRead();
        expect(
          r0.pos === "static" && r0.z === "auto",
          `  不放大时 \`.frontRoot\` 仍是 static/auto（平时不给 absolute 后代换包含块） → ${r0.pos} / ${r0.z}`,
        ).toBe(true);

        await top({ page: true, waifu: true, zoomed: true });
        const r1 = await rootRead();
        expect(
          r1.pos === "relative" && r1.z === "1100",
          `★ 放大态是 relative + 1100（读者量到的值与阶梯一致） → ${r1.pos} / ${r1.z}`,
        ).toBe(true);

        await top({ page: true, waifu: true });
        const r2 = await rootRead();
        expect(
          r2.pos === "static" && r2.z === "auto",
          `★ 退出放大态后**回到 static/auto**（只加不摘的话整站会一直盖在对话面板上，而那时页面还能滚、看着完全不像层级问题） → ${r2.pos} / ${r2.z}`,
        ).toBe(true);

        await page.waitForTimeout(100);
        expect(errs().length === 0, `  全程无 pageerror → ${errs().slice(0, 2)}`).toBe(true);
      },
    );

    // ── 【④】向量空间放大态：首页那一列要盖得住缎带与接缝胶带 ──
    // 夹具只做一件事：把"接缝那一段"（`.ContentContainer`，粉/薄荷交界那道胶带是它的
    // `::before`）与"置顶那张卡"（`.ContentContainer .TopArticle > .Top > .TopTape`）
    // 挪进视口。`!important` 是刻意的：真规则是 `.ContentContainer .TopArticle` 这种两条
    // 起步的选择器，夹具不抬特异度就压不动它。**只改位置/尺寸，一个层级属性都不碰。**
    const zoomFiles = (raiseCol: boolean): Record<string, string> => ({
      "index.html": ZOOM_HTML,
      "index.css": indexCss,
      "app.css": compileSass(APP_SASS),
      "sections.css": compileSass(SECTIONS_SASS),
      "vitrine.css": compileSass(VITRINE_SASS),
      // home.css 占位：真正的内容在沙箱里现编译（红基线要先落盘 _home.flat.sass）
      "home.css": raiseCol ? compileSass(HOME_SASS) : "",
    });

    await withSandbox(zoomFiles(true), async (sb) => {
      await page.setViewportSize({ width: 900, height: 400 });
      const errs4 = collectPageErrors(page);
      await page.goto(sb.url);
      await page.waitForTimeout(300);

      const found = await Promise.all(
        ["#right", "#vit", ".TopTape", ".ContentContainer"].map((s) =>
          page.locator(s).count(),
        ),
      );
      expect(
        errs4().length === 0 && found.every((n) => n === 1),
        `  夹具是好的（无 JS 报错、\`.heroRight\` / 放大窗口 / 缎带 / 接缝段都在） → counts=[${found}] ${errs4().slice(0, 1).join("; ")}`,
      ).toBe(true);

      await page.evaluate(() =>
        (window as unknown as { __zoom: (on: boolean) => void }).__zoom(false),
      );
      const zOff = await page.evaluate(() =>
        (window as unknown as { __colZ: () => string }).__colZ(),
      );
      await page.evaluate(() =>
        (window as unknown as { __zoom: (on: boolean) => void }).__zoom(true),
      );
      const zOn = await page.evaluate(() =>
        (window as unknown as { __colZ: () => string }).__colZ(),
      );
      expect(
        zOff === "3" && zOn === "200",
        `★ 抬升是**开关式**的：不放大时仍是 3（那时它不该插队），放大态才到 200 → ${zOff} → ${zOn}`,
      ).toBe(true);

      const pr = (await page.evaluate(() =>
        (window as unknown as { __probes: () => Probes | null }).__probes(),
      )) as Probes | null;
      expect(
        !!pr && pr.ribbon.inV3 && pr.seam.inV3,
        `★ 两个探针点都落在放大窗口 \`.vit-3d\` 的矩形之内（在外面的话下面的判据是空的） → ${JSON.stringify(pr)}`,
      ).toBe(true);

      if (pr) {
        for (const [key, name] of [
          ["ribbon", "置顶缎带"],
          ["seam", "粉/薄荷接缝胶带"],
        ] as const) {
          const hit = await page.evaluate(
            ([x, y]) =>
              (
                window as unknown as {
                  __hit: (x: number, y: number) => string;
                }
              ).__hit(x, y),
            pr[key].xy,
          );
          expect(
            hit === "zoom",
            `★ 放大态下「${name}」那一点上最上面的是放大窗口（不是它自己） → 实测 ${hit} @ (${pr[key].xy[0]}, ${pr[key].xy[1]})`,
          ).toBe(true);
        }
      }
    });

    // ── 【④b】红基线：摘掉那两行抬升，上面那两条必须改判 ──
    await withSandbox(zoomFiles(false), async (sb) => {
      // 摘掉 `body.exhibit-zoomed &` 那两行 → _home.flat.sass → 再编译成 home.css。
      // （四份 sass 都不 @import 项目内其他 sass，摘完落到沙箱里编译是安全的。）
      const homeText = await fs.readFile(HOME_SASS, "utf-8");
      expect(
        homeText.split(ZOOM_RAISE).length - 1,
        `红基线补丁正好找到一处（夹具自检，对应 Python 版的 assert，不是判据）`,
      ).toBe(1);
      await sb.write(
        "_home.flat.sass",
        homeText.replace(ZOOM_RAISE, ""),
      );
      await sb.write("home.css", compileSass(path.join(sb.dir, "_home.flat.sass")));

      const errs5 = collectPageErrors(page);
      await page.goto(sb.url);
      await page.waitForTimeout(300);

      expect(
        errs5().length === 0,
        `  对照组页面本身是好的（无 JS 报错） → ${errs5().slice(0, 1).join("; ")}`,
      ).toBe(true);

      await page.evaluate(() =>
        (window as unknown as { __zoom: (on: boolean) => void }).__zoom(true),
      );
      const zFlat = await page.evaluate(() =>
        (window as unknown as { __colZ: () => string }).__colZ(),
      );
      expect(
        zFlat === "3",
        `  对照组的 \`.heroRight\` 在放大态也停在 3（差别只在少了那两行） → ${zFlat}`,
      ).toBe(true);

      const prb = (await page.evaluate(() =>
        (window as unknown as { __probes: () => Probes | null }).__probes(),
      )) as Probes | null;
      if (prb) {
        for (const [key, name, want] of [
          ["ribbon", "置顶缎带", "ribbon"],
          ["seam", "粉/薄荷接缝胶带", "seam"],
        ] as const) {
          const hit = await page.evaluate(
            ([x, y]) =>
              (
                window as unknown as {
                  __hit: (x: number, y: number) => string;
                }
              ).__hit(x, y),
            prb[key].xy,
          );
          expect(
            hit === want,
            `★ 对照组里「${name}」确实盖在放大窗口之上（⇒ 上面那两条有牙，不是「元素不存在也是绿的」） → 实测 ${hit}`,
          ).toBe(true);
        }
      }
    });
  });
});
