import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { FE_DIR, compileSass, withSandbox, collectPageErrors } from "./sandbox";

/**
 * 河灯留言板（/guestbook）弹窗里的字压在纸面上还读不读得出来（20261009，用户报「字体颜色太淡看不清」）。
 * （原 tests/riverboard-contrast.test.py，20261019 迁移）
 *
 * 现场（用户报的）：「河灯留言板字体颜色太淡看不清」。不是审美问题，是一处**合成**问题：
 *
 *   · 20261005 把三个弹窗与灯气泡整体换成「墨青夜河 + 月白纸笺 + 朱砂印」，那次重绘
 *     **只重描了它逐个点名的选择器**；
 *   · 没被点名的那一族还留着"深底浅字"时代的取值（火漆棕底 + 米色字），那是为夜河底选的；
 *   · 压在纸面（`--rz-paper` ≈ rgb(229,217,190)）之上后，实测对比度掉到 1.0~2.5:1 ——
 *     最典型的灯影集条目：条目底 2.49:1、11px 的 meta 1.54:1、空态 1.02:1（几乎与纸同色）。
 *
 * 修法（`index.scss` 的 20261009 块）：这一族按纸面重定成三档墨 + 一档朱砂。判据为什么落在
 * 这里而不是"截图看一眼"：这一族的失效方式是**静默**的——覆盖块少写一条选择器、或者
 * 特异性被基形压过（`(0,4,0)` 压不过 `(0,5,0)` 这种事，看源码看不出来），页面照常渲染、
 * lint/tsc/单测全绿，只有字在纸面上悄悄消失。所以：
 *
 *   ① 真编译 `index.scss`（不是手抄选择器）+ 站内令牌与重置；
 *   ② 标记按 `index.tsx` 的 DOM 手搭，**凡是住在纸面容器里的文字**（气泡／三个弹窗盒／
 *      细读弹窗盒）逐段量**合成后**的对比度，全族 ≥ 4.5；
 *   ③ 反向对照：把 20261009 那一块从源码里摘掉再编译，同一份标记必须掉回 < 3.0
 *      —— 证明上面那些判据不是空断言；
 *   ④ 夜河场景上的字（标题／对联／底部提示）对**纯夜底色**留出画布水光的余量；
 *   ⑤ 源码契约：朱砂令牌只有一个定义处；那一族里不许再出现夜河浅色。
 */

const SCSS_PATH = path.join(FE_DIR, "src/pages/RiverBoard/index.scss");

// 20261009 那一块的起止标记（哨兵；改动块首注释会让这里失效，属于有意为之的耦合）
const MARK = "/* ---------------- 20261009：纸面上的遗留夜河色";
const END = "@media (max-width: 620px) {";

