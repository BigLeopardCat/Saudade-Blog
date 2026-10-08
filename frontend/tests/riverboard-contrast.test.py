#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""河灯留言板（/guestbook）弹窗里的字压在纸面上还读不读得出来（20261009，用户报「字体颜色太淡看不清」）。

  python3 tests/riverboard-contrast.test.py

现场（用户报的）：「河灯留言板字体颜色太淡看不清」。不是审美问题，是一处**合成**问题：

  · 20261005 把三个弹窗与灯气泡整体换成「墨青夜河 + 月白纸笺 + 朱砂印」，那次重绘
    **只重描了它逐个点名的选择器**；
  · 没被点名的那一族还留着"深底浅字"时代的取值（火漆棕底 + 米色字），那是为夜河底选的；
  · 压在纸面（`--rz-paper` ≈ rgb(229,217,190)）之上后，实测对比度掉到 1.0~2.5:1 ——
    最典型的灯影集条目：条目底 2.49:1、11px 的 meta 1.54:1、空态 1.02:1（几乎与纸同色）。

修法（`index.scss` 的 20261009 块）：这一族按纸面重定成三档墨 + 一档朱砂。判据为什么落在
这里而不是"截图看一眼"：这一族的失效方式是**静默**的——覆盖块少写一条选择器、或者
特异性被基形压过（`(0,4,0)` 压不过 `(0,5,0)` 这种事，看源码看不出来），页面照常渲染、
lint/tsc/单测全绿，只有字在纸面上悄悄消失。所以：

  ① 真编译 `index.scss`（不是手抄选择器）+ 站内令牌与重置；
  ② 标记按 `index.tsx` 的 DOM 手搭，**凡是住在纸面容器里的文字**（气泡／三个弹窗盒／
     细读弹窗盒）逐段量**合成后**的对比度，全族 ≥ 4.5；
  ③ 反向对照：把 20261009 那一块从源码里摘掉再编译，同一份标记必须掉回 < 3.0
     —— 证明上面那些判据不是空断言；
  ④ 夜河场景上的字（标题／对联／底部提示）对**纯夜底色**留出画布水光的余量；
  ⑤ 源码契约：朱砂令牌只有一个定义处；那一族里不许再出现夜河浅色。
