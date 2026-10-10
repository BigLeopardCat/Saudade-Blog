#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""文章阅读页手机档真的生效（20261001）。

  python3 tests/read-mobile.test.py

现场：`ReadArticle/index.sass` 末尾那段 `@media (max-width:768px)` 从写下那天
（`f207b6d`，commit message 写着「移动端正文全宽显示、封面/标题瘦身」）**一次都没生效过**
——媒体查询不改特异性，块里裸写的 `.readContent`(0,1,0) 输给桌面那条
`.readContainer .readContent`(0,2,0)。375px 真机上量的结果是：正文 300px 宽（＝桌面的
80%）、封面 400px 高、内边距 20px，与这一档想要的 100%/200px/12px 全不一样。
**它是"半死"**：同块里 `.readInfo h1` 的 `font-size` 没有桌面规则跟它抢，是活的 ⇒ 肉眼看
"字确实变小了"，会以为整块都在工作——所以判据只能是量几何，不能靠读代码。

为什么用无头浏览器而不是 node 桩：这是布局（百分比宽度、绝对定位、媒体查询命中），
真 CSS = node 侧真编译的 `.sass` + 仓库那份 `* { box-sizing: border-box }` 重置。

锁五件：
  ① 编译产物里那几条**确实带着 `!important`**（这一档能不能赢全靠它——判据 ④ 的反向对照
     会证明没有它就回落）；
  ② 375px：正文满宽（= 视口）且内边距 12px 10px、封面 260px、描述卡满宽、`.readInfo`
     bottom 12px 且**宽度 343px（视口 − 32）居中**、`.markdown-body` max-width 100%；
  ③ 768/769 边界：媒体档只到 768px（769 起必须回到桌面值，否则是"溢出到桌面上"的另一种病）；
  ④ **反向对照**：把编译产物里这一段的 `!important` 剥掉再量一次 ⇒ 正文**确实**掉回
     80%（300px）、封面掉回 400px、`.readInfo` 掉回 880px（宽出屏幕）。证明 ② 不是空断言。
  ⑤ 1200px 桌面档一字未动：正文 880px / 内边距 20px / 封面 400px / 描述卡内边距 25px；
  ⑥ **正文包裹层不被宽原子顶出视口**（20261005 新档，与媒体档无关、病根在基础层那条
     `display:flex; flex-direction:column; align-items:center`）——夹具复现真 DOM 的三层
     嵌套 + 一整行不折行的代码，量包裹层宽度与 `documentElement.scrollWidth`；**红基线**
     单独摘掉 `.readBody` 那条规则（它没有 `!important`，④ 的剥法够不到它），必须当场
     顶到 2000px 以外。线上根因与实测数字写在 ⑥ 的小节头注里。

⚠️ 20261003：`.readInfo` 那三条（宽 880 → `calc(100% - 32px)`、三列 → 单列、bottom 45 → 12）
是**顺带修掉的既有缺陷**：它从来就没有宽度覆盖，`left: 50%` + 横向 −50% 让这个 880px 的
定宽盒在 375px 上两边各伸出屏幕 236px/540px —— 三列时屏幕上"剩的正好是中间那条标题"所以
看不出来，改成单列（20261003 用户第 2 条）就全露馅了。本套件因此多量一条**盒子宽度**。

（判据 ④ 之所以连"剥掉之后掉到哪"都钉住：剥完必须**恰好**回到 `.readContainer` 那条的值，
说明压死它的是那条规则、而不是别的什么。根因的形状由 CI 的
`sass-media-shadow.test.mjs`（特异性档）全仓盯着，这一份只管"渲染出来是什么"。）

20261005 加了两节（同一处两个不同的病，见各自小节头注）：
  ⑦ 正文列内边距只留一处 + 手机档那三条死声明的**渲染值**（⑦b 是字面删规则的反向对照）；
  ⑧ 阅读面底色**两档**（20261008 换：白天 = 主题底 `--washi-theme-bg`（粉紫天青那张，
     首页首屏/登录页同一支）、夜间 = 不透明 `#121a27`）/ 正文补 0.2px 描边且**不重排**
     （摘掉描边那条后同段落的宽/高/行数必须逐项相同）。白天那支读的是 `var(--washi-theme-bg)`
     （出处 `src/index.css`，沙箱拷成 tokens.css）⇒ 夹具外面要套一层 `.frontRoot`
     （那两条规则的祖先选择器），暗色档另用 `.frontRoot.frontDark` 臂。本节另有一臂**反向
     对照**（⑧c）：把夜间那支按行为改回 `transparent`（旧写法）⇒ "不透明"那条判据当场红。
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

SASS_FILE = FE / "src/frontHome/Content/ReadArticle/index.sass"
RESET_CSS = FE / "src/frontHome/main.css"
# 沙箱里**必须**有第三张表：编辑器那份（`components/Editor/index.css`，被 router 静态引入
# ⇒ 线上对每一个 `.markdown-body` 都生效）。第 ⑦ 节量的那种缺陷**就是它漏进来的**
#（`.markdown-body{padding:45px}` + 媒体档 15px，打在正文那两层嵌套上 ⇒ 桌面 45+45、
# 手机 15+15 全叠）——不把它放进沙箱，判据测的是一个"没有编辑器样式表的世界"，
# 上一轮那句"手机档内边距 12px 10px 已经对了"就是这么落在空处的。
# 次序照线上：编辑器表在前、本仓 sass 在后（产物里 `components/Editor` 在 ReadArticle 之前）。
EDITOR_CSS = FE / "src/components/Editor/index.css"

# 与 index.tsx 同形：.readContainer > (.readCover > .readInfo) + .readDescription
# + .readContent.markdown-body（正文那两个类在同一个元素上，见 index.tsx:622）
# `.readInfo` 里只渲染中区（标题那一格）：本套件量的是正文/描述卡/封面的几何与标题字号，
# 左区（作者+时间）与右区（读数四件）不参与任何一条判据 —— 它们的几何在
# `read-stats-cluster.test.py` 里是主角，那边有完整的三区夹具。
# 20261005 起夹具里补上了真 DOM 的**三层嵌套**（`.readContent > .readBody > #content`）：
# 正文包裹层那一条（判据 ⑥）只有在子项真的挂在 `.readContent` 下面时才量得出来。
# 旧夹具把 `<p>正文</p>` 直接挂在 `.readContent` 上，`.readBody` 整层不存在 ⇒ 那一类
# 缺陷它一条都看不见。②–⑤ 量的是 `.readContent`/`.readDescription`/`.readCover`/`.readInfo`
# 自己的盒子，加一层 `width:100%` 的包裹不影响它们。
MARKUP = """
<div class="readContainer">
  <div class="readCover">
    <div class="readInfo"><div class="readMain"><h1>标题</h1></div></div>
  </div>
  <div class="readDescription"><p>摘要</p></div>
  <div class="readContent markdown-body">
    <div class="readBody"><div id="content" class="markdown-body">
      <div class="markdown-body"><p>正文</p></div>
    </div></div>
  </div>
</div>
"""

