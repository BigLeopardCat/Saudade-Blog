#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""首页首屏 hero：拼贴底 + 描边标题 + 命令条 + 手账内页 + 展示柜贴图 + 樱花（20260930 五轮）。

  python3 tests/home-hero.test.py

现场（用户要求）："主页也想要这种图片的风格"（参考图 = 粉紫淡彩的日系手账封面），
五轮又追加了四条：顶栏要能看清、卡片换同风格、"文本往中间移动 + 文本放大"、
**展示柜搬到视频下面**。改法是**只重做首屏**：

  ① `.collageBg` 柔和色块 + 方格纸     ② `.petals` 七片樱花
  ③ `.SayWords` 窗贴标签 / 描边渐变标题 / 命令条 / 社交按钮 / 签名 / 下翻钮
  ④ `.heroRight` 右列 = `.heroPanel`（手账内页，视频）+ 它下面的 `.vitrine`（展示柜贴图）

本套件钉的是**几何与纪律**，不是"好不好看"：

  ① ★ **"居中成对"**：四轮时文字列与右列是 `space-between` 顶到两端的，五轮按用户原话
     （"左侧那一堆文本和组件往中间移动"）改成 `justify-content: center`，左内边距同时
     8% → 10%。居中把**组**摆正、内边距让文字列仍贴左，两条一起才成立 —— 本组同时量
     "组心落在内容盒中心" 和 "文字列左缘不越过 10%"。
  ② ★ **展示柜搬家**：`left: calc(8vw + 450px)` / `bottom: 18.7vh` 那套绝对定位几何
     **已整体作废**（它是按"签名右侧的缝"算的，而缝的前提随四轮改版没了）。现在它住在
     `.heroRight` 里、视频正下方，宽度吃列宽 —— 本组量"两张卡同宽、上下相接、都在列内"。
  ③ `.heroBottom` 的居中契约：签名 `.home-one-say` 自己也是绝对定位，横向居中靠的是
     "绝对定位子元素取 flex 静态位"，而它的 `bottom: 86px` 又是相对这一行算的 —— 这三条
     原来是 JSX 里的内联 style，20260930 收进 sass，最容易漏的就是居中。
  ④ 手机档（≤768px）：一列，内页在文字下面且整宽、标题降到 2rem；**页面不许出现横向滚动**
     —— 色块的负偏移（`left: -12vw` 那类）没有 `overflow: hidden` 就会造出滚动条。
  ⑤ 夜间档：整个 `.heroPanel` 隐藏（视频仅白天显示是 20260902 的用户要求；只藏 video 会留
     一张空白的白卡片）。⚠️ 四轮那句"右半屏归 Vitrine"**已作废**——展示柜不再只在夜里出现，
     它常驻在列里；夜里这一列只是少了一张卡（断言随之改成"列顶就是展示柜"）。拼贴底换深色。
  ⑥ 展示柜卡片的结构契约（翻页 / 放大）：`perspective` 必须挂在卡片自己身上、
     `overflow: hidden` 不许写在 `.vit-3d` 上、放大态靠 flex 居中而不是 transform —— 三条
     各有一次踩坑史，都在 `Vitrine/index.sass` 头注里。这组一半量几何、一半读源码。
  ⑦ 纪律：不许 `filter: blur()` / `backdrop-filter`（后台 GPU 事故的放大器），樱花只动
     transform/opacity（读编译产物的 `@keyframes` 原文），`prefers-reduced-motion` 下樱花
     不出现、光标常亮 —— 且**带牙**：正常档下这些动画必须是活的（否则"两边都 none"也能绿）。
  ⑧ 视频选择器契约：组件里的 IntersectionObserver 取的是 `hero.querySelector('video')`
     ⇒ hero 里**有且只有一个** video，且它住在内页里。
  ⑨ 源码锁：hero 段不许有内联 `style={{`（几何全在 sass 里）+ 展示柜那几个状态机不许退化。

  （**形状扫描**住在本目录的 `sass-media-shadow.test.mjs`，进 CI 的秒级 job，判据只此一份
   实现。第 ④ 组里那两条数值断言是同一件事的几何侧——"这一档到底有没有生效"；
   一个管形状、一个管结果，两边不重复。）
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
VITRINE_TSX = FE / "src/frontHome/Content/ContentHome/Vitrine/index.tsx"
HERO_TSX = FE / "src/frontHome/Content/ContentHome/index.tsx"
RESET_CSS = FE / "src/frontHome/main.css"

