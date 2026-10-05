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
`tests/sass-media-shadow.test.mjs`（特异性档）全仓盯着，这一份只管"渲染出来是什么"。）
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
    check("  正文内边距掉回 20px", abs(float(l["content"]["padL"].rstrip("px")) - 20) < 0.5,
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
    check("正文内边距 20px", abs(float(d["content"]["padL"].rstrip("px")) - 20) < 0.5,
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
    check("★桌面档正文列仍是 660px（＝840 − 2×90，与改动前逐像素同宽）",
          abs(d["pW"][0] - 660) < 1 and d["outer"]["padL"] == "90px" and d["inner"]["padL"] == "0px",
          f'p={d["pW"][0]} 外 {d["outer"]["padL"]} / 内 {d["inner"]["padL"]}')
    check(f'  桌面档正文 17px / 行高 {d["p"]["lh"]}（= 1.85 × 17 ≈ 31.45px）',
          d["p"]["fs"] == "17px" and abs(float(d["p"]["lh"].rstrip("px")) - 31.45) < 0.3, str(d["p"]))
    check(f'  桌面档 `h1` 仍是 3.5rem = {d["h1"]["fs"]}（媒体档没有漏到桌面）',
          d["h1"]["fs"] == "56px", d["h1"]["fs"])

    print("⑦b 反向对照：字面删掉新加的那两条内边距规则 ⇒ 手机档正文列当场掉回 310px")
    nl = measure_layout(SB_NO_PAD.as_uri() + "/index.html", 390)
    check("★对照里外层的左内边距回到编辑器那 15px（缺陷本体）",
          nl["outer"]["padL"] == "15px", nl["outer"]["padL"])
    check(f'★正文列掉回 {nl["pW"][0]}px（≤320：两层 15px 全叠才会是这个数）',
          nl["pW"][0] <= 320, str(nl["pW"]))

    # 负空间：这个类名是 JSX 与 sass 之间**唯一的**接缝，改名一边就是静默失效
    # （`className='readBody'` 还在、sass 那边没规则 ⇒ 上面两组判据全绿而线上照旧）。
    _tsx = (FE / "src/frontHome/Content/ReadArticle/index.tsx").read_text(encoding="utf-8")
    check("★`index.tsx` 里那个 motion.div 挂着 className='readBody'（同名接缝）",
          "className='readBody'" in _tsx, "找不到这个字面")

    check("无 JS 运行时报错", not errs, "；".join(errs[:3]))
    br.close()

print(f"\n{'✗' if FAIL else '✓'} read-mobile：{PASS} 通过 / {FAIL} 失败")
raise SystemExit(1 if FAIL else 0)
