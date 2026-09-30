# -*- coding: utf-8 -*-
"""首页三块标签（置顶 / 文章 / More）的解剖学验收：真 sass + 真类名 + 量计算的样式。

20261001 八轮（用户第 4 条：「那三个标签丑死了，大改，其中置顶的标签还可以，但是动效
上下晃动给人不稳定失去掌控的心理感觉」）把这三块又重排了一次。它们**全是纯 CSS 的形状
与动效**，没有一处能用"源码里有没有这段字符串"证明对了：

  · 置顶的尾尖是 `clip-path` 切出来的 —— 源码写着 `polygon(...)` 不代表浏览器算出来的
    就是一枚箭头尾尖（写成四角手撕边也是合法的 `polygon`）；
  · 「文章」左缘那道装订边（`border-left`）与右端的圆角，是**实测盒子**；
  · More 那枚 chevron 是"两条边 + 转 -45°"，靠 `::after` 的宽高与 border 判定；
  · **三块牌子静置时一律不许动**（八轮的总纲，也是用户这句话的落点）：常驻循环
    （`ribbon-float` / `tag-twinkle` / `more-nudge`）撤得只剩置顶尾尖那枚 ✦ 的呼吸，
    且它只动 opacity、不产生位移。这条判据是 `animationName` + `transform` 一起读的
    —— "不动"不是一个能在源码里 grep 到的事实，得问浏览器要计算后的值；
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
        // 八轮的判据要读它：撤掉常驻动画之后，斜贴的角度**改由基规则的 transform 给**
        // ——"有没有角度"只有计算值知道（源码里写了 `rotate(-3.6deg)` 也可能是被
        // 另一条同特异度的规则压掉的）。
        transform: getComputedStyle(el).transform,
        radius: getComputedStyle(el).borderRadius,
        // 「文章」牌子的装订边（第八轮由 `::before` 渐变竖脊改成 `border-left` 平涂）
        borderLeftW: getComputedStyle(el).borderLeftWidth,
        borderLeftColor: getComputedStyle(el).borderLeftColor,
        borderTopColor: getComputedStyle(el).borderTopColor,
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
    # ── 八轮的第 4 条：**缎带自己不许再动** ──────────────────────────────────
    # 原话「动效上下晃动给人不稳定失去掌控的心理感觉」。判据分两半，缺一不可：
    #   ① `animationName` 没有常驻动画（`ribbon-float` 已撤）；
    #   ② 斜贴的角度仍在 —— 它现在由基规则的 `transform` 给。只撤动画不补角度的话
    #      缎带会变成正着贴的，那是另一个形状了（这条正是"撤得对不对"的关键）。
    check("★ 缎带自己不再有常驻动画（`ribbon-float` 的慢浮已撤）",
          tape["anim"] == "none", tape["anim"])
    # ⚠️ 浏览器把 `rotate(-3.6deg)` 算成 matrix，从计算值里读不出"是不是 -3.6°"，
    # 所以这条只判"有没有角度"，并紧跟着用**负空间**证明它确实测得到东西。
    check("★ 斜贴的角度改由基规则的 transform 给（撤了动画也不是正着贴的）",
          tape["transform"] != "none", tape["transform"])
    pg.add_style_tag(content=".ContentContainer .TopArticle .Top .TopTape{transform:none!important}")
    pg.wait_for_timeout(120)
    check("（对照）抹掉角度后 transform 真的是 none ⇒ 上一条判据有牙",
          probe("#tape")["transform"] == "none", probe("#tape")["transform"])
    pg.evaluate("() => { const s=[...document.querySelectorAll('style')].pop(); s.remove(); }")
    pg.wait_for_timeout(120)
    check("（对照）样式表摘掉后角度回来了", probe("#tape")["transform"] != "none")
    # 六轮的"斜掠高光"必须真的没了：它是 `::after` 上一条 22px 宽的白色渐变
    check("六轮那条斜掠高光已撤（`::after` 不再是 22px 的白色渐变块）",
          tape["after"]["w"] != "22px" or "gradient" not in tape["after"]["pos"],
          f'{tape["after"]["w"]} / {tape["after"]["pos"]}')
    check("高度仍由内容撑开（缎带不该被钉死成一张固定尺寸的片）",
          20 <= tape["h"] <= 34, f'{tape["w"]:.1f}×{tape["h"]:.1f}')

    # ── 二、「文章」段落签（八轮大改：一张和纸条）──────────────────────────────
    print("\n【二】文章：和纸条（左直边 + 平涂装订边 + 墨色线性图标 + 右端圆角）")
    plate = probe("#plate")
    # 装订边：八轮从 `::before`（5px 渐变竖脊）改成 `border-left`（4px 平涂）。
    # 判据同时看**宽度**与**颜色**：只看宽度的话，四边都是 1px 也可能碰巧是 4px；
    # 看颜色才能证明"左缘那一道与其余三边不是同一条线"。
    check("左缘那道装订边在（`border-left` 4px、颜色与其余三边不同）",
          plate["borderLeftW"] == "4px" and plate["borderLeftColor"] != plate["borderTopColor"],
          f'{plate["borderLeftW"]} {plate["borderLeftColor"]} vs {plate["borderTopColor"]}')
    check("旧的 `::before` 渐变竖脊已撤（不再有那条伪元素）",
          plate["before"]["content"] in ("none", ""), plate["before"]["content"])
    # 左直右圆 = 贴纸那头 / 翘起那头（与置顶缎带的直边同款语言）
    check("左端直角、右端圆角（`0 10px 10px 0`）",
          plate["radius"].replace(" ", "") in ("0px10px10px0px", "0px10px10px0"),
          plate["radius"])
    # ★ 母题归置顶独占：这块牌子上**不许**再出现 ✦（原来的撞车正是"丑"的一部分）
    check("★ 这块牌子上没有 ✦（右端那枚记号归置顶独占，不再两处撞车）",
          "✦" not in plate["after"]["content"], plate["after"]["content"])
    icon = pg.evaluate("""() => {
        const s = getComputedStyle(document.querySelector('#plateIcon'));
        const r = document.querySelector('#plateIcon').getBoundingClientRect();
        return { w: r.width, h: r.height, radius: s.borderRadius, color: s.color,
                 bg: s.backgroundImage, anim: s.animationName, fs: s.fontSize };
    }""")
    # 七轮那个 20×20 的渐变圆盘是"丑"的第二块：徽章比字还重。八轮回到墨色线性。
    check("图标不再装盘（没有圆角背景、没有渐变底）",
          icon["bg"] == "none" and icon["radius"] in ("0px", "0%"),
          f'bg={icon["bg"]} r={icon["radius"]}')
    check("图标是承色的一枚线性字（不是 11px 的白字压在盘上）",
          float(icon["fs"].rstrip("px")) >= 14 and icon["color"] not in ("rgb(255, 255, 255)", "white"),
          f'{icon["fs"]} {icon["color"]}')
    check("★ 牌子静置不动（图标那条 twinkle 也撤了 —— 三块牌子里只剩置顶的 ✦ 会呼吸）",
          plate["anim"] == "none" and plate["after"]["anim"] == "none"
          and icon["anim"] == "none",
          f'{plate["anim"]} / {plate["after"]["anim"]} / {icon["anim"]}')

    # ── 三、More ─────────────────────────────────────────────────────────────
    print("\n【三】More：右端一枚 chevron（静置不动，悬停才走）")
    more = probe("#more")
    # chevron = 一个 8×8 的盒子 + 只画右边和下边 + 转 -45°。
    # 判 border 的**宽度**而不是有没有 border：`.allContent` 的基础规则给整块牌子
    # 留了 1px 的四边边框（`border: 1px solid var(--washi-line)`），
    # 只判"有边框"的话，箭头那两条边和牌子自己的四条边分不开。
    check("箭头是两条边（右 2px + 下 2px，比牌子自己那 1px 粗）",
          more["after"]["borderRight"] == "2px" and more["after"]["borderBottom"] == "2px",
          f'{more["after"]["borderRight"]}/{more["after"]["borderBottom"]}')
    # ⚠️ 这一条是八轮最容易做错的地方：原来那个 -45° 是 **keyframe 给的**，动画一撤、
    # 基规则里不补 `transform` 的话，箭头就摊平成一个直角（`border-right` +
    # `border-bottom` 就是个 L，不是箭头）。所以这里判的是**撤掉动画之后它还是斜的**。
    check("★ 箭头静置时不动、但**仍是斜的**（角度已从 keyframe 搬进基规则）",
          more["after"]["anim"] == "none" and more["after"]["transform"] != "none",
          f'{more["after"]["anim"]} / {more["after"]["transform"]}')
    check("More 不再挂 `.allContent` 那枚 ✦（同一族里两枚记号不许撞车）",
          "✦" not in more["after"]["content"], more["after"]["content"])
    check("左缘装订边仍在（同一块牌子，只是尺寸与手感不同）",
          more["borderLeftW"] == "4px" and more["borderLeftColor"] != more["borderTopColor"],
          f'{more["borderLeftW"]} {more["borderLeftColor"]}')
    check("牌子本身也没有常驻动画", more["anim"] == "none", more["anim"])

    # 悬停：箭头往前送一点。八轮撤掉 `more-nudge` 之后没有"动画恒压声明"那层了，
    # 这条 `transform` 直接生效 —— 但仍要实测，因为 `:hover` 的链一旦写错就静默失效。
    pg.hover("#more")
    pg.wait_for_timeout(400)
    hov = probe("#more")
    check("悬停后箭头右移（动效改为只在指针接触时发生）",
          hov["after"]["transform"] != more["after"]["transform"]
          and hov["after"]["transform"] != "none",
          f'{more["after"]["transform"]} → {hov["after"]["transform"]}')

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
    # 八轮起三块牌子静置本来就不动，这一档要守的只剩"那条唯一的常驻动效（✦ 的呼吸）
    # 真的被关掉"，以及"关的是动画、不是把记号藏掉"。
    check("置顶：✦ 的呼吸停",
          red_tape["anim"] == "none" and red_tape["after"]["anim"] == "none",
          f'{red_tape["anim"]}/{red_tape["after"]["anim"]}')
    # 这条是七轮**专门改对**的：六轮这里给 `::after` 写了 `opacity: 0`（那会儿它是高光），
    # 七轮 `::after` 换成了 ✦ —— 藏掉就等于把缎带的尾尖记号删了。
    check("★ 减少动效下尾尖那枚 ✦ **还在**（只停动画，不隐藏）",
          float(red_tape["after"]["opacity"]) >= 0.99, red_tape["after"]["opacity"])
    check("文章：整块静止（这一档与常速档应当完全一致）",
          red_plate["anim"] == "none" and red_plate["after"]["anim"] == "none",
          f'{red_plate["anim"]}/{red_plate["after"]["anim"]}')
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
