#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""文章卡片：分类行↔封面空隙 + 页脚钉底 + 悬浮展开简介（20260930）。

  python3 tests/article-card-hover.test.py

现场（用户原话，三问一次报上来）：
  1. "把分类行和卡片的封面之间空隙缩小，确保卡片底部的作者署名头像和发布修改时间信息
     位置定死在卡牌底部不动"；
  2. "鼠标悬浮展开简介有问题，展开后最后一行只显示上半部分，还有如果卡片的简介滚动过
     离开后简介展示行没有回到头部"；
  3. "鼠标悬浮于置顶卡片标题和简介会抖动布局改掉，置顶卡片也没悬浮简介上方展开简介"。

四个症状的根因都是量出来的（改前/改中的探针实测），不是"看上去像"：
  · 展开高度落在半行上（两个来源）：
    ① `.ArticleContent` 是**定高 flex 列**，简介一带 `min-height: 0` 就被 flex 压成任意像素
       ——实测压出过 250px（12.5 行）与 85px（4.25 行）⇒ 最后一行只露上半；
    ② 文件末尾那条**裸写的** `.ArticleDescription:hover` 里的 `padding-bottom: 10px` 一直在
       生效（它的 max-height/overflow 被嵌套规则压掉了，但 padding 谁也没声明过）⇒ 展开盒
       高 = 内容 + 10，而 `box-sizing: border-box` 让 max-height 把 padding 也算进去 ⇒
       上限 200px 里只剩 190px 给正文 = 9.5 行，第 10 行照样切一半。这条是本套件**量出来的**
       （读数里 `padding-bottom` 非 0 才回头找到的），已连同那条裸规则一起删掉；
  · 页脚跑出卡片：同一个溢出把内容区撑到 532px（卡只有 600px）⇒ 页脚底 813 > 卡底 689
    ⇒ 被 `.ArticleCard{overflow:hidden}` 裁掉；
  · 滚位不回头：`overflow: hidden` 的盒子**同样是滚动容器**（静置态下 scrollHeight 就是
    全文高度）⇒ 悬浮展开滚下去再移开，静置态显示的是全文**中段**。CSS 里没有"回到顶部"
    这件事，只有 `utils/descHover.ts` 抹滚位；
  · 顶卡抖动：内容列是 `justify-content: center`，只要总占位变了整块就重新居中 ⇒
    标题/简介 `:hover` 的一点点高度变化都让全列上下窜。

两张卡现在**共用同一套"定高槽"**（20260930 定稿）：简介住在 `.descSlot`（桌面 60px）里、
**槽内绝对定位**，于是它长高/缩回**根本不参与布局** ⇒ 这个盒子占位恒等于静置态 ⇒ 页脚不可能
动、垂直居中的列不可能重新居中；高度只能取 `max-height`（行高整数倍）或全文自身高度 ⇒ 下沿不
可能落在半行上。两条都是**结构性**的，与"卡片还剩多少余量"无关（旧写法靠余量，余量随标题行数/
标签行数浮动）。

诚实备注（走过的弯路，别改回去）：中间试过"就地长高 + 等量负 margin 抵掉"。它只在简介**刚好
长到上限**时成立——负 margin 是定值、而高度是 `min(全文, 上限)`，两者不等时占位就变了
（实测简介 5 行时页脚被抽上去 100px）；而且它要求 `margin-bottom` 与 `max-height` 同步过渡，
不同步时中途占位是负的、垂直居中的列会整块窜（探针实测 90px 位移）。第 ④′ 组就是钉这条的。

本套件量的是**布局真相**，所以一律用 `offsetTop/offsetHeight`（不受 CSS transform 影响）
而不是 `getBoundingClientRect`——普通卡有 `&:hover { transform: scale(1.03) }`，用 rect
比"静置 vs 悬浮"会把那 3% 的缩放读成"页脚移动了"。

悬浮一律不用 `pg.hover()`：Playwright 要求元素"位置/尺寸稳定"才敢下手，而展开动画有 0.8s，
它会一直重试到超时（实测卡死 60+ 次）。本套件自己移坐标 + 轮询到布局稳定（见 `hover_stable`）。

20260930 增补（用户第四报："在文章标签变成两行时，作者信息时间信息在卡片的位置还是没锁死，
跑出卡片了"）：普通卡从 `height: 600px` 改成 `min-height`（**下限**，20260930 二轮由 600 降
到 520）+ 网格项 `display: flex`（同排拉伸等高），内容多就长高。两条相关纪律：
  · 桩里必须补上「更新于」那行——它 `position: absolute` 挂在页脚盒子**外面**，是溢出时
    第一个被切的东西；旧桩只写「发布于」⇒ 这条缺陷在本套件里量不到（判据两边一样坏）。
  · 移动档撤下限要写 `min-height: 0 !important`：`height: auto !important` 管不到 `min-height`
    （两个是不同的属性，同族的坑）。判据写"矮于 520"而不是"≠ 520"。
置顶卡**仍是定高**（轮播：按内容长高会让各 slide 参差），它的余量够大（10 个标签两行
时仍余 111px，探针实测），不需要长高。20261004 这个定高由 640 收到 **460**（用户第九报
「轮播图占一行是不是太长了不协调」：首屏是一整屏的 hero，紧跟的顶卡再吃掉 640px，
比下面每一行文章卡（430–510）都重）。连带收到 200px 的还有它简介浮层的展开上限
（第 ⑦ 组「浮层没跑出卡片」是这条例外的探针）。

20260930 二轮（用户第五报："卡片比例有点不好看，重新调整卡片样式"）：封面 200 → 240、
下限 600 → 520、普通卡简介展开上限 200 → **140**。三个数是**联动的**——简介浮层是绝对定位、
向下长，卡片不跟着长高 ⇒ 它的可用高度 = 卡底 − 浮层顶，封面每加高 1px 就直接吃掉 1px。
第 ⑫ 组把这条锁死：逐个内容形状量「卡底 − 浮层顶」，最小的那个（3 行标题 + 无标签 = 150px）
决定展开上限。别只改其中一个数就交。

