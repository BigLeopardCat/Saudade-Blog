#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""文章卡片读数（浏览 / 点赞 / 收藏）的**几何**回归（20260930）。

  python3 tests/article-card-stats.test.py

现场（用户要求）："给文章卡片加上浏览数，点赞数，收藏数和对应图标，
就在卡片的图片下方那一行"。

判据那半边在 `article-card-stats.test.mjs`（读不到 ≠ 0），这里只量**位置与预算**。
为什么非要用真浏览器：`.ArticleCard` 是 `height: 600px` 的定高卡（移动端才 `height: auto`），
内容区的收支在 20260912 调到只剩约 7px 余量（见 index.sass 里那段注释）——多出来的高度
会把 `margin-top: auto` 顶掉，同一排卡片的页脚就高低不齐。加不加一行、加在哪儿，
node 桩里算不出来。

所以读数**挂在分类那一行上**（不另开一行），本套件就是这条决定的回归锁：

  ① 位置：读数在封面图**下方**（top ≥ 图底）、在分类标题**同一行**的右侧；
  ② ★ 零高度成本：同一份标记、只差三个数，`.ArticleFooter` 的 offsetTop
     **一个像素都不许变**——这条一旦红，说明读数被挪成了独立一行；
  ③ 预算没被撑破：3 行标题 + 3 行摘要（最坏情况）下内容区不溢出（scrollHeight ≤ clientHeight）；
  ④ 夜间：颜色取的是主题变量（不是写死的灰），与卡片底色对比度 ≥ 3:1；
  ⑤ 窄屏 327px：容不下时**整块读数换行**，而不是把分类名截断（内容是内容、读数是装饰）；
  ⑥ 顺序恒为 阅读 → 点赞 → 收藏（与判据里的 STAT_CELL_ORDER 一致）。
"""
import pathlib
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
RESET_CSS = FE / "src/frontHome/main.css"

# 与 Article.tsx 同形的标记（不挂 React：本套件量的是类名与结构决定的布局，
# 图标就是那三段 path，尺寸由 width/height 属性定）。
# 三个数的值取 12 / 3 / 1 —— 个位数与两位数都在场，能看出定宽有没有起作用。
ICONS = {
    "views": '<svg aria-hidden="true" viewBox="0 0 24 24" width="13" height="13" fill="none" '
             'stroke="currentColor" stroke-width="1.8"><path d="M1.8 12S5.6 5.5 12 5.5 22.2 12 22.2 12 '
             '18.4 18.5 12 18.5 1.8 12 1.8 12z"/><circle cx="12" cy="12" r="3.1"/></svg>',
    "likes": '<svg aria-hidden="true" viewBox="0 0 24 24" width="13" height="13" fill="currentColor">'
             '<path d="M12 20.8 4.1 12.9a5.2 5.2 0 0 1 0-7.3 5.2 5.2 0 0 1 7.3 0l.6.6.6-.6a5.2 5.2 0 0 1 '
             '7.3 0 5.2 5.2 0 0 1 0 7.3z"/></svg>',
    "favorites": '<svg aria-hidden="true" viewBox="0 0 24 24" width="13" height="13" fill="currentColor">'
                 '<path d="M12 2.6l2.9 5.9 6.5.9-4.7 4.6 1.1 6.5-5.8-3.1-5.8 3.1 1.1-6.5L2.6 9.4l6.5-.9z"/></svg>',
}
STATS = ('<div class="ArticleStats" id="stats">'
         + "".join(f'<span class="ArticleStat" title="{label}">{ICONS[k]}'
                   f'<span class="ArticleStatNum">{v}</span></span>'
                   for k, label, v in (("views", "阅读量", 12),
                                       ("likes", "点赞数", 3),
                                       ("favorites", "收藏数", 1)))
         + "</div>")

LONG_TITLE = "从零把站内对话助手接进个人博客：规划器、执行器与质检闸的完整记录（下篇）"
LONG_DESC = "这一段是摘要，按最坏情况写满三行：讲的是为什么把执行器做成确定性的、为什么叙述者不绑工具、" \
            "以及验收为什么必须由回执驱动而不是由模型自述，最后附带一串踩坑清单与回归锁的清单与取舍。"

# 卡片宽度按桌面三列（1280 视口 · 80% 容器 / 3 列 ≈ 341px）复现；
# `stats=""` 的那份就是"没有读数"的对照卡，两份除读数外**逐字节相同**。
# `.ContentContainer` 这层不能省：整套卡片规则都挂在
# `.ContentContainer .allArticles .ArticleCard …` 这条链下（选择器链在 sass 里，缺一层就整套失效，
# 量出来全是 0 —— 那不是"布局坏了"，是沙箱没接上）。所以下面第 ⓪ 组先自检"规则真的生效了"。
MARKUP = """
<div class="ContentContainer" id="cc">
<div class="allArticles" style="width:341px;grid-template-columns:repeat(1,1fr)">
  <div class="article">
    <div class="ArticleCard" id="card">
      <div class="ArticleCover" id="cover"></div>
      <div class="ArticleContent" id="content">
        <div class="ArticleHead" id="head">
          <h4 id="cat" style="color:#5a8fbf"># 编程随笔</h4>
          {stats}
        </div>
        <h3 class="ArticleTitle" id="title">{title}</h3>
        <p class="ArticleDescription" id="desc">{desc}</p>
        <div style="width:100%;margin-top:auto;flex-shrink:0">
          <div class="tags" style="width:100%;margin-top:10px"></div>
          <div class="ArticleFooter" id="footer" style="display:flex;align-items:center;paddingBottom:20px;marginTop:10px">
            <span style="font-weight:bold">Sora</span>
            <span class="post-date" style="margin-left:10px">发布于 2026-09-30</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</div>
