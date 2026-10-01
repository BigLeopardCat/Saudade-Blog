#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""文章详情页的顶部栏：导航字压在深色横幅上还读不读得出来（20261001，用户第 3 条）。

  python3 tests/read-topbar-contrast.test.py

现场（用户报的）：「文章详情页的顶部栏字体看不清」。

不是审美问题，是一处**合成**问题，读代码看不出来：

  · `.headContainer` 默认 `background: transparent`，导航字吃 `var(--washi-ink)`
    （白天档 `#4a3550` 深墨紫）。这个值当初是压**淡彩首屏**选的，约 7:1，没问题。
  · 但文章详情页的首屏不是淡彩纸，是 `.readCover` —— 封面视频/大图，外加它自己
    顶缘那条 `rgba(0,0,0,.5)` 渐变。**实测横幅在导航那一带的中位亮度 = 58/255**。
  · 深墨紫压 58/255 ⇒ **1.0:1**。字和底是同一个亮度，肉眼完全分不开。
  · 夜间档本来就吃浅色令牌（`.frontDark` 把 `--washi-ink` 翻成 `#f3e8f6`），
    所以只有白天中招 —— 用户报的就是他白天看到的那一版。

修法（`index.sass` 的 `.over-dark`，类名由 `Head/index.tsx` 按路由挂）：
**字色 + 底色一起落**。只换字色不够——横幅是**视频**，最亮那 1% 的像素亮到 119/255，
浅字压上去只剩 3.8:1；配一层 0.30 的黑纱才把它压到 5.4:1。

判据为什么落在这里而不是"截图看一眼"：这一族（[[sass-media-shadow-silent-failure]] 同源）
的失效方式是**静默**的——类名没挂上、或者被同特异性的规则盖掉，页面照常渲染、
lint/tsc/单测全绿，只有字在深底上悄悄消失。所以：

  ① 真编译 `Head/index.sass`（不是手抄选择器）+ 仓库里那份 `.css` 令牌与重置；
  ② 白天/夜间 × 中位亮度/最亮 1% 四种合成，逐个量**合成后**的对比度；
  ③ 反向对照：**摘掉 `.over-dark`** 时同一份标记必须读到 < 3.0 —— 证明上面那些
     判据不是空断言（否则"加了类"这件事根本没被验证到）；
  ④ 悬停/滚动态（`.is-stuck`）不受本次改动影响；
  ⑤ 源码契约：类名确实由 `/article/` 路由挂上去（sass 再好，没人挂也白搭）。
"""
import pathlib
import subprocess
import tempfile
import shutil

FE = pathlib.Path(__file__).resolve().parent.parent

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

SASS_FILE = FE / "src/frontHome/Head/index.sass"

# 实测的横幅亮度（`/article/54`，导航文字带 y 30..56 / x 290..1050，逐帧采样 8 帧同值）：
#   中位 58/255、p90 72、p99 119。取中位与最亮那 1% 两档当判据的两端。
BANNER_MEDIAN = "rgb(58, 58, 59)"
BANNER_BRIGHT = "rgb(119, 119, 119)"

# 与 Head/index.tsx 同形的标记。`.headContainer` 的类名按"透明态 / 悬停 / 滚动态 /
# 文章页"四种情形切换 —— 那正是被测对象。
MARKUP = """
<div class="frontRoot">
  <header>
    <div class="headContainer{cls}">
      <div class="phoneBar"><i class="iconfont" id="burger">≡</i></div>
      <div class="webTitle"><h2><span class="firstTitle">Saudade</span>Blog</h2></div>
      <div class="headBar"><ul><li id="nav">首页</li><li id="nav2">留言板</li></ul></div>
    </div>
  </header>