20261004（用户第九报「一页的信息量太少」）：封面 200 → **160**、下限 470 → **430**，
**成对**改。这是上面那条联动的另一面：两个数同向移动时卡底与浮层顶**相减抵消** ⇒
⑫ 组那张可用高度表（150/170/182/214/246）**一列都没变**，变的只有卡的绝对高
（470/430/502/534/566，见 ⑫ 组实测）。谁将来只改其中一个数，⑫ 组就会红——
那正是它存在的意义。

判据分两半（诚实备注）：
  · 这里量几何（真 sass + 真 Chromium + 真事件）；
  · `article-card-hover.test.mjs` 锁源码接线——**React 的 `onMouseLeave` 挂在哪个元素上、
    有没有被人删掉**，无头沙箱里没有 React，测不到。本套件用真实原生的 mouseleave 调
    **esbuild 打出来的真 `descHover.ts`**，验的是"这个函数在真事件下确实把滚位抹回 0"。
"""
import pathlib
import shutil
import subprocess
import tempfile
import time

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
DESC_HOVER = FE / "src/utils/descHover.ts"

LONG_TITLE = "从零把站内对话助手接进个人博客：规划器、执行器与质检闸的完整记录（下篇）"
LONG_DESC = "这一段是摘要，按最坏情况写满：讲的是为什么把执行器做成确定性的、为什么叙述者不绑工具、" \
            "以及验收为什么必须由回执驱动而不是由模型自述；再补上跨轮执行记忆为什么必须落库、" \
            "而不是留在叙述文本里，最后是踩坑清单与取舍说明。"
# 要验"滚过之后回顶部"就必须让全文**真的比展开态高**：普通卡展开上限 140px（7 行），
# 所以这里给十几行往上。
HUGE_DESC = LONG_DESC * 5
# ⚠️ `LONG_DESC` 本身刻意**够不到展开上限**（实测展开 100px = 5 行，上限 140px）——第 ③ 组
# 就是拿它当"中等长度"用的：上限那一档由 HUGE_DESC 覆盖（第 ④ 组）。两档都要有，
# 因为"负 margin"那套方案只在**刚好长到上限**时才成立（负 margin 定值 vs 高度取 min）：
# 拿 LONG_DESC 去试就会看到页脚被抽上去 100px。别把这两个常量合并。

# 读数（浏览/点赞/收藏）那一行：与 Article.tsx 同形。它挂在分类行上、尺寸小于 h4，
# 所以那一行的高度仍由 h4 定（"零高度成本"那条归 article-card-stats 管）。
STATS = ('<div class="ArticleStats">'
         '<span class="ArticleStat" title="阅读量"><span class="ArticleStatNum">12</span></span>'
         '<span class="ArticleStat" title="点赞数"><span class="ArticleStatNum">3</span></span>'
         '<span class="ArticleStat" title="收藏数"><span class="ArticleStatNum">1</span></span>'
         '</div>')


def tags(n: int) -> str:
    """标签：antd Tag 的实测几何（height 22 / margin 5 / padding 0 7）。沙箱里没有 antd 的
    CSS，所以按它的尺寸手写。"""
    return '<div class="tags" id="tags" style="width:100%;margin-top:10px">' + "".join(
        f'<span style="display:inline-block;height:22px;line-height:22px;margin:5px;'
        f'padding:0 7px;border:1px solid #d9d9d9;border-radius:4px;font-size:12px">标签{i}</span>'
        for i in range(n)) + "</div>"


# 普通卡：与 Article.tsx 同形。`.ContentContainer .allArticles .ArticleCard …` 这条选择器链
# 一层都不能缺（缺一层整套规则失效、量出来全是 0——第 ⓪ 组就是防这个的自检）。
CARD_MARKUP = """
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
        <div class="descSlot" id="slot"><p class="ArticleDescription" id="desc">{desc}</p></div>
        <div style="width:100%;margin-top:auto;flex-shrink:0">
          {tags}
          <div class="ArticleFooter" id="footer" style="display:flex;align-items:center;paddingBottom:20px;marginTop:10px">
            <span style="display:inline-block;width:40px;height:40px;border-radius:50%;background:#ccc;margin-right:10px"></span>
            <span style="font-weight:bold;margin-right:10px;line-height:22px;font-size:14px">林陌青川</span>
            <!-- ⚠️「更新于」那行**不能省**（20260930）：`position: absolute; top: 100%` 把它挂在
                 这个列盒子**外面**，页脚盒子只有一行高 ⇒ 卡片一旦收支为负，被 `overflow: hidden`
                 切掉的第一个就是它。旧桩只写「发布于」，于是"标签换到第二行、时间信息跑出卡片"
                 这个现场在本套件里量不到（判据两边一样坏 ⇒ 照样全绿）。 -->
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