PETALS = "".join(f'<span class="petal p{i}"></span>' for i in range(1, 8))

# 与 index.tsx 的 hero 段同形的标记（不挂 React：本套件量的是类名与结构决定的布局）。
# 社媒按钮用固定宽的方块代替——它们由 SocialButton 渲染，这里只需要"四个占位"。
# 展示柜按真实 DOM 摆（`.vit-3d` → 两张 `.vit-face`），量的是**它自己的高度与位置**，
# 翻页/放大的状态机另有源码锁（第 ⑥ / ⑨ 组）。
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
  <div class="heroRight" id="right">
    <figure class="heroPanel" id="panel">
      <video class="heroVideo" id="video" muted loop playsinline></video>
      <span class="heroPanelTape tapeL" id="tapeL"></span>
      <span class="heroPanelTape tapeR" id="tapeR"></span>
    </figure>
    <section class="vitrine" id="vit">
      <span class="vit-tape vit-tapeL"></span><span class="vit-tape vit-tapeR"></span>
      <div class="vit-3d" id="vit3d">
        <div class="vit-face vit-cover" id="vitface">
          <span class="vit-coverStar">✦</span><span class="vit-coverTitle">词图关系图谱</span>
        </div>
      </div>
      <button class="vit-flip" id="vitflip" type="button"></button>
    </section>
  </div>
  <div class="heroBottom" id="bottom">
    <p class="home-one-say" id="onesay">慢慢来比较快</p>
    <i class="iconfont icon-rcd-angle-double-down upAndDown heroScroll" id="scroll"></i>
  </div>
