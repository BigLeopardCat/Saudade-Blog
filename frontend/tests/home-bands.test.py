# -*- coding: utf-8 -*-
"""首页「段落带」+ 页脚封底的验收（用户 20261001 第 4 条）。

原话：「不止第一页主页，下面包括脚页也做风格适配，主页段落感和配色搭配撞色感，
不要一股脑一个首页顶部颜色配到底。」

改版前的实况：`.SelfDescription`（首屏）/ `.ContentContainer`（正文）/ `.footerContainer`
（页脚）三段的 `background` **都是 `var(--container-background-color)`**（半透明白铺在
页面底图上）⇒ 从上到下没有一处换色。这正是"一个颜色配到底"，也是本套件要钉死的那条回归。

为什么必须真跑浏览器：这条改造的正确性全在**渲染结果**里 —— 源码写着
`background-image: …, var(--band-content)` 不代表那条渐变真的画出来了（先写
`background: var(--band-content)` 再补 `background-image` 就会把它整条顶掉，
两条声明改的是同一个属性）；页脚字色对封底的对比度、窄屏 logo 排有没有溢出，
都只有量像素/量盒子才看得见。**源码锁只做补充，主判据是计算值与像素。**

用法：python3 frontend/tests/home-bands.test.py
"""
import functools
import http.server
import io
import pathlib
import re
import subprocess
import tempfile
import threading

from PIL import Image

ROOT = pathlib.Path(__file__).resolve().parents[2]
FE = ROOT / "frontend"
IDX_CSS = FE / "src/index.css"
MAIN_CSS = FE / "src/frontHome/main.css"
SECTIONS = FE / "src/frontHome/Content/ContentHome/sections.sass"
HOME_SASS = FE / "src/frontHome/Content/ContentHome/index.sass"
FOOT_SASS = FE / "src/frontHome/Footer/index.sass"
FOOT_TSX = FE / "src/frontHome/Footer/index.tsx"
HOME_TSX = FE / "src/frontHome/Content/ContentHome/index.tsx"

FAILS = []


def check(desc, cond, detail=""):
    print(("  ✅ " if cond else "  ❌ ") + desc + (f"  [{detail}]" if detail else ""))
    if not cond:
        FAILS.append(desc)


def strip_comments(text, line_comments=True):
    """剥注释再比拼子串。

    ⚠️ 必须剥：这两份文件里都有大段头注在**解释**这次改动，里面原文写着旧令牌名
    （`--container-background-color`）与旧写法（`style={{…}}`）—— 不剥的话"不许
    出现 X"会被自己的说明文字判红（同族教训：全仓扫描的针会自命中）。
    剥掉之后剩下的才是**代码**，`style={{` 只可能出现在真 JSX 属性里。"""
    text = re.sub(r"/\*.*?\*/", "", text, flags=re.S)
    if line_comments:
        text = re.sub(r"^[ \t]*//.*$", "", text, flags=re.M)
    return text


# ═══ 一、源码锁 ════════════════════════════════════════════════════════════════
# 这几条不是"渲染对不对"，是"别把这次拆开的三段又合回去"。合回去的写法每次都很自然
# （把色值直接写进组件、把 import 挪回一行、给 logo 排去掉 flex-wrap），所以钉住。
print("【一】源码锁：三段不许再合回去")

foot_tsx = FOOT_TSX.read_text(encoding="utf-8")
foot_tsx_code = strip_comments(foot_tsx)
home_tsx = HOME_TSX.read_text(encoding="utf-8")
foot_sass = strip_comments(FOOT_SASS.read_text(encoding="utf-8"))
sections_sass = strip_comments(SECTIONS.read_text(encoding="utf-8"))
idx_css = IDX_CSS.read_text(encoding="utf-8")

check("页脚 TSX 零行内样式（`style={{` 出现 0 次）",
      foot_tsx_code.count("style={{") == 0, f"{foot_tsx_code.count('style={{')} 处")

# 每个类名都要在 TSX 里真的挂着 —— sass 里写好了但 TSX 没写上，等于整块没样式。
# （`.footerContainer` 是既有挂点，一并列上：它是"这一整套只作用于页脚"的边界。）
for cls in ["footerContainer", "footLine", "footNote", "footTech", "footTechRust",
            "footTechAxum", "footPoem", "footBeian", "footBeianIcon", "footLogos",
            "footLogoAli", "footLogoTx", "footLogoCf", "footLogoLive2d"]:
    check(f"页脚 TSX 挂着 .{cls}", cls in foot_tsx_code)

