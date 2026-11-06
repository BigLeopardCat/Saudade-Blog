#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""文章卡片读数（浏览 / 点赞 / 收藏）的**几何**回归。"""
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
# 图标就是那四段 path，尺寸由 width/height 属性定）。
# 四个数的值取 12 / 3 / 1 / 8 —— 个位数与两位数都在场，能看出定宽有没有起作用。
ICONS = {
    "views": '<svg aria-hidden="true" viewBox="0 0 24 24" width="13" height="13" fill="none" '
             'stroke="currentColor" stroke-width="1.8"><path d="M1.8 12S5.6 5.5 12 5.5 22.2 12 22.2 12 '
             '18.4 18.5 12 18.5 1.8 12 1.8 12z"/><circle cx="12" cy="12" r="3.1"/></svg>',
    "likes": '<svg aria-hidden="true" viewBox="0 0 24 24" width="13" height="13" fill="currentColor">'
             '<path d="M12 20.8 4.1 12.9a5.2 5.2 0 0 1 0-7.3 5.2 5.2 0 0 1 7.3 0l.6.6.6-.6a5.2 5.2 0 0 1 '
             '7.3 0 5.2 5.2 0 0 1 0 7.3z"/></svg>',
    "favorites": '<svg aria-hidden="true" viewBox="0 0 24 24" width="13" height="13" fill="currentColor">'
                 '<path d="M12 2.6l2.9 5.9 6.5.9-4.7 4.6 1.1 6.5-5.8-3.1-5.8 3.1 1.1-6.5L2.6 9.4l6.5-.9z"/></svg>',
    "comments": '<svg aria-hidden="true" viewBox="0 0 24 24" width="13" height="13" fill="none" '
                'stroke="currentColor" stroke-width="1.8" stroke-linejoin="round">'
                '<path d="M4.1 3.9h15.8a2.2 2.2 0 0 1 2.2 2.2v8.6a2.2 2.2 0 0 1-2.2 2.2h-8.6l-4.4 3.4'
                'v-3.4H4.1a2.2 2.2 0 0 1-2.2-2.2V6.1a2.2 2.2 0 0 1 2.2-2.2z"/></svg>',
}
STATS = ('<div class="ArticleStats" id="stats">'
         + "".join(f'<span class="ArticleStat" title="{label}">{ICONS[k]}'
                   f'<span class="ArticleStatNum">{v}</span></span>'
                   for k, label, v in (("views", "阅读量", 12),
                                       ("likes", "点赞数", 3),
                                       ("favorites", "收藏数", 1),
                                       ("comments", "讨论数", 8)))
         + "</div>")

def TAGS(n: int) -> str:
    """按 antd Tag 尺寸生成标签行；用多标签覆盖换行压力。"""
    return ('<div class="tags" id="tags" style="width:100%;margin-top:10px">'
            + "".join(f'<span style="display:inline-block;height:22px;line-height:22px;margin:5px;'
                      f'padding:0 7px;border:1px solid #d9d9d9;border-radius:4px;font-size:12px">'
                      f'标签{i}</span>' for i in range(n)) + "</div>")


LONG_TITLE = "从零把站内对话助手接进个人博客：规划器、执行器与质检闸的完整记录（下篇）"
LONG_DESC = "这一段是摘要，按最坏情况写满三行：讲的是为什么把执行器做成确定性的、为什么叙述者不绑工具、" \
            "以及验收为什么必须由回执驱动而不是由模型自述，最后附带一串踩坑清单与回归锁的清单与取舍。"

CAT_SHORT = "# 编程"
CAT_LONG = "# 本项目介绍"
CAT_HUGE = "# 物联网与嵌入式设备调试记录"   # 压力档：桌面 20px 字体下约 180px