# 判据 ⑥ 的夹具：一个**宽原子**（一整行不折行的代码）。真页面上 `code` 的
# `white-space: pre` 来自 bytemd/hljs（线上实测 computed：`pre` = pre-wrap、`code` = pre），
# 本沙箱只加载本仓那份 sass + 复位表，所以这一条由夹具自己写 —— 这是**补沙箱缺的那张表**，
# 不是给被测规则开后门：`.readBody` 与 `pre` 那两条都不碰 `code` 的 white-space。
WIDE_ATOM = '<pre><code style="white-space: pre">' + ('abcdefghij' * 60) + '</code></pre>'
MARKUP_WIDE = """
<div class="readContainer">
  <div class="readCover"><div class="readInfo"><div class="readMain"><h1>标题</h1></div></div></div>
  <div class="readContent markdown-body">
    <div class="readBody"><div id="content" class="markdown-body">
      <div class="markdown-body">""" + WIDE_ATOM + """</div>
    </div></div>
    <div class="navigation" id="toc"></div>
  </div>
</div>
"""

# 判据 ⑦ 的夹具：正文那两层嵌套里放齐"会被手机档那几条声明改到"的三种块
#（h1 / p / pre），量它们的**渲染值**。h1 与 p 是 20261005 之前"写了但被压死"的那几条，
# pre 是只有 `overflow-x` 活着的那一条。
MARKUP_TEXT = """
<div class="readContainer">
  <div class="readContent markdown-body">
    <div class="readBody"><div id="content" class="markdown-body">
      <div class="markdown-body">
        <h1>正文里的一级标题</h1>
        <p>第一段正文，用来量字号与行距。</p>
        <p>第二段正文，用来量段间距。</p>
        <pre><code>echo hello</code></pre>
      </div>
    </div></div>
  </div>
</div>
"""

MQ = "@media only screen and (max-width: 768px)"

# 判据 ⑧ 的夹具：底色 + 描边。比 ⑦ 多两件东西 ——
#   ① 外面套一层 `.frontRoot`：底色那两条规则的祖先选择器就是它
#     （`.frontRoot:not(.frontDark) &` / `.frontDark &`），夹具里没有它，这两条**一条都不命中**，
#      量到的永远是"没有背景"（上一版沙箱就是这样，"白天底色"这个缺陷它根本看不见）；
#   ② 一只**会折行的长段落** + 一只 `li` + 一段行内 `code` + 一个 `pre > code`：
#      描边要覆盖正文（含列表），要**避开**代码；而"不重排"这一条必须有会折行的段落才量得出来
#      —— 单行段落摘掉描边也还是单行，行数判据恒真。段落里混排中英，让断行点不是某个整数。
COLOR_MARKUP = """
<div class="frontRoot">
  <div class="readContainer">
    <div class="readContent markdown-body">
      <div class="readBody"><div id="content" class="markdown-body">
        <div class="markdown-body">
          <h1>正文里的标题</h1>
          <p>这是一段会折行的正文，用来量描边会不会改变字形的前进宽度。汉字与 Latin 混排，
             line wrapping 的断点落在哪里由字体度量决定，只要前进宽度一个像素都不变，
             段落的高度、宽度与行数就应当逐像素相同。这段要够长，长到在 836 的列宽里
             至少折成三行，否则行数判据没有分辨力。再补一句让它更长一些，再多补两句：
             正文列 20261010 从 660 撑到 836 之后，同样的字数会少折一行，所以夹具的长度
             必须跟着版面的有效宽走——改宽了它就要重新量一遍，否则这条不重排判据没有
             分辨力。这里再多写一点，确保在三行以上稳定成立。</p>
          <ul><li>列表项也要被描边覆盖</li></ul>
          <p>行内代码 <code>npm test</code> 应当被清零。</p>
          <pre><code>echo hello</code></pre>
        </div>
      </div></div>
    </div>
  </div>
</div>
"""

# 这一段里该有的 !important 条数（`.readContent` / `.readDescription` 各宽+内边距 4 条、
# 封面高 1、`.readInfo` 的列数/行距/宽/max-width/横向居中/bottom/内边距 7 条、
# 正文 max-width 1、pre 的 overflow-x 1）。反向对照剥的就是它们。
N_IMPORTANT = 14
STRIP = [
    "width: 100% !important",          # 出现两次（正文与描述卡各一，字面相同）
    "padding: 12px 10px !important",
    "padding: 12px !important",
    "height: 260px !important",
    "grid-template-columns: 1fr !important",
    "row-gap: 10px !important",
    "width: calc(100% - 32px) !important",
    "max-width: calc(100% - 32px) !important",
    "transform: translateX(-50%) !important",
    "bottom: 12px !important",
    "padding: 12px 16px !important",
    "max-width: 100% !important",
    # 20261005：`pre` 这条由 `hidden` 改成 `auto`（长代码行改成可横向滑，理由见 sass 同处
    # 注释）。反向对照要剥的仍然是**这一条**，只是取的值变了。
    "overflow-x: auto !important",
]


def compile_css() -> str:
    r = subprocess.run(["node", "-e", SASS_JS, str(SASS_FILE)], cwd=str(FE), capture_output=True)
    if r.returncode != 0:
        raise SystemExit("sass 编译失败：\n" + r.stderr.decode("utf-8", "replace"))
    return r.stdout.decode("utf-8")


def build_sandbox(css: str, name: str) -> pathlib.Path:
    sb = pathlib.Path(tempfile.mkdtemp(prefix=f"readmob-{name}-"))
    (sb / "read.css").write_text(css, encoding="utf-8")
    shutil.copy(RESET_CSS, sb / "main.css")
    shutil.copy(EDITOR_CSS, sb / "editor.css")
    (sb / "index.html").write_text(
        '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">'
        '<link rel="stylesheet" href="main.css"><link rel="stylesheet" href="editor.css">'
        '<link rel="stylesheet" href="read.css">'
        '</head><body><div id="root"></div></body></html>',
        encoding="utf-8")
    return sb


CSS = compile_css()