check("页脚底色改走 `--band-foot`（不再共用 `--container-background-color`）",
      "var(--band-foot)" in foot_sass
      and "--container-background-color" not in foot_sass)

# 正文带的底色必须是 `background-image` 的**第三条**。写成 `background: var(--band-content)`
# 再补 `background-image` 的话，后者把前者整条顶掉（同一个属性）—— 底下的带子就没了。
check("正文带底色是 background-image 的第三条（不是另起一条 background）",
      re.search(r"background-image:.*,\s*var\(--band-content\)", sections_sass) is not None
      and "--container-background-color" not in sections_sass)

# 同特异度下后写者赢：`sections.sass` 必须排在 `index.sass` 之后，否则整份没写。
i_base = home_tsx.find("'./index.sass'")
i_band = home_tsx.find("'./sections.sass'")
check("ContentHome/index.tsx 里 sections.sass 排在 index.sass 之后",
      0 <= i_base < i_band, f"index.sass@{i_base} sections.sass@{i_band}")

# 深浅两档必须成对（`src/index.css` 头注立的规矩）：四个令牌各出现两次。
# ⚠️ 数的时候带冒号：`--band-foot-ink` 是 `--band-foot-ink-2` 的前缀，不带冒号会多算。
for tok in ["--band-content:", "--band-foot:", "--band-foot-ink:", "--band-foot-ink-2:"]:
    n = idx_css.count(tok)
    check(f"令牌 {tok[:-1]} 深浅各一档", n == 2, f"{n} 次")

check("页脚 logo 排能换行（窄屏不探出容器）", "flex-wrap: wrap" in foot_sass)


# ═══ 二、沙箱 ═════════════════════════════════════════════════════════════════
# 真 sass（三份）+ 真令牌（index.css / main.css）+ 真类名。页面底图在沙箱里换成一个
# 不透明的近白/近黑 —— 真站上它是 `--front-body-color`（33% 的白/黑）压在**已 404 的**
# 背景图上，纵向本来就没有变化，换成纯色只是把"底"这件事写得确定一点。
sb = pathlib.Path(tempfile.mkdtemp(prefix="home-bands-"))


def compile_sass(path):
    r = subprocess.run(["node", "-e",
                        "const s=require('sass');const r=s.compile(process.argv[1],{style:'expanded'});"
                        "process.stdout.write(r.css);", str(path)],
                       cwd=str(FE), capture_output=True)
    if r.returncode != 0:
        raise SystemExit(f"sass 编译失败（{path.name}）：\n" + r.stderr.decode("utf-8", "replace"))
    return r.stdout.decode("utf-8")


css = "\n".join([
    IDX_CSS.read_text(encoding="utf-8"),
    MAIN_CSS.read_text(encoding="utf-8"),
    compile_sass(HOME_SASS),
    compile_sass(SECTIONS),
    compile_sass(FOOT_SASS),
])
(sb / "bands.css").write_text(css, encoding="utf-8")

GIF = "data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw=="

MARKUP = """
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
""".replace("GIF", GIF)

# 浅色档与夜间档各出一份：`var()` 是在**元素**上解析的，令牌换了档必须有肉眼可量的差别。
# 夜间档把 `.frontRoot` 换成 `.frontDark frontRoot`（App.tsx:67 的真实类名组合），
# 底色用一个近黑 —— 真站夜间页面底是 33% 的黑压出来的深灰。
TEMPLATE = """<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<style>html,body{{margin:0;background:{pagebg};font-family:sans-serif}}
.ContentContainer{{min-height:520px}}</style>
<style>{css}</style></head><body>{body}</body></html>"""

for theme, pagebg in (("light", "#fbfbfb"), ("dark", "#141218")):
    root = 'frontDark frontRoot' if theme == "dark" else 'frontRoot'
    (sb / f"{theme}.html").write_text(
        TEMPLATE.format(pagebg=pagebg, css=css, body=MARKUP.replace('"frontRoot"', f'"{root}"')),
        encoding="utf-8")


class _Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a, **k):
        return None