</div>
"""


def build_sandbox() -> pathlib.Path:
    sb = pathlib.Path(tempfile.mkdtemp(prefix="readtopbar-"))
    r = subprocess.run(["node", "-e", SASS_JS, str(SASS_FILE)], cwd=str(FE), capture_output=True)
    if r.returncode != 0:
        raise SystemExit("sass 编译失败：\n" + r.stderr.decode("utf-8", "replace"))
    (sb / "head.css").write_text(r.stdout.decode("utf-8"), encoding="utf-8")
    # 令牌（`--washi-ink` 两档都在 src/index.css 里；不复述它的值）+ 盒模型重置
    (sb / "tokens.css").write_text((FE / "src/index.css").read_text(encoding="utf-8"),
                                   encoding="utf-8")
    shutil.copy(FE / "src/frontHome/main.css", sb / "main.css")
    (sb / "index.html").write_text(
        '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">'
        '<link rel="stylesheet" href="tokens.css"><link rel="stylesheet" href="main.css">'
        '<link rel="stylesheet" href="head.css">'
        '</head><body><div id="root"></div></body></html>', encoding="utf-8")
    return sb


SANDBOX = build_sandbox()
URL = SANDBOX.as_uri() + "/index.html"

from playwright.sync_api import sync_playwright  # noqa: E402

# 标记与页面底色一次画好（`:hover` 得由真鼠标进，不能在这一步里造假）
PAINT = """(o) => {
  document.documentElement.classList.toggle('frontDark', !!o.dark);
  document.body.style.background = o.banner;
  document.getElementById('root').innerHTML = o.markup;
}"""

# 量的是**合成后**的底色：从元素一路往上把 backgroundColor 叠到页面底（横幅）上。
# 只看 computed backgroundColor 会被"透明"骗过去——`.headContainer` 默认就是透明的。
PROBE = """() => {
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
  const probe = (sel) => {
    const el = document.querySelector(sel);
    const cs = getComputedStyle(el);
    return { color: cs.color, bg: bgBehind(el), fs: cs.fontSize, fw: cs.fontWeight };
  };
  return { nav: probe('#nav'), nav2: probe('#nav2'), burger: probe('#burger'),
           title: probe('.webTitle h2') };
}"""


def rgb(s: str) -> dict:
    p = [float(x) for x in s[s.index("(") + 1:s.index(")")].split(",")[:3]]
    return {"r": p[0], "g": p[1], "b": p[2]}


def lum(c: dict) -> float:
    def f(v):
        v /= 255
        return v / 12.92 if v <= 0.03928 else ((v + 0.055) / 1.055) ** 2.4
    return 0.2126 * f(c["r"]) + 0.7152 * f(c["g"]) + 0.0722 * f(c["b"])


def ratio(fg: str, bg: dict) -> float:
    a, b = lum(rgb(fg)), lum(bg)
    hi, lo = max(a, b), min(a, b)
    return (hi + 0.05) / (lo + 0.05)


with sync_playwright() as p:
    br = p.chromium.launch()
    pg = br.new_page(viewport={"width": 1280, "height": 900})
    errs: list[str] = []
    pg.on("pageerror", lambda e: errs.append(str(e)))
    pg.goto(URL)
    pg.wait_for_timeout(150)

    def run(cls="", dark=False, banner=BANNER_MEDIAN, hover=False):
        pg.evaluate(PAINT, {"markup": MARKUP.format(cls=cls), "dark": dark, "banner": banner})
        if hover:
            # 真鼠标进 —— `:hover` 没法用 JS 造假。**停在 `.webTitle` 上**而不是某一项
            # 导航上：`li:hover` 还有它自己的和纸胶带 chip（粉底粉字，是既定的悬停外观，
            # 与本条判据无关），停在标题上量到的才是 `.headContainer:hover` 那一层。
            pg.hover(".webTitle")
            pg.wait_for_timeout(80)    # 那条规则带 `transition: 0.6s`，等底色落定
        return pg.evaluate(PROBE)

    print("① 文章详情页（.over-dark）：四种合成逐档 ≥ 4.5:1")
    for label, banner in (("中位亮度 58/255", BANNER_MEDIAN), ("最亮 1% 119/255", BANNER_BRIGHT)):
        r = run(" over-dark", banner=banner)
        for name, key in (("首页", "nav"), ("留言板", "nav2")):
            cr = ratio(r[key]["color"], r[key]["bg"])
            check(f"白天 · {label} · 导航「{name}」对比度 ≥ 4.5", cr >= 4.5,
                  f'{cr:.2f}:1  color={r[key]["color"]}')
        cr = ratio(r["burger"]["color"], r["burger"]["bg"])
        check(f"白天 · {label} · 窄屏汉堡钮 ≥ 4.5", cr >= 4.5, f"{cr:.2f}:1")
    r = run(" over-dark", dark=True)
    check("夜间 · 导航「首页」对比度 ≥ 4.5",
          ratio(r["nav"]["color"], r["nav"]["bg"]) >= 4.5,
          f'{ratio(r["nav"]["color"], r["nav"]["bg"]):.2f}:1')

    print("② 反向对照：摘掉 .over-dark（= 用户看到的那一版）必须读不出来")
    r0 = run("")
    cr0 = ratio(r0["nav"]["color"], r0["nav"]["bg"])
    check("白天 · 透明态 · 导航对比度 < 3.0（这就是「看不清」本身）", cr0 < 3.0,
          f'{cr0:.2f}:1  color={r0["nav"]["color"]} bg={tuple(round(v) for v in r0["nav"]["bg"].values())}')
    # 再证一条：读不出来是因为**字是深的**而底也是深的（不是"底太亮"那种相反的情形）
    check("  · 那一版的字色确实是深墨紫（亮度 < 0.1）",
          lum(rgb(r0["nav"]["color"])) < 0.1, r0["nav"]["color"])

    print("③ 悬停 / 滚动态（本次改动不许弄坏；悬停用真鼠标进）")
    for cls, label, hv in ((" is-stuck", "已滚动", False), ("", "悬停", True)):
        r = run(cls, banner=BANNER_BRIGHT, hover=hv)
        check(f"白天 · {label} 态 · 导航 ≥ 4.5", ratio(r["nav"]["color"], r["nav"]["bg"]) >= 4.5,
              f'{ratio(r["nav"]["color"], r["nav"]["bg"]):.2f}:1')
    # 悬停时 `.headContainer:hover`（0.66）与 `.over-dark`（0.30）同特异性 ⇒ 源码顺序
    # 决定谁赢。这条量的是**悬停真的比常驻态更暗**（顺序写反了会反着来）。
    stuck = run(" is-stuck", banner=BANNER_BRIGHT)["nav"]["bg"]
    over_ = run(" over-dark", banner=BANNER_BRIGHT)["nav"]["bg"]
    check("悬停/滚动的 0.66 深底比 .over-dark 的 0.30 更暗（同特异性规则的顺序没写反）",
          lum(stuck) < lum(over_) - 0.01,
          f'stuck {lum(stuck):.3f} vs over-dark {lum(over_):.3f}')

    print("④ 源码契约：类名真的由路由挂上去（sass 再好，没人挂也白搭）")
    tsx = (FE / "src/frontHome/Head/index.tsx").read_text(encoding="utf-8")
    check("引了 useLocation（判据是路由，不是别的东西）",
          "useLocation" in tsx and "from \"react-router-dom\"" in tsx)
    check("判据是 /article/ 开头（文章详情页）",
          "/article/" in tsx and "pathname.startsWith(" in tsx, "")
    check("类名里拼了 ' over-dark'", "' over-dark'" in tsx, "")
    check("sass 里真有 .over-dark 这一支",
          ".headContainer.over-dark" in (FE / "src/frontHome/Head/index.sass").read_text(
              encoding="utf-8") or "&.over-dark" in (FE / "src/frontHome/Head/index.sass").read_text(
              encoding="utf-8"))

    check("无 JS 运行时报错", not errs, "; ".join(errs[:2]))
    br.close()

shutil.rmtree(SANDBOX, ignore_errors=True)
print(f"\n{'✗' if FAIL else '✓'} read-topbar-contrast：{PASS} 通过 / {FAIL} 失败")
raise SystemExit(1 if FAIL else 0)