</div>
""".replace("__PETALS__", PETALS)


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
        # 社媒按钮的替身：固定 40px 方块，让 .Social 的 336px 宽度真的被占满
        '<style>.sBtn{display:inline-block;width:40px;height:40px;background:#ddd;border-radius:50%}</style>'
        # ⚠️ 量的是**静置几何**，所以入场的 `left-in`（1s 的 translateX(-50%)）与手账内页/
        # 展示柜的静态 transform 一律先关掉——它们都是绘制层，留着会让每个 rect 读数偏半个
        # 盒宽（本套件第一版就栽在这里：`.SayWords` 的 rect.left 读成 -104，而 offsetLeft
        # 是 115）。这些装饰的**存在**另有源码锁（读编译产物），不靠几何量。
        # ⚠️ `.vitrine` 的 `vit-in` 只做透明度，但一并关掉：它 `animation-fill-mode: both`
        #    期间元素仍在动画时间轴上，量 opacity 会读到中间值。
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
      transform: cs.transform, textShadow: cs.textShadow,
      // 第 ⑥ 组：perspective 挂错层会让放大态飞不出原位；overflow 挂在 preserve-3d 上
      // 会把 3D 拍平。两条都是"只有量出来才算数"的属性。
      perspective: cs.perspective, transformStyle: cs.transformStyle,
      backface: cs.backfaceVisibility, overflow: cs.overflow, zIndex: cs.zIndex,
    };
  };
  const doc = document.documentElement;
  const petals = [...document.querySelectorAll('.petal')];
  return {
    hero: R('#hero'), say: R('#say'), title: R('#title'), tag: R('#tag'),
    term: R('#term'), caret: R('#caret'), social: R('#social'), panel: R('#panel'),
    video: R('#video'), tapeL: R('#tapeL'), tapeR: R('#tapeR'), right: R('#right'),
    vit: R('#vit'), vit3d: R('#vit3d'), vitface: R('#vitface'), vitflip: R('#vitflip'),
    bottom: R('#bottom'), onesay: R('#onesay'), scroll: R('#scroll'), collage: R('#collage'),
    viewport: { w: window.innerWidth, h: window.innerHeight },
    docOverflow: { scrollW: doc.scrollWidth, clientW: doc.clientWidth,
                   bodyScrollW: document.body.scrollWidth },
    petalCount: petals.length,
    petalAnim: petals.length ? getComputedStyle(petals[0]).animationName : null,
    petalDur: petals.length ? getComputedStyle(petals[0]).animationDuration : null,
    petalOpacity: petals.length ? getComputedStyle(petals[0]).opacity : null,
    // 樱花量**布局宽**：它一直在转（旋转中的方块 rect 会读到 12×√2 ≈ 17px）
    petalW: petals.length ? petals[0].offsetWidth : 0,
    tagStarAnim: document.querySelector('.heroTagStar')
      ? getComputedStyle(document.querySelector('.heroTagStar')).animationName : null,
    tagStarOpacity: document.querySelector('.heroTagStar')
      ? getComputedStyle(document.querySelector('.heroTagStar')).opacity : null,
    videoCount: document.querySelectorAll('.SelfDescription video').length,
    videoInPanel: !!document.querySelector('.heroPanel video'),
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


def css_rule(css: str, sel: str) -> str:
    """取一条规则（选择器行到它的 `}` 或 `{`）。用于第 ⑥ 组的源码锁。"""
    m = re.search(r"(?m)^" + re.escape(sel) + r"\s*\{", css)
    if not m:
        return ""
    end = css.find("\n}", m.end())
    return css[m.end():end if end > 0 else len(css)]


# 舞台：`.SelfDescription` 的左内边距 10%、右内边距 6%（桌面档）——"组居中"的判据锚在
# 内容盒中心 = 0.52 × 视口宽。写死常量会随 sass 改动静默失效，所以从编译产物里现场读。
PAD_L = re.search(r"padding:\s*112px\s+6%\s+148px\s+10%", HERO_CSS) is not None

print("== ① 桌面档：文字列与右列**居中成对**、右列两张卡同宽相接 ==")
with sync_playwright() as p:
    br = p.chromium.launch()
    pg = br.new_page(viewport={"width": 1440, "height": 900})
    errs: list[str] = []
    pg.on("pageerror", lambda e: errs.append(str(e)))
    pg.goto(URL)

    check("桌面档的内边距仍是 `112px 6% 148px 10%`（左 10% 是五轮的新值，"
          "下面的'组心'判据按它推）", PAD_L)

    for vw in (1366, 1440, 1920):
        m = seam_at(pg, vw)
        hero, say, right, panel, vit = m["hero"], m["say"], m["right"], m["panel"], m["vit"]
        gap = max(32, min(0.04 * vw, 80))
        check(f"{vw}px：右列宽 = min(38vw, 520) = {round(min(0.38 * vw, 520))}",
              abs(right["w"] - min(0.38 * vw, 520)) <= 1, f"实测 {right['w']}")
        # 居中：两列的**组心**落在内容盒中心（0.10vw 起、0.94vw 止 ⇒ 中心 0.52vw）。
        # 这一条是五轮的核心要求，`space-between`/`flex-start` 都会给出别的数。
        pair_center = (say["left"] + right["right"]) / 2
        check(f"{vw}px：★ 文字列+右列**居中成对**（组心 = 内容盒中心 {round(0.52 * vw)}）",
              abs(pair_center - 0.52 * vw) <= 2,
              f"组心 {pair_center:.1f}（`space-between` 会给 {(0.10 * vw + right['right']) / 2:.1f}）")
        check(f"{vw}px：文字列左缘不越过 10% 内边距（{round(0.10 * vw)}）",
              say["left"] >= 0.10 * vw - 1, f"say.left {say['left']}")
        check(f"{vw}px：两列之间正是那个 `clamp(32px, 4vw, 80px)` 的 gap = {round(gap)}",
              abs((right["left"] - say["right"]) - gap) <= 1,
              f"实测 {right['left'] - say['right']}")
        check(f"{vw}px：内页是右列第一张卡（列顶、整列宽）",
              abs(panel["top"] - right["top"]) <= 1 and abs(panel["w"] - right["w"]) <= 1,
              f"panel.top {panel['top']} / right.top {right['top']}；w {panel['w']}/{right['w']}")
        check(f"{vw}px：★ 展示柜在视频**下面**、与内页同宽同左缘（用户原话「放到视频下面」）",
              vit["top"] >= panel["bottom"] and abs(vit["w"] - panel["w"]) <= 1
              and abs(vit["left"] - panel["left"]) <= 1,
              f"vit.top {vit['top']} vs panel.bottom {panel['bottom']}；"
              f"w {vit['w']}/{panel['w']} left {vit['left']}/{panel['left']}")
        check(f"{vw}px：展示柜是 16:7 的一张卡（`.vit-3d` 的 aspect-ratio 撑起高度）",
              abs(m["vit3d"]["h"] - m["vit3d"]["w"] * 7 / 16) <= 2,
              f"{m['vit3d']['w']}×{m['vit3d']['h']}")
        check(f"{vw}px：两张卡都在视口内（不溢出右边）",
              right["right"] <= vw, f"right.right {right['right']} / vw {vw}")
        check(f"{vw}px：hero 至少占满首屏（`min-height: 100vh`）",
              900 <= hero["h"] <= 960, f"hero.h {hero['h']}")
        check(f"{vw}px：无横向溢出（色块负偏移被 hero 的 overflow 兜住）",
              m["docOverflow"]["scrollW"] <= m["docOverflow"]["clientW"] + 1,
              f"scrollW {m['docOverflow']['scrollW']} / clientW {m['docOverflow']['clientW']}")

    m = seam_at(pg, 1440)
    title = m["title"]
    print("   （1440px 实测：标题盒 %dx%d，字号 %s，右列 %d×%d，展示柜 %d×%d）"
          % (title["w"], title["h"], title["fs"], m["right"]["w"], m["right"]["h"],
             m["vit"]["w"], m["vit"]["h"]))
    check("★ 量之前先证明**静置**：文字列与内页的 computed transform 都是 none"
          "（入场动画没关掉的话，下面每个 rect 都偏半个盒宽）",
          m["say"]["transform"] == "none" and m["panel"]["transform"] == "none",
          f"say {m['say']['transform']} / panel {m['panel']['transform']}")
    # 标题字号五轮起是 `clamp(2.5rem, 3.6vw, 3.2rem)`（用户要"文本放大"）——四轮那条
    # "字号必须是 2.5rem" 的锁随之作废，改成**按视口算期望值**，锁的仍是"这个 clamp 还在"。
    for vw in (1366, 1440, 1920):
        pg.set_viewport_size({"width": vw, "height": 900})
        fs = float(pg.evaluate(
            "() => { const e = document.querySelector('#title');"
            " return e ? getComputedStyle(e).fontSize.replace('px','') : '0'; }"))
        expect = min(max(40.0, 0.036 * vw), 51.2)
        check(f"{vw}px：标题字号 = clamp(2.5rem, 3.6vw, 3.2rem) = {expect:.1f}px",
              abs(fs - expect) <= 0.6, f"实测 {fs}px")
    pg.set_viewport_size({"width": 1440, "height": 900})
    m = pg.evaluate(PAINT, {"markup": HERO, "dark": False})
    title = m["title"]
    check("★ 字距必须是 normal（`letter-spacing` 会直接把标题盒撑宽）",
          title["ls"] in ("normal", "0px"), f"实测 {title['ls']}")
    check("★ 字重仍是 bold（换个权重盒宽就变）",
          title["fw"] in ("700", "bold"), f"实测 {title['fw']}")
    check("  描边确实是**绘制层**：3px 白描边在（不参与度量）",
          title["strokeW"] == "3px" and title["strokeC"] == "rgb(255, 255, 255)",
          f"{title['strokeW']} / {title['strokeC']}")

    print("\n== ② 底部那行：签名居中 + 渐变填充 + 箭头在它下方（内联 style 收进 sass 的回归锁）==")
    m = seam_at(pg, 1440)
    onesay, scroll, hero, panel, right = m["onesay"], m["scroll"], m["hero"], m["panel"], m["right"]
    center = (onesay["left"] + onesay["right"]) / 2
    check("★ 签名横向居中（±1px）——靠 `.heroBottom` 的全宽 flex + justify-content: center",
          abs(center - m["viewport"]["w"] / 2) <= 1,
          f"签名中心 {center:.1f} / 视口中心 {m['viewport']['w'] / 2}")
    check("签名离 hero 下缘 86px（`bottom: 86px` 是相对 `.heroBottom` 这行算的）",
          abs(hero["bottom"] - onesay["bottom"] - 86) <= 1,
          f"hero.bottom−onesay.bottom = {hero['bottom'] - onesay['bottom']}")
    check("★ 签名是**渐变字**（粉紫渐变填充 + 透明字色），字号 20px",
          onesay["fill"] == "rgba(0, 0, 0, 0)" and "linear-gradient" in onesay["bgImage"]
          and onesay["fs"] == "20px",
          f"fill {onesay['fill']} / fs {onesay['fs']} / bg {onesay['bgImage'][:48]}")
    check("★ 渐变档**没有投影**（`background-clip: text` 下投影画在字形里，会把渐变洗淡）",
          onesay["textShadow"] == "none", f"实测 {onesay['textShadow']}")
    check("签名的行宽仍 ≤ 880px（原来内联写法是 `white-space: nowrap`，没被盒子拉断）",
          onesay["w"] <= 880, f"实测 {onesay['w']}px")
    check("★ 下翻钮是 48×48 的贴纸圆钮（`font-size: 30px`，不是原来那枚 50px 裸箭头）",
          scroll["w"] == 48 and scroll["h"] == 48 and scroll["fs"] == "30px"
          and scroll["borderRadius"] == "50%",
          f"{scroll['w']}×{scroll['h']} fs {scroll['fs']} r {scroll['borderRadius']}")
    check("下滚箭头的 `up-down` 无限动画还在（`transform` 归它所有，别在 hover 里抢）",
          scroll["anim"] == "up-down" and scroll["animDur"] != "0s",
          f"{scroll['anim']} / {scroll['animDur']}")
    check("箭头在签名下方、离 hero 下缘 20px",
          scroll["bottom"] > onesay["bottom"] and abs(hero["bottom"] - scroll["bottom"] - 20) <= 1,
          f"箭底 {scroll['bottom']} / 签名底 {onesay['bottom']}")
    check("底部那行不压内页、不压展示柜（z-index 2 且横向避开）",
          onesay["right"] <= right["left"] or onesay["bottom"] <= right["top"]
          or onesay["left"] >= right["right"] or onesay["top"] >= right["bottom"],
          f"签名 {onesay} / 右列 {right}")

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
    # 五轮新增的两条常驻动画：同样只许动合成器属性（它们在首屏、和看板娘抢 GPU）
    for name in ("tag-twinkle", "top-shine"):
        k = keyframes_block(HERO_CSS, name)
        ps = set(re.findall(r"^\s*([a-z-]+)\s*:", k, re.M))
        check(f"★ `@keyframes {name}` 只声明 transform / opacity",
              ps and ps <= {"transform", "opacity"}, f"实际声明 {sorted(ps)}")
    k3 = keyframes_block(HERO_CSS, "sig-draw")
    ps3 = set(re.findall(r"^\s*([a-z-]+)\s*:", k3, re.M))
    check("★ `@keyframes sig-draw`（签名那道手写底线）只声明 transform",
          ps3 and ps3 <= {"transform"}, f"实际声明 {sorted(ps3)}")

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

    print("\n== ⑤ 手机档（375px）：一列、内页在文字下面整宽、展示柜跟在它后面 ==")
    pg.set_viewport_size({"width": 375, "height": 780})
    m = pg.evaluate(PAINT, {"markup": HERO, "dark": False})
    say, panel, title, hero, right, vit = m["say"], m["panel"], m["title"], m["hero"], m["right"], m["vit"]
    check("hero 变成一列：右列在文字列**下面**（不是上面，也不是并排）",
          right["top"] >= say["bottom"] and abs(right["left"] - say["left"]) <= 1,
          f"right.top {right['top']} vs say.bottom {say['bottom']}；left {right['left']}/{say['left']}")
    check("右列整宽（100%），内页跟着整宽、不出屏",
          right["w"] >= 375 * 0.85 and panel["w"] >= 375 * 0.85 and panel["right"] <= 375,
          f"right.w {right['w']} panel.w {panel['w']} right {panel['right']}")
    # ★ 这几条是 20260930 出图核对时补的：手机档那一段**写在父规则声明之前**，同特异度下
    # 被父规则压掉，`padding`/`gap`/`justify-content` 一个都没生效（页面不报错、也不影响
    # 上面那三条判据）。数值断言把"声明有没有落地"钉死，光看"是不是一列"是看不出来的。
    check("★ 手机档的 `padding: … 5% …` 真的生效（左 5% = 18.75px，父规则的 10% 是 37.5px）",
          abs(say["left"] - 375 * 0.05) <= 1, f"say.left {say['left']}（5% 期望 18.75 / 10% 是 37.5）")
    check("★ 手机档的 `gap: 28px` 真的生效（父规则的 clamp() 会给出别的数）",
          abs(right["top"] - say["bottom"] - 28) <= 1, f"文字与右列的间距 {right['top'] - say['bottom']}")
    check("  手机档仍占满首屏（`min-height: 100vh` 没被手机档撤掉）",
          hero["h"] >= 780, f"hero.h {hero['h']}")
    check("标题降到 2rem=32px、描边收细到 2px（桌面的 clamp 下限 2.5rem 会折两行贴边）",
          title["fs"] == "32px" and title["strokeW"] == "2px",
          f"fs {title['fs']} stroke {title['strokeW']}")
    check("★ 无横向滚动（樱花/色块/胶带都不许造出滚动条）",
          m["docOverflow"]["scrollW"] <= m["docOverflow"]["clientW"] + 1,
          f"scrollW {m['docOverflow']['scrollW']} / clientW {m['docOverflow']['clientW']}")
    check("命令条在手机上不出屏（`white-space: nowrap` 的长条）",
          m["term"]["right"] <= 375, f"term.right {m['term']['right']}")
    # ⚠️ 四轮那条 `≤1100px 就 display: none` **已删**（它是为"绝对定位占右半屏"写的，
    # 而卡片现在住在视频下面，跟左侧文字组不在一条水平线上，不存在"硬塞会打架"）。
    # 判据随之反过来：手机上它必须**在**，而且仍在内页下面、同宽。
    check("★ 展示柜在手机档**仍然显示**（旧的 `≤1100px display: none` 已随搬家废除）",
          vit["display"] != "none" and vit["top"] >= panel["bottom"]
          and abs(vit["w"] - panel["w"]) <= 1,
          f"display {vit['display']} top {vit['top']} vs panel.bottom {panel['bottom']}")

    print("\n== ⑥ 展示柜卡片：翻页 / 放大 的两条硬契约（挂 perspective、量 overflow）==")
    m = seam_at(pg, 1440)
    check("★ `perspective` 挂在**卡片自己**身上（`.vitrine`），不在祖先链上"
          "（挂到 `.heroRight`/`.SelfDescription` 上，放大态的 `position: fixed` 会被框住）",
          m["vit"]["perspective"] != "none"
          and m["right"]["perspective"] == "none" and m["hero"]["perspective"] == "none",
          f"vit {m['vit']['perspective']} / right {m['right']['perspective']} / hero {m['hero']['perspective']}")
    check("★ `.vit-3d` 是 preserve-3d 且**没有** `overflow: hidden`"
          "（overflow 是分组属性，会把它拍平成 flat ⇒ 翻页时两张面同时可见）",
          m["vit3d"]["transformStyle"] == "preserve-3d" and m["vit3d"]["overflow"] == "visible",
          f"{m['vit3d']['transformStyle']} / {m['vit3d']['overflow']}")
    check("圆角与裁剪下沉在 `.vit-face` 上（overlay 隐藏 + 圆角都在这一层）",
          m["vitface"]["overflow"] == "hidden" and m["vitface"]["backface"] == "hidden"
          and m["vitface"]["borderRadius"] == "15px",
          f"{m['vitface']['overflow']} / {m['vitface']['backface']} / {m['vitface']['borderRadius']}")
    check("★ 放大态靠 **flex 居中**（`inset: 0` + `display: flex`），"
          "不许用 `translate(-50%,-50%)`（transform 会给 fixed 后代造包含块，压暗层盖不满屏）",
          "position: fixed" in css_rule(VITRINE_CSS, ".vitrine.is-zoomed")
          and "inset: 0" in css_rule(VITRINE_CSS, ".vitrine.is-zoomed")
          and "translate(-50%" not in VITRINE_CSS,
          "见 Vitrine/index.sass 的 放大 段落")
    check("★ 内联态图谱不吃指针事件、放大后才交还（`pointer-events` 两态都写了）",
          ":not(.is-zoomed)" in VITRINE_CSS and "pointer-events: none" in VITRINE_CSS
          and "pointer-events: auto" in VITRINE_CSS)
    check("★ 入场动画只做透明度（`vit-in` 里不许有 transform——"
          "否则动画那 0.7 秒内点开会飞错位置）",
          set(re.findall(r"^\s*([a-z-]+)\s*:", keyframes_block(VITRINE_CSS, "vit-in"), re.M))
          <= {"opacity"})
    check("★ 旧几何 `left: calc(8vw + 450px)` 已不在（第五轮搬家后它是死值，"
          "留着会让人以为还有那条缝）",
          "8vw + 450px" not in VITRINE_CSS and "calc(8vw + 450px)" not in VITRINE_CSS)

    print("\n== ⑦ 夜间档：内页整块隐藏、展示柜补位、拼贴换深色、标题披粉白渐变 ==")
    pg.set_viewport_size({"width": 1440, "height": 900})
    light = pg.evaluate(PAINT, {"markup": HERO, "dark": False})
    dark = pg.evaluate(PAINT, {"markup": HERO, "dark": True})
    check("★ 夜间 `.heroPanel` 整块 `display: none`（只藏 video 会留一张空白的白卡片）",
          dark["panel"]["display"] == "none", f"实测 {dark['panel']['display']}")
    check("  白天内页必须在（对照组：这条判据不是「两边都 none」）",
          light["panel"]["display"] != "none" and light["video"]["display"] == "block",
          f"panel {light['panel']['display']} / video {light['video']['display']}")
    check("★ 夜间这一列只剩展示柜，且它就在列顶（含它自己那 24px 余量之内；"
          "24px 是给白天内页的歪角+胶带留的，夜里内页不在流里、就只是一点余量）",
          dark["vit"]["display"] != "none"
          and 0 <= dark["vit"]["top"] - dark["right"]["top"] <= 24,
          f"vit.top {dark['vit']['top']} / right.top {dark['right']['top']}")
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
    check("★ 夜间签名同样吃到渐变（它头上那条 V13 `color: #ffffff !important` 压不掉"
          "`-webkit-text-fill-color`）",
          dark["onesay"]["fill"] == "rgba(0, 0, 0, 0)"
          and "linear-gradient" in dark["onesay"]["bgImage"],
          f"fill {dark['onesay']['fill']}")
    check("夜间樱花改深粉（浅粉在深底上糊成一片）",
          dark["petalAnim"] == "petal-fall" and dark["petalCount"] == 7,
          f"{dark['petalAnim']} / {dark['petalCount']}")

    print("\n== ⑧ prefers-reduced-motion：樱花不出现、光标常亮（且带牙）==")
    normal = pg.evaluate(PAINT, {"markup": HERO, "dark": False})
    pg.emulate_media(reduced_motion="reduce")
    reduced = pg.evaluate(PAINT, {"markup": HERO, "dark": False})
    check("★ 正常档下樱花**在动**、光标**在闪**、标签星**在闪**（否则下面的判据是空的）",
          normal["petalAnim"] == "petal-fall" and normal["petalDur"] != "0s"
          and normal["caret"]["anim"] == "caret-blink"
          and normal["tagStarAnim"] == "tag-twinkle",
          f"petal {normal['petalAnim']}/{normal['petalDur']} caret {normal['caret']['anim']}"
          f" star {normal['tagStarAnim']}")
    check("★ 减少动效档：樱花 `animation: none` 且不可见",
          reduced["petalAnim"] == "none" and reduced["petalOpacity"] == "0",
          f"{reduced['petalAnim']} / opacity {reduced['petalOpacity']}")
    check("★ 减少动效档：光标 animation 停、常亮",
          reduced["caret"]["anim"] == "none" and reduced["caret"]["opacity"] == "1",
          f"{reduced['caret']['anim']} / {reduced['caret']['opacity']}")
    check("★ 减少动效档：标签星停、常亮",
          reduced["tagStarAnim"] == "none" and reduced["tagStarOpacity"] == "1",
          f"{reduced['tagStarAnim']} / {reduced['tagStarOpacity']}")
    pg.emulate_media(reduced_motion="no-preference")

    print("\n== ⑨ 源码锁：只许有一处 hero 几何 / 不许把内联 style 加回来 / 展示柜状态机 ==")
    tsx = HERO_TSX.read_text(encoding="utf-8")
    hero_jsx = tsx.split('<div className="SelfDescription"')[1].split("<Vitrine/>")[0]
    check("hero 段（到 `<Vitrine/>` 为止）里没有内联 `style={{`（几何全在 sass 里）",
          "style={{" not in hero_jsx, f"命中 {hero_jsx.count('style={{')} 处")
    check("hero 段里没有遗留的 `heroPanelVeil`（那块遮罩随满屏视频一起删了）",
          "heroPanelVeil" not in tsx)
    check("★ `.heroRight` 里 **video 在前、`<Vitrine/>` 在后**（用户要的「视频下面」是 DOM 顺序，"
          "不是靠 CSS 调出来的）",
          tsx.index('className="heroPanel"') < tsx.index("<Vitrine/>")
          and 'className="heroRight"' in tsx)
    vtsx = VITRINE_TSX.read_text(encoding="utf-8")
    check("★ 封面面单击**不放大**（用户原话是「**翻页后**可以单击展示柜」）",
          "if (!flipped || zoomed) return;" in vtsx)
    check("★ 图谱面**翻到之前不挂载**（`exhibits` 那条是 `lazy(...)`，早退没了以后"
          "这是唯一的性能闸：没人翻页就一份图数据都不下载）",
          "{mounted && (" in vtsx and "setMounted(true)" in vtsx)
    check("★ 翻页钮拦冒泡（它住在卡片里，不拦的话这一下会同时命中卡片的「放大」）",
          "e.stopPropagation()" in vtsx and "handleFlip" in vtsx)
    check("★ 放大态锁文档滚动 + Esc 关闭（不然滚轮推着底下页面走）",
          "document.body.style.overflow" in vtsx and "Escape" in vtsx)

    check("无 JS 运行时报错", not errs, "; ".join(errs[:2]))
    br.close()

shutil.rmtree(SANDBOX, ignore_errors=True)
print(f"\n{'✗' if FAIL else '✓'} home-hero：{PASS} 通过 / {FAIL} 失败")