_server = http.server.ThreadingHTTPServer(
    ("127.0.0.1", 0), functools.partial(_Quiet, directory=str(sb)))
threading.Thread(target=_server.serve_forever, daemon=True).start()
PORT = _server.server_address[1]

from playwright.sync_api import sync_playwright  # noqa: E402


# ── 颜色工具（与 `tests/dark-mode-contrast.test.py` 同一套口径）──────────────────
def P(s):
    """`rgb(r, g, b)` / `rgba(r, g, b, a)` → 元组。"""
    nums = [float(x) for x in re.findall(r"-?\d*\.?\d+", s)]
    return tuple(nums)


def _srgb(v):
    v /= 255.0
    return v / 12.92 if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4


def lin(c):
    r, g, b = (_srgb(v) for v in c[:3])
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def ratio(fg, bg):
    a, b = lin(fg), lin(bg)
    hi, lo = max(a, b), min(a, b)
    return (hi + 0.05) / (lo + 0.05)


def over(fg, bg):
    """带 alpha 的前景压在**不透明**背景上。页脚两个字色令牌都是 rgba。"""
    a = fg[3] if len(fg) > 3 else 1.0
    return tuple(round(fg[i] * a + bg[i] * (1 - a)) for i in range(3))


def last_grad_first_stop(bg):
    """`background-image` 里**最后一层**渐变的第一个色标（= 那一层带子最上面的颜色）。

    三层背景的 `background-image` 是一条逗号分隔的列表，`linear-gradient(` 里本身
    也带逗号 —— 按 `linear-gradient(` 切开再取最后一段，就绕开了"逗号也算层分隔符"
    这个坑。色标抽到的可能是 rgba（渐变常常带 alpha），只取前三位。"""
    layer = bg.rsplit("linear-gradient(", 1)[-1]
    m = re.search(r"rgba?\([^)]*\)", layer)
    return P(m.group(0))[:3] if m else (0, 0, 0)


def deepest_bg(el):
    """元素**真正画出来的那层色**：`background-color` 为空时退到最后一层渐变。"""
    c = P(el["bgc"])
    if len(c) > 3 and c[3] == 0:          # rgba(0,0,0,0) = 没设底色
        return last_grad_first_stop(el["bg"])
    return c[:3]


PROBE = """(sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    const b = getComputedStyle(el, '::before');
    return {
        rect: {l: r.left, t: r.top, w: r.width, h: r.height, b: r.bottom},
        bg: cs.backgroundImage, bgc: cs.backgroundColor, color: cs.color,
        overflowY: cs.overflowY,
        before: {content: b.content, h: b.height, top: b.top, bg: b.backgroundImage},
    };
}"""

TEXT_SEL = {"l1": ".footLine", "l2": ".footNote", "l3": ".footTechRust",
            "l4": ".footPoem p", "l5": ".footBeian", "l5a": ".footBeian .link"}

