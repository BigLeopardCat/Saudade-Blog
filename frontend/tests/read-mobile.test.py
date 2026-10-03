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
  ⑤ 1200px 桌面档一字未动：正文 880px / 内边距 20px / 封面 400px / 描述卡内边距 25px。

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

# 与 index.tsx 同形：.readContainer > (.readCover > .readInfo) + .readDescription
# + .readContent.markdown-body（正文那两个类在同一个元素上，见 index.tsx:622）
# `.readInfo` 里只渲染中区（标题那一格）：本套件量的是正文/描述卡/封面的几何与标题字号，
# 左区（作者+时间）与右区（读数四件）不参与任何一条判据 —— 它们的几何在
# `read-stats-cluster.test.py` 里是主角，那边有完整的三区夹具。
MARKUP = """
<div class="readContainer">
  <div class="readCover">
    <div class="readInfo"><div class="readMain"><h1>标题</h1></div></div>
  </div>
  <div class="readDescription"><p>摘要</p></div>
  <div class="readContent markdown-body"><p>正文</p></div>
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
    "overflow-x: hidden !important",
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
    (sb / "index.html").write_text(
        '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">'
        '<link rel="stylesheet" href="main.css"><link rel="stylesheet" href="read.css">'
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

SB = build_sandbox(CSS, "fixed")
SB_LEGACY = build_sandbox(LEGACY, "legacy")

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

    check("无 JS 运行时报错", not errs, "；".join(errs[:3]))
    br.close()

print(f"\n{'✗' if FAIL else '✓'} read-mobile：{PASS} 通过 / {FAIL} 失败")
raise SystemExit(1 if FAIL else 0)
