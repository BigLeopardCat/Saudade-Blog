#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""首页首屏 hero：拼贴底 + 描边标题 + 命令条 + 手账内页 + 樱花（20260930 四轮）。

  python3 tests/home-hero.test.py

现场（用户要求）："主页也想要这种图片的风格"（参考图 = 粉紫淡彩的日系手账封面）。
改法是**只重做首屏**：满屏视频 + "Hi! I'm …" 换成
  ① `.collageBg` 柔和色块 + 方格纸   ② `.petals` 七片樱花
  ③ `.SayWords` 窗贴标签 / 描边渐变标题 / 命令条 / 社交按钮
  ④ `.heroPanel` 视频变成拼贴里的一张"手账内页"（白边 + 两角胶带）。

本套件钉的是**几何与纪律**，不是"好不好看"：

  ① ★ **不许动的缝**：Vitrine（展示柜窗口）的 `left: calc(8vw + 450px)` 是按
     "8% 左内边距 + 标题盒宽 437.9px + 12px 缝"算出来的（见 Vitrine/index.sass 头注，
     20260923 改这版几何当天被用户判"不美观"整体撤回）。所以这次标题**只加了绘制层**
     （白描边 / 渐变填充 / 投影），字号 · 字距 · 字重一个没动 —— 本组同时量**缝还在**
     和**那三个属性确实没变**，两头都锁。
  ② `.heroBottom` 的居中契约：签名 `.home-one-say` 自己也是绝对定位，横向居中靠的是
     "绝对定位子元素取 flex 静态位"，而它的 `bottom: 86px` 又是相对这一行算的 —— 这三条
     原来是 JSX 里的内联 style，20260930 收进 sass，最容易漏的就是居中。
  ③ 手机档（≤768px）：一列，内页在文字下面且整宽、标题降到 2rem；**页面不许出现横向滚动**
     —— 色块的负偏移（`left: -12vw` 那类）没有 `overflow: hidden` 就会造出滚动条。
  ④ 夜间档：整个 `.heroPanel` 隐藏（视频仅白天显示是 20260902 的用户要求；只藏 video 会留
     一张空白的白卡片），右半屏归 Vitrine —— 两者不许同屏；拼贴底换深色。
  ⑤ 纪律：不许 `filter: blur()` / `backdrop-filter`（后台 GPU 事故的放大器），樱花只动
     transform/opacity（读编译产物的 `@keyframes` 原文），`prefers-reduced-motion` 下樱花
     不出现、光标常亮 —— 且**带牙**：正常档下这些动画必须是活的（否则"两边都 none"也能绿）。
  ⑥ 视频选择器契约：组件里的 IntersectionObserver 取的是 `hero.querySelector('video')`
     ⇒ hero 里**有且只有一个** video，且它住在内页里。
"""
import pathlib
import re
import shutil
import subprocess
import tempfile

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

SASS_FILE = FE / "src/frontHome/Content/ContentHome/index.sass"
VITRINE_SASS = FE / "src/frontHome/Content/ContentHome/Vitrine/index.sass"
RESET_CSS = FE / "src/frontHome/main.css"

PETALS = "".join(f'<span class="petal p{i}"></span>' for i in range(1, 8))

# 与 index.tsx 的 hero 段同形的标记（不挂 React：本套件量的是类名与结构决定的布局）。
# 社媒按钮用固定宽的方块代替——它们由 SocialButton 渲染，这里只需要"四个占位"。
HERO = """
<div class="SelfDescription" id="hero">
  <div class="collageBg" id="collage" aria-hidden="true">
    <span class="blob blobA"></span><span class="blob blobB"></span><span class="blob blobC"></span>
  </div>
  <div class="petals" id="petals" aria-hidden="true">__PETALS__</div>
  <div class="SayWords" id="say">
    <div class="heroTag" id="tag"><span class="heroTagStar">✦</span><span>Sora の 记录室</span></div>
    <h1 class="home-title-h3" id="title">Sereno da Saudade</h1>
    <div class="heroTerminal" id="term" aria-hidden="true">
      <span class="termUser">saudade@blog</span><span class="termSep">:</span>
      <span class="termPath">~</span><span class="termSep">$</span>
      <span class="termCmd">cat ./about.md</span><span class="termCaret" id="caret"></span>
    </div>
    <div class="Social" id="social">
      <i class="sBtn"></i><i class="sBtn"></i><i class="sBtn"></i><i class="sBtn"></i>
    </div>
  </div>
  <figure class="heroPanel" id="panel">
    <video class="heroVideo" id="video" muted loop playsinline></video>
    <span class="heroPanelTape tapeL" id="tapeL"></span>
    <span class="heroPanelTape tapeR" id="tapeR"></span>
  </figure>
  <div class="vitrine" id="vit"><div class="vit-head"></div></div>
  <div class="heroBottom" id="bottom">
    <p class="home-one-say" id="onesay">慢慢来比较快</p>
    <i class="iconfont icon-rcd-angle-double-down upAndDown heroScroll" id="scroll"></i>
  </div>