"""
import pathlib
import re
import shutil
import subprocess
import tempfile

FE = pathlib.Path(__file__).resolve().parent.parent
SCSS = FE / "src/pages/RiverBoard/index.scss"

PASS, FAIL = 0, 0


def check(desc: str, cond: bool, detail: str = "") -> None:
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"  ✓ {desc}")
    else:
        FAIL += 1
        print(f"  ✗ {desc}" + (f"  → {detail}" if detail else ""))


SASS_JS = 'const sass=require("sass");process.stdout.write(sass.compile(process.argv[1]).css.toString());'
# 20261009 那一块的起止标记（哨兵；改动块首注释会让这里失效，属于有意为之的耦合）
MARK = "/* ---------------- 20261009：纸面上的遗留夜河色"
END = "@media (max-width: 620px) {"


def compile_scss(src: str) -> str:
    with tempfile.NamedTemporaryFile("w", suffix=".scss", delete=False, encoding="utf-8") as f:
        f.write(src)
        tmp = pathlib.Path(f.name)
    try:
        r = subprocess.run(["node", "-e", SASS_JS, str(tmp)], cwd=str(FE), capture_output=True)
        if r.returncode != 0:
            raise SystemExit("sass 编译失败：\n" + r.stderr.decode("utf-8", "replace"))
        return r.stdout.decode("utf-8")
    finally:
        tmp.unlink(missing_ok=True)


SRC = SCSS.read_text(encoding="utf-8")
# 反向对照用的"旧档"：整块摘掉 20261009（块是顶层规则，下一条就是媒体查询）
head, rest = SRC.split(MARK, 1)
BLOCK, tail = rest.split(END, 1)          # 只到媒体查询为止，别把文件后半也算进"这一块"
SRC_OLD = head + END + tail
# 另一类改动是"就地提 alpha"（改在基形/20261005 块里，不在 20261009 块里），摘块抓不到
# 它们 —— 反向对照得把那一处字面量倒回去再编译一次，否则"旧档"其实是新档。
BOOT_NEW, BOOT_OLD = "color: rgba(240, 226, 200, 0.62);", "color: rgba(240, 226, 200, 0.5);"
assert SRC.count(BOOT_NEW) == 1, "进门幕那行字的取值变了，反向对照的锚点要跟着更新"
SRC_BOOT_OLD = SRC.replace(BOOT_NEW, BOOT_OLD)

# 与 `index.tsx` 同形的标记（只搭结构，不引组件——本判据要的是"哪一族字住在纸面上"）。
# 夜河底的画布/灯体不需要：`.rz-root` 自己那层 `#03050c` 就是合成链的底。
MARKUP = """
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
"""


def build_sandbox() -> pathlib.Path:
    sb = pathlib.Path(tempfile.mkdtemp(prefix="rzcontrast-"))
    (sb / "rz.css").write_text(compile_scss(SRC), encoding="utf-8")
    (sb / "rz-old.css").write_text(compile_scss(SRC_OLD), encoding="utf-8")
    # 站内令牌与重置（不复述它的值）。站内 body 今天是 Dashboard 那支 `--body-color`
    # 浅蓝灰；`.rz-root` 自己不透明，量到的纸面与它无关 —— 这里就照它填，顺带证明这一点。
    (sb / "tokens.css").write_text((FE / "src/index.css").read_text(encoding="utf-8"),
                                   encoding="utf-8")
    (sb / "index.html").write_text(
        '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">'
        '<link rel="stylesheet" href="tokens.css"><link rel="stylesheet" href="rz.css">'
        '</head><body><div id="root"></div></body></html>', encoding="utf-8")
    (sb / "old.html").write_text(
        '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">'
        '<link rel="stylesheet" href="tokens.css"><link rel="stylesheet" href="rz-old.css">'
        '</head><body><div id="root"></div></body></html>', encoding="utf-8")
    (sb / "rz-bootold.css").write_text(compile_scss(SRC_BOOT_OLD), encoding="utf-8")
    (sb / "boot-old.html").write_text(
        '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">'
        '<link rel="stylesheet" href="tokens.css"><link rel="stylesheet" href="rz-bootold.css">'
        '</head><body><div id="root"></div></body></html>', encoding="utf-8")
    return sb


SANDBOX = build_sandbox()

from playwright.sync_api import sync_playwright  # noqa: E402

PAINT = """(o) => {
  document.body.style.background = o.body;
  document.body.style.margin = '0';
  document.getElementById('root').innerHTML = o.markup;
}"""

# 量的是**合成后**的底色：从元素一路往上把自己的 backgroundColor 叠到底。
# 只看 computed backgroundColor 会被"透明"骗过去（`.rz-minetag` 就是 transparent）。
PROBE = """(sels) => {
  const parse = (s) => {
    const m = (s || '').match(/rgba?\\(([^)]+)\\)/);
    if (!m) return null;
    const p = m[1].split(',').map((x) => parseFloat(x));
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  };
  const over = (fg, bg) => ({
    r: fg.r * fg.a + bg.r * (1 - fg.a),
    g: fg.g * fg.a + bg.g * (1 - fg.a),
    b: fg.b * fg.a + bg.b * (1 - fg.a),
    a: 1,
  });
  const bgBehind = (el) => {
    let acc = parse(getComputedStyle(document.body).backgroundColor);
    const chain = [];
    for (let n = el; n && n !== document.documentElement; n = n.parentElement) chain.push(n);
    chain.reverse();
    for (const n of chain) {
      const c = parse(getComputedStyle(n).backgroundColor);
      if (c && c.a > 0) acc = over(c, acc);
    }
    return acc;
  };
  const op = (el) => {
    let o = 1;
    for (let n = el; n && n !== document.documentElement; n = n.parentElement) {
      o *= parseFloat(getComputedStyle(n).opacity || '1');
    }
    return o;
  };
  const PAPER = '.rz-bubble, .rz-modal-box, .rz-album-box, .rz-notice-box';
  const root = document.querySelector('.rz-root');
  const out = [];
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let n;
  while ((n = w.nextNode())) {
    const t = (n.textContent || '').trim();
    if (!t) continue;
    const el = n.parentElement;
    if (!el) continue;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    const opa = op(el);
    if (opa < 0.9) continue;          // 悬停才亮的那种（气泡未开）不参与
    const holder = el.closest(PAPER);
    out.push({
      txt: t.slice(0, 18),
      sel: el.tagName.toLowerCase() + '.' + (el.className || '').toString().trim().split(/\\s+/).join('.'),
      paper: !!holder,
      paperSel: holder ? '.' + (holder.className || '').toString().trim().split(/\\s+/).join('.') : '',
      color: cs.color, fs: cs.fontSize, bg: bgBehind(el),
    });
  }
  const probe = (s) => {
    const el = document.querySelector(s);
    if (!el) return null;
    const cs = getComputedStyle(el);
    return { color: cs.color, bg: bgBehind(el), fs: cs.fontSize };
  };
  const named = {};
  for (const s of sels) named[s] = probe(s);
  return { items: out, named: named };
}"""

NAMED = [
    ".rz-album-box", ".rz-album-item", ".rz-album-msg", ".rz-album-meta", ".rz-album-empty",
    ".rz-album-find", ".rz-album-tabs button.sel", ".rz-album-catf-seal", ".rz-album-seal",
    ".rz-minetag.rz-no", ".rz-cat-name b", ".rz-cat-name i", ".rz-lamp-card", ".rz-cat-card",
    ".rz-wish-count", ".rz-wish-anon.on", ".rz-reject", ".rz-reclaim", ".rz-reclaim.armed",
    ".rz-minetag.rz-ok", ".rz-modal-close", ".rz-hint", ".rz-title", ".rz-couplet > span",
    ".rz-couplet b", ".rz-home-btn", ".rz-album-btn", ".rz-wish-btn",
    ".rz-album-box::before",
]


def rgba(s: str) -> dict:
    p = [float(x) for x in s[s.index("(") + 1:s.index(")")].split(",")]
    return {"r": p[0], "g": p[1], "b": p[2], "a": p[3] if len(p) > 3 else 1.0}


def lum(c: dict) -> float:
    def f(v):
        v /= 255
        return v / 12.92 if v <= 0.03928 else ((v + 0.055) / 1.055) ** 2.4
    return 0.2126 * f(c["r"]) + 0.7152 * f(c["g"]) + 0.0722 * f(c["b"])


def ratio(fg: str, bg: dict) -> float:
    """文字的对比度必须按**压上去之后的那个颜色**算。

    只取 `color` 的 RGB 会漏掉 alpha：本族大量用 `rgba(16,35,43,.78)` 这种半透明的墨，
    照字面算出来是"全墨"（`.rz-album-msg` 与 `.rz-album-meta` 会算出**一模一样**的读数，
    因为两者 RGB 相同、只差 alpha —— 那正是这个坑露出来的样子）。
    """
    c = rgba(fg)
    a = c["a"]
    eff = {k: c[k] * a + bg[k] * (1 - a) for k in ("r", "g", "b")}
    x, y = lum(eff), lum(bg)
    hi, lo = max(x, y), min(x, y)
    return (hi + 0.05) / (lo + 0.05)


def short(bg: dict) -> str:
    return "rgb(%d,%d,%d)" % (round(bg["r"]), round(bg["g"]), round(bg["b"]))


with sync_playwright() as p:
    br = p.chromium.launch()
    pg = br.new_page(viewport={"width": 1280, "height": 900})
    errs: list[str] = []
    pg.on("pageerror", lambda e: errs.append(str(e)))

    def run(url: str):
        pg.goto(url)
        pg.wait_for_timeout(120)
        pg.evaluate(PAINT, {"markup": MARKUP, "body": "#E4E9F7"})
        # 必须等入场动画走完：`.rz-modal` 带 `animation: rz-fade 0.25s`（从 opacity 0 起），
        # 量早了整族会被"半透明"过滤掉 —— 这是取样错，不是页面错。
        pg.wait_for_timeout(800)
        return pg.evaluate(PROBE, NAMED)

    r = run(SANDBOX.as_uri() + "/index.html")
    paper = [x for x in r["items"] if x["paper"]]

    print("① 纸面上的每一段文字逐条 ≥ 4.5（合成后的底色）")
    worst = []
    for it in sorted(paper, key=lambda x: ratio(x["color"], x["bg"])):
        cr = ratio(it["color"], it["bg"])
        if cr >= 4.5:
            continue
        worst.append(it)
        check(f"{it['sel']} 「{it['txt']}」 ≥ 4.5", False,
              f"{cr:.2f}:1  color={it['color']} bg={short(it['bg'])}")
    check(f"纸面文字共 {len(paper)} 段，全部 ≥ 4.5", not worst,
          f"最低 {ratio(sorted(paper, key=lambda x: ratio(x['color'], x['bg']))[0]['color'], sorted(paper, key=lambda x: ratio(x['color'], x['bg']))[0]['bg']):.2f}:1"
          if paper else "一段都没扫到")
    check("扫到的纸面文字 ≥ 30 段（判据不是空扫）", len(paper) >= 30, f"实得 {len(paper)}")
    # 抽几条报出读数，便于人工核对
    for it in sorted(paper, key=lambda x: ratio(x["color"], x["bg"]))[:6]:
        print("      %5.2f:1  %-34s %s" % (ratio(it["color"], it["bg"]), it["sel"], it["txt"]))

    print("② 纸面本身确实是月白纸笺（不是暗底在兜底）")
    box = r["named"][".rz-album-box"]
    check("灯影集盒底合成亮度 > 0.6（月白纸笺）", lum(box["bg"]) > 0.6,
          f'{short(box["bg"])} lum={lum(box["bg"]):.2f}')

    print("③ 反向对照：把 20261009 那块摘掉（= 用户看到的那一版）")
    r0 = run(SANDBOX.as_uri() + "/old.html")
    named0 = r0["named"]
    family = [".rz-album-msg", ".rz-album-meta", ".rz-album-empty", ".rz-album-tabs button.sel",
              ".rz-minetag.rz-no", ".rz-cat-name b", ".rz-wish-count", ".rz-reclaim"]
    reds = 0
    for s in family:
        cr = ratio(named0[s]["color"], named0[s]["bg"])
        if cr < 3.0:
            reds += 1
        print("      %5.2f:1  %s" % (cr, s))
    check(f"旧档里这一族至少 5 条 < 3.0（「看不清」本身），实得 {reds}", reds >= 5)
    check("旧档页签选中仍是 `#ffe4ae`（20261005 没覆盖 color）",
          "255, 228, 174" in named0[".rz-album-tabs button.sel"]["color"].replace(" ", " "))
    # 摘掉之后逐条都要**变差**（不是"改了跟没改一样"）
    for s in family:
        a = ratio(named0[s]["color"], named0[s]["bg"])
        b = ratio(r["named"][s]["color"], r["named"][s]["bg"])
        check(f"{s}：修后好于旧档（{a:.2f} → {b:.2f}）", b > a)

    print("④ 夜河场景上的字：对纯夜底色留出画布水光的余量（≥ 6.0）")
    for s in (".rz-hint", ".rz-title", ".rz-couplet > span", ".rz-couplet b",
              ".rz-home-btn", ".rz-album-btn", ".rz-wish-btn"):
        cr = ratio(r["named"][s]["color"], r["named"][s]["bg"])
        check(f"{s} ≥ 6.0（线上画布比纯底亮，余量要够）", cr >= 6.0, f"{cr:.2f}:1")
    hint = r["named"][".rz-hint"]["color"]
    check("底部提示的字面量确实是 0.78（20261009 从 0.56 提上来）", "0.78" in hint, hint)

    print("⑤ 源码契约")
    check("`--rz-vermilion-ink` 恰好定义一次（令牌岛）",
          SRC.count("--rz-vermilion-ink:") == 1, str(SRC.count("--rz-vermilion-ink:")))
    # 块首注释**必须**留着那些旧色值（它是"修之前量到多少"的记录），所以只能查声明体：
    # 先摘注释再找。判据要管的是"这一族有没有人还在用夜河浅色"，不是"文件里提过没提过"。
    # 注意 MARK 是注释的开头（`/*`）本身，split 后已不在 BLOCK 里 ⇒ 拼回去再剥。
    decls = re.sub(r"/\*.*?\*/", "", MARK + BLOCK, flags=re.S)
    for bad in ("#ff9d8a", "#f0c987", "#ffe4ae", "rgba(240, 222, 188", "--rz-vermilion-bright"):
        check(f"20261009 块（去掉注释后）不再出现夜河浅色 {bad}", bad not in decls)
    check("块首注释仍然记着旧读数（注释被误删就没人知道「为什么是 1.0~2.5」）",
          "#ffe4ae" in BLOCK and "#ff9d8a" in BLOCK)
    check("`.rz-hint` 的 0.56 已不存在（基形 0.38 那处仍在基形里，与覆盖块无关）",
          "color: rgba(238, 226, 197, 0.56)" not in SRC)
    check("块首注释与哨兵一致（判据靠它摘块，别改名）", MARK in SRC)

    check("无 JS 运行时报错", not errs, "; ".join(errs[:2]))

    print("⑥ 悬停态：基形里那套「深底浅字」的 :hover 与覆盖块同特异性 ⇒ 不显式写 color 就漏")
    # 悬停要**真命中测试**，所以量之前先把其余弹窗摘出屏幕（几个弹窗在标记里互相叠着，
    # 顶层那个会把底下的按钮盖住 —— 不摘的话 hover 落在别的元素上，量到的是"没悬停"）。
    def hover_measure(url: str, keep: str, sel: str):
        pg.goto(url)
        pg.wait_for_timeout(120)
        pg.evaluate(PAINT, {"markup": MARKUP, "body": "#E4E9F7"})
        pg.wait_for_timeout(800)
        pg.evaluate("(keep) => { document.querySelectorAll('.rz-modal').forEach((m) =>"
                    " { if (!m.matches(keep)) m.style.display = 'none'; }); }", keep)
        pg.hover(sel)
        pg.wait_for_timeout(200)
        return pg.evaluate(PROBE, [sel])["named"][sel]

    for s, keep in ((".rz-album-tabs button:nth-child(2)", ".rz-album-modal"),
                    (".rz-wish-ghost", ".rz-wish-modal")):
        n = hover_measure(SANDBOX.as_uri() + "/index.html", keep, s)
        cr = ratio(n["color"], n["bg"])
        check(f"悬停 {s} ≥ 4.5", cr >= 4.5, f'{cr:.2f}:1 color={n["color"]}')
        o = hover_measure(SANDBOX.as_uri() + "/old.html", keep, s)
        cr0 = ratio(o["color"], o["bg"])
        check(f"旧档悬停 {s} < 3.0（那条 hover 泄漏是真的）", cr0 < 3.0, f"{cr0:.2f}:1")

    print("⑦ 进门幕那行字：底是它自己的不透明渐变，按两端停机色各量一次")
    # 这层幕自己单开一页量：它 position:absolute; inset:0; z-index:9，跟别的弹窗叠在一页里
    # 会把上面那节的悬停命中测试全挡掉。渐变换不来"合成底"（探针只读 backgroundColor），
    # 就把渐变换成它的两个停机色各量一遍 —— 那正是这行字能落到的最暗／最亮底。
    BOOT = ('<div class="rz-root"><div class="rz-boot"><div class="rz-boot-glow"></div>'
            '<p>河灯将明 · 稍候</p></div></div>')
    for arm, want in (("index.html", True), ("boot-old.html", False)):
        for end in ("#02040c", "#081029"):
            pg.goto(SANDBOX.as_uri() + "/" + arm)
            pg.wait_for_timeout(120)
            pg.evaluate(
                "(o) => { document.body.style.background = '#E4E9F7';"
                " document.getElementById('root').innerHTML = o.m;"
                " const b = document.querySelector('.rz-boot');"
                " b.style.backgroundImage = 'none'; b.style.backgroundColor = o.e; }",
                {"m": BOOT, "e": end})
            pg.wait_for_timeout(400)
            n = pg.evaluate(PROBE, [".rz-boot p"])["named"][".rz-boot p"]
            cr = ratio(n["color"], n["bg"])
            if want:
                check(f"进门幕（渐变停机 {end}）≥ 4.5", cr >= 4.5, f"{cr:.2f}:1")
            else:
                check(f"旧档同一处（渐变停机 {end}）< 4.5（0.5 是从这里提上来的）",
                      cr < 4.5, f"{cr:.2f}:1")
    br.close()

shutil.rmtree(SANDBOX, ignore_errors=True)
print(f"\n{'✗' if FAIL else '✓'} riverboard-contrast：{PASS} 通过 / {FAIL} 失败")
raise SystemExit(1 if FAIL else 0)