with sync_playwright() as p:
    br = p.chromium.launch()

    for theme in ("light", "dark"):
        print(f"\n【二{'.浅色档' if theme == 'light' else '.夜间档'}】三段配色（{theme}）")
        pg = br.new_page(viewport={"width": 1280, "height": 900})
        errs = []
        pg.on("pageerror", lambda e: errs.append(str(e)))
        pg.goto(f"http://127.0.0.1:{PORT}/{theme}.html")
        pg.wait_for_timeout(300)

        def probe(sel):
            return pg.evaluate("(sel) => (" + PROBE + ")(sel)", sel)

        hero, content, foot = probe("#hero"), probe("#content"), probe("#foot")

        # ① 正文带的底色真的画出来了：`background-image` 里应当**解析出** `--band-content`
        #    那一组色标（浅色档是薄荷 #eaf7f1 → 淡紫 #f1edff）。计算值会把 `var()` 展开，
        #    所以这里比的是展开后的 rgb()，比"源码里有没有那串字"硬得多。
        want = ("rgb(234, 247, 241)", "rgb(241, 237, 255)") if theme == "light" \
            else ("rgb(19, 38, 42)", "rgb(32, 26, 49)")
        check("正文带的 background-image 里解析出分段带的两个色标",
              all(w in content["bg"] for w in want),
              content["bg"][-90:])
        check("正文带不再是那层半透明白/黑（--container-background-color）",
              "rgba(255, 255, 255, 0.6)" not in content["bg"]
              and "rgba(0, 0, 0, 0.6)" not in content["bg"])

        # ② 页脚底色是 `--band-foot`（不透明渐变）。
        check("页脚的 background-image 里解析出封底色",
              ("rgb(58, 49, 84)" if theme == "light" else "rgb(47, 39, 69)") in foot["bg"],
              foot["bg"][:70])
        check("页脚不再共用 `--container-background-color`",
              "rgba(255, 255, 255, 0.6)" not in foot["bg"]
              and "rgba(0, 0, 0, 0.6)" not in foot["bg"])

        # ③ 三段**互不相同** = "不要一股脑一个颜色配到底"的字面判据。
        #    首屏那张纸是半透明的（`--container-background-color` 铺在拼贴底上），
        #    真正看得见的是 `.collageBg` 那一层，所以拿它代表首屏。
        hero_c = deepest_bg(probe("#hero .collageBg"))
        content_c = deepest_bg(content)
        foot_c = deepest_bg(foot)

        def dmax(a, b):
            return max(abs(a[i] - b[i]) for i in range(3))

        check("首屏 / 正文带 / 封底 三段底色两两不同",
              min(dmax(hero_c, content_c), dmax(content_c, foot_c), dmax(hero_c, foot_c)) >= 8,
              f"首屏{hero_c} 正文{content_c} 封底{foot_c}")
        # 浅色档：封底是深色、上面两段是浅色（"两张内页 + 一张封底"）。
        # 夜间档：三段**都**是深色（这是刻意的），能判的是**封底比正文带亮一档** ——
        # 它是封底不是内页，夜里也该与上面拉开（`src/index.css` 头注写明了这一点）。
        if theme == "light":
            check("封底是深色、首屏与正文带是浅色（截面上真的分了两段）",
                  lin(foot_c) < 0.30 and lin(content_c) > 0.55 and lin(hero_c) > 0.55,
                  f"L(首屏)={lin(hero_c):.3f} L(正文)={lin(content_c):.3f} L(封底)={lin(foot_c):.3f}")
        else:
            check("夜间三段仍是深色，但封底比正文带亮一档",
                  lin(foot_c) < 0.35 and lin(foot_c) > lin(content_c) > lin(hero_c),
                  f"L(首屏)={lin(hero_c):.3f} L(正文)={lin(content_c):.3f} L(封底)={lin(foot_c):.3f}")

        # ④ 像素判据：上面比的是**声明的色标**，这一条比的是**渲染出来的像素** ——
        #    "背景层被后一条声明顶掉"这类事故只有像素看得出来（声明还在，画不出来）。
        #    取样点全取在各段左缘、且**贴着接缝**（首屏贴下沿、正文带贴上沿、封底贴上沿）：
        #    这是最严的位置 —— 相邻两段在别处拉开、在接缝处却同色，等于没有分段。
        #    先量字色（下一步要把文字调成透明，之后就读不到真字色了）。
        info = {name: pg.evaluate(
            "(s)=>{const e=document.querySelector(s);const c=getComputedStyle(e).color;"
            "const r=e.getBoundingClientRect();"
            "return {c:c,l:r.left,t:r.top,w:r.width,h:r.height};}", sel)
            for name, sel in TEXT_SEL.items()}
        # ⚠️ 连 `transition` 一起关掉：`.link` 有 `transition: color .25s`，只把颜色改成
        # `transparent` 的话那一刻它正**过渡到一半**，截到的仍是灰字 —— 量出来的对比度
        # 只有 2.4:1（本套件初版就被这个假红骗过一次）。
        pg.add_style_tag(content=".footerContainer *{color:transparent !important;"
                                 "transition:none !important}")
        shot = Image.open(io.BytesIO(pg.screenshot(full_page=True))).convert("RGB")
        probes = {"首屏": (int(hero["rect"]["l"] + 40), int(hero["rect"]["b"] - 40)),
                  "正文带": (int(content["rect"]["l"] + 40), int(content["rect"]["t"] + 60)),
                  "封底": (int(foot["rect"]["l"] + 40), int(foot["rect"]["t"] + 60))}
        px = {k: shot.getpixel(v)[:3] for k, v in probes.items()}
        check("三段**渲染出来的像素**两两不同（且取的是接缝附近）",
              min(dmax(px["首屏"], px["正文带"]), dmax(px["正文带"], px["封底"]),
                  dmax(px["首屏"], px["封底"])) >= 8,
              " ".join(f"{k}{v}" for k, v in px.items()))

        # ⑤ 页脚字压在这一段上的对比度（WCAG AA 4.5:1）。取样读的是**这一行字下面**的
        #    真实底色 —— 渐变、贴片、`|` 分隔符都不会算错（文字已在前一步调成透明）。
        for name, sel in TEXT_SEL.items():
            el_css = info[name]
            fg = P(el_css["c"])
            xs = [el_css["l"] + 3, el_css["l"] + el_css["w"] * 0.5, el_css["l"] + el_css["w"] - 3]
            y = int(el_css["t"] + el_css["h"] * 0.5)
            worst = None
            for x in xs:
                bg = shot.getpixel((int(x), y))[:3]
                r = ratio(over(fg, bg), bg)
                if worst is None or r < worst[0]:
                    worst = (r, bg, int(x))
            # 报最差那一点的位置与底色：对照度判红时，先要分清是"字色不行"还是"取样点
            # 落在了一块浅色装饰上"（页脚那排 logo 贴片就吃过这个误判）。
            check(f"对比度 ≥ 4.5:1  {sel}", worst[0] >= 4.5,
                  f"{worst[0]:.2f}:1  底色{worst[1]} @x={worst[2]}")

        pg.close()
        check(f"{theme}：无 JS 报错", not errs, str(errs[:1]))

    # ── 三、几何：胶带的位置与窄屏 logo 排 ────────────────────────────────────
    print("\n【三】几何：接缝胶带 / 窄屏 logo 排")
    pg = br.new_page(viewport={"width": 1280, "height": 900})
    pg.goto(f"http://127.0.0.1:{PORT}/light.html")
    pg.wait_for_timeout(300)
    content = pg.evaluate("(sel) => (" + PROBE + ")(sel)", "#content")
    foot = pg.evaluate("(sel) => (" + PROBE + ")(sel)", "#foot")

    # `.ContentContainer` 有 `overflow-x: hidden` ⇒ 按规范 `overflow-y` 计算成 `auto`
    # ⇒ 它是个**裁剪盒**。胶带一旦探出上沿（`top: -8px`）就会被裁掉，只剩贴着上沿的
    # 一条横杠（20261001 出图核对时抓到的）。所以这里同时钉住"是裁剪盒"与"胶带没探出去"。
    check("正文带是裁剪盒（overflow-y 计算成 auto）——胶带不许骑缝",
          content["overflowY"] == "auto", content["overflowY"])
    check("正文带胶带贴在上沿（top ≥ 0）且真有 15px 高",
          float(content["before"]["top"].replace("px", "")) >= 0
          and content["before"]["h"] == "15px",
          f"top={content['before']['top']} h={content['before']['h']}")
    # 页脚没有 overflow ⇒ 那半片可以骑到接缝外面去，两处胶带才是"把两张纸粘起来"。
    check("页脚胶带骑缝（top < 0）",
          float(foot["before"]["top"].replace("px", "")) < 0, foot["before"]["top"])

    for w in (320, 375):
        pg.set_viewport_size({"width": w, "height": 800})
        pg.wait_for_timeout(200)
        r = pg.evaluate("""() => {
            const f = document.querySelector('#foot').getBoundingClientRect();
            const l = document.querySelector('#logos').getBoundingClientRect();
            return {fl: f.left, fr: f.right, ll: l.left, lr: l.right,
                    sw: document.documentElement.scrollWidth, iw: window.innerWidth};
        }""")
        check(f"{w}px 下 logo 排没探出页脚",
              r["ll"] >= r["fl"] - 0.5 and r["lr"] <= r["fr"] + 0.5,
              f"页脚[{r['fl']:.0f},{r['fr']:.0f}] logo[{r['ll']:.0f},{r['lr']:.0f}]")
        check(f"{w}px 下没有横向滚动条", r["sw"] <= r["iw"], f"scrollWidth={r['sw']}")
    pg.close()
    br.close()

print()
if FAILS:
    print(f"❌ {len(FAILS)} 条未通过：")
    for f in FAILS:
        print("   · " + f)
    raise SystemExit(1)
print("✅ 全部通过")
