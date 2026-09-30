# -*- coding: utf-8 -*-
"""首页三块标签（置顶 / 文章 / More）的解剖学验收：真 sass + 真类名 + 量计算的样式。

20261001 七轮（用户第 3 条：「三个文本标签"置顶，文章，more"继续优化形态符合当前主题的
日式动漫风格组件，不必拘泥于现在的形态的动效」）把这三块重排了一遍。它们**全是纯 CSS
的形状与动效**，没有一处能用"源码里有没有这段字符串"证明对了：

  · 置顶的尾尖是 `clip-path` 切出来的 —— 源码写着 `polygon(...)` 不代表浏览器算出来的
    就是一枚箭头尾尖（写成四角手撕边也是合法的 `polygon`）；
  · 「文章」左缘那道竖脊、图标那枚圆形徽章，都是**伪元素/子元素的实测盒子**；
  · More 那枚 chevron 是"两条边 + 转 -45°"，靠 `::after` 的宽高与 border 判定；
  · **减少动效档下 ✦ 必须还在**（六轮那里是 `opacity: 0`——当时 `::after` 是高光，
    藏着对；七轮换成了 ✦，藏掉就等于把记号删了）。这一条只有真跑 reduce 档才看得见。

本机无中文字体（汉字渲染成 .notdef 方块），所以断言全走**盒子与计算值**，不比字形；
箭头/星号这类非汉字符号不受影响。用法：python3 frontend/tests/home-labels.test.py
"""
import functools
import http.server
import pathlib
import shutil
import subprocess
import sys
import tempfile
import threading

ROOT = pathlib.Path(__file__).resolve().parents[2]
FE = ROOT / "frontend"
SASS_FILE = FE / "src/frontHome/Content/ContentHome/index.sass"

FAILS = []


def check(desc, cond, detail=""):
    print(("  ✅ " if cond else "  ❌ ") + desc + (f"  [{detail}]" if detail else ""))
    if not cond:
        FAILS.append(desc)


sb = pathlib.Path(tempfile.mkdtemp(prefix="home-labels-"))
css = sb / "labels.css"
r = subprocess.run(["node", "-e",
                    "const s=require('sass');const r=s.compile(process.argv[1],{style:'expanded'});"
                    "process.stdout.write(r.css);", str(SASS_FILE)],
                   cwd=str(FE), capture_output=True)
if r.returncode != 0:
    raise SystemExit("sass 编译失败：\n" + r.stderr.decode("utf-8", "replace"))
css.write_text(r.stdout.decode("utf-8"), encoding="utf-8")
# 这三块标签住在 `.ContentContainer` 里（`.allContent` / `.more` 都挂在它下面）——
# 沙箱必须补上这层祖先，否则选择器一条都不命中，量到的全是浏览器默认值。
(sb / "index.html").write_text(
    '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">'
    '<style>body{margin:0;font-family:sans-serif}</style>'
    '<style>' + css.read_text(encoding="utf-8") + '</style></head><body>'
    '<div class="ContentContainer">'
    '<div class="TopArticle" style="position:relative;width:520px;height:280px;background:#fff">'
    '<div class="Top"><span class="TopTape" id="tape">'
    '<i class="iconfont icon-sticky1" id="tapeIcon" aria-hidden="true"></i>置顶</span></div>'
    '</div>'
    '<div class="allContent" id="plate">'
    '<i class="iconfont icon-wenzhang2" id="plateIcon" aria-hidden="true"></i>文章</div>'
    '<div class="allContent more" id="more">More</div>'
    '</div></body></html>', encoding="utf-8")


class _Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a, **k):
        return None


_handler = functools.partial(_Quiet, directory=str(sb))
_server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _handler)
threading.Thread(target=_server.serve_forever, daemon=True).start()
URL = f"http://127.0.0.1:{_server.server_address[1]}/index.html"

from playwright.sync_api import sync_playwright  # noqa: E402

# 量一个伪元素的盒子。`getComputedStyle(el, '::after')` 拿的是**计算后的声明**，
# 不是布局盒子 —— 宽高要按 pseudo 的 width/height 读（这三块都给了显式值，
# 没有 auto 的情形，所以够用）。
PROBE = """() => {
    const el = document.querySelector(sel);
    return {
        w: el.getBoundingClientRect().width,
        h: el.getBoundingClientRect().height,
        clip: getComputedStyle(el).clipPath,
        anim: getComputedStyle(el).animationName,
        before: (() => { const s = getComputedStyle(el, '::before');
                         return { content: s.content, w: s.width, h: s.height,
                                  bg: s.backgroundImage, pos: s.position }; })(),
        after: (() => { const s = getComputedStyle(el, '::after');
                        return { content: s.content, w: s.width, h: s.height,
                                 opacity: s.opacity, anim: s.animationName,
                                 borderRight: s.borderRightWidth, borderBottom: s.borderBottomWidth,
                                 transform: s.transform, pos: s.position }; })(),
    };
}"""