# 这一段媒体档在产物里的**字面区间**：反向对照只剥它里面的 !important（别处的 !important
# 一概不动，否则对照证明不了"压死它的就是桌面那条"）。用花括号配对找结尾，不靠猜缩进。
def block_region(css: str, header: str) -> tuple[int, int]:
    i = css.rindex(header)
    k = css.index("{", i)
    depth = 1
    j = k + 1
    while depth:
        if css[j] == "{":
            depth += 1
        elif css[j] == "}":
            depth -= 1
        j += 1
    return i, j


START, END = block_region(CSS, MQ)
BLOCK = CSS[START:END]
LEGACY = CSS[:START] + BLOCK.replace(" !important", "") + CSS[END:]

# 判据 ⑥ 的反向对照：**单独**摘掉 `.readBody` 那条（它写的是基础层、没有 `!important`，
# 上面那份 LEGACY 剥不到它）。摘掉之后正文包裹层回到"由 fit-content 定尺"，宽原子当场
# 把整层顶出去 —— 这条对照是 ⑥ 的全部意义所在。
import re  # noqa: E402

READBODY_RE = re.compile(r"\.readContainer \.readContent \.readBody \{[^}]*\}")
_m = READBODY_RE.search(CSS)
if _m is None:
    raise SystemExit("编译产物里没有 `.readContainer .readContent .readBody` 规则 ——"
                     " 类名（index.tsx 的 className='readBody'）与 sass 对不上了")
NO_BODY = CSS[:_m.start()] + CSS[_m.end():]

SB = build_sandbox(CSS, "fixed")
SB_LEGACY = build_sandbox(LEGACY, "legacy")
SB_NO_BODY = build_sandbox(NO_BODY, "nobody")


# 判据 ⑦b 的反向对照：**删掉** 20261005 新加的那两条内边距规则，其余一字不动
#（编辑器表在、手机档的 !important 也全在）⇒ 手机档正文列必须掉回 310px。
# 这是"改动前那一臂"的取法：按**字面**删本次新增的规则，**不读 `git show HEAD:`**
#（提交之后它取到的就是改动后那份，两条臂逐字相同、红基线恒真 —— 同族教训见
# `mermaid-mobile-zoom.test.py` 的换臂注释）。
def drop_rules(css: str, sel: str) -> str:
    needle = sel + " {"
    n = css.count(needle)
    if n == 0:
        raise SystemExit(f"编译产物里找不到 `{needle}` —— 内边距那两条改名了，⑦b 要先对齐")
    for _ in range(n):
        i = css.index(needle)
        css = css[:i] + css[i:].split("}", 1)[1]
    return css


NO_PAD = drop_rules(drop_rules(
    CSS, ".readContainer .readContent .readBody > .markdown-body > .markdown-body"),
    ".readContainer .readContent .readBody > .markdown-body")
SB_NO_PAD = build_sandbox(NO_PAD, "nopad")

from playwright.sync_api import sync_playwright  # noqa: E402

MEASURE = """(markup) => {
  document.getElementById('root').innerHTML = markup;
  const box = (s) => {
    const e = document.querySelector(s);
    const r = e.getBoundingClientRect();
    const cs = getComputedStyle(e);
    return { w: r.width, h: r.height, left: r.left, right: r.right,
             padL: cs.paddingLeft, maxW: cs.maxWidth, bottom: cs.bottom };
  };
  return {
    vw: window.innerWidth,
    mq: window.matchMedia('(max-width: 768px)').matches,
    h1fs: getComputedStyle(document.querySelector('.readInfo h1')).fontSize,
    content: box('.readContent'),
    desc: box('.readDescription'),
    cover: box('.readCover'),
    info: box('.readInfo'),
  };
}"""