// 与 `index.tsx` 同形的标记（只搭结构，不引组件——本判据要的是"哪一族字住在纸面上"）。
// 夜河底的画布/灯体不需要：`.rz-root` 自己那层 `#03050c` 就是合成链的底。
const MARKUP = `
<div class="rz-root">
  <div class="rz-ui">
    <div class="rz-title">河灯留言板<i></i>
      <div class="rz-couplet"><span>一言<b>一</b></span><span>一盏<b>灯</b></span></div>
    </div>
    <button class="rz-home-btn">回主页</button>
    <button class="rz-album-btn">灯影集</button>
    <button class="rz-wish-btn"><i></i>点一盏河灯</button>
    <div class="rz-hint">把心愿放进河灯，它会顺水飘向远方</div>
  </div>

  <div class="rz-lanterns">
    <div class="rz-lantern rz-open">
      <div class="rz-bubble">
        <div class="rz-msg">愿你今夜好梦，明日顺遂。</div>
        <div class="rz-who">无名 · 刚刚</div>
        <span class="rz-seal">愿</span>
      </div>
    </div>
  </div>

  <!-- 细读弹窗 -->
  <div class="rz-modal">
    <div class="rz-modal-box">
      <div class="rz-scroll">
        <div class="rz-msg">愿你今夜好梦，明日顺遂。</div>
        <div class="rz-who">无名 · 2026-10-01 12:00</div>
        <div class="rz-reject"><span class="rz-reject-label">驳回理由</span>含广告内容</div>
        <div class="rz-mine-row">
          <span class="rz-minetag rz-wait">待审</span>
          <span class="rz-minetag rz-no">未通过</span>
          <span class="rz-minetag rz-ok">已点亮</span>
          <button class="rz-reclaim">收回河灯</button>
          <button class="rz-reclaim armed">确认收回？</button>
          <span class="rz-reclaim-err">收回失败，请稍后再试</span>
        </div>
        <button class="rz-modal-close"><span>关闭</span></button>
      </div>
      <span class="rz-seal">愿</span>
    </div>
  </div>

  <!-- 心愿弹窗 -->
  <div class="rz-modal rz-wish-modal">
    <div class="rz-modal-box rz-wish-box">
      <div class="rz-wish-step">
        <h3 class="rz-wish-title">点一盏河灯</h3>
        <p class="rz-wish-sub">先挑一盏喜欢的灯</p>
        <div class="rz-lamp-grid">
          <button class="rz-lamp-card sel"><img src="x" alt=""><span>河灯</span></button>
          <button class="rz-lamp-card"><img src="x" alt=""><span>莲灯</span></button>
        </div>
        <div class="rz-cat-grid">
          <button class="rz-cat-card sel">
            <span class="rz-seal rz-cat-seal">愿</span>
            <span class="rz-cat-name"><b>愿 · 星愿</b><i>把话交给河水</i></span>
          </button>
        </div>
        <textarea class="rz-wish-input" placeholder="此刻想说的话…"></textarea>
        <div class="rz-wish-count">12/200</div>
        <div class="rz-wish-author-row">
          <input class="rz-wish-author" placeholder="留名（默认当前账号昵称）">
          <button class="rz-wish-anon on">匿名</button>
          <button class="rz-wish-anon">具名</button>
        </div>
        <div class="rz-wish-foot">
          <button class="rz-wish-ghost">上一步</button>
          <button class="rz-wish-primary">放下河灯</button>
        </div>
      </div>
      <div class="rz-wish-step rz-wish-done">
        <div class="rz-wish-done-glow"></div>
        <h3 class="rz-wish-title">灯已入河</h3>
        <p class="rz-wish-sub">灯入待审，通过后即在河面公开点亮。</p>
        <div class="rz-wish-foot"><button class="rz-wish-primary">去看看我的灯</button></div>
      </div>
    </div>
  </div>

  <!-- 灯影集 -->
  <div class="rz-modal rz-album-modal">
    <div class="rz-album-box">
      <button class="rz-album-find on">寻灯</button>
      <h3 class="rz-album-title">灯影集</h3>
      <div class="rz-album-search"><input placeholder="检索心愿、留名或印章…"></div>
      <div class="rz-album-tabs"><button class="sel">时序↓</button><button>我的河灯</button><button>类型</button></div>
      <div class="rz-album-catf">
        <button class="rz-seal rz-album-catf-seal sel">愿</button>
        <button class="rz-seal rz-album-catf-seal">安</button>
      </div>
      <div class="rz-album-list">
        <button class="rz-album-item">
          <span class="rz-seal rz-album-seal">愿</span>
          <span class="rz-album-msg">愿你今夜好梦</span>
          <span class="rz-album-meta">无名 · 2026-10-01<i class="rz-minetag rz-wait">待审</i></span>
          <span class="rz-album-reason">驳回理由：含广告内容</span>
        </button>
        <button class="rz-album-item">
          <span class="rz-seal rz-album-seal">安</span>
          <span class="rz-album-msg">平安喜乐</span>
          <span class="rz-album-meta">无名 · 2026-10-01<i class="rz-minetag rz-no">未通过</i></span>
        </button>
        <button class="rz-album-item">
          <span class="rz-seal rz-album-seal">灯</span>
          <span class="rz-album-msg">灯灯灯</span>
          <span class="rz-album-meta">无名 · 2026-10-01<i class="rz-minetag rz-ok">已点亮</i></span>
        </button>
      </div>
      <p class="rz-album-empty">卷中暂无留言</p>
    </div>
  </div>

  <!-- 进门公告 -->
  <div class="rz-modal rz-notice-modal">
    <div class="rz-notice-box">
      <h3 class="rz-notice-title">留言板公告</h3>
      <div class="rz-notice-body"><p>本网站当前为非交互式个人站点。</p></div>
      <div class="rz-notice-foot"><button class="rz-wish-primary">我知道了</button></div>
    </div>
  </div>
</div>
`;