</div>
"""


def build_sandbox() -> pathlib.Path:
    sb = pathlib.Path(tempfile.mkdtemp(prefix="cardstats-"))
    r = subprocess.run(["node", "-e", SASS_JS, str(SASS_FILE)], cwd=str(FE), capture_output=True)
    if r.returncode != 0:
        raise SystemExit("sass 编译失败：\n" + r.stderr.decode("utf-8", "replace"))
    (sb / "home.css").write_text(r.stdout.decode("utf-8"), encoding="utf-8")
    shutil.copy(RESET_CSS, sb / "main.css")
    (sb / "index.html").write_text(
        '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">'
        '<link rel="stylesheet" href="main.css"><link rel="stylesheet" href="home.css">'
        '</head><body><div id="root"></div></body></html>',
        encoding="utf-8")
    return sb


SANDBOX = build_sandbox()
URL = SANDBOX.as_uri() + "/index.html"

from playwright.sync_api import sync_playwright  # noqa: E402

PAINT = """(o) => {
  document.getElementById('root').innerHTML = o.markup;
  const box = (id) => {
    const el = document.getElementById(id);
    return el ? el.getBoundingClientRect() : null;
  };
  const r = (id) => { const b = box(id); return b ? {top:Math.round(b.top),bottom:Math.round(b.bottom),
    left:Math.round(b.left),right:Math.round(b.right),w:Math.round(b.width),h:Math.round(b.height)} : null; };
  const content = document.getElementById('content');
  const stats = document.getElementById('stats');
  const cells = stats ? [...stats.querySelectorAll('.ArticleStat')] : [];
  const svg0 = cells.length ? cells[0].querySelector('svg') : null;
  const cs = stats ? getComputedStyle(stats) : null;
  const cardCs = getComputedStyle(document.getElementById('card'));
  // 对比度：读数色 vs 卡片底色（卡底色取 --pic-background-cover 的计算值）
  const parse = (c) => (c.match(/[\\d.]+/g) || []).slice(0,3).map(Number);
  const lum = (rgb) => { const f = rgb.map((v) => { v/=255; return v<=0.03928? v/12.92 : Math.pow((v+0.055)/1.055,2.4); });
    return 0.2126*f[0]+0.7152*f[1]+0.0722*f[2]; };
  const cardBg = parse(cardCs.backgroundColor === 'rgba(0, 0, 0, 0)' ? 'rgb(255,255,255)' : cardCs.backgroundColor);
  const ratio = cs ? (() => { const a = lum(parse(cs.color)), b = lum(cardBg);
    const [hi, lo] = a > b ? [a, b] : [b, a]; return Math.round(((hi+0.05)/(lo+0.05))*100)/100; })() : 0;
  return {
    cover: r('cover'), head: r('head'), cat: r('cat'), stats: r('stats'), footer: r('footer'),
    title: r('title'), content: r('content'), card: r('card'),
    cellCount: cells.length,
    cellTexts: cells.map((c) => c.querySelector('.ArticleStatNum').textContent),
    svgSize: svg0 ? {w: svg0.getBoundingClientRect().width, h: svg0.getBoundingClientRect().height} : null,
    statsColor: cs ? cs.color : null,
    statsDisplay: cs ? cs.display : null,
    statsContrast: ratio,
    contentOverflow: content.scrollHeight - content.clientHeight,
    cardOverflow: document.getElementById('card').scrollHeight - document.getElementById('card').clientHeight,
    catFullText: document.getElementById('cat').textContent,
    catClipped: (() => { const el = document.getElementById('cat'); return el.scrollWidth > el.clientWidth + 1; })(),
    pageOverflow: document.documentElement.scrollWidth > window.innerWidth,
  };
}"""

with sync_playwright() as p:
    br = p.chromium.launch()
    pg = br.new_page(viewport={"width": 1280, "height": 900})
    errs: list[str] = []
    pg.on("pageerror", lambda e: errs.append(str(e)))
    pg.goto(URL)
    pg.wait_for_timeout(150)

    long_mk = MARKUP.format(stats=STATS, title=LONG_TITLE, desc=LONG_DESC)
    bare_mk = MARKUP.format(stats="", title=LONG_TITLE, desc=LONG_DESC)

    print("⓪ 沙箱自检：卡片规则真的生效了（否则下面全是 0 与 0 比，怎么比都过）")
    on = pg.evaluate(PAINT, {"markup": long_mk})
    check("封面图有高度（.ArticleCover 的规则生效）", on["cover"]["h"] > 100,
          f"cover h={on['cover']['h']}")
    check("分类标题有高度（说明选择了这条选择器链）", on["cat"]["h"] > 0, f"cat h={on['cat']['h']}")
    check("读数块有宽度（不是塌成 0 的空盒子）", on["stats"]["w"] > 0, f"stats w={on['stats']['w']}")
    check("读数块取了 flex（sass 里的 display 生效）", on["statsDisplay"] == "flex",
          str(on["statsDisplay"]))
    check("卡片定高 600px（桌面档）", abs(on["card"]["h"] - 600) < 1, f"card h={on['card']['h']}")

    print("① 位置：在封面图下方那一行，且在分类标题右侧")
    check("读数确实在封面图下方（top ≥ 图底）",
          on["stats"] and on["stats"]["top"] >= on["cover"]["bottom"],
          f"stats.top {on['stats'] and on['stats']['top']} / cover.bottom {on['cover']['bottom']}")
    check("读数与分类标题**同一行**（上下差 < 一个行高）",
          on["stats"] and on["cat"] and abs(on["stats"]["top"] - on["cat"]["top"]) < 24,
          f"stats.top {on['stats'] and on['stats']['top']} / cat.top {on['cat']['top']}")
    check("读数在分类标题右侧（left 更大）",
          on["stats"] and on["cat"] and on["stats"]["left"] > on["cat"]["left"],
          f"stats.left {on['stats'] and on['stats']['left']} / cat.left {on['cat']['left']}")
    check("那一行是内容区第一行（head.top == content.top + padding）",
          on["head"]["top"] > on["cover"]["bottom"],
          f"head.top {on['head']['top']} / cover.bottom {on['cover']['bottom']}")

    print("② ★ 零高度成本：有/无读数，页脚位置一个像素都不变")
    off = pg.evaluate(PAINT, {"markup": bare_mk})
    check("页脚 offsetTop 完全一致（读数没占高度）",
          abs(on["footer"]["top"] - off["footer"]["top"]) < 0.5,
          f"有读数 {on['footer']['top']} / 无读数 {off['footer']['top']}")
    check("  分类标题位置也没变",
          abs(on["cat"]["top"] - off["cat"]["top"]) < 0.5,
          f"有 {on['cat']['top']} / 无 {off['cat']['top']}")
    check("  对照卡里确实没有读数（否则上面两条是空断言）",
          off["stats"] is None and on["stats"] is not None, f"{off['stats']} / {on['stats']}")

    print("③ 预算没被撑破（3 行标题 + 3 行摘要的最坏情况）")
    check("内容区不溢出（scrollHeight ≤ clientHeight + 1）",
          on["contentOverflow"] <= 1, f"溢出 {on['contentOverflow']}px")
    check("卡片整体不溢出（定高 600 的卡没被撑破）",
          on["cardOverflow"] <= 1, f"溢出 {on['cardOverflow']}px（卡高 {on['card']['h']}）")
    check("页脚贴着内容区底（margin-top:auto 仍生效）",
          on["content"]["bottom"] - on["footer"]["bottom"] < 40,
          f"content.bottom {on['content']['bottom']} / footer.bottom {on['footer']['bottom']}")

    print("④ 夜间：取主题变量（不是写死的灰），对比度 ≥ 3:1")
    pg.evaluate("() => document.documentElement.classList.add('frontDark')")
    dark = pg.evaluate(PAINT, {"markup": long_mk})
    check("夜间读数色 = --font-p-color 的夜间值 rgb(204, 204, 204)",
          dark["statsColor"] == "rgb(204, 204, 204)", str(dark["statsColor"]))
    check(f"与卡片底色的对比度 ≥ 3:1", dark["statsContrast"] >= 3.0,
          f"{dark['statsContrast']}:1（底 {dark['card'] and 'dark card'}）")
    pg.evaluate("() => document.documentElement.classList.remove('frontDark')")

    print("⑤ 窄屏 327px：容不下时读数整块换行，分类名不被截断")
    pg.set_viewport_size({"width": 327, "height": 800})
    narrow = pg.evaluate(PAINT, {"markup": long_mk})
    check("分类名完整（没被 ellipsis 截掉）",
          not narrow["catClipped"] and narrow["catFullText"] == "# 编程随笔",
          f"clipped={narrow['catClipped']} text={narrow['catFullText']!r}")
    check("三个数都还在（换行不是隐藏）", narrow["cellCount"] == 3, str(narrow["cellCount"]))
    check("读数仍在封面图下方", narrow["stats"]["top"] >= narrow["cover"]["bottom"],
          f"stats.top {narrow['stats']['top']} / cover.bottom {narrow['cover']['bottom']}")
    check("页面不出现横向滚动", not narrow["pageOverflow"])
    pg.set_viewport_size({"width": 1280, "height": 900})

    print("⑥ 三个数：顺序、数值、图标尺寸")
    check("顺序恒为 阅读 → 点赞 → 收藏", on["cellTexts"] == ["12", "3", "1"], str(on["cellTexts"]))
    check("图标是 svg 且 13×13",
          on["svgSize"] and abs(on["svgSize"]["w"] - 13) < 0.6 and abs(on["svgSize"]["h"] - 13) < 0.6,
          str(on["svgSize"]))
    check("三个格子都有 title（悬停说明：阅读量/点赞数/收藏数）",
          pg.evaluate("() => [...document.querySelectorAll('.ArticleStat')].map(e => e.title)")
          == ["阅读量", "点赞数", "收藏数"],
          str(pg.evaluate("() => [...document.querySelectorAll('.ArticleStat')].map(e => e.title)")))

    check("无 JS 运行时报错", not errs, "; ".join(errs[:2]))
    br.close()

shutil.rmtree(SANDBOX, ignore_errors=True)
print(f"\n{'✗' if FAIL else '✓'} article-card-stats：{PASS} 通过 / {FAIL} 失败")
raise SystemExit(1 if FAIL else 0)