with sync_playwright() as p:
    br = p.chromium.launch()
    errs: list[str] = []

    def measure(url: str, width: int) -> dict:
        pg = br.new_page(viewport={"width": width, "height": 900})
        pg.on("pageerror", lambda e: errs.append(str(e)))
        pg.goto(url)
        pg.wait_for_timeout(120)
        m = pg.evaluate(MEASURE, MARKUP)
        pg.close()
        return m

    print("① 编译产物里这几条确实带 !important（这一档能赢全靠它）")
    check(f"这一段媒体档里有 {N_IMPORTANT} 条 !important（剥掉它们就是判据 ④ 的对照）",
          BLOCK.count("!important") == N_IMPORTANT, str(BLOCK.count("!important")))
    for s in STRIP:
        check(f"  `{s}` 在这段里", s in BLOCK, s.replace(" !important", ""))

    print("② 375px：这一档真的生效")
    URL = SB.as_uri() + "/index.html"
    m = measure(URL, 375)
    check("媒体档命中（判据的前提）", m["mq"] is True, str(m["mq"]))
    check("正文满宽 = 视口 375（不是桌面的 80%＝300）",
          abs(m["content"]["w"] - 375) < 1, f"w={m['content']['w']}")
    check("正文内边距 12px 10px（不是 20px）",
          abs(float(m["content"]["padL"].rstrip("px")) - 10) < 0.5, m["content"]["padL"])
    check("封面高 260px（不是 400）", abs(m["cover"]["h"] - 260) < 1, f"h={m['cover']['h']}")
    check("封面信息条 bottom 12px（不是 45）",
          abs(float(m["info"]["bottom"].rstrip("px")) - 12) < 0.5, m["info"]["bottom"])
    # ★ 20261003 顺带修掉的那条既有缺陷：`.readInfo` 基础规则写死 880px（桌面三列的账），
    # 手机档从来没有宽度覆盖 ⇒ `left: 50%` + 横向 −50% 让这个 880px 的盒子两边各伸出屏幕
    # 一大截，靠 `overflow: hidden` 裁掉。三列时屏幕上剩的正好是中间那条标题（看不出来），
    # 改成单列之后左区/右区会全部跑到屏幕外 —— 所以单列必须与这条宽度一起改。
    check("★信息条宽 = 视口 − 32（343px，不是桌面的 880）",
          abs(m["info"]["w"] - 343) < 1, f"w={m['info']['w']}")
    check("  且两侧各留 16px 居中（左缘 16 / 右缘 359）",
          abs(m["info"]["left"] - 16) < 1 and abs(m["info"]["right"] - 359) < 1,
          f'left {m["info"]["left"]:.1f} / right {m["info"]["right"]:.1f}')
    check("描述卡满宽 375 且内边距 12px（不是 25）",
          abs(m["desc"]["w"] - 375) < 1 and abs(float(m["desc"]["padL"].rstrip("px")) - 12) < 0.5,
          f"w={m['desc']['w']} pad={m['desc']['padL']}")
    check(".markdown-body max-width 100%（不是 880px）", m["content"]["maxW"] == "100%",
          m["content"]["maxW"])

    print("③ 边界：媒体档到 768px 为止")
    m768 = measure(URL, 768)
    m769 = measure(URL, 769)
    check("768px 仍在这档里（正文满宽）", abs(m768["content"]["w"] - 768) < 1,
          f"w={m768['content']['w']}")
    check("769px 回到桌面档（正文 80%，需要时受 880 上限约束）",
          abs(m769["content"]["w"] - 769 * 0.8) < 1.5, f"w={m769['content']['w']}")
    check("  769px 封面回到 400px", abs(m769["cover"]["h"] - 400) < 1, f"h={m769['cover']['h']}")

    print("④ 反向对照：剥掉这段的 !important ⇒ 真的掉回桌面值（证明 ② 不是空断言）")
    URL2 = SB_LEGACY.as_uri() + "/index.html"
    l = measure(URL2, 375)
    check("媒体档仍命中（对面不是靠「没命中」取胜的）", l["mq"] is True, str(l["mq"]))
    check("  正文掉回 300px（＝375×80%，就是 `.readContainer .readContent` 那条）",
          abs(l["content"]["w"] - 300) < 1.5, f"w={l['content']['w']}")
    check("  正文内边距掉回 22px", abs(float(l["content"]["padL"].rstrip("px")) - 22) < 0.5,
          l["content"]["padL"])
    check("  封面掉回 400px", abs(l["cover"]["h"] - 400) < 1, f"h={l['cover']['h']}")
    check("  封面信息条掉回 45px",
          abs(float(l["info"]["bottom"].rstrip("px")) - 45) < 0.5, l["info"]["bottom"])
    # 顺带把"手机上原来是什么样"钉住：880px 的定宽盒在 375px 视口里左缘 −252.5px
    # （= 187.5 − 440），两边各伸出屏幕一大截 —— 这就是 20261003 顺带修掉的那条缺陷。
    check("  信息条掉回 880px 宽、左缘 −252.5px（整块宽出屏幕，靠裁切才看得见）",
          abs(l["info"]["w"] - 880) < 1 and l["info"]["left"] < -200,
          f'w={l["info"]["w"]} left={l["info"]["left"]:.1f}')
    # "半死"的证据：同一块里 h1 的字号没有任何桌面规则跟它抢 ⇒ 剥不剥 !important 都不变，
    # 所以肉眼看"字变小了"会以为整块在干活。这条同时是②的陪衬：不是所有声明都靠 !important 活着。
    check("  同一次对照里 `.readInfo h1` 字号**一个像素没变**（它是这块里本来就没被压的那条）",
          l["h1fs"] == m["h1fs"], f"legacy {l['h1fs']} / fixed {m['h1fs']}")

    print("⑤ 桌面档一字未动（1200px）")
    d = measure(URL, 1200)
    check("媒体档不命中", d["mq"] is False, str(d["mq"]))
    check("正文 880px（max-width 生效）", abs(d["content"]["w"] - 880) < 1, f"w={d['content']['w']}")
    check("正文内边距 22px", abs(float(d["content"]["padL"].rstrip("px")) - 22) < 0.5,
          d["content"]["padL"])
    check("封面 400px", abs(d["cover"]["h"] - 400) < 1, f"h={d['cover']['h']}")
    check("描述卡内边距 25px", abs(float(d["desc"]["padL"].rstrip("px")) - 25) < 0.5,
          d["desc"]["padL"])

    print("⑥ 正文包裹层：宽原子不许把整层顶出视口（20261005 新档）")
    # 现场：手机档文章页正文被左右切开。根因**不在媒体档**，在基础规则那条
    # `.readContent { display:flex; flex-direction:column; align-items:center }` ——
    # flex 竖列 + 居中 ⇒ 子项在**交叉轴**上按 fit-content 定尺，而 fit-content 的下限是
    # min-content。正文里只要有**一个** min-content 超过视口的原子，这一层就被顶宽、
    # 左右对称溢出；`html { overflow-x: hidden }` 把两边裁掉 ⇒ 症状是"正文被切了"，
    # 不是"能左右滑"（浏览器连滚动条都不给）。
    # 线上实测（20261005 05:5x，`/article/16`，390×844 DPR2 移动 UA）：
    #   `.readContent` = 390px(x=0)，**它的子项 = 658.7px(x=−134.4)**，`window.innerWidth`
    #   被撑到 524（视觉视口缩小）。触发它的原子就是 `<pre><code>`——`code` 拿到
    #   `white-space: pre` 之后，**最长那一行代码的宽度就是这一层的 min-content**
    #   （该文最长行 69 字符 ⇒ 598.7px > 370px 可用宽度）。
    # 修法 = 基础层给包裹层一条 `width: 100%`（`.readBody`，见 sass 同处注释）。
    WIDE_MEASURE = """(markup) => {
      document.getElementById('root').innerHTML = markup;
      const w = document.querySelector('.readBody');
      const r = w.getBoundingClientRect();
      const pre = document.querySelector('pre');
      return {
        w: +r.width.toFixed(1), l: +r.left.toFixed(1), r: +r.right.toFixed(1),
        docScrollW: document.documentElement.scrollWidth,
        clientW: document.documentElement.clientWidth,
        // 代码块自己能不能横向滑（`pre` 那条 20261005 由 hidden 改成 auto）
        preScrollW: pre ? pre.scrollWidth : null,
        preClientW: pre ? pre.clientWidth : null,
      };
    }"""

    def measure_wide(url: str) -> dict:
        pg = br.new_page(viewport={"width": 390, "height": 844})
        pg.on("pageerror", lambda e: errs.append(str(e)))
        pg.goto(url)
        pg.wait_for_timeout(120)
        out = pg.evaluate(WIDE_MEASURE, MARKUP_WIDE)
        pg.close()
        return out

    # 夹具自检：宽原子真的挂在 `.readBody` 里、`pre` 真的超宽 —— 少了这一条，下面
    # "没有溢出"在夹具根本没造出宽原子时也是绿的。
    fx = measure_wide(URL)
    check(f"★夹具自检：代码块内容宽 {fx['preScrollW']}px 远大于其可见宽 "
          f"{fx['preClientW']}px（宽原子真的造出来了，否则下面的判据是空的）",
          fx["preScrollW"] is not None and fx["preClientW"] is not None
          and fx["preScrollW"] > 3000 and fx["preScrollW"] > fx["preClientW"] * 5, str(fx))
    check("★正文包裹层 = 视口 − 左右内边距（370px，左缘 10 / 右缘 380）",
          abs(fx["w"] - 370) < 1 and abs(fx["l"] - 10) < 1 and abs(fx["r"] - 380) < 1,
          f'w={fx["w"]} l={fx["l"]} r={fx["r"]}')
    check("★页面级没有横向溢出（documentElement.scrollWidth ≤ 视口 390）",
          fx["docScrollW"] <= 390, f'scrollW={fx["docScrollW"]} clientW={fx["clientW"]}')
    check("  超长代码行由**代码块自己**横向滑（`pre` scrollWidth > clientWidth）",
          fx["preScrollW"] > fx["preClientW"], f'{fx["preScrollW"]} / {fx["preClientW"]}')

    print("⑥b 反向对照：单独摘掉 `.readBody` 那条 ⇒ 整层当场被顶出去（证明 ⑥ 不是空断言）")
    nb = measure_wide(SB_NO_BODY.as_uri() + "/index.html")
    check("★对照组里包裹层被顶到 min-content（> 2000px）且左缘远在屏幕外",
          nb["w"] > 2000 and nb["l"] < -2000, f'w={nb["w"]} l={nb["l"]}')
    check("★对照组里页面级横向溢出确实存在（这正是「被切开」的成因）",
          nb["docScrollW"] > 390, f'scrollW={nb["docScrollW"]}')
    check("  对照组与修好那版**只差那一条**（两边 `pre` 都是 auto、都在滑）",
          nb["preScrollW"] == fx["preScrollW"], f'{nb["preScrollW"]} vs {fx["preScrollW"]}')

    print("⑦ 正文列的内边距只留一处 + 手机档那三条死声明真的活了（20261005 新档）")
    # 现场：正文是**两层** `.markdown-body` 嵌套（`#content` + bytemd Viewer 自己那层），
    # 而编辑器样式表那两条 padding 是 class 选择器 —— 不管你在第几层都命中
    # ⇒ 桌面 45+45、手机 15+15 **全部叠加**。用户报的「左右两侧空白还多」就是它：
    # 线上实测 390px 左右各 40px，正文列只剩 310px。
    # 同一族的另一副面孔：媒体档里 `.markdown-body h1/p/pre` 那几条 (0,1,x) 被基础层的
    # (0,2,1)/(0,3,1) 压死，**一条都没生效过**（头注却写着"它们是干净的"）。所以本节
    # 只读 computed 值 —— "源码里写着"与"渲染成这样"在这一族里根本不是一回事。
    LAYOUT = """(markup) => {
      document.getElementById('root').innerHTML = markup;
      const cs = (s) => {
        const e = document.querySelector(s); if (!e) return null;
        const c = getComputedStyle(e), r = e.getBoundingClientRect();
        return { padL: c.paddingLeft, padR: c.paddingRight, w: +r.width.toFixed(1),
                 lh: c.lineHeight, fs: c.fontSize, x: +r.left.toFixed(1) };
      };
      return {
        vw: innerWidth, mq: matchMedia('(max-width: 768px)').matches,
        outer: cs('.readBody > .markdown-body'),
        inner: cs('.readBody > .markdown-body > .markdown-body'),
        p: cs('.readBody p'), h1: cs('.readBody h1'), pre: cs('.readBody pre'),
        pW: [...document.querySelectorAll('.readBody p')]
              .map((e) => +e.getBoundingClientRect().width.toFixed(1)),
      };
    }"""

    def measure_layout(url: str, width: int) -> dict:
        pg = br.new_page(viewport={"width": width, "height": 900})
        pg.on("pageerror", lambda e: errs.append(str(e)))
        pg.goto(url)
        pg.wait_for_timeout(120)
        out = pg.evaluate(LAYOUT, MARKUP_TEXT)
        pg.close()
        return out

    t = measure_layout(URL, 390)
    check("前提：这一节量的就是手机档", t["mq"] is True, str(t["mq"]))
    check("★两层都不再吃编辑器那 15px（外层 12 / 内层 0）",
          t["outer"]["padL"] == "12px" and t["inner"]["padL"] == "0px",
          f'外 {t["outer"]["padL"]} / 内 {t["inner"]["padL"]}')
    check(f'★正文列 {t["pW"][0]}px（= 390 − 2×10 − 2×12 = 346；改动前是 310）',
          abs(t["pW"][0] - 346) < 1, str(t["pW"]))
    check(f'  正文 17px / 行高 {t["p"]["lh"]}（= 1.7 × 17 = 28.9px；这条原来被压死，'
          f'手机档一直吃的是桌面那个行高）',
          t["p"]["fs"] == "17px" and abs(float(t["p"]["lh"].rstrip("px")) - 28.9) < 0.2, str(t["p"]))
    check(f'  `h1` = {t["h1"]["fs"]}（1.6rem；基础档 3.5rem = 56px，手机档原来也是它）',
          t["h1"]["fs"] == "25.6px", t["h1"]["fs"])
    check(f'  `pre` = {t["pre"]["fs"]}（手机档那一条原来同样没生效）',
          t["pre"]["fs"] == "13px", t["pre"]["fs"])

    d = measure_layout(URL, 1440)
    check("★桌面档正文列 836px（＝880 − 2×22，与讨论区正文列同宽，20261010 改）",
          abs(d["pW"][0] - 836) < 1 and d["outer"]["padL"] == "0px" and d["inner"]["padL"] == "0px",
          f'p={d["pW"][0]} 外 {d["outer"]["padL"]} / 内 {d["inner"]["padL"]}')
    check(f'  桌面档正文 17px / 行高 {d["p"]["lh"]}（= 1.85 × 17 ≈ 31.45px）',
          d["p"]["fs"] == "17px" and abs(float(d["p"]["lh"].rstrip("px")) - 31.45) < 0.3, str(d["p"]))
    check(f'  桌面档 `h1` 仍是 3.5rem = {d["h1"]["fs"]}（媒体档没有漏到桌面）',
          d["h1"]["fs"] == "56px", d["h1"]["fs"])

    # 20261010 补：这一条钉的是**跨组件**的不变量——正文列与讨论区（`CommentSection`）
    # 正文列同宽。它靠的是"两边容器横向内边距同值（各 22px）"，而讨论区是**另一个组件**
    # 的 sass，本套件默认不编译它。只钉自己这侧的 836 是钉不住的：哪天讨论区把 22 改成
    # 别的一档，两栏就悄悄错开、而上面那条判据照样全绿。所以现场编译那份 sass，量它
    # **渲染后**的内容盒宽（`clientWidth` 已去掉卡片那 1px 边框，再减左右内边距）。
    CMT_SASS = FE / "src/components/CommentSection/index.sass"
    cmt = subprocess.run(["node", "-e", SASS_JS, str(CMT_SASS)], cwd=str(FE),
                         capture_output=True)
    if cmt.returncode != 0:
        raise SystemExit("CommentSection sass 编译失败：\n"
                         + cmt.stderr.decode("utf-8", "replace"))
    SB_CMT = build_sandbox(cmt.stdout.decode("utf-8"), "cmt")
    CMT_MEASURE = """() => {
      document.getElementById('root').innerHTML =
        '<div class="commentSection"><div class="commentThread"><div class="commentRow">'
        + '<img class="commentAvatar" alt=""><div class="commentMain">'
        + '<div class="commentBody markdown-body"><p>讨论区正文</p></div>'
        + '</div></div></div></div>';
      const sec = document.querySelector('.commentSection');
      const cs = getComputedStyle(sec);
      const p = document.querySelector('.commentMain p').getBoundingClientRect();
      return { inner: sec.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight),
               padL: parseFloat(cs.paddingLeft), mainW: p.width };
    }"""
    pg = br.new_page(viewport={"width": 1440, "height": 900})
    pg.goto(SB_CMT.as_uri() + "/index.html")
    pg.wait_for_timeout(80)
    c = pg.evaluate(CMT_MEASURE)
    pg.close()
    check(f'★讨论区内容盒 {c["inner"]:.0f}px 与正文列 {d["pW"][0]:.0f}px 同宽'
          f'（两边容器横向内边距都是 22px；讨论区另吃卡片那 1px×2 边框，故差 2px）',
          abs(c["inner"] - d["pW"][0]) < 3 and abs(c["padL"] - 22) < 0.5,
          f'讨论区 inner={c["inner"]:.1f} padL={c["padL"]} / 正文 p={d["pW"][0]}')

    print("⑦b 反向对照：字面删掉新加的那两条内边距规则 ⇒ 手机档正文列当场掉回 310px")
    nl = measure_layout(SB_NO_PAD.as_uri() + "/index.html", 390)
    check("★对照里外层的左内边距回到编辑器那 15px（缺陷本体）",
          nl["outer"]["padL"] == "15px", nl["outer"]["padL"])
    check(f'★正文列掉回 {nl["pW"][0]}px（≤320：两层 15px 全叠才会是这个数）',
          nl["pW"][0] <= 320, str(nl["pW"]))

    print("⑧ 阅读面底色两档（20261008 换底）+ 正文补 0.2px 描边（20261005 第二轮）")
    # 同一处几轮反馈、两个不同的病：
    #   ① 底色。20261008 用户：「夜间模式什么时候改的文章详情页的背景颜色，文本都看不清了，
    #      该回去，白天模式背景也改成博客主题背景」——两档一起改，改掉的其实是同一个病：
    #      这一支从前**夜间写 transparent**，等于把阅读面的底抵押给了 `body`；而 `body` 上
    #      那张深色底是登录页一条裸 `body` 规则漏出来的。ca6b9b0（20261006）把它收成
    #      `body.login-route` ⇒ 泄漏断了，`body` 退回后台模板的 #E4E9F7 ⇒ 夜间阅读面成了
    #      33% 黑压在浅紫蓝上的 rgb(153,156,165)（白字 2.76:1）。成因全在 sass 那段注释里。
    #      本节钉**渲染值**：白天那支必须是主题底那条渐变（两端色值都在 computed 里）、
    #      **且不再等于站内内容页那支**（用户第二轮就是否掉了那支："白天怎么文章详情页是
    #      纯白，不是博客主题色系背景"——半透明白遮罩叠出来是 rgb(246,248,251) 的近白，
    #      铺满一篇长文就是一整幅白）；夜间那支必须**不透明**且是 rgb(18,26,39)。"不透明"
    #      是夜间那条判据的关键：旧写法 transparent 的 computed 值是 rgba(0,0,0,0) ⇒ 当场红
    #      （⑧c 的反向对照证明这一点）。另加一条**可读性**判据：深色正文与渐变**每一个色停**
    #      的对比度都要 ≥4.5:1 —— 主题底可以花，但不能把字压到看不清。
    #   ② 描边（20261005 第二轮「文章页字体还是看起来比讨论区细」）——正文与讨论区正文是
    #      **同一条字体栈、同一个字重(400)、同一种颜色**，差别只有字号（17 vs 14.72px）。
    #      DPR2 下量中心扫描线上的墨迹宽，两者都是 1 CSS px：CJK 在小字号被格点吸附、
    #      大字号不吸附 ⇒ 相对笔画 0.0588 vs 0.0679，字越大反而显得越细。`font-weight`
    #      在微软雅黑上推不动（只有 Light/Regular/Bold），只剩描边这一根杠杆。
    #      不重排是"能上"的前提：描边若参与排版，全站行数/分页都会动。
    def build_color_sandbox(css: str, name: str) -> pathlib.Path:
        # 与 ①②⑦ 那个沙箱**只差**一张表：`src/index.css`。底色那支 20261008 第二轮起读的是
        # `--washi-theme-bg`（出处就是这张表，线上它由 main.tsx 第一行 import）——**少一张
        # 就量不出东西**：令牌没定义时 `var()` 整条 background 落空，白天那支会变成透明
        # （而"透明"正好是旧写法，判据会以为改回去了）。
        sb = pathlib.Path(tempfile.mkdtemp(prefix=f"readcol-{name}-"))
        (sb / "read.css").write_text(css, encoding="utf-8")
        shutil.copy(RESET_CSS, sb / "main.css")
        shutil.copy(EDITOR_CSS, sb / "editor.css")
        shutil.copy(FE / "src/index.css", sb / "tokens.css")
        (sb / "index.html").write_text(
            '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">'
            '<link rel="stylesheet" href="main.css"><link rel="stylesheet" href="tokens.css">'
            '<link rel="stylesheet" href="editor.css"><link rel="stylesheet" href="read.css">'
            '</head><body><div id="root"></div></body></html>', encoding="utf-8")
        return sb

    # 不重排那一臂：按**字面**把描边摘掉（1 处，锚点命中数先断言），其余一字不动。
    # 与 ⑦b 同一取法：不读 `git show HEAD:`（提交之后两条臂会逐字相同、红基线恒真）。
    STROKE = "-webkit-text-stroke: 0.2px currentColor;"
    if CSS.count(STROKE) != 1:
        raise SystemExit(f"编译产物里 `{STROKE}` 出现 {CSS.count(STROKE)} 次（应为 1）"
                         " —— 描边那条改名/挪窝了，⑧ 的不重排对照要先对齐")
    NO_STROKE = CSS.replace(STROKE, "-webkit-text-stroke: 0;")
    SB_COLOR = build_color_sandbox(CSS, "theme")
    SB_NO_STROKE = build_color_sandbox(NO_STROKE, "bare")

    # ⑧c 的反向对照：把夜间那支**按行为**改回旧写法（transparent）⇒ 判据必须当场红。
    # 为什么非要这一臂：本轮修的病**全在"不透明"这三个字上**，而"不透明"在源码文本里
    # 看不出来（`background: transparent` 与 `background: #121a27` 都是一行合法 sass，
    # 而前者在脱离泄漏之后会静默变成浅灰底）。剥掉行为、量到的也必须是行为。
    # 取法是锚点（正则命中那一块 + 块内那条 background）而不是写死字符串：dart-sass
    # 对 `#121a27` 的输出形式（hex 还是 rgb()）不是本套件该钉的东西。
    _m = re.search(r"\.frontDark \.readContainer\s*\{([^}]*)\}", CSS)
    if not _m:
        raise SystemExit("编译产物里找不到 `.frontDark .readContainer{}` —— 夜间底色挪窝了，"
                         "⑧c 的反向对照要先对齐")
    _bg = re.search(r"background:\s*[^;]+;", _m.group(0))
    if not _bg:
        raise SystemExit(f"夜间那一块里没有 background：{_m.group(0)!r}")
    SB_NIGHT_OLD = build_color_sandbox(
        CSS.replace(_m.group(0), _m.group(0).replace(_bg.group(0), "background: transparent;")),
        "oldnight")

    COLOR = """(arg) => {
      document.getElementById('root').innerHTML = arg.markup;
      const cs = (s) => {
        const e = document.querySelector(s); if (!e) return null;
        const c = getComputedStyle(e), r = e.getBoundingClientRect();
        return { bg: c.backgroundColor, bi: c.backgroundImage,
                 sw: c.webkitTextStrokeWidth, sc: c.webkitTextStrokeColor,
                 color: c.color, w: +r.width.toFixed(2), h: +r.height.toFixed(2), fs: c.fontSize };
      };
      const inner = '.readBody > .markdown-body > .markdown-body';
      const p = document.querySelector(inner + ' > p');
      // 行数用 Range 数**行框**：段落折了几行是"有没有重排"最直接的证据
      //（宽高在 836 这种定宽列里可能因为最后一行断点位置而凑巧相等，行数不会）。
      const rg = document.createRange();
      rg.selectNodeContents(p);
      return {
        light: cs('.readContainer'),
        p: cs(inner + ' > p'),
        li: cs('.readBody li'), h1: cs('.readBody h1'),
        pre: cs('.readBody pre'), code: cs('.readBody pre code'),
        inlineCode: cs(inner + ' > p > code'),
        lines: rg.getClientRects().length,
        tile: getComputedStyle(document.documentElement)
                .getPropertyValue('--container-background-color').trim(),
        themebg: getComputedStyle(document.documentElement)
                .getPropertyValue('--washi-theme-bg').trim(),
      };
    }"""

    def measure_color(sb: pathlib.Path, dark: bool) -> dict:
        markup = (COLOR_MARKUP.replace('class="frontRoot"', 'class="frontRoot frontDark"')
                  if dark else COLOR_MARKUP)
        pg = br.new_page(viewport={"width": 1440, "height": 900})
        pg.on("pageerror", lambda e: errs.append(str(e)))
        pg.goto(sb.as_uri() + "/index.html")
        pg.wait_for_timeout(120)
        out = pg.evaluate(COLOR, {"markup": markup})
        pg.close()
        return out

    cl = measure_color(SB_COLOR, dark=False)
    cd = measure_color(SB_COLOR, dark=True)
    co = measure_color(SB_NIGHT_OLD, dark=True)
    _nz = lambda s: re.sub(r"\s+", "", s or "")  # noqa: E731 —— 归一化空白后再比字面

    def _norm_bg(s: str) -> str:
        # 令牌的**声明值**是 `#fff6fa` 这种十六进制，浏览器把它**算**成 `rgb(255, 246, 250)`
        # 才放进 background-image。要比"渲染出来的就是那一支"，就得先归一到同一种写法，
        # 否则比的是"十六进制 ≠ rgb()"这种格式差异（20261008 当场踩到，两条判据假红）。
        s = (s or "").lower()
        s = re.sub(r"#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})",
                   lambda m: "rgb(%d,%d,%d)" % tuple(int(v, 16) for v in m.groups()), s)
        return _nz(s)

    check("前提：两支令牌都解析出来了（少一支下面量的是空/落空）",
          "255, 255, 255" in cl["tile"] and "0.6" in cl["tile"]
          and "rgb(255,246,250)" in _norm_bg(cl["themebg"])
          and "rgb(233,244,255)" in _norm_bg(cl["themebg"]),
          f'内容页那支 {cl["tile"]!r} / 主题底 {cl["themebg"]!r}')
    check("★白天档 = **主题底**：`.readContainer` 的 background-image 就是 `--washi-theme-bg`"
          "（粉紫天青那张，与首页首屏/登录页同源）",
          _norm_bg(cl["light"]["bi"]) == _norm_bg(cl["themebg"]),
          f'读到 {cl["light"]["bi"]!r} / 令牌 {cl["themebg"]!r}')
    check("★白天档**不再**是站内内容页那支半透明白遮罩（20261008 第二轮用户否掉的就是它："
          "铺满一篇长文是一整幅白，看不出主题色）",
          _norm_bg(cl["light"]["bi"]) != _norm_bg(cl["tile"])
          and "233, 244, 255" in cl["light"]["bi"],
          f'读到 {cl["light"]["bi"]!r}')
    # 可读性：主题底可以花，但不能把字压到看不清。渐变里最亮的那个色停是最坏情况。
    def _lum(c):
        def f(v):
            v = v / 255
            return v / 12.92 if v <= 0.03928 else ((v + 0.055) / 1.055) ** 2.4
        r, g, b = (f(x) for x in c)
        return 0.2126 * r + 0.7152 * g + 0.0722 * b

    def _ratio(c1, c2):
        a, bb = _lum(c1), _lum(c2)
        return (max(a, bb) + 0.05) / (min(a, bb) + 0.05)

    _stops = [tuple(int(v) for v in m) for m in
              re.findall(r"rgb\((\d+), (\d+), (\d+)\)", cl["light"]["bi"])]
    _ink = tuple(int(v) for v in re.match(r"rgba?\((\d+), (\d+), (\d+)", cl["p"]["color"]).groups())
    _worst = min((_ratio(_ink, s), s) for s in _stops) if _stops else (0, None)
    check(f'★正文压在这条渐变上仍然看得清：与每个色停的对比度都 ≥4.5（最差 {_worst[0]:.1f}:1）',
          len(_stops) >= 2 and _worst[0] >= 4.5, f'色停 {_stops} / 字色 {cl["p"]["color"]}')
    check("★夜间档 = 不透明深墨蓝 rgb(18,26,39)（= 20261006 之前屏幕上的那一档；"
          "computed 值不带 alpha，就是「不透明」这个判据本身）",
          cd["light"]["bg"] == "rgb(18, 26, 39)", cd["light"]["bg"])
    check("★⑧c 反向对照：同一份产物把夜间那支按行为改回 transparent ⇒ 当场不是那个色"
          "（旧写法在泄漏断掉之后就会静默变成浅灰底，这条对照证明上面那条判据咬得住）",
          co["light"]["bg"] == "rgba(0, 0, 0, 0)" and co["light"]["bg"] != "rgb(18, 26, 39)",
          co["light"]["bg"])
    check("★正文（含列表、标题）带 0.2px 描边，颜色 = 当前字色（`currentColor`）",
          cl["p"]["sw"] == "0.2px" and cl["li"]["sw"] == "0.2px" and cl["h1"]["sw"] == "0.2px"
          and cl["p"]["sc"] == cl["p"]["color"],
          f'p {cl["p"]["sw"]} / li {cl["li"]["sw"]} / h1 {cl["h1"]["sw"]}，'
          f'描边色 {cl["p"]["sc"]} vs 字色 {cl["p"]["color"]}')
    check("★代码清零：`pre`/`pre code`/行内 `code` 三处都是 0px（深底浅字描边会失衡）",
          cl["pre"]["sw"] == "0px" and cl["code"]["sw"] == "0px"
          and cl["inlineCode"]["sw"] == "0px",
          f'pre {cl["pre"]["sw"]} / pre code {cl["code"]["sw"]} / 行内 {cl["inlineCode"]["sw"]}')
    check(f'  描边没有改字号（正文仍 {cl["p"]["fs"]}）', cl["p"]["fs"] == "17px", cl["p"]["fs"])

    cn = measure_color(SB_NO_STROKE, dark=False)
    check("  对照臂的前提：描边真的没了（正文 0px）", cn["p"]["sw"] == "0px", cn["p"]["sw"])
    check(f'★不重排：同段落的宽 {cl["p"]["w"]} / 高 {cl["p"]["h"]} / 行数 {cl["lines"]} '
          f'与摘掉描边那臂（{cn["p"]["w"]} / {cn["p"]["h"]} / {cn["lines"]}）逐项相同',
          cl["p"]["w"] == cn["p"]["w"] and cl["p"]["h"] == cn["p"]["h"]
          and cl["lines"] == cn["lines"],
          f'带描边 {cl["p"]["w"]}×{cl["p"]["h"]} {cl["lines"]} 行 / '
          f'不带 {cn["p"]["w"]}×{cn["p"]["h"]} {cn["lines"]} 行')
    check(f'  夹具自检：那一段真的折成了多行（{cl["lines"]} 行 ≥ 3，否则行数判据无分辨力）',
          cl["lines"] >= 3, str(cl["lines"]))

    # 负空间一：主题底那张纸是**跨文件同源**的（ReadArticle / 首页首屏 `.collageBg` /
    # 登录页两条），20261008 收成 `--washi-theme-bg` 一支。只量这一页，量得再对也不代表
    # 那三处还牵着手 ⇒ 这里按**源码**数：三处都只写 `var(--washi-theme-bg)`、都不再写那张
    # 渐变的字面值（写着字面值就是"改一处必须同步另一处"的形状，那正是收令牌要治的病）。
    # 只有 `src/index.css` 该出现字面值，且只出现一次。
    _CONSUMERS = ["src/pages/Login/index.sass",
                  "src/frontHome/Content/ContentHome/index.sass",
                  "src/frontHome/Content/ReadArticle/index.sass"]
    _LIT = "linear-gradient(160deg, #fff6fa"
    _lit_bad = [p for p in _CONSUMERS
                if _LIT in (FE / p).read_text(encoding="utf-8")]
    _var_missing = [p for p in _CONSUMERS
                    if "var(--washi-theme-bg)" not in (FE / p).read_text(encoding="utf-8")]
    _tok = (FE / "src/index.css").read_text(encoding="utf-8")
    check("★主题底三处同源、值只写一份：首页首屏/登录页/文章阅读面都写 `var(--washi-theme-bg)`，"
          "都不再抄那张渐变的字面值（字面值只该在 `src/index.css` 里出现一次）",
          not _lit_bad and not _var_missing and _tok.count("--washi-theme-bg:") == 1,
          f'仍写字面值的 {_lit_bad} / 没写 var 的 {_var_missing} / '
          f'index.css 里定义 {_tok.count("--washi-theme-bg:")} 次')
    # 负空间一之二：这一支**不许有夜间档**。`.frontDark, .dark, .washiDark` 那档也挂在 body 上
    # （后台/浮层用），而 var() 是继承来的 —— 一旦给它一个暗值，白天臂会被一个挂在 body 上的
    # `.washiDark` 悄悄翻黑（令牌不看你自己那支是不是夜间臂）。
    _nightblock = re.search(r"\.frontDark,\s*\.dark,\s*\.washiDark\s*\{([\s\S]*?)\n\}", _tok)
    check("★主题底**只定义在这一档**（`.frontDark, .dark, .washiDark` 那档里不许出现它）",
          _nightblock is not None and "--washi-theme-bg" not in _nightblock.group(1),
          "夜间档里也定义了它" if _nightblock else "找不到夜间令牌块")

    # 负空间二：米白那个令牌 20261008 随它的唯一用处一起删了。判据同样只认编译产物。
    check("★`--washi-paper-warm` 在编译产物里一次都不出现（零引用的令牌不许留）",
          "--washi-paper-warm" not in CSS, "还在")

    # 负空间：这个类名是 JSX 与 sass 之间**唯一的**接缝，改名一边就是静默失效
    # （`className='readBody'` 还在、sass 那边没规则 ⇒ 上面两组判据全绿而线上照旧）。
    _tsx = (FE / "src/frontHome/Content/ReadArticle/index.tsx").read_text(encoding="utf-8")
    check("★`index.tsx` 里那个 motion.div 挂着 className='readBody'（同名接缝）",
          "className='readBody'" in _tsx, "找不到这个字面")

    check("无 JS 运行时报错", not errs, "；".join(errs[:3]))
    br.close()

print(f"\n{'✗' if FAIL else '✓'} read-mobile：{PASS} 通过 / {FAIL} 失败")
raise SystemExit(1 if FAIL else 0)