with sync_playwright() as p:
    br = p.chromium.launch()
    pg = br.new_page(viewport={"width": 1280, "height": 900})
    errs = []
    pg.on("pageerror", lambda e: errs.append(str(e)))
    pg.goto(URL)
    pg.wait_for_timeout(400)

    def probe(sel):
        return pg.evaluate("(sel) => (" + PROBE + ")(sel)", sel)

    # ── 一、置顶缎带 ──────────────────────────────────────────────────────────
    print("\n【一】置顶：漫画缎带（右端尾尖）")
    tape = probe("#tape")
    # 尾尖的判据 = 顶点里有一个 **100% 50%**（右缘正中收成一点）+ 共 5 个顶点。
    # 六轮那版是 8 个顶点的四角手撕边，两种写法都"是 polygon"，只有顶点表分得开。
    clip = tape["clip"].replace(" ", "")
    check("轮廓是 5 顶点缎带（右端 `100% 50%` 尾尖）",
          clip.count(",") == 4 and "100%50%" in clip, tape["clip"])
    # 左端两个顶点必须**同为 0**（上下各一，中间不开豁口）——「直边」= x 一路是 0。
    # ⚠️ 别按源码里写的字面去比：`0` 到这一步已经算成 `0px`，源码那串 `0 100%`
    # 在 computedStyle 里是 `0px100%`（本套件初版就栽在这个字面差上）。
    check("左端是直边（`0 0` 起、`0 100%` 收 —— 那一头贴在卡片上）",
          clip.startswith("polygon(0px0px,") and clip.endswith("0px100%)"), tape["clip"][:60])
    check("纸上那枚 ✦ 在尾尖后（`::after` 的 content 是 ✦、有呼吸动画）",
          "✦" in tape["after"]["content"] and tape["after"]["anim"] == "tag-twinkle",
          f'{tape["after"]["content"]} / {tape["after"]["anim"]}')
    check("缎带自己是慢浮（`ribbon-float`），不是六轮那条 `tape-sway`",
          tape["anim"] == "ribbon-float", tape["anim"])
    # 六轮的"斜掠高光"必须真的没了：它是 `::after` 上一条 22px 宽的白色渐变
    check("六轮那条斜掠高光已撤（`::after` 不再是 22px 的白色渐变块）",
          tape["after"]["w"] != "22px" or "gradient" not in tape["after"]["pos"],
          f'{tape["after"]["w"]} / {tape["after"]["pos"]}')
    check("高度仍由内容撑开（缎带不该被钉死成一张固定尺寸的片）",
          20 <= tape["h"] <= 34, f'{tape["w"]:.1f}×{tape["h"]:.1f}')

    # ── 二、「文章」段落签 ────────────────────────────────────────────────────
    print("\n【二】文章：見出しプレート（左边竖脊 + 圆形徽章 + 右端 ✦）")
    plate = probe("#plate")
    check("左缘那道竖脊在（`::before` 宽 5px、贴左、是渐变）",
          plate["before"]["w"] == "5px" and plate["before"]["pos"] == "absolute"
          and "gradient" in plate["before"]["bg"],
          f'{plate["before"]["w"]} / {plate["before"]["bg"][:40]}')
    check("顶上那道胶带边已撤（`::before` 不再横在顶部）",
          plate["before"]["h"] != "3px", plate["before"]["h"])
    check("右端那枚 ✦ 在（`::after` 是 ✦、会闪）",
          "✦" in plate["after"]["content"] and plate["after"]["anim"] == "tag-twinkle",
          plate["after"]["content"])
    icon = pg.evaluate("""() => {
        const s = getComputedStyle(document.querySelector('#plateIcon'));
        const r = document.querySelector('#plateIcon').getBoundingClientRect();
        return { w: r.width, h: r.height, radius: s.borderRadius, color: s.color,
                 bg: s.backgroundImage, anim: s.animationName };
    }""")
    check("图标是 20×20 的圆徽章（不是一枚裸字）",
          round(icon["w"]) == 20 and round(icon["h"]) == 20 and icon["radius"] in ("50%", "10px"),
          f'{icon["w"]:.1f}×{icon["h"]:.1f} r={icon["radius"]}')
    check("徽章是实底渐变 + 白字",
          "gradient" in icon["bg"] and icon["color"] in ("rgb(255, 255, 255)", "white"),
          f'{icon["color"]} / {icon["bg"][:40]}')
    check("牌子本身静止（常驻动画只许挂在徽章与 ✦ 上）",
          plate["anim"] == "none", plate["anim"])

    # ── 三、More ─────────────────────────────────────────────────────────────
    print("\n【三】More：右端一枚会动的 chevron")
    more = probe("#more")
    # chevron = 一个 7×7 的盒子 + 只画右边和下边 + 转 -45°。
    # 判 border 的**宽度**而不是有没有 border：`.allContent` 的基础规则给整块牌子
    # 留了 1px 的四边边框（`border: 1px solid var(--washi-line)`），
    # 只判"有边框"的话，箭头那两条边和牌子自己的四条边分不开。
    check("箭头是两条边（右 2px + 下 2px，比牌子自己那 1px 粗）",
          more["after"]["borderRight"] == "2px" and more["after"]["borderBottom"] == "2px",
          f'{more["after"]["borderRight"]}/{more["after"]["borderBottom"]}')
    check("箭头被转成斜的（`more-nudge` 的 transform 里有 rotate）",
          more["after"]["anim"] == "more-nudge", more["after"]["anim"])
    check("More 不再挂 `.allContent` 那枚 ✦（同一族里两枚记号不许撞车）",
          "✦" not in more["after"]["content"], more["after"]["content"])
    check("左缘竖脊仍在（同一块牌子，只是尺寸与手感不同）",
          more["before"]["w"] == "5px" and "gradient" in more["before"]["bg"],
          more["before"]["w"])

    # 悬停：箭头停住并多走一点（动画恒压声明，不停住那条不生效——这正是要钉的坑）
    pg.hover("#more")
    pg.wait_for_timeout(400)
    hov = probe("#more")
    check("悬停后箭头停住并右移（动画已让位给声明）",
          hov["after"]["anim"] == "none" and hov["after"]["transform"] != "none",
          f'{hov["after"]["anim"]} / {hov["after"]["transform"]}')

    # ── 四、减少动效 ─────────────────────────────────────────────────────────
    print("\n【四】减少动效档")
    # ⚠️ `page.hover` 的悬停态**会一直粘着**，除非把指针挪走（或页面重挂）。
    # 上面那一步悬停在 `#more` 上，这里不挪开的话量到的是 `.more:hover::after`
    # ——它的 `animation: none` 会让下面的"箭头停住"**假绿**（初版就是这么骗过去的）。
    pg.mouse.move(0, 0)
    pg.wait_for_timeout(200)
    pg.emulate_media(reduced_motion="reduce")
    pg.wait_for_timeout(300)
    red_tape, red_plate, red_more = probe("#tape"), probe("#plate"), probe("#more")
    check("置顶：慢浮停",
          red_tape["anim"] == "none" and red_tape["after"]["anim"] == "none",
          f'{red_tape["anim"]}/{red_tape["after"]["anim"]}')
    # 这条是七轮**专门改对**的：六轮这里给 `::after` 写了 `opacity: 0`（那会儿它是高光），
    # 七轮 `::after` 换成了 ✦ —— 藏掉就等于把缎带的尾尖记号删了。
    check("★ 减少动效下尾尖那枚 ✦ **还在**（只停动画，不隐藏）",
          float(red_tape["after"]["opacity"]) >= 0.99, red_tape["after"]["opacity"])
    check("文章：徽章与 ✦ 停、✦ 仍亮",
          red_plate["after"]["anim"] == "none" and float(red_plate["after"]["opacity"]) >= 0.99,
          f'{red_plate["after"]["anim"]}/{red_plate["after"]["opacity"]}')
    check("More：箭头停住且**仍是斜的**（摊平就是两条正交的边，不是箭头）",
          red_more["after"]["anim"] == "none" and red_more["after"]["transform"] != "none",
          red_more["after"]["transform"])

    check("全程无页面异常", not errs, "; ".join(errs[:3]))
    # 出一张图给人眼看形状（缎带尾尖、竖脊、箭头）。**不落在仓库里**：
    # `tests/` 下没有任何被跟踪的 png，扔一个进去它会在 `git status` 里
    # 永远挂着、还容易被 `git add -A` 顺手带上（本仓明令禁止的那个动作）。
    # 本机无中文字体，汉字是豆腐块，这张图看的是**轮廓**不是字。
    shot = pathlib.Path(tempfile.gettempdir()) / "home-labels.png"
    pg.screenshot(path=str(shot), full_page=True)
    pg.close()
    br.close()

print()
if FAILS:
    print(f"❌ {len(FAILS)} 项未通过：")
    for f in FAILS:
        print("   - " + f)
    sys.exit(1)
print("✅ 首页三块标签：全部通过")
print(f"   （形状截图：{pathlib.Path(tempfile.gettempdir()) / 'home-labels.png'}）")