</div>
""".replace("__PETALS__", PETALS)

# 对照组：一枚**裸 h3**（不挂任何类，只给内联 font-size = 现在那枚 h1 的 2.5rem），
# 用来证明"h1 + 我们那几条规则"与"原来的 h3"同宽（UA 默认 h1 与 h3 都是 bold，真正决定
# 宽度的是 font-size；这条如果红了，说明两边不同源、缝的推导依据也就变了）
CONTROL = ('<div class="SelfDescription"><div class="SayWords">'
           '<h3 id="ctrl" style="font-size:2.5rem">Sereno da Saudade</h3></div></div>')


def build_sandbox() -> pathlib.Path:
    sb = pathlib.Path(tempfile.mkdtemp(prefix="homehero-"))
    for name, src in (("home.css", SASS_FILE), ("vitrine.css", VITRINE_SASS)):
        r = subprocess.run(["node", "-e", SASS_JS, str(src)], cwd=str(FE), capture_output=True)
        if r.returncode != 0:
            raise SystemExit(f"sass 编译失败（{src.name}）：\n" + r.stderr.decode("utf-8", "replace"))
        (sb / name).write_text(r.stdout.decode("utf-8"), encoding="utf-8")
    shutil.copy(RESET_CSS, sb / "main.css")
    (sb / "index.html").write_text(
        '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">'
        '<link rel="stylesheet" href="main.css"><link rel="stylesheet" href="vitrine.css">'
        '<link rel="stylesheet" href="home.css">'
        # 社媒按钮的替身：固定 40px 方块，让 .Social 的 300px 宽度真的被占满
        '<style>.sBtn{display:inline-block;width:40px;height:40px;background:#ddd;border-radius:50%}</style>'
        # ⚠️ 量的是**静置几何**，所以入场的 `left-in`（1s 的 translateX(-50%)）与手账内页/
        # 展示柜的静态 transform 一律先关掉——它们都是绘制层，留着会让每个 rect 读数偏半个
        # 盒宽（本套件第一版就栽在这里：`.SayWords` 的 rect.left 读成 -104，而 offsetLeft
        # 是 115）。这些装饰的**存在**另有源码锁（读编译产物），不靠几何量。
        # （樱花**不**在这一串里：第 ⑦ 组要验「正常档下它真的在动」——关掉就没牙了。
        #   它的尺寸量 `offsetWidth`，本来就免疫 transform。）
        '<style>.SayWords,.heroPanel,.vitrine{animation:none !important}'
        '.heroPanel,.vitrine{transform:none !important}</style>'
        '</head><body><div id="root"></div></body></html>',
        encoding="utf-8")
    return sb


SANDBOX = build_sandbox()
URL = SANDBOX.as_uri() + "/index.html"
HERO_CSS = (SANDBOX / "home.css").read_text(encoding="utf-8")
VITRINE_CSS = (SANDBOX / "vitrine.css").read_text(encoding="utf-8")

from playwright.sync_api import sync_playwright  # noqa: E402

PAINT = """(o) => {
  const root = document.getElementById('root');
  root.innerHTML = o.markup;
  root.classList.toggle('frontDark', !!o.dark);
  const R = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const b = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return {
      left: Math.round(b.left), top: Math.round(b.top), right: Math.round(b.right),
      bottom: Math.round(b.bottom), w: Math.round(b.width), h: Math.round(b.height),
      offW: el.offsetWidth, offH: el.offsetHeight, offTop: el.offsetTop,
      fs: cs.fontSize, ls: cs.letterSpacing, fw: cs.fontWeight, ff: cs.fontFamily.split(',')[0],
      color: cs.color, fill: cs.webkitTextFillColor, bgImage: cs.backgroundImage,
      strokeW: cs.webkitTextStrokeWidth, strokeC: cs.webkitTextStrokeColor,
      display: cs.display, filter: cs.filter, backdrop: cs.backdropFilter,
      anim: cs.animationName, animDur: cs.animationDuration, opacity: cs.opacity,
      willChange: cs.willChange, padding: cs.padding, overflowX: cs.overflowX,
      borderRadius: cs.borderRadius, position: cs.position, background: cs.backgroundColor,
      transform: cs.transform,
    };
  };
  const doc = document.documentElement;
  const petals = [...document.querySelectorAll('.petal')];
  return {
    hero: R('#hero'), say: R('#say'), title: R('#title'), ctrl: R('#ctrl'), tag: R('#tag'),
    term: R('#term'), caret: R('#caret'), social: R('#social'), panel: R('#panel'),
    video: R('#video'), tapeL: R('#tapeL'), tapeR: R('#tapeR'), vit: R('#vit'), bottom: R('#bottom'),
    onesay: R('#onesay'), scroll: R('#scroll'), collage: R('#collage'),
    viewport: { w: window.innerWidth, h: window.innerHeight },
    docOverflow: { scrollW: doc.scrollWidth, clientW: doc.clientWidth,
                   bodyScrollW: document.body.scrollWidth },
    petalCount: petals.length,
    petalAnim: petals.length ? getComputedStyle(petals[0]).animationName : null,
    petalDur: petals.length ? getComputedStyle(petals[0]).animationDuration : null,
    petalOpacity: petals.length ? getComputedStyle(petals[0]).opacity : null,
    // 樱花量**布局宽**：它一直在转（旋转中的方块 rect 会读到 12×√2 ≈ 17px）
    petalW: petals.length ? petals[0].offsetWidth : 0,
    videoCount: document.querySelectorAll('.SelfDescription video').length,
    videoInPanel: !!document.querySelector('.heroPanel video'),
    // 内页里有几个 video（IO 选择器取的是第一个，多于一个就是隐患）
    blobs: document.querySelectorAll('.blob').length,
    // 三个色块的实际绘制面积之和 / hero 面积（GPU 层大小的粗估）
    blobFilters: [...document.querySelectorAll('.blob')].map((b) => getComputedStyle(b).filter),
  };
}"""


def seam_at(pg, vw: int, dark: bool = False) -> dict:
    pg.set_viewport_size({"width": vw, "height": 900})
    return pg.evaluate(PAINT, {"markup": HERO, "dark": dark})


def keyframes_block(css: str, name: str) -> str:
    m = re.search(r"@keyframes " + name + r"\s*\{(.*?)\n\}", css, re.S)
    return m.group(1) if m else ""


print("== ① 桌面档结构：文字列在左、内页在右，且互不重叠 + ★ Vitrine 的缝 ==")
with sync_playwright() as p:
    br = p.chromium.launch()
    pg = br.new_page(viewport={"width": 1440, "height": 900})
    errs: list[str] = []
    pg.on("pageerror", lambda e: errs.append(str(e)))
    pg.goto(URL)

    for vw in (1366, 1440, 1920):
        m = seam_at(pg, vw)
        hero, say, title, panel, vit = m["hero"], m["say"], m["title"], m["panel"], m["vit"]
        # Vitrine 的 `left: calc(8vw + 450px)`（1366 起；≥1100 才显示）
        expect_vit_left = round(vw * 0.08 + 450)
        check(f"{vw}px：Vitrine 左缘 = 8vw+450 = {expect_vit_left}（从真 CSS 量，不是我复述常量）",
              abs(vit["left"] - expect_vit_left) <= 1, f"实测 {vit['left']}")
        seam = vit["left"] - title["right"]
        check(f"{vw}px：★ 标题右缘到 Vitrine 的缝 ≥ 8px（线上实测 12px；缝隙变负 = 夜里压字）",
              seam >= 8, f"缝 {seam}px（标题右缘 {title['right']}）")
        # 只量文字列：内页与展示柜窗口**永不同屏**（前者 `.frontDark` 隐藏、后者白天不渲染），
        # 本桩为了量几何把两者都摆上了，所以「内页不越线」这条在这里没有意义——它由第 ⑥ 组管。
        check(f"{vw}px：文字列右缘（含命令条/社媒，最宽的是标题）也不越过 Vitrine",
              say["right"] <= vit["left"] + 1, f"say {say['right']} vs vit {vit['left']}")
        check(f"{vw}px：内页在文字列右侧且不重叠",
              panel["left"] >= say["right"], f"panel.left {panel['left']} vs say.right {say['right']}")
        check(f"{vw}px：内页整体在视口内（不溢出右边）",
              panel["right"] <= vw, f"panel.right {panel['right']} / vw {vw}")
        check(f"{vw}px：hero 高度 = 视口高（签名钉在首屏底部）",
              abs(hero["h"] - 900) <= 1, f"hero.h {hero['h']}")
        check(f"{vw}px：无横向溢出（色块负偏移被 hero 的 overflow 兜住）",
              m["docOverflow"]["scrollW"] <= m["docOverflow"]["clientW"] + 1,
              f"scrollW {m['docOverflow']['scrollW']} / clientW {m['docOverflow']['clientW']}")

    m = seam_at(pg, 1440)
    title = m["title"]
    print("   （1440px 实测：标题盒 %dx%d，字号 %s，字距 %s，字重 %s，描边 %s，缝 %dpx）"
          % (title["w"], title["h"], title["fs"], title["ls"], title["fw"], title["strokeW"],
             m["vit"]["left"] - title["right"]))
    check("★ 量之前先证明**静置**：文字列与内页的 computed transform 都是 none"
          "（入场动画没关掉的话，下面每个 rect 都偏半个盒宽）",
          m["say"]["transform"] == "none" and m["panel"]["transform"] == "none",
          f"say {m['say']['transform']} / panel {m['panel']['transform']}")
    check("★ 标题的**度量属性一个没动**：字号正是 2.5rem=40px",
          title["fs"] == "40px", f"实测 {title['fs']}")
    check("★ 字距必须是 normal（`letter-spacing` 会直接把标题盒撑宽 ⇒ 缝变小）",
          title["ls"] in ("normal", "0px"), f"实测 {title['ls']}")
    check("★ 字重仍是 bold（与原来那枚 h3 的 UA 默认一致，换个权重盒宽就变）",
          title["fw"] in ("700", "bold"), f"实测 {title['fw']}")
    check("  描边确实是**绘制层**：3px 白描边在，而盒宽仍等于纯文本宽（下方对照）",
          title["strokeW"] == "3px" and title["strokeC"] == "rgb(255, 255, 255)",
          f"{title['strokeW']} / {title['strokeC']}")

    # 对照组：**裸 h3**（不挂任何类、只有内联的 font-size，与原来那枚 h3 同条件）与我们的
    # h1 —— 同宽才算"换标签 + 加绘制层没动任何影响宽度的东西"。对照组必须放进 `.SayWords`
    # 里（它现在是 flex 列、子项按 max-content 收窄；塞在普通块里会量成满宽 1440）。
    pg.evaluate(PAINT, {"markup": CONTROL + HERO})
    ctrl = pg.evaluate("() => ({ctrl: document.getElementById('ctrl').offsetWidth,"
                       " title: document.getElementById('title').offsetWidth,"
                       " ctrlFs: getComputedStyle(document.getElementById('ctrl')).fontSize,"
                       " ctrlFw: getComputedStyle(document.getElementById('ctrl')).fontWeight})")
    check(f"★ 对照：裸 h3 与标题**同宽**（{ctrl['ctrl']} vs {ctrl['title']}）"
          f"⇒ 换 h1 + 加绘制层没改任何影响宽度的东西",
          ctrl["ctrl"] == ctrl["title"] and ctrl["ctrl"] > 100, f"{ctrl}")
    print("   （对照组：裸 h3 宽 %d / 标题宽 %d，字号 %s，字重 %s）"
          % (ctrl["ctrl"], ctrl["title"], ctrl["ctrlFs"], ctrl["ctrlFw"]))

    print("\n== ② 底部那行：签名居中 + 箭头在它下方（内联 style 收进 sass 的回归锁）==")
    m = seam_at(pg, 1440)
    onesay, scroll, hero, panel, vit = m["onesay"], m["scroll"], m["hero"], m["panel"], m["vit"]
    center = (onesay["left"] + onesay["right"]) / 2
    check("★ 签名横向居中（±1px）——靠 `.heroBottom` 的全宽 flex + justify-content: center",
          abs(center - m["viewport"]["w"] / 2) <= 1,
          f"签名中心 {center:.1f} / 视口中心 {m['viewport']['w'] / 2}")
    check("签名离 hero 下缘 86px（`bottom: 86px` 是相对 `.heroBottom` 这行算的）",
          abs(hero["bottom"] - onesay["bottom"] - 86) <= 1,
          f"hero.bottom−onesay.bottom = {hero['bottom'] - onesay['bottom']}")
    check("下滚箭头在签名下方（bottom: 20px、字号 50px）",
          scroll["bottom"] > onesay["bottom"] and abs(hero["bottom"] - scroll["bottom"] - 20) <= 1
          and scroll["fs"] == "50px",
          f"箭底 {scroll['bottom']} / 签名底 {onesay['bottom']} / fs {scroll['fs']}")
    check("签名的行宽仍 ≤ 880px（原来内联写法是 `white-space: nowrap`，没被盒子拉断）",
          onesay["w"] <= 880, f"实测 {onesay['w']}px")
    check("底部那行不压内页、不压 Vitrine（z-index 2 且横向避开）",
          onesay["right"] <= panel["left"] or onesay["bottom"] <= panel["top"]
          or onesay["left"] >= panel["right"] or onesay["top"] >= panel["bottom"],
          f"签名 {onesay} / 内页 {panel}")

    print("\n== ③ 装饰层纪律：无 blur/backdrop、樱花只动 transform/opacity ==")
    for sel, box in (("#collage", m["collage"]), ("#panel", m["panel"]), ("#title", m["title"])):
        check(f"{sel} 上没有 filter / backdrop-filter（大面积模糊是 GPU 事故的放大器）",
              box["filter"] == "none" and box["backdrop"] == "none",
              f"filter={box['filter']} backdrop={box['backdrop']}")
    check("三个色块也都没有 filter（柔化靠 radial-gradient 自带羽化）",
          all(f == "none" for f in m["blobFilters"]), f"{m['blobFilters']}")
    check("樱花是 7 片、每片都是小元素（≤16px，合成层开销可忽略）",
          m["petalCount"] == 7 and m["petalW"] <= 16, f"{m['petalCount']} 片 / 首片 {m['petalW']}px")
    # 装饰层的**存在**靠源码锁（几何被桩里的静置覆写抹掉了，量不到）
    check("手账内页确实歪 1.2 度、两角胶带确实各歪几度（编译产物里查得到）",
          "rotate(1.2deg)" in HERO_CSS and "rotate(-5deg)" in HERO_CSS and "rotate(4deg)" in HERO_CSS)
    kf = keyframes_block(HERO_CSS, "petal-fall")
    props = set(re.findall(r"^\s*([a-z-]+)\s*:", kf, re.M))
    check("★ `@keyframes petal-fall` 只声明 transform / opacity（读编译产物原文）",
          props and props <= {"transform", "opacity"}, f"实际声明 {sorted(props)}")
    kf2 = keyframes_block(HERO_CSS, "caret-blink")
    props2 = set(re.findall(r"^\s*([a-z-]+)\s*:", kf2, re.M))
    check("★ `@keyframes caret-blink` 同样只动 opacity（光标闪，盒子不许动）",
          props2 and props2 <= {"opacity"}, f"实际声明 {sorted(props2)}")

    print("\n== ④ 视频选择器契约（组件 IO 取的是 hero 里第一个 video）==")
    m = seam_at(pg, 1440)
    check("hero 里**有且只有一个** video，且它住在内页 `.heroPanel` 里",
          m["videoCount"] == 1 and m["videoInPanel"] == 1,
          f"count={m['videoCount']} inPanel={m['videoInPanel']}")
    check("两角胶带在（探出去 13px，故内页**不能**写 overflow: hidden）",
          m["tapeL"] is not None and m["tapeR"] is not None
          and m["tapeL"]["top"] < m["panel"]["top"], f"tapeL.top {m['tapeL']['top']} / panel.top {m['panel']['top']}")
    check("胶带探出的部分没被 hero 的 overflow: hidden 剪掉（离视口边缘还远）",
          m["tapeL"]["top"] >= m["hero"]["top"], f"{m['tapeL']['top']} vs {m['hero']['top']}")

    print("\n== ⑤ 手机档（375px）：一列、内页在文字下面整宽、无横向滚动 ==")
    pg.set_viewport_size({"width": 375, "height": 780})
    m = pg.evaluate(PAINT, {"markup": HERO, "dark": False})
    say, panel, title, hero = m["say"], m["panel"], m["title"], m["hero"]
    check("hero 变成一列：内页在文字列**下面**（不是上面，也不是并排）",
          panel["top"] >= say["bottom"] and abs(panel["left"] - say["left"]) <= 1,
          f"panel.top {panel['top']} vs say.bottom {say['bottom']}；left {panel['left']}/{say['left']}")
    check("内页整宽（100%），不出屏",
          panel["w"] >= 375 * 0.85 and panel["right"] <= 375, f"w {panel['w']} right {panel['right']}")
    # ★ 这几条是 20260930 出图核对时补的：手机档那一段**写在父规则声明之前**，同特异度下
    # 被父规则压掉，`padding`/`gap`/`justify-content` 一个都没生效（页面不报错、也不影响
    # 上面那三条判据）。数值断言把"声明有没有落地"钉死，光看"是不是一列"是看不出来的。
    check("★ 手机档的 `padding: … 5% …` 真的生效（左 5% = 18.75px，父规则的 8% 是 30px）",
          abs(say["left"] - 375 * 0.05) <= 1, f"say.left {say['left']}（5% 期望 18.75 / 8% 是 30）")
    check("★ 手机档的 `gap: 28px` 真的生效（父规则的 48px / `space-between` 会给出别的数）",
          abs(panel["top"] - say["bottom"] - 28) <= 1, f"文字与内页间距 {panel['top'] - say['bottom']}")
    check("  手机档仍占满首屏（`min-height: 100vh` 没被手机档撤掉）",
          abs(hero["h"] - 780) <= 1, f"hero.h {hero['h']}")
    check("标题降到 2rem=32px、描边收细到 2px（桌面的 2.5rem 会折两行贴边）",
          title["fs"] == "32px" and title["strokeW"] == "2px",
          f"fs {title['fs']} stroke {title['strokeW']}")
    check("★ 无横向滚动（樱花/色块/胶带都不许造出滚动条）",
          m["docOverflow"]["scrollW"] <= m["docOverflow"]["clientW"] + 1,
          f"scrollW {m['docOverflow']['scrollW']} / clientW {m['docOverflow']['clientW']}")
    check("命令条在手机上不出屏（`white-space: nowrap` 的长条）",
          m["term"]["right"] <= 375, f"term.right {m['term']['right']}")
    check("Vitrine 在 ≤1100px 是 display: none（手机上不来抢位）",
          m["vit"]["display"] == "none", f"实测 {m['vit']['display']}")

    print("\n== ⑥ 夜间档：内页整块隐藏、拼贴换深色、标题披粉白渐变 ==")
    pg.set_viewport_size({"width": 1440, "height": 900})
    light = pg.evaluate(PAINT, {"markup": HERO, "dark": False})
    dark = pg.evaluate(PAINT, {"markup": HERO, "dark": True})
    check("★ 夜间 `.heroPanel` 整块 `display: none`（只藏 video 会留一张空白的白卡片）",
          dark["panel"]["display"] == "none", f"实测 {dark['panel']['display']}")
    check("  白天内页必须在（对照组：这条判据不是「两边都 none」）",
          light["panel"]["display"] != "none" and light["video"]["display"] == "block",
          f"panel {light['panel']['display']} / video {light['video']['display']}")
    check("夜间拼贴底换成深色（与白天不是同一张 background-image）",
          dark["collage"]["bgImage"] != light["collage"]["bgImage"]
          and "rgb(22, 18, 31)" in dark["collage"]["bgImage"],
          f"夜间 {dark['collage']['bgImage'][:60]}")
    check("夜间标题仍是渐变填充 + 透明字（粉白那套），描边换成白 0.9",
          dark["title"]["fill"] == "rgba(0, 0, 0, 0)"
          and "linear-gradient" in dark["title"]["bgImage"]
          and dark["title"]["strokeC"].startswith("rgba(255, 255, 255"),
          f"fill {dark['title']['fill']} / stroke {dark['title']['strokeC']}")
    check("  白天标题是粉紫渐变、深粉兜底色（不支持 background-clip 的浏览器不瞎）",
          light["title"]["fill"] == "rgba(0, 0, 0, 0)" and "linear-gradient" in light["title"]["bgImage"],
          f"fill {light['title']['fill']}")
    check("夜间樱花改深粉（浅粉在深底上糊成一片）",
          dark["petalAnim"] == "petal-fall" and dark["petalCount"] == 7,
          f"{dark['petalAnim']} / {dark['petalCount']}")

    print("\n== ⑦ prefers-reduced-motion：樱花不出现、光标常亮（且带牙）==")
    normal = pg.evaluate(PAINT, {"markup": HERO, "dark": False})
    pg.emulate_media(reduced_motion="reduce")
    reduced = pg.evaluate(PAINT, {"markup": HERO, "dark": False})
    check("★ 正常档下樱花**在动**、光标**在闪**（否则下面的判据是空的）",
          normal["petalAnim"] == "petal-fall" and normal["petalDur"] != "0s"
          and normal["caret"]["anim"] == "caret-blink",
          f"petal {normal['petalAnim']}/{normal['petalDur']} caret {normal['caret']['anim']}")
    check("★ 减少动效档：樱花 `animation: none` 且不可见",
          reduced["petalAnim"] == "none" and reduced["petalOpacity"] == "0",
          f"{reduced['petalAnim']} / opacity {reduced['petalOpacity']}")
    check("★ 减少动效档：光标 animation 停、常亮",
          reduced["caret"]["anim"] == "none" and reduced["caret"]["opacity"] == "1",
          f"{reduced['caret']['anim']} / {reduced['caret']['opacity']}")
    pg.emulate_media(reduced_motion="no-preference")

    print("\n== ⑧ 源码锁：只许有一处 hero 几何 / 不许把内联 style 加回来 ==")
    tsx = (FE / "src/frontHome/Content/ContentHome/index.tsx").read_text(encoding="utf-8")
    hero_jsx = tsx.split('<div className="SelfDescription"')[1].split("<Vitrine/>")[0]
    check("hero 段（到 `<Vitrine/>` 为止）里没有内联 `style={{`（几何全在 sass 里）",
          "style={{" not in hero_jsx, f"命中 {hero_jsx.count('style={{')} 处")
    check("hero 段里没有遗留的 `heroPanelVeil`（那块遮罩随满屏视频一起删了）",
          "heroPanelVeil" not in tsx)
    check("Vitrine 的几何仍是 `8vw + 450px`（本套件的缝判据锚在这一条上）",
          re.search(r"left:\s*calc\(8vw \+ 450px\)", VITRINE_CSS) is not None)

    # （这里**没有**第 ⑨ 组：形状扫描住在 `tests/sass-media-shadow.test.mjs`，进 CI 的秒级
    # job，判据只此一份实现。上面第 ⑤ 组补的那两条数值断言是同一件事的几何侧——"这一档
    # 到底有没有生效"；一个管形状、一个管结果，两边不重复。）

    check("无 JS 运行时报错", not errs, "; ".join(errs[:2]))
    br.close()

shutil.rmtree(SANDBOX, ignore_errors=True)
print(f"\n{'✗' if FAIL else '✓'} home-hero：{PASS} 通过 / {FAIL} 失败")
raise SystemExit(1 if FAIL else 0)