const NAMED = [
  ".rz-album-box", ".rz-album-item", ".rz-album-msg", ".rz-album-meta", ".rz-album-empty",
  ".rz-album-find", ".rz-album-tabs button.sel", ".rz-album-catf-seal", ".rz-album-seal",
  ".rz-minetag.rz-no", ".rz-cat-name b", ".rz-cat-name i", ".rz-lamp-card", ".rz-cat-card",
  ".rz-wish-count", ".rz-wish-anon.on", ".rz-reject", ".rz-reclaim", ".rz-reclaim.armed",
  ".rz-minetag.rz-ok", ".rz-modal-close", ".rz-hint", ".rz-title", ".rz-couplet > span",
  ".rz-couplet b", ".rz-home-btn", ".rz-album-btn", ".rz-wish-btn",
  ".rz-album-box::before",
];

interface Rgb {
  r: number;
  g: number;
  b: number;
}
interface Rgba extends Rgb {
  a: number;
}
interface PaperItem {
  txt: string;
  sel: string;
  paper: boolean;
  paperSel: string;
  color: string;
  fs: string;
  bg: Rgba;
}
interface StyleProbe {
  color: string;
  bg: Rgba;
  fs: string;
}
interface ProbeResult {
  items: PaperItem[];
  named: Record<string, StyleProbe | null>;
}

const PAINT = (o: { markup: string; body: string }): void => {
  document.body.style.background = o.body;
  document.body.style.margin = "0";
  document.getElementById("root")!.innerHTML = o.markup;
};