# 置顶卡：与 ContentHome/index.tsx 的 `.TopArticle` 同形（`display:flex` 是那边的内联样式，
# 会压掉 sass 里的 `display:grid`，所以这里也写成内联）。
TOP_MARKUP = """
<div class="ContentContainer" id="cc">
  <div class="TopArticle" id="card" style="display:flex;position:relative">
    <!-- 置顶贴纸（20261001 六轮）：`.Top` 只剩定位（`top` 写进 sass，内联的
         `translateY(-40%)` 已删），长相全在 `.TopTape` 那张胶带上。 -->
    <div class="Top"><span class="TopTape">置顶</span></div>
    <div style="width:100%;height:100%;border-radius:15px;overflow:hidden">
      <div style="display:flex;width:100%;height:100%">
        <div class="TopArticleInner" id="inner">
          <div class="TopCover" id="cover"></div>
          <div class="topContent" id="content">
            <h4 id="cat"># 编程随笔</h4>
            <h3 class="contentTitle" id="title">{title}</h3>
            <div class="descSlot" id="slot"><div class="ArticleDescription" id="desc">{desc}</div></div>
            {tags}
            <div class="topFooter" id="footer" style="display:flex;align-items:center;paddingBottom:20px">
              <span style="display:inline-block;width:40px;height:40px;border-radius:50%;background:#ccc;margin-right:10px"></span>
              <span style="font-weight:bold;margin-right:10px;line-height:22px;font-size:14px">林陌青川</span>
              <!-- 同普通卡：顶卡页脚里也挂着「更新于」那行（JSX 里两份是同形的，含那个钟表图标——
                   图标只影响行宽不影响行高，沙箱里没有 iconfont 就不放它）。 -->
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
    sb = pathlib.Path(tempfile.mkdtemp(prefix="cardhover-"))
    r = subprocess.run(["node", "-e", SASS_JS, str(SASS_FILE)], cwd=str(FE), capture_output=True)
    if r.returncode != 0:
        raise SystemExit("sass 编译失败：\n" + r.stderr.decode("utf-8", "replace"))
    (sb / "home.css").write_text(r.stdout.decode("utf-8"), encoding="utf-8")
    shutil.copy(RESET_CSS, sb / "main.css")

    # 真 `descHover.ts`（esbuild 打成 IIFE）。只拷这一个文件：它除了一个 type-only 的
    # `import type {MouseEvent} from "react"`（编译期被抹掉）没有任何依赖。
    (sb / "src" / "utils").mkdir(parents=True)
    shutil.copy(DESC_HOVER, sb / "src" / "utils" / "descHover.ts")
    (sb / "entry.ts").write_text(
        "import { resetDescScroll } from './src/utils/descHover';\n"
        "(window as any).__resetDescScroll = resetDescScroll;\n",
        encoding="utf-8")
    subprocess.run([str(FE / "node_modules/.bin/esbuild"), "entry.ts",
                    "--bundle", "--format=iife", "--outfile=bundle.js"],
                   cwd=str(sb), check=True, capture_output=True)

    (sb / "index.html").write_text(
        '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">'
        '<link rel="stylesheet" href="main.css"><link rel="stylesheet" href="home.css">'
        '</head><body><div id="root"></div><script src="bundle.js"></script></body></html>',
        encoding="utf-8")
    return sb


SANDBOX = build_sandbox()
URL = SANDBOX.as_uri() + "/index.html"

from playwright.sync_api import sync_playwright  # noqa: E402

# 静置态的测量。量的全是**布局坐标**（offsetTop/offsetHeight）：transform 不影响它们，
# 于是"静置 vs 悬浮"可以直接逐像素比，不会被卡片那 3% 的缩放骗到。
PAINT = """(o) => {
  document.getElementById('root').innerHTML = o.markup;
  const el = (id) => document.getElementById(id);
  const off = (id) => { const e = el(id); return e ? {top: e.offsetTop, h: e.offsetHeight} : null; };
  const rect = (id) => { const e = el(id); if (!e) return null;
    const b = e.getBoundingClientRect();
    return {top: Math.round(b.top), bottom: Math.round(b.bottom), h: Math.round(b.height)}; };
  const desc = el('desc'), card = el('card'), content = el('content');
  const cs = getComputedStyle(desc);
  const head = el('head');
  return {
    desc: {...off('desc'), scrollH: desc.scrollHeight, clientH: desc.clientHeight,
           scrollTop: desc.scrollTop, lineHeight: parseFloat(cs.lineHeight),
           overflowY: cs.overflowY, maxHeight: cs.maxHeight, marginBottom: cs.marginBottom,
           paddingBottom: cs.paddingBottom, position: cs.position,
           bg: cs.backgroundColor, zIndex: cs.zIndex},
    slot: off('slot'),
    // 简介浮层的可用高度 = 卡底 − 浮层顶。**两级 offsetParent 相加**：`#slot` 的
    // offsetParent 是 `.ArticleContent`（它自己 position: relative），而 `.ArticleContent`
    // 的 offsetParent 才是卡片 ⇒ 混着减会得出"浮层悬在 300px 高处"这种假数
    // （同第 ⑪ 组页脚那条注释踩过的坑）。
    contentTop: content.offsetTop,
    descAbs: content.offsetTop + el('slot').offsetTop,
    avail: card.offsetHeight - (content.offsetTop + el('slot').offsetTop),
    cover: rect('cover'), head: off('head'), footer: off('footer'), footerRect: rect('footer'),
    upd: rect('upd'),
    title: off('title'), cat: off('cat'), tags: off('tags'), content: off('content'),
    card: {...off('card'), rect: rect('card'),
           overflow: card.scrollHeight - card.clientHeight, clientH: card.clientHeight,
           minHeight: getComputedStyle(card).minHeight},
    contentOverflow: content.scrollHeight - content.clientHeight,
    // ① 的判据：分类行上沿到封面图下沿的距离（普通卡）。置顶卡没有 .ArticleHead ⇒ null
    headGap: head && el('cover') ? rect('head').top - rect('cover').bottom : null,
    pageOverflow: document.documentElement.scrollWidth > window.innerWidth,
  };
}"""

# 悬浮态：不能再用 PAINT（它会重写 innerHTML、把悬浮态丢掉），所以单独一段只读的 JS。
HOVER_READ = """() => {
  const el = (id) => document.getElementById(id);
  const desc = el('desc'), card = el('card'), footer = el('footer'), content = el('content');
  const cs = getComputedStyle(desc);
  const r = desc.getBoundingClientRect(), cr = card.getBoundingClientRect();
  return {
    descH: desc.offsetHeight, descTop: desc.offsetTop, descScrollH: desc.scrollHeight,
    descClientH: desc.clientHeight, descScrollTop: desc.scrollTop,
    descRectBottom: Math.round(r.bottom), cardRectBottom: Math.round(cr.bottom),
    lineHeight: parseFloat(cs.lineHeight), maxHeight: cs.maxHeight, overflowY: cs.overflowY,
    marginBottom: cs.marginBottom, paddingBottom: cs.paddingBottom, position: cs.position,
    slotH: el('slot').offsetHeight, slotTop: el('slot').offsetTop,
    bg: cs.backgroundColor, zIndex: cs.zIndex,
    footerTop: footer.offsetTop, titleTop: el('title').offsetTop,
    catTop: el('cat') ? el('cat').offsetTop : null,
    tagsTop: el('tags') ? el('tags').offsetTop : null,
    contentOverflow: content.scrollHeight - content.clientHeight,
    cardOverflow: card.scrollHeight - card.clientHeight,
    cardH: card.offsetHeight, cardClientH: card.clientHeight,
  };
}"""

# 把真的 `resetDescScroll` 接成 desc 的 mouseleave 处理器。React 那边是
# `onMouseLeave={resetDescScroll}`（同一份实现、同一个元素），但沙箱里没有 React，
# 所以这里手工接一根线，好让下一步是**真事件 + 真实现**，而不是我手搓的桩。
ATTACH = """() => {
  const el = document.getElementById('desc');
  el.addEventListener('mouseleave', (e) => window.__resetDescScroll(e));
}"""

# 稳定判据用的几个键：简介高度/顶部 + 它后面那一段的位置。四个都连续三次不动才算落定。
STABLE_KEYS = ("descH", "descTop", "footerTop", "titleTop")


def hover_stable(pg, sel: str, keys=STABLE_KEYS, settle_ms: int = 950,
                 timeout_s: float = 5.0) -> dict:
    """把鼠标移到 `sel` 的中心，等布局落定后返回一份读数。

    不用 `pg.hover()`：它在元素位置/尺寸还在变的时候会一直重试（展开动画 0.8s），
    实测卡死 60+ 次重试。这里自己算中心点、自己轮询。
    先睡满一次过渡时长再判稳定，否则缓动尾部每 100ms 的变化量会小于 0.5px、
    被误判成"已经落定"而采到一个 199px 这种半途值（`% 行高` 那条断言就是被它坑的）。
    """
    box = pg.evaluate("""(sel) => { const r = document.querySelector(sel).getBoundingClientRect();
        return {x: r.left + r.width / 2, y: r.top + r.height / 2}; }""", sel)
    pg.mouse.move(box["x"], box["y"])
    pg.wait_for_timeout(settle_ms)
    last, stable, deadline = pg.evaluate(HOVER_READ), 0, time.time() + timeout_s
    while time.time() < deadline:
        pg.wait_for_timeout(100)
        cur = pg.evaluate(HOVER_READ)
        stable = stable + 1 if all(abs(cur[k] - last[k]) < 0.5 for k in keys) else 0
        last = cur
        if stable >= 3:
            break
    return last


def unhover(pg) -> None:
    """把鼠标挪出所有卡片（并给 mouseleave 一点时间）。"""
    pg.mouse.move(5, 5)
    pg.wait_for_timeout(150)

with sync_playwright() as p:
    br = p.chromium.launch()
    pg = br.new_page(viewport={"width": 1280, "height": 900})
    errs: list[str] = []
    pg.on("pageerror", lambda e: errs.append(str(e)))
    pg.goto(URL)
    pg.wait_for_timeout(150)

    card_mk = CARD_MARKUP.format(stats=STATS, title=LONG_TITLE, desc=LONG_DESC, tags=tags(3))
    huge_mk = CARD_MARKUP.format(stats=STATS, title=LONG_TITLE, desc=HUGE_DESC, tags=tags(3))
    top_mk = TOP_MARKUP.format(title=LONG_TITLE, desc=HUGE_DESC, tags=tags(6))

    print("⓪ 沙箱自检：卡片规则真的生效了（否则下面全是 0 与 0 比，怎么比都过）")
    on = pg.evaluate(PAINT, {"markup": card_mk})
    check("封面图 160px（.ArticleCover 的规则生效；20261004 由 200 降 40，与下限成对）",
          abs(on["cover"]["h"] - 160) < 1, f"cover h={on['cover']['h']}")
    # 502 = 160（封面）+ 342（内容自然高：3 行标题 + 1 行标签的 LONG_TITLE/tags(3) 这一组）。
    # ⚠️ 这个数是**量出来的**、不是算出来的：卡片按内容长高，下限 430 在这组内容下根本
    # 不参与（内容自然高 502 > 430）。真要验"停在下限"看第 ⑪ 组。
    # 20261001 由 596 变来：封面 −40、标题 30px→26px 每行 −4（3 行 −12）⇒ 合计 −54。
    # 20261004 再由 542 变来：只动了封面那 −40（**内容自然高 342 一字未改**——这正是
    # "封面与下限成对改、内容那段不动"的实证）。
    check("卡片 502px = 内容自然高（下限 430 不参与；内容多就长高）",
          abs(on["card"]["h"] - 502) < 1, f"card h={on['card']['h']}")
    check("简介行高 20px（展开高度按它取整）", abs(on["desc"]["lineHeight"] - 20) < 0.5,
          str(on["desc"]["lineHeight"]))
    check("简介在内容区里（选择器链没断）", on["desc"]["h"] > 0, f"desc h={on['desc']['h']}")
    check("标签行有高度（标签那一段也在场）", on["tags"] and on["tags"]["h"] >= 30,
          f"tags h={on['tags'] and on['tags']['h']}")
    check("简介槽在场且 60px（整个方案的支点，缺了它就退回 flex 流里）",
          on["slot"] and abs(on["slot"]["h"] - 60) <= 1, f"slot={on['slot']}")
    check("简介在槽内是绝对定位（它长高才不会撑动后面的标签/页脚）",
          on["desc"]["position"] == "absolute", on["desc"]["position"])

    print("① 分类行与封面之间的空隙：收到 20px（用户点名的那一条）")
    check("空隙 = 内容区上内边距 20px（旧值 40px）", abs(on["headGap"] - 20) <= 1,
          f"实测 {on['headGap']}px")
    check("空隙确实在天花板之上（分类行没被封面盖住）", on["headGap"] > 0, f"{on['headGap']}px")

    print("② 静置态：简介恰好 3 行、页脚完整在卡内、卡片不溢出")
    check("简介静置 60px = 3 × 20px", abs(on["desc"]["h"] - 60) <= 1, f"desc h={on['desc']['h']}")
    check("简介没被 flex 压过（被压就会是 4.25 行这种半行值）",
          on["desc"]["h"] % 20 == 0, f"desc h={on['desc']['h']}")
    check("静置态没有 padding-bottom（正文高度 = 行高整数倍的前提）",
          on["desc"]["paddingBottom"] in ("0px", ""), on["desc"]["paddingBottom"])
    check("内容区不溢出（scrollHeight ≤ clientHeight + 1）",
          on["contentOverflow"] <= 1, f"溢出 {on['contentOverflow']}px")
    check("★ 页脚完整在卡内（改前它会被 overflow:hidden 裁出卡外）",
          on["footerRect"]["bottom"] <= on["card"]["rect"]["bottom"] + 1,
          f"页脚底 {on['footerRect']['bottom']} / 卡底 {on['card']['rect']['bottom']}")
    check("卡片整体不溢出（长高后的卡没被撑破）", on["card"]["overflow"] <= 1,
          f"溢出 {on['card']['overflow']}px（卡高 {on['card']['h']}，可视 {on['card']['clientH']}）")
    check("★ 页脚里「更新于」那行也在卡内（绝对定位挂在页脚盒子**外面**，最先被切的就是它）",
          on["upd"] and on["upd"]["bottom"] <= on["card"]["rect"]["bottom"] + 1,
          f"更新于底 {on['upd'] and on['upd']['bottom']} / 卡底 {on['card']['rect']['bottom']}")

    # ⚠️ 这一组用的是**够不到上限**的 LONG_DESC（展开 5 行 = 100px，上限 140px）。
    # 这正是"负 margin"方案唯一露馅的档位：负 margin 是定值、而高度是 min(全文, 上限)，
    # 两者不等时占位就变了（当年那个定值取 −140px ⇒ 占位 = 100 − 140 = −40 ⇒ 页脚被
    # 抽上去 100px）。探针实测过这个数，所以这一组不是"随便挑一段文字"，别换成 HUGE_DESC。
    print("③ 悬浮展开（普通卡·中等长度简介 100px < 上限 140px）：页脚仍一个像素不动")
    pg.evaluate(PAINT, {"markup": card_mk})
    hv = hover_stable(pg, "#desc")
    check("展开后简介高于静置态（真的展开了，不是只换个 padding）", hv["descH"] > on["desc"]["h"],
          f"悬浮 {hv['descH']} / 静置 {on['desc']['h']}")
    check("★ 展开高度严格落在 静置 60px 与上限 140px 之间，且是行高整数倍"
          "（实测 100px = 5 行；正文没被 padding 吃掉）",
          60 < hv["descH"] < 140 and hv["descH"] % int(hv["lineHeight"]) == 0
          and hv["paddingBottom"] in ("0px", ""),
          f"h={hv['descH']} padding-bottom={hv['paddingBottom']} 行高={hv['lineHeight']}")
    check("这一档够不到上限 ⇒ 不该出现内部滚动（真被切了才会滚）",
          hv["descScrollH"] <= hv["descClientH"] + 1,
          f"全文 {hv['descScrollH']} / 可视 {hv['descClientH']}")
    check("★ 页脚 offsetTop 与静置态逐像素相同（用户要求「定死在卡底」）",
          abs(hv["footerTop"] - on["footer"]["top"]) < 0.5,
          f"悬浮 {hv['footerTop']} / 静置 {on['footer']['top']}")
    check("  标题、标签行、分类行的位置也没被挤动",
          abs(hv["titleTop"] - on["title"]["top"]) < 0.5
          and abs(hv["tagsTop"] - on["tags"]["top"]) < 0.5
          and abs(hv["catTop"] - on["cat"]["top"]) < 0.5,
          f"title {hv['titleTop']}/{on['title']['top']} · tags {hv['tagsTop']}/{on['tags']['top']}")
    check("简介槽高度没被撑开（60px：支点还在）", abs(hv["slotH"] - 60) <= 1, f"slot={hv['slotH']}")
    check("展开后卡片仍不溢出（页脚没被顶出卡外）", hv["cardOverflow"] <= 1,
          f"溢出 {hv['cardOverflow']}px（卡高 {hv['cardH']} / 可视 {hv['cardClientH']}）")
    check("展开后的浮层没被卡片下沿切掉（下沿仍在卡内）",
          hv["descRectBottom"] <= hv["cardRectBottom"] + 1,
          f"浮层底 {hv['descRectBottom']} / 卡底 {hv['cardRectBottom']}")
    check("浮层压得住下面的标签/页脚：底色不透明 + z-index 抬起来",
          hv["bg"] not in ("rgba(0, 0, 0, 0)", "transparent") and hv["zIndex"] != "auto",
          f"background={hv['bg']} z-index={hv['zIndex']}")
    unhover(pg)

    print("④ 长简介：展开到上限（7 行）、可滚动、滚过之后离开能回到顶部")
    big = pg.evaluate(PAINT, {"markup": huge_mk})
    bh = hover_stable(pg, "#desc")
    check("展开到底就是 140px = 7 行（不是「能塞多少塞多少」）",
          bh["descH"] == 140 and bh["maxHeight"] == "140px",
          f"h={bh['descH']} max-height={bh['maxHeight']}")
    check("★ 上限那 140px **全是正文**：padding-bottom=0（旧裸规则的 10px 混进来时，"
          "正文只剩 130px ⇒ 第 7 行被切一半，就是用户报的现象）",
          bh["paddingBottom"] in ("0px", ""), f"padding-bottom={bh['paddingBottom']}")
    check("全文比展开态高 ⇒ 给出滚动（而不是裁掉）",
          bh["descScrollH"] > bh["descClientH"] + 1 and bh["overflowY"] in ("auto", "scroll"),
          f"全文 {bh['descScrollH']} / 可视 {bh['descClientH']} / overflow-y={bh['overflowY']}")
    check("  页脚同样一个像素没动", abs(bh["footerTop"] - big["footer"]["top"]) < 0.5,
          f"悬浮 {bh['footerTop']} / 静置 {big['footer']['top']}")
    check("  浮层仍在卡内（长简介下沿也没被切）",
          bh["descRectBottom"] <= bh["cardRectBottom"] + 1,
          f"浮层底 {bh['descRectBottom']} / 卡底 {bh['cardRectBottom']}")
    check("前提：静置态下简介**也是滚动容器**（滚动不是凭空多出来的）",
          big["desc"]["scrollH"] > big["desc"]["clientH"] + 1,
          f"{big['desc']['scrollH']} vs {big['desc']['clientH']}")
    pg.evaluate(ATTACH)
    scrolled = pg.evaluate("""() => { const d = document.getElementById('desc');
      d.scrollTop = 120; return {top: d.scrollTop, sh: d.scrollHeight, ch: d.clientHeight}; }""")
    check("展开态真的能滚下去（滚位不为 0，否则下面那条是空断言）", scrolled["top"] > 0,
          f"scrollTop={scrolled['top']}")
    pg.mouse.move(5, 5)        # 真鼠标移出 → 浏览器派发真 mouseleave
    pg.wait_for_timeout(200)
    left = pg.evaluate("() => document.getElementById('desc').scrollTop")
    check("★ 鼠标离开后滚位 = 0（静置态显示的是全文开头，而不是中段）", left == 0,
          f"scrollTop={left}")

    print("⑤ 置顶卡静置：简介 3 行，页脚在卡内")
    top = pg.evaluate(PAINT, {"markup": top_mk})
    # 顶卡**仍是定高**（与普通卡的"下限"不同，这是刻意的）：它是轮播，按内容长高会让
    # 各 slide 高度参差、切换时整块跳。它的余量够大（实测 10 个标签两行时仍余 111px），
    # 所以不需要普通卡那套"长高"。
    # 20261004：640 → 460（高度对齐下面每一行文章卡）。
    check("置顶卡 460px 定高", abs(top["card"]["h"] - 460) < 1, f"card h={top['card']['h']}")
    check("  顶卡页脚的「更新于」也在卡内",
          top["upd"] and top["upd"]["bottom"] <= top["card"]["rect"]["bottom"] + 1,
          f"更新于底 {top['upd'] and top['upd']['bottom']} / 卡底 {top['card']['rect']['bottom']}")
    check("简介 60px = 3 × 20px", abs(top["desc"]["h"] - 60) <= 1, f"desc h={top['desc']['h']}")
    check("简介行高 20px（与普通卡同一套，展开高度才能取整）",
          abs(top["desc"]["lineHeight"] - 20) < 0.5, str(top["desc"]["lineHeight"]))
    check("顶卡的简介槽也在场（60px + 原本那 20px 间距归槽管）",
          abs(top["slot"]["h"] - 60) <= 1 and top["desc"]["position"] == "absolute",
          f"slot={top['slot']} position={top['desc']['position']}")
    check("页脚完整在卡内", top["footerRect"]["bottom"] <= top["card"]["rect"]["bottom"] + 1,
          f"页脚底 {top['footerRect']['bottom']} / 卡底 {top['card']['rect']['bottom']}")

    print("⑥ 悬浮置顶卡标题：全列一个像素都不许动（用户报的「抖动布局」）")
    pg.evaluate(PAINT, {"markup": top_mk})
    t_hv = hover_stable(pg, "#title")
    check("★ 标题悬浮后标题自己没动", abs(t_hv["titleTop"] - top["title"]["top"]) < 0.5,
          f"悬浮 {t_hv['titleTop']} / 静置 {top['title']['top']}")
    check("  分类行没动", abs(t_hv["catTop"] - top["cat"]["top"]) < 0.5,
          f"{t_hv['catTop']} / {top['cat']['top']}")
    check("  简介没动（垂直居中列没被重新居中）", abs(t_hv["descTop"] - top["desc"]["top"]) < 0.5,
          f"{t_hv['descTop']} / {top['desc']['top']}")
    check("  标签行没动", abs(t_hv["tagsTop"] - top["tags"]["top"]) < 0.5,
          f"{t_hv['tagsTop']} / {top['tags']['top']}")
    check("  页脚没动", abs(t_hv["footerTop"] - top["footer"]["top"]) < 0.5,
          f"{t_hv['footerTop']} / {top['footer']['top']}")
    check("  简介高度也没变（标题的 :hover 不再解除行数限制）",
          abs(t_hv["descH"] - top["desc"]["h"]) < 0.5, f"{t_hv['descH']} / {top['desc']['h']}")
    unhover(pg)

    print("⑦ 悬浮置顶卡简介：展开成浮层，占位不变 ⇒ 邻居全不动")
    pg.evaluate(PAINT, {"markup": top_mk})
    d_hv = hover_stable(pg, "#desc")
    check("★ 简介真的展开了（旧版这条被 0,3,0 的选择器压住：只改 max-height/padding ⇒ 10px 抖动）",
          d_hv["descH"] >= 200 and d_hv["overflowY"] == "auto",
          f"h={d_hv['descH']} overflow-y={d_hv['overflowY']} max-height={d_hv['maxHeight']}")
    check("展开高度能被行高整除（200px = 10 行；20261004 由 240 = 12 行的上限收下来）",
          d_hv["descH"] % 20 == 0, f"{d_hv['descH']}px")
    check("★ 槽顶住了占位：标签行 offsetTop 与静置逐像素相同（垂直居中列没重新居中）",
          abs(d_hv["tagsTop"] - top["tags"]["top"]) < 0.5,
          f"悬浮 {d_hv['tagsTop']} / 静置 {top['tags']['top']}")
    check("  页脚没动", abs(d_hv["footerTop"] - top["footer"]["top"]) < 0.5,
          f"{d_hv['footerTop']} / {top['footer']['top']}")
    check("  标题没动", abs(d_hv["titleTop"] - top["title"]["top"]) < 0.5,
          f"{d_hv['titleTop']} / {top['title']['top']}")
    check("  分类行没动", abs(d_hv["catTop"] - top["cat"]["top"]) < 0.5,
          f"{d_hv['catTop']} / {top['cat']['top']}")
    check("  槽高度也没变（60px）", abs(d_hv["slotH"] - 60) <= 1, f"slot={d_hv['slotH']}")
    check("浮层底色不透明 + z-index 抬起来（压得住下面的标签/页脚）",
          d_hv["bg"] not in ("rgba(0, 0, 0, 0)", "transparent") and d_hv["zIndex"] != "auto",
          f"background={d_hv['bg']} z-index={d_hv['zIndex']}")
    check("浮层没跑出卡片", d_hv["descRectBottom"] <= d_hv["cardRectBottom"] + 1,
          f"浮层底 {d_hv['descRectBottom']} / 卡底 {d_hv['cardRectBottom']}")
    unhover(pg)

    # ⑦′ 顶卡的"中等长度"档：与第 ③ 组同一个道理（这一档才是负 margin 方案露馅的地方），
    # 而顶卡是**垂直居中**列 ⇒ 占位一变整列都动，比普通卡更早暴露。
    print("⑦′ 置顶卡 + 中等长度简介（展开 80px < 上限 200px）：整列仍不动")
    med_top_mk = TOP_MARKUP.format(title=LONG_TITLE, desc=LONG_DESC, tags=tags(6))
    top_med = pg.evaluate(PAINT, {"markup": med_top_mk})
    dt_hv = hover_stable(pg, "#desc")
    check("展开高度严格落在 静置 60px 与上限 200px 之间、是行高整数倍、正文没被 padding 吃掉"
          "（同一段文字在顶卡里是 4 行 = 80px：这一列比普通卡宽 ≈70px，所以行数更少——"
          "两个卡的文字换行数不一样，别把普通卡那条数抄过来）",
          60 < dt_hv["descH"] < 200 and dt_hv["descH"] % int(dt_hv["lineHeight"]) == 0
          and dt_hv["paddingBottom"] in ("0px", ""),
          f"h={dt_hv['descH']} 行高={dt_hv['lineHeight']} padding-bottom={dt_hv['paddingBottom']}")
    check("★ 标签行/页脚/标题/分类行与静置逐像素相同",
          abs(dt_hv["tagsTop"] - top_med["tags"]["top"]) < 0.5
          and abs(dt_hv["footerTop"] - top_med["footer"]["top"]) < 0.5
          and abs(dt_hv["titleTop"] - top_med["title"]["top"]) < 0.5
          and abs(dt_hv["catTop"] - top_med["cat"]["top"]) < 0.5,
          f"tags {dt_hv['tagsTop']}/{top_med['tags']['top']} · footer {dt_hv['footerTop']}/{top_med['footer']['top']} "
          f"· title {dt_hv['titleTop']}/{top_med['title']['top']}")
    unhover(pg)

    print("⑧ 置顶卡的简介也要能滚回顶部（与普通卡共用一份实现）")
    pg.evaluate(PAINT, {"markup": top_mk})
    pg.evaluate(ATTACH)
    hover_stable(pg, "#desc")
    t_scroll = pg.evaluate("""() => { const d = document.getElementById('desc');
      d.scrollTop = 120; return d.scrollTop; }""")
    check("展开态能滚下去", t_scroll > 0, f"scrollTop={t_scroll}")
    unhover(pg)
    t_left = pg.evaluate("() => document.getElementById('desc').scrollTop")
    check("鼠标离开后滚位 = 0", t_left == 0, f"scrollTop={t_left}")

    print("⑨ 夜间：浮层底色取主题变量（不是写死的白）")
    pg.evaluate("() => document.documentElement.classList.add('frontDark')")
    pg.evaluate(PAINT, {"markup": top_mk})
    hover_stable(pg, "#desc")
    dark_bg = pg.evaluate("() => getComputedStyle(document.getElementById('desc')).backgroundColor")
    check("夜间浮层底色 = --pic-background-cover 的夜间值 rgb(33, 33, 33)",
          dark_bg == "rgb(33, 33, 33)", str(dark_bg))
    pg.evaluate("() => document.documentElement.classList.remove('frontDark')")

    print("⑩ 窄屏 375px：移动档不被这套改动碰到")
    pg.set_viewport_size({"width": 375, "height": 800})
    mob = pg.evaluate(PAINT, {"markup": card_mk})
    # ⚠️ 判据是"**矮于** 430"（= 桌面那条下限的当前值），不是"≠ 430"：桌面那条下限是
    # `min-height`，而移动档只写了 `height: auto !important` 是**管不到它**的（两个是不同的
    # 属性——"属性有没有第二处声明"那个家族坑）⇒ 漏了 `min-height: 0 !important` 时卡片会被
    # 撑到恰好 430，`!= 430` 那种写法照样绿。顺带把计算值也读出来，红的时候一眼知道是哪条没生效。
    # 判据的数要跟桌面那条下限**一起动**（20261004：470 → 430），否则这条会跟着变松。
    check("移动档卡片矮于 430（桌面那条下限被撤掉了）", mob["card"]["h"] < 430,
          f"card h={mob['card']['h']}")
    check("  `min-height` 计算值是 0（撤的是下限本身，不是被 height 覆盖）",
          mob["card"]["minHeight"] in ("0px", ""), str(mob["card"]["minHeight"]))
    check("移动档简介仍是钳制态（没被展开规则顶开）", mob["desc"]["h"] < 60,
          f"desc h={mob['desc']['h']}（移动档 clamp 2 行）")
    check("移动档槽高也跟着缩小（≈2 行；桌面那 60px 会让卡片白多一截空档）",
          abs(mob["slot"]["h"] - mob["desc"]["h"]) <= 1,
          f"slot={mob['slot']['h']} / desc={mob['desc']['h']}")
    check("页面不出现横向滚动", not mob["pageOverflow"])
    pg.set_viewport_size({"width": 1280, "height": 900})

    print("⑪ ★ 标签换行：卡片按内容长高，页脚与「更新于」都留在卡内（20260930 现场）")
    # 用户原话："在文章标签变成两行时，作者信息时间信息在卡片的位置还是没锁死，跑出卡片了"。
    # 定高那版实测：3 行标题 + 标签第三行 ⇒ 「更新于」底 = 卡底 + 19（30px 的行只剩 11px 露在外面）。
    # 现在卡片是 `min-height`（下限 430，20261004 由 470 再降 40）+ 网格项 flex ⇒ 内容多就长高。
    # 逐档写死"该不该长"：**短标题 + 无标签**那种最空的卡（自然高 405）才停在下限 430；
    # 3 行标题 + 无标签就已经自然高 470、不用下限兜了（20261004 实测）。
    for title, n, expect_grow in (("面试复盘", 0, False), (LONG_TITLE, 6, True),
                                  (LONG_TITLE, 12, True)):
        r = pg.evaluate(PAINT, {"markup": CARD_MARKUP.format(
            stats=STATS, title=title, desc=LONG_DESC, tags=tags(n))})
        if expect_grow:
            check(f"{n} 个标签：内容超出下限 ⇒ 卡片长高到 430 以上", r["card"]["h"] > 430,
                  f"card h={r['card']['h']}")
        else:
            check(f"最空的卡（短标题 + {n} 个标签）：内容塞得下 ⇒ 停在下限 430",
                  abs(r["card"]["h"] - 430) < 1, f"card h={r['card']['h']}")
        check("  卡片不溢出（overflow: hidden 没在裁东西）", r["card"]["overflow"] <= 1,
              f"溢出 {r['card']['overflow']}px")
        check("  页脚底 ≤ 卡底（作者署名没跑出去）",
              r["footerRect"]["bottom"] <= r["card"]["rect"]["bottom"] + 1,
              f"页脚底 {r['footerRect']['bottom']} / 卡底 {r['card']['rect']['bottom']}")
        check("  「更新于」底 ≤ 卡底（时间信息也没跑出去）",
              r["upd"] and r["upd"]["bottom"] <= r["card"]["rect"]["bottom"] + 1,
              f"更新于底 {r['upd'] and r['upd']['bottom']} / 卡底 {r['card']['rect']['bottom']}")
        # ⚠️ 这条只能用 rect 比：`.ArticleContent` 自己也是 `position: relative`，于是页脚的
        # offsetParent 是**内容区**（不是卡片）⇒ `footer.offsetTop` 与 `content.offsetTop`
        # 不在同一个坐标系里，混着减会得出"页脚悬在 232px 高处"这种假红。
        check("  页脚仍被 margin-top:auto 钉在卡底（长高不是把页脚留在半空）",
              r["card"]["rect"]["bottom"] - r["footerRect"]["bottom"] < 40,
              f"卡底 {r['card']['rect']['bottom']} / 页脚底 {r['footerRect']['bottom']}")

    print("⑫ ★ 简介浮层的可用高度（封面 160 / 下限 430 / 上限 140 三个数联动，20261004）")
    # 浮层绝对定位、向下长，卡片不跟着长高 ⇒ 可用高度 = **卡底 − 浮层顶**，它**不是**恒定的：
    # 只取决于浮层底下那一段（简介槽 60 + 间距 + 标签 + 页脚 + 内容下内边距）。
    # 这张表就是"上限为什么是 140 而不是 200"的判据；改封面 / 改下限 / 改标签那一段，都要重看。
    #
    # 20261001 复核：封面 −40、标题 30→26px **同时**把"卡底"和"浮层顶"往上挪，两者相减互相
    # 抵消 ⇒ 只有被 `min-height` 兜住的那一档（下数第二行）真的变了：下限 520→470 让"兜出来
    # 的余量"从 25px 缩到 20px ⇒ 175 → 170。**最挤那档仍是 150px，上限 140 不动。**
    #
    # 20261004 复核（封面 200→160、下限 470→430）：**这张表一个字都不用改**，实测逐档相同
    # （卡高变成 470/430/502/534/566，浮层顶同步上移 40，相减抵消）。它就是"为什么那两个数
    # 必须成对改"的判据：只改封面 ⇒ 各档可用 +40（上限可以抬高）；只改下限 ⇒ 被兜住的那档
    # −40 直接跌破 140（第 8 行被切半个）。
    shapes = [
        ("3 行标题 + 无标签", LONG_TITLE, 0, 150),          # ← 最挤：没有标签那一行撑着
        ("1 行标题 + 无标签", "面试复盘", 0, 170),           # 被下限 430 兜住 ⇒ 多 20px 余量
        ("3 行标题 + 1 行标签", LONG_TITLE, 3, 182),
        ("3 行标题 + 2 行标签", LONG_TITLE, 6, 214),
        ("3 行标题 + 3 行标签", LONG_TITLE, 12, 246),
    ]
    avails = {}
    for label, title, n, expect in shapes:
        m = pg.evaluate(PAINT, {"markup": CARD_MARKUP.format(
            stats=STATS, title=title, desc=LONG_DESC, tags=tags(n))})
        avails[label] = m["avail"]
        check(f"{label}：可用 {expect}px（卡 {m['card']['h']} − 浮层顶 {m['descAbs']}）",
              abs(m["avail"] - expect) <= 1, f"实测 {m['avail']}px")
    worst = min(avails.values())
    check("★ 每一档都装得下展开上限 140px（最挤的那档也要够）", worst >= 140, f"最挤 {worst}px")
    check("★ 判据有牙：最挤那档 **< 200px** ⇒ 上一版的上限 200 就是会切行的"
          "（本组能把它抓红，不是套空断言）", worst < 200, f"最挤 {worst}px")
    check("  结构关系：标签每多一行 ⇒ 可用 +32px（标签就长在浮层底下）",
          abs((avails["3 行标题 + 1 行标签"] - avails["3 行标题 + 无标签"]) - 32) <= 1,
          f"{avails['3 行标题 + 无标签']} → {avails['3 行标题 + 1 行标签']}")
    check("  结构关系：被下限兜住的卡反而**更宽裕**（兜出来的余量也落在浮层底下）",
          avails["1 行标题 + 无标签"] > avails["3 行标题 + 无标签"],
          f"{avails['1 行标题 + 无标签']} vs {avails['3 行标题 + 无标签']}")

    # 算术之外再走一遍真事件：把最挤那档展开到底，验它**真的**没被卡底切掉。
    tight_mk = CARD_MARKUP.format(stats=STATS, title=LONG_TITLE, desc=HUGE_DESC, tags=tags(0))
    pg.evaluate(PAINT, {"markup": tight_mk})
    tight_hv = hover_stable(pg, "#desc")
    check("★ 最挤那档展开到底：浮层底仍在卡内（算术是 150 − 140 = 10px 余量）",
          tight_hv["descRectBottom"] <= tight_hv["cardRectBottom"] + 1,
          f"浮层底 {tight_hv['descRectBottom']} / 卡底 {tight_hv['cardRectBottom']}")
    check("  展开高度仍是上限 140px（没有被「装不下」改成别的值）",
          tight_hv["descH"] == 140, f"h={tight_hv['descH']}")
    unhover(pg)

    check("无 JS 运行时报错", not errs, "; ".join(errs[:2]))
    br.close()

shutil.rmtree(SANDBOX, ignore_errors=True)
print(f"\n{'✗' if FAIL else '✓'} article-card-hover：{PASS} 通过 / {FAIL} 失败")
raise SystemExit(1 if FAIL else 0)