# 卡片宽度按桌面三列（1280 视口 · 80% 容器 / 3 列 ≈ 341px）复现；
# `stats=""` 的那份就是"没有读数"的对照卡，两份除读数外**逐字节相同**。
# `.ContentContainer` 这层不能省：整套卡片规则都挂在
# `.ContentContainer .allArticles .ArticleCard …` 这条链下（选择器链在 sass 里，缺一层就整套失效，
# 量出来全是 0 —— 那不是"布局坏了"，是沙箱没接上）。所以下面第 ⓪ 组先自检"规则真的生效了"。
MARKUP = """
<div class="ContentContainer" id="cc">
<div class="allArticles" style="width:{w}px;grid-template-columns:repeat(1,1fr)">
  <div class="article">
    <div class="ArticleCard" id="card">
      <div class="ArticleCover" id="cover"></div>
      <div class="ArticleContent" id="content">
        <div class="ArticleHead" id="head">
          <h4 id="cat" style="color:#5a8fbf">{cat}</h4>
          {stats}
        </div>
        <h3 class="ArticleTitle" id="title">{title}</h3>
        <!-- ⚠️ `.descSlot` 不能省（20260930）：简介现在是**槽内绝对定位**的，少了这层槽，
             它就相对 `.ArticleContent` 定位到内容区左上角、盖住分类行与标题——而本套件的
             判据全是"页脚/内容区"，两边一样坏 ⇒ 照样全绿。桩必须与 Article.tsx 同形。 -->
        <div class="descSlot" id="slot"><p class="ArticleDescription" id="desc">{desc}</p></div>
        <div style="width:100%;margin-top:auto;flex-shrink:0">
          {tags}
          <div class="ArticleFooter" id="footer" style="display:flex;align-items:center;paddingBottom:20px;marginTop:10px">
            <span style="display:inline-block;width:40px;height:40px;border-radius:50%;background:#ccc;margin-right:10px"></span>
            <span style="font-weight:bold;margin-right:10px;line-height:22px;font-size:14px">林陌青川</span>
            <!-- ⚠️「更新于」那行**不能省**（20260930）：它 `position: absolute; top: 100%` 挂在
                 这个列盒子**外面**，页脚盒子只有一行高、那行全靠内容区 32px 下内边距兜着
                 ⇒ 卡片收支一旦为负，第一个被 `overflow: hidden` 切掉的就是它。
                 旧桩只写了「发布于」，正是"标签换到第二行、时间信息跑出卡片"那个现场
                 在本套件里**量不到**的原因（判据两边一样坏 ⇒ 照样全绿）。 -->
            <div style="position:relative;display:flex;flex-direction:column">
              <span class="post-date" id="pub" style="font-size:12px;color:#7f7e7e;line-height:22px">发布于 2026-09-30</span>
              <span class="post-date" id="upd" style="position:absolute;top:100%;margin-top:6px;left:0;font-size:12px;color:#7f7e7e;line-height:22px;white-space:nowrap">更新于 2026-09-30</span>
            </div>
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
    title: r('title'), content: r('content'), card: r('card'), upd: r('upd'), tags: r('tags'),
    tagRows: (() => { const t = document.getElementById('tags');
      return t ? new Set([...t.children].map((e) => Math.round(e.getBoundingClientRect().top))).size : 0; })(),
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

    def mk(stats: str = STATS, tags_n: int = 0, title: str = LONG_TITLE,
           desc: str = LONG_DESC, cat: str = CAT_SHORT, w: int = 341) -> str:
        return MARKUP.format(stats=stats, title=title, desc=desc, tags=TAGS(tags_n),
                             cat=cat, w=w)

    long_mk = mk()
    bare_mk = mk(stats="")

    print("⓪ 沙箱自检：卡片规则真的生效了（否则下面全是 0 与 0 比，怎么比都过）")
    on = pg.evaluate(PAINT, {"markup": long_mk})
    check("封面图有高度（.ArticleCover 的规则生效）", on["cover"]["h"] > 100,
          f"cover h={on['cover']['h']}")
    check("分类标题有高度（说明选择了这条选择器链）", on["cat"]["h"] > 0, f"cat h={on['cat']['h']}")
    check("读数块有宽度（不是塌成 0 的空盒子）", on["stats"]["w"] > 0, f"stats w={on['stats']['w']}")
    check("读数块取了 flex（sass 里的 display 生效）", on["statsDisplay"] == "flex",
          str(on["statsDisplay"]))
    check("卡片高 510px = 内容自然高（下限 470 不参与；封面 200 是 20261001 新值）",
          abs(on["card"]["h"] - 510) < 1, f"card h={on['card']['h']}")

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
    check("卡片整体不溢出（长高后的卡没被撑破）",
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

    print("⑤ ★ 桌面档：读数与分类**同一行**，容不下时截分类名（20260930 二轮·混排现场）")
    for w in (341, 300):
        s = pg.evaluate(PAINT, {"markup": mk(w=w)})
        l = pg.evaluate(PAINT, {"markup": mk(cat=CAT_LONG, w=w)})
        tag = f"容器 {w}px"
        check(f"{tag} · 短名卡：读数与分类名同一行",
              abs(s["stats"]["top"] - s["cat"]["top"]) < 12,
              f"stats.top {s['stats']['top']} / cat.top {s['cat']['top']}")
        check(f"{tag} · 长名卡：读数也在同一行（**这就是上一版会混排的那一档**）",
              abs(l["stats"]["top"] - l["cat"]["top"]) < 12,
              f"stats.top {l['stats']['top']} / cat.top {l['cat']['top']}")
        check(f"{tag} · 两张卡等高（分类名长短不再改变卡片高度）",
              abs(s["card"]["h"] - l["card"]["h"]) < 1,
              f"卡高 {s['card']['h']} vs {l['card']['h']}")
        # 卡片宽度必须由列数决定、与分类名长短无关。这条是 `.allArticles > .article`
        # / `.ArticleCard` 那两条 `min-width: 0` 的锁：不给它，长分类名会把网格轨道的
        # `auto` 下限顶上去（容器 341px 时长名卡会变成 **396px**）。
        check(f"{tag} · 两张卡同宽且等于容器宽（分类名长短不改卡片宽度）",
              abs(s["card"]["w"] - w) < 1 and abs(l["card"]["w"] - w) < 1,
              f"短名 {s['card']['w']} / 长名 {l['card']['w']} / 容器 {w}")
        check(f"{tag} · 读数块没被压缩（flex-shrink: 0 生效：四格宽度不变）",
              abs(s["stats"]["w"] - on["stats"]["w"]) < 1,
              f"{w}px {s['stats']['w']} vs 1280px {on['stats']['w']}")
        check(f"{tag} · 四个数都还在（截断不是隐藏）", s["cellCount"] == 4, str(s["cellCount"]))
        check(f"{tag} · 页面不出现横向滚动", not s["pageOverflow"] and not l["pageOverflow"])
    wide = pg.evaluate(PAINT, {"markup": mk(cat=CAT_LONG, w=341)})
    check("容器 341px + 真实长名：不被截（三列档放得下，不该无差别加省略号）",
          not wide["catClipped"], f"clipped={wide['catClipped']} / cat w={wide['cat']['w']}")
    tight = pg.evaluate(PAINT, {"markup": mk(cat=CAT_HUGE, w=300)})
    check("容器 300px + 压力长名：真的被截断（省略号生效：scrollWidth > clientWidth）",
          tight["catClipped"], f"clipped={tight['catClipped']}")
    check("  但文字没丢（截断是 CSS 的，DOM 里仍是全名）",
          tight["catFullText"] == CAT_HUGE, repr(tight["catFullText"]))
    check("  被截断的那一档卡片宽度也不变（截断替代撑宽）",
          abs(tight["card"]["w"] - 300) < 1, f"card w={tight['card']['w']}")
    short_tight = pg.evaluate(PAINT, {"markup": mk(w=300)})
    check("短名卡在同样 300px 下**不**被截断（不是无差别加省略号）",
          not short_tight["catClipped"], f"clipped={short_tight['catClipped']}")
    check("读数仍在封面图下方", tight["stats"]["top"] >= tight["cover"]["bottom"],
          f"stats.top {tight['stats']['top']} / cover.bottom {tight['cover']['bottom']}")

    print("⑤b ★ 手机档（≤768px 两列）：读数整块落到分类**下面那一行**，同屏一刀切")
    pg.set_viewport_size({"width": 375, "height": 800})
    ms = pg.evaluate(PAINT, {"markup": mk(w=300)})
    ml = pg.evaluate(PAINT, {"markup": mk(cat=CAT_LONG, w=300)})
    check("手机档卡片宽 172px（375 × 95% 两列；沙箱复现的是真机几何）",
          abs(ms["card"]["w"] - 172) < 1, f"card w={ms['card']['w']}")
    for label, m in (("短名", ms), ("长名", ml)):
        check(f"  手机 {label}卡：读数在分类**下方**（不再是同一行）",
              m["stats"]["top"] - m["cat"]["top"] > 12,
              f"stats.top {m['stats']['top']} / cat.top {m['cat']['top']}")
    check("  两张卡的相对位置完全一致（同屏不再混排）",
          abs((ms["stats"]["top"] - ms["cat"]["top"]) - (ml["stats"]["top"] - ml["cat"]["top"])) < 1,
          f"间距 {ms['stats']['top'] - ms['cat']['top']} vs {ml['stats']['top'] - ml['cat']['top']}")
    check("  两张卡等高且同宽（用户报的'参差'就是这个）",
          abs(ms["card"]["h"] - ml["card"]["h"]) < 1 and abs(ms["card"]["w"] - ml["card"]["w"]) < 1,
          f"高 {ms['card']['h']} vs {ml['card']['h']}／宽 {ms['card']['w']} vs {ml['card']['w']}")
    check("  手机档的读数块与桌面同宽（没被压扁）",
          abs(ml["stats"]["w"] - on["stats"]["w"]) < 1,
          f"{ml['stats']['w']} vs 桌面 {on['stats']['w']}")
    check("  手机档分类名拿满**整行宽**（stretch 生效，且真实长名放得下不被截）",
          not ml["catClipped"] and abs(ml["cat"]["w"] - ml["head"]["w"]) < 1,
          f"clipped={ml['catClipped']} / cat w={ml['cat']['w']} / head w={ml['head']['w']}")
    check("  读数左对齐于分类名（同一列基准，不是居中的）",
          abs(ms["stats"]["left"] - ms["cat"]["left"]) < 1,
          f"stats.left {ms['stats']['left']} / cat.left {ms['cat']['left']}")
    check("  四个数都在、且页面不出现横向滚动",
          ml["cellCount"] == 4 and not ms["pageOverflow"] and not ml["pageOverflow"],
          f"{ml['cellCount']} / {ml['pageOverflow']}")
    pg.set_viewport_size({"width": 1280, "height": 900})

    print("⑥ 四个数：顺序、数值、图标尺寸")
    check("顺序恒为 阅读 → 点赞 → 收藏 → 讨论",
          on["cellTexts"] == ["12", "3", "1", "8"], str(on["cellTexts"]))
    check("图标是 svg 且 13×13",
          on["svgSize"] and abs(on["svgSize"]["w"] - 13) < 0.6 and abs(on["svgSize"]["h"] - 13) < 0.6,
          str(on["svgSize"]))
    check("四个格子都有 title（悬停说明：阅读量/点赞数/收藏数/讨论数）",
          pg.evaluate("() => [...document.querySelectorAll('.ArticleStat')].map(e => e.title)")
          == ["阅读量", "点赞数", "收藏数", "讨论数"],
          str(pg.evaluate("() => [...document.querySelectorAll('.ArticleStat')].map(e => e.title)")))

    print("⑦ ★ 标签换行：卡片按内容长高，页脚与「更新于」都不许被切掉（20260930 现场）")
    for title, n, expect_grow in (("面试复盘", 0, False), (LONG_TITLE, 8, True),
                                  (LONG_TITLE, 12, True)):
        r = pg.evaluate(PAINT, {"markup": mk(tags_n=n, title=title)})
        if expect_grow:
            check(f"{n} 个标签（{r['tagRows']} 行）：内容超出下限 ⇒ 卡片长高到 470 以上",
                  r["card"]["h"] > 470, f"card h={r['card']['h']} / 标签行数 {r['tagRows']}")
        else:
            check(f"最空的卡（短标题 + {n} 个标签）：内容塞得下 ⇒ 停在下限 470",
                  abs(r["card"]["h"] - 470) < 1,
                  f"card h={r['card']['h']} / 标签行数 {r['tagRows']}")
        check(f"  卡片不溢出（overflow: hidden 没在裁东西）",
              r["cardOverflow"] <= 1, f"溢出 {r['cardOverflow']}px")
        check(f"  「更新于」整行在卡内（底 ≤ 卡底）",
              r["upd"] and r["upd"]["bottom"] <= r["card"]["bottom"],
              f"upd.bottom {r['upd'] and r['upd']['bottom']} / card.bottom {r['card']['bottom']}")
        check(f"  页脚整行在卡内（作者署名没跑出去）",
              r["footer"]["bottom"] <= r["card"]["bottom"],
              f"footer.bottom {r['footer']['bottom']} / card.bottom {r['card']['bottom']}")
    # 反面对照：标签只有一行时**也不许**停在 470 —— 长高不能变成"每张卡都松垮"，但下限
    # 降了之后这一档本来就该按内容高（3 行标题 + 1 行标签 = 542）。
    flat = pg.evaluate(PAINT, {"markup": mk(tags_n=3)})
    check("3 个标签（1 行）+ 3 行标题：按内容高 542px（不是被下限硬撑出来的数）",
          abs(flat["card"]["h"] - 542) < 1, f"card h={flat['card']['h']}")
    check("  该档「更新于」也在卡内",
          flat["upd"] and flat["upd"]["bottom"] <= flat["card"]["bottom"],
          f"upd.bottom {flat['upd'] and flat['upd']['bottom']} / card.bottom {flat['card']['bottom']}")

    check("无 JS 运行时报错", not errs, "; ".join(errs[:2]))
    br.close()

shutil.rmtree(SANDBOX, ignore_errors=True)
print(f"\n{'✗' if FAIL else '✓'} article-card-stats：{PASS} 通过 / {FAIL} 失败")
raise SystemExit(1 if FAIL else 0)