// 量的是**合成后**的底色：从元素一路往上把自己的 backgroundColor 叠到底。
// 只看 computed backgroundColor 会被"透明"骗过去（`.rz-minetag` 就是 transparent）。
const PROBE = (sels: string[]): ProbeResult => {
  const parse = (s: string): Rgba | null => {
    const m = (s || "").match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const p = m[1]!.split(",").map((x) => parseFloat(x));
    return { r: p[0]!, g: p[1]!, b: p[2]!, a: p.length > 3 ? p[3]! : 1 };
  };
  const over = (fg: Rgba, bg: Rgba): Rgba => ({
    r: fg.r * fg.a + bg.r * (1 - fg.a),
    g: fg.g * fg.a + bg.g * (1 - fg.a),
    b: fg.b * fg.a + bg.b * (1 - fg.a),
    a: 1,
  });
  const bgBehind = (el: Element): Rgba => {
    let acc = parse(getComputedStyle(document.body).backgroundColor)!;
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
  const op = (el: Element): number => {
    let o = 1;
    for (let n: Element | null = el; n && n !== document.documentElement; n = n.parentElement) {
      o *= parseFloat(getComputedStyle(n).opacity || "1");
    }
    return o;
  };
  const PAPER = ".rz-bubble, .rz-modal-box, .rz-album-box, .rz-notice-box";
  const root = document.querySelector(".rz-root")!;
  const out: PaperItem[] = [];
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node: Node | null;
  while ((node = w.nextNode())) {
    const t = (node.textContent || "").trim();
    if (!t) continue;
    const el = node.parentElement;
    if (!el) continue;
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden") continue;
    const opa = op(el);
    if (opa < 0.9) continue; // 悬停才亮的那种（气泡未开）不参与
    const holder = el.closest(PAPER);
    out.push({
      txt: t.slice(0, 18),
      sel:
        el.tagName.toLowerCase() +
        "." +
        (el.className || "").toString().trim().split(/\s+/).join("."),
      paper: !!holder,
      paperSel: holder
        ? "." + (holder.className || "").toString().trim().split(/\s+/).join(".")
        : "",
      color: cs.color,
      fs: cs.fontSize,
      bg: bgBehind(el),
    });
  }
  const probe = (s: string): StyleProbe | null => {
    const el = document.querySelector(s);
    if (!el) return null;
    const cs = getComputedStyle(el);
    return { color: cs.color, bg: bgBehind(el), fs: cs.fontSize };
  };
  const named: Record<string, StyleProbe | null> = {};
  for (const s of sels) named[s] = probe(s);
  return { items: out, named: named };
};

const rgba = (s: string): Rgba => {
  const p = s
    .slice(s.indexOf("(") + 1, s.indexOf(")"))
    .split(",")
    .map((x) => parseFloat(x));
  return { r: p[0]!, g: p[1]!, b: p[2]!, a: p.length > 3 ? p[3]! : 1 };
};

const lum = (c: Rgb): number => {
  const f = (v: number): number => {
    const x = v / 255;
    return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
};

// 文字的对比度必须按**压上去之后的那个颜色**算。
//
// 只取 `color` 的 RGB 会漏掉 alpha：本族大量用 `rgba(16,35,43,.78)` 这种半透明的墨，
// 照字面算出来是"全墨"（`.rz-album-msg` 与 `.rz-album-meta` 会算出**一模一样**的读数，
// 因为两者 RGB 相同、只差 alpha —— 那正是这个坑露出来的样子）。
const ratio = (fg: string, bg: Rgba): number => {
  const c = rgba(fg);
  const a = c.a;
  const eff = {
    r: c.r * a + bg.r * (1 - a),
    g: c.g * a + bg.g * (1 - a),
    b: c.b * a + bg.b * (1 - a),
  };
  const x = lum(eff);
  const y = lum(bg);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};

const short = (bg: Rgba): string =>
  `rgb(${Math.round(bg.r)},${Math.round(bg.g)},${Math.round(bg.b)})`;

// compileSass 只收文件路径：把改写后的源码写临时文件再编译（与原 Python 版同手法）。
const compileScssText = async (text: string): Promise<string> => {
  const tmp = path.join(
    tmpdir(),
    `rz-contrast-${Date.now()}-${Math.random().toString(36).slice(2)}.scss`,
  );
  await writeFile(tmp, text, "utf-8");
  try {
    return compileSass(tmp);
  } finally {
    await rm(tmp, { force: true });
  }
};

test.describe("河灯留言板纸面对比度", () => {
  test.setTimeout(180_000);

  test("纸面文字/反向对照/夜河余量/源码契约/悬停/进门幕（39 条判据）", async ({
    page,
  }) => {
    const src = readFileSync(SCSS_PATH, "utf-8");
    // 反向对照用的"旧档"：整块摘掉 20261009（块是顶层规则，下一条就是媒体查询）
    const markIdx = src.indexOf(MARK);
    const head = src.slice(0, markIdx);
    const rest = src.slice(markIdx + MARK.length);
    const endIdx = rest.indexOf(END);
    const BLOCK = rest.slice(0, endIdx); // 只到媒体查询为止，别把文件后半也算进"这一块"
    const tail = rest.slice(endIdx + END.length);
    const SRC_OLD = head + END + tail;
    // 另一类改动是"就地提 alpha"（改在基形/20261005 块里，不在 20261009 块里），摘块抓不到
    // 它们 —— 反向对照得把那一处字面量倒回去再编译一次，否则"旧档"其实是新档。
    const BOOT_NEW = "color: rgba(240, 226, 200, 0.62);";
    const BOOT_OLD = "color: rgba(240, 226, 200, 0.5);";
    if (src.split(BOOT_NEW).length - 1 !== 1) {
      throw new Error("进门幕那行字的取值变了，反向对照的锚点要跟着更新");
    }
    const SRC_BOOT_OLD = src.replace(BOOT_NEW, BOOT_OLD);

    const rzCss = await compileScssText(src);
    const rzOldCss = await compileScssText(SRC_OLD);
    const rzBootOldCss = await compileScssText(SRC_BOOT_OLD);
    // 站内令牌与重置（不复述它的值）。站内 body 今天是 Dashboard 那支 `--body-color`
    // 浅蓝灰；`.rz-root` 自己不透明，量到的纸面与它无关 —— 这里就照它填，顺带证明这一点。
    const tokensCss = readFileSync(path.join(FE_DIR, "src/index.css"), "utf-8");

    const htmlPage = (cssHref: string): string =>
      '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">' +
      '<link rel="stylesheet" href="tokens.css">' +
      `<link rel="stylesheet" href="${cssHref}">` +
      '</head><body><div id="root"></div></body></html>';

    await withSandbox(
      {
        "index.html": htmlPage("rz.css"),
        "old.html": htmlPage("rz-old.css"),
        "boot-old.html": htmlPage("rz-bootold.css"),
        "rz.css": rzCss,
        "rz-old.css": rzOldCss,
        "rz-bootold.css": rzBootOldCss,
        "tokens.css": tokensCss,
      },
      async (sb) => {
        const url = (name: string) => new URL(name, sb.url).toString();

        await page.setViewportSize({ width: 1280, height: 900 });
        const errs = collectPageErrors(page);

        const run = async (u: string): Promise<ProbeResult> => {
          await page.goto(u);
          await page.waitForTimeout(120);
          await page.evaluate(PAINT, { markup: MARKUP, body: "#E4E9F7" });
          // 必须等入场动画走完：`.rz-modal` 带 `animation: rz-fade 0.25s`（从 opacity 0 起），
          // 量早了整族会被"半透明"过滤掉 —— 这是取样错，不是页面错。
          await page.waitForTimeout(800);
          return page.evaluate(PROBE, NAMED);
        };

        const r = await run(url("index.html"));
        const paper = r.items.filter((x) => x.paper);

        // ── ① 纸面上的每一段文字逐条 ≥ 4.5（合成后的底色）──
        const byRatio = [...paper].sort(
          (a, b) => ratio(a.color, a.bg) - ratio(b.color, b.bg),
        );
        for (const it of byRatio) {
          const cr = ratio(it.color, it.bg);
          if (cr >= 4.5) continue;
          expect
            .soft(
              false,
              `${it.sel} 「${it.txt}」 ≥ 4.5 → ${cr.toFixed(2)}:1  color=${it.color} bg=${short(it.bg)}`,
            )
            .toBe(true);
        }
        expect
          .soft(
            byRatio.every((it) => ratio(it.color, it.bg) >= 4.5),
            `纸面文字共 ${paper.length} 段，全部 ≥ 4.5` +
              (paper.length
                ? ` → 最低 ${ratio(byRatio[0]!.color, byRatio[0]!.bg).toFixed(2)}:1`
                : " → 一段都没扫到"),
          )
          .toBe(true);
        expect
          .soft(
            paper.length >= 30,
            `扫到的纸面文字 ≥ 30 段（判据不是空扫） → 实得 ${paper.length}`,
          )
          .toBe(true);

        // ── ② 纸面本身确实是月白纸笺（不是暗底在兜底）──
        const box = r.named[".rz-album-box"]!;
        expect
          .soft(
            lum(box.bg) > 0.6,
            `灯影集盒底合成亮度 > 0.6（月白纸笺） → ${short(box.bg)} lum=${lum(box.bg).toFixed(2)}`,
          )
          .toBe(true);

        // ── ③ 反向对照：把 20261009 那块摘掉（= 用户看到的那一版）──
        const r0 = await run(url("old.html"));
        const named0 = r0.named;
        const family = [
          ".rz-album-msg", ".rz-album-meta", ".rz-album-empty", ".rz-album-tabs button.sel",
          ".rz-minetag.rz-no", ".rz-cat-name b", ".rz-wish-count", ".rz-reclaim",
        ];
        let reds = 0;
        for (const s of family) {
          const cr = ratio(named0[s]!.color, named0[s]!.bg);
          if (cr < 3.0) reds++;
        }
        expect
          .soft(
            reds >= 5,
            `旧档里这一族至少 5 条 < 3.0（「看不清」本身），实得 ${reds}`,
          )
          .toBe(true);
        expect
          .soft(
            named0[".rz-album-tabs button.sel"]!.color.replace(/ /g, "").includes("255,228,174"),
            `旧档页签选中仍是 #ffe4ae（20261005 没覆盖 color） → ${named0[".rz-album-tabs button.sel"]!.color}`,
          )
          .toBe(true);
        // 摘掉之后逐条都要**变差**（不是"改了跟没改一样"）
        for (const s of family) {
          const a = ratio(named0[s]!.color, named0[s]!.bg);
          const b = ratio(r.named[s]!.color, r.named[s]!.bg);
          expect
            .soft(b > a, `${s}：修后好于旧档（${a.toFixed(2)} → ${b.toFixed(2)}）`)
            .toBe(true);
        }

        // ── ④ 夜河场景上的字：对纯夜底色留出画布水光的余量（≥ 6.0）──
        for (const s of [
          ".rz-hint", ".rz-title", ".rz-couplet > span", ".rz-couplet b",
          ".rz-home-btn", ".rz-album-btn", ".rz-wish-btn",
        ]) {
          const cr = ratio(r.named[s]!.color, r.named[s]!.bg);
          expect
            .soft(cr >= 6.0, `${s} ≥ 6.0（线上画布比纯底亮，余量要够） → ${cr.toFixed(2)}:1`)
            .toBe(true);
        }
        expect
          .soft(
            r.named[".rz-hint"]!.color.includes("0.78"),
            `底部提示的字面量确实是 0.78（20261009 从 0.56 提上来） → ${r.named[".rz-hint"]!.color}`,
          )
          .toBe(true);

        // ── ⑤ 源码契约 ──
        expect
          .soft(
            src.split("--rz-vermilion-ink:").length - 1 === 1,
            `--rz-vermilion-ink 恰好定义一次（令牌岛） → ${src.split("--rz-vermilion-ink:").length - 1}`,
          )
          .toBe(true);
        // 块首注释**必须**留着那些旧色值（它是"修之前量到多少"的记录），所以只能查声明体：
        // 先摘注释再找。判据要管的是"这一族有没有人还在用夜河浅色"，不是"文件里提过没提过"。
        // 注意 MARK 是注释的开头（`/*`）本身，摘块后已不在 BLOCK 里 ⇒ 拼回去再剥。
        const decls = (MARK + BLOCK).replace(/\/\*.*?\*\//gs, "");
        for (const bad of [
          "#ff9d8a", "#f0c987", "#ffe4ae", "rgba(240, 222, 188", "--rz-vermilion-bright",
        ]) {
          expect
            .soft(!decls.includes(bad), `20261009 块（去掉注释后）不再出现夜河浅色 ${bad}`)
            .toBe(true);
        }
        expect
          .soft(
            BLOCK.includes("#ffe4ae") && BLOCK.includes("#ff9d8a"),
            `块首注释仍然记着旧读数（注释被误删就没人知道「为什么是 1.0~2.5」）`,
          )
          .toBe(true);
        expect
          .soft(
            !src.includes("color: rgba(238, 226, 197, 0.56)"),
            `.rz-hint 的 0.56 已不存在（基形 0.38 那处仍在基形里，与覆盖块无关）`,
          )
          .toBe(true);
        expect
          .soft(src.includes(MARK), `块首注释与哨兵一致（判据靠它摘块，别改名）`)
          .toBe(true);

        expect
          .soft(errs().length === 0, `无 JS 运行时报错 → ${errs().slice(0, 2).join("; ")}`)
          .toBe(true);

        // ── ⑥ 悬停态：基形里那套「深底浅字」的 :hover 与覆盖块同特异性 ⇒ 不显式写 color 就漏 ──
        // 悬停要**真命中测试**，所以量之前先把其余弹窗摘出屏幕（几个弹窗在标记里互相叠着，
        // 顶层那个会把底下的按钮盖住 —— 不摘的话 hover 落在别的元素上，量到的是"没悬停"）。
        const hoverMeasure = async (
          u: string,
          keep: string,
          sel: string,
        ): Promise<StyleProbe> => {
          await page.goto(u);
          await page.waitForTimeout(120);
          await page.evaluate(PAINT, { markup: MARKUP, body: "#E4E9F7" });
          await page.waitForTimeout(800);
          await page.evaluate((k) => {
            document.querySelectorAll(".rz-modal").forEach((m) => {
              if (!m.matches(k)) (m as HTMLElement).style.display = "none";
            });
          }, keep);
          await page.hover(sel);
          await page.waitForTimeout(200);
          return (await page.evaluate(PROBE, [sel])).named[sel]!;
        };

        for (const [s, keep] of [
          [".rz-album-tabs button:nth-child(2)", ".rz-album-modal"],
          [".rz-wish-ghost", ".rz-wish-modal"],
        ] as const) {
          const n = await hoverMeasure(url("index.html"), keep, s);
          const cr = ratio(n.color, n.bg);
          expect
            .soft(cr >= 4.5, `悬停 ${s} ≥ 4.5 → ${cr.toFixed(2)}:1 color=${n.color}`)
            .toBe(true);
          const o = await hoverMeasure(url("old.html"), keep, s);
          const cr0 = ratio(o.color, o.bg);
          expect
            .soft(cr0 < 3.0, `旧档悬停 ${s} < 3.0（那条 hover 泄漏是真的） → ${cr0.toFixed(2)}:1`)
            .toBe(true);
        }

        // ── ⑦ 进门幕那行字：底是它自己的不透明渐变，按两端停机色各量一次 ──
        // 这层幕自己单开一页量：它 position:absolute; inset:0; z-index:9，跟别的弹窗叠在一页里
        // 会把上面那节的悬停命中测试全挡掉。渐变换不来"合成底"（探针只读 backgroundColor），
        // 就把渐变换成它的两个停机色各量一遍 —— 那正是这行字能落到的最暗／最亮底。
        const BOOT =
          '<div class="rz-root"><div class="rz-boot"><div class="rz-boot-glow"></div>' +
          "<p>河灯将明 · 稍候</p></div></div>";
        for (const [arm, want] of [
          ["index.html", true],
          ["boot-old.html", false],
        ] as const) {
          for (const end of ["#02040c", "#081029"]) {
            await page.goto(url(arm));
            await page.waitForTimeout(120);
            await page.evaluate(
              (o: { m: string; e: string }) => {
                document.body.style.background = "#E4E9F7";
                document.getElementById("root")!.innerHTML = o.m;
                const b = document.querySelector(".rz-boot") as HTMLElement;
                b.style.backgroundImage = "none";
                b.style.backgroundColor = o.e;
              },
              { m: BOOT, e: end },
            );
            await page.waitForTimeout(400);
            const n = (await page.evaluate(PROBE, [".rz-boot p"])).named[".rz-boot p"]!;
            const cr = ratio(n.color, n.bg);
            if (want) {
              expect
                .soft(cr >= 4.5, `进门幕（渐变停机 ${end}）≥ 4.5 → ${cr.toFixed(2)}:1`)
                .toBe(true);
            } else {
              expect
                .soft(
                  cr < 4.5,
                  `旧档同一处（渐变停机 ${end}）< 4.5（0.5 是从这里提上来的） → ${cr.toFixed(2)}:1`,
                )
                .toBe(true);
            }
          }
        }
      },
    );
  });
});
