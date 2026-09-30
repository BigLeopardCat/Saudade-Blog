#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""文章横幅「收藏」按钮竖排（20260926）。

  python3 tests/read-fav-vertical.test.py

现场（用户报的）：「文章页面已收藏的文本改为竖着排，因为有时会被挤成三个字两行」。
20261001 追加第 ⑦ 组（用户第 4 条：「收藏按钮，点赞按钮，浏览数图标风格不一致，且布局
没有锁死，会被标题长度影响」）：标记改成**真的三区结构**（`.readAuthor` / `.readMain` /
两个读数簇），并新增"四种标题长度下右区几何逐字相同"的判据。
成因是布局而不是字：`.readInfo` 是 flex 行（`index.sass:61`），标题一长就把最后那个
`.readFavWrap` 挤窄，按钮是 `padding: 2px 12px` 的胶囊 ⇒ 内容盒装不下「已收藏」三字
（13px × 3 ≈ 39px）⇒ 折成「已收」「藏」。

为什么用无头浏览器而不是 node 桩：这是**布局**问题（flex 收缩、行盒、竖排书写模式），
桩里算不出 flex 收缩后的真实宽度。真 CSS = node 侧真编译的 `.sass` + 仓库里那份
`* { box-sizing: border-box }` 重置（`src/frontHome/main.css`），页面里手写与
`index.tsx` 同形的标记（不挂 React——按钮的类名与结构就是全部接口）。

锁七件：
  ① 竖排真的生效（writing-mode / text-orientation 的计算值）；
  ② 文案盒高 > 宽（竖起来了一列，不是横着的一行）；
  ③ **挤压回归**（这条就是用户报的那件事）：超长标题 + 327px 窄屏下，文案只有**一个**
     行盒（`getClientRects().length === 1`）、且 `.readFavWrap` 不比按钮窄（没被挤小）；
     ③b 反向对照：把 wrap 的 flex 改回可收缩（`0 1 auto`）时它**确实会**被挤小——
     证明这个场景真的会触发，③ 不是空断言；
  ④ ★ 仍在（与文案分开的两个 span），且 `aria-hidden="true"`；
  ⑤ 已收藏态底色仍是河灯金 `#ffcc7c`，未收藏态仍是透明 + 描边（三态色一字未改）；
  ⑥ 窄屏（327px）同样不折；
  ⑦ 布局锁死：短/中/长/超长四种标题下，中区里日期与右区两簇的四个坐标**逐字相同**，
     整张卡的高度也不变；并带一条反向对照（把 `.readMain` 拆回平级三项 + `space-between`
     ⇒ 日期当场漂走），证明 ⑦ 不是空断言。
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

# 与 index.tsx 同形的标记：.readContainer > .readCover > .readInfo > .readFavWrap > button
# （antd 的 Flex 用普通 div 代替——它的宽度不影响本套件的三条判据）
MARKUP = """
<div class="readContainer">
  <div class="readCover">
    <div class="readInfo">
      <div class="ant-flex readAuthor"><span class="frontAvatar">头像</span>泠月</div>
      <div class="readMain">
        <h1 id="title">{title}</h1>
        <h3 id="date">2026-09-26</h3>
      </div>
      <div class="readFavWrap" id="wrap">
        <button type="button" class="readFavBtn{faved}" id="btn">
          <svg aria-hidden="true" width="14" height="14" id="star"></svg>
          <span class="readFavLabel" id="label">{text}</span>
        </button>
      </div>
      <div class="readLikeWrap" id="like">
        <span class="readViews" id="views"><svg width="14" height="14"></svg>
          <span class="readViewsNum">128</span></span>
        <button type="button" class="readLikeBtn" id="likebtn">
          <svg aria-hidden="true" width="14" height="14" id="heart"></svg>
          <span class="readLikeNum">7</span></button>
      </div>
    </div>
  </div>
</div>
"""

LONG_TITLE = "一篇标题特别长的文章：从零开始把站内对话助手接进个人博客的完整记录与踩坑清单（下篇）"


def build_sandbox() -> pathlib.Path:
    sb = pathlib.Path(tempfile.mkdtemp(prefix="readfav-"))
    r = subprocess.run(["node", "-e", SASS_JS, str(SASS_FILE)],
                       cwd=str(FE), capture_output=True)
    if r.returncode != 0:
        raise SystemExit("sass 编译失败：\n" + r.stderr.decode("utf-8", "replace"))
    (sb / "read.css").write_text(r.stdout.decode("utf-8"), encoding="utf-8")
    shutil.copy(RESET_CSS, sb / "main.css")
    (sb / "index.html").write_text(
        '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">'
        '<link rel="stylesheet" href="main.css"><link rel="stylesheet" href="read.css">'
        '</head><body><div id="root"></div></body></html>',
        encoding="utf-8")
    return sb


SANDBOX = build_sandbox()
URL = SANDBOX.as_uri() + "/index.html"

from playwright.sync_api import sync_playwright  # noqa: E402

PAINT = """(o) => {
  const root = document.getElementById('root');
  root.innerHTML = o.markup;
  const wrap = document.getElementById('wrap');
  const lbl = document.getElementById('label');
  if (o.legacy) {
    // 反向对照（第 ⑦b 组）：把 `.readMain` 那一层拆掉（`display: contents`）+
    // 复原 20261001 之前的 `space-between` —— 日期就该跟着标题长短漂走。
    document.querySelector('.readInfo').style.justifyContent = 'space-between';
    // 反向对照：把这套修复整个撤回原状（20260926 之前就是这三条），证明"标题一长会把
    // 文案挤成两行"这件事在这个场景里**真的会发生**——否则 ③ 是空断言。
    wrap.style.flex = '0 1 auto';
    lbl.style.writingMode = 'horizontal-tb';
    lbl.style.whiteSpace = 'normal';
    lbl.style.textOrientation = 'mixed';
  }
  const btn = document.getElementById('btn');
  const label = document.getElementById('label');
  const cs = getComputedStyle(label);
  const lr = label.getBoundingClientRect();
  const br = btn.getBoundingClientRect();
  const wr = wrap.getBoundingClientRect();
  // **行盒计数必须用 Range**：`element.getClientRects()` 给的是元素的边框盒，
  // 块级/弹性子项折了几行都只有一个（那是"元素占几块地方"，不是"排了几行"）；
  // Range 逐个行盒给矩形 —— 横向折成两行就是两个，竖排一列就是一个。
  const rng = document.createRange();
  rng.selectNodeContents(label);
  return {
    writingMode: cs.writingMode || cs.webkitWritingMode,
    textOrientation: cs.textOrientation || cs.webkitTextOrientation,
    whiteSpace: cs.whiteSpace,
    labelRects: label.getClientRects().length,
    labelLines: rng.getClientRects().length,
    lineTops: [...rng.getClientRects()].map((x) => Math.round(x.top)),
    lineLefts: [...rng.getClientRects()].map((x) => Math.round(x.left)),
    labelW: lr.width, labelH: lr.height,
    btnW: br.width, wrapW: wr.width, wrapH: wr.height,
    wrapFlex: getComputedStyle(wrap).flex,
    titleW: document.getElementById('title').getBoundingClientRect().width,
    titleH: document.getElementById('title').getBoundingClientRect().height,
    // 标题**盒**宽是恒定的（它吃满中区），"标题变长了"只能看行盒：一行 / 两行
    titleLines: (() => { const g = document.createRange();
      g.selectNodeContents(document.getElementById('title'));
      return g.getClientRects().length; })(),
    starTag: document.querySelector('.readFavBtn > [aria-hidden="true"]').tagName,
    starHidden: document.querySelector('.readFavBtn > [aria-hidden="true"]').getAttribute('aria-hidden'),
    starW: document.querySelector('.readFavBtn > [aria-hidden="true"]').getBoundingClientRect().width,
    viewIconW: document.querySelector('.readViews > [aria-hidden], .readViews > svg')
                 .getBoundingClientRect().width,
    favLeft: wr.left, favRight: wr.right,
    likeLeft: document.getElementById('like').getBoundingClientRect().left,
    dateLeft: document.getElementById('date').getBoundingClientRect().left,
    dateTop: document.getElementById('date').getBoundingClientRect().top,
    infoH: document.querySelector('.readInfo').getBoundingClientRect().height,
    labelText: label.textContent,
    btnBg: getComputedStyle(btn).backgroundColor,
    btnBorderColor: getComputedStyle(btn).borderTopColor,
    overflows: document.documentElement.scrollWidth > window.innerWidth,
  };
}"""

with sync_playwright() as p:
    br = p.chromium.launch()
    pg = br.new_page(viewport={"width": 1280, "height": 900})
    errs: list[str] = []
    pg.on("pageerror", lambda e: errs.append(str(e)))
    pg.goto(URL)
    pg.wait_for_timeout(150)

    faved = MARKUP.format(title=LONG_TITLE, faved=" isFaved", star="★", text="已收藏")
    plain = MARKUP.format(title=LONG_TITLE, faved="", star="☆", text="收藏")

    print("① 竖排真的生效")
    r = pg.evaluate(PAINT, {"markup": faved})
    check("writing-mode = vertical-rl", r["writingMode"] == "vertical-rl", r["writingMode"])
    check("text-orientation = upright（★ 也跟着直立）", r["textOrientation"] == "upright",
          r["textOrientation"])
    check("white-space = nowrap（竖排不许再折成第二列）", r["whiteSpace"] == "nowrap",
          r["whiteSpace"])

    print("② 文案盒高 > 宽（竖起来的一列）")
    check("高 > 宽", r["labelH"] > r["labelW"], f"{r['labelW']}×{r['labelH']}")
    check("文案仍在（三个字没被截）", r["labelText"] == "已收藏", r["labelText"])

    print("③ 挤压回归：超长标题下也不折行、不被挤小")
    check("文案只有一个行盒（没折成两行）", r["labelLines"] == 1, str(r["labelLines"]))
    check("按钮里装得下文案（按钮不窄于文案）", r["btnW"] >= r["labelW"] - 0.5,
          f"btn {r['btnW']} / label {r['labelW']}")
    check(".readFavWrap 不比按钮窄（没被 flex 挤小）", r["wrapW"] >= r["btnW"] - 0.5,
          f"wrap {r['wrapW']} / btn {r['btnW']}")
    check("wrap 的 flex 是 0 0 auto（不收缩的那一份）", r["wrapFlex"] == "0 0 auto", r["wrapFlex"])
    check("标题确实占掉了空间（否则这个场景没被复现）",
          r["titleW"] > 200, f"title {r['titleW']}")
    # 与"标题短、容器不挤"的同一份标记比：宽度一模一样才说明真的没被挤（比阈值更硬）
    rnat = pg.evaluate(PAINT, {"markup": MARKUP.format(title="短标题", faved=" isFaved",
                                                       star="★", text="已收藏")})
    check("与短标题时的自然宽度相等（一个像素都没被挤掉）",
          abs(r["wrapW"] - rnat["wrapW"]) < 0.5,
          f"长标题 {r['wrapW']} / 短标题 {rnat['wrapW']}")

    print("③b 反向对照：撤回修复后**真的**折成两行（证明 ③ 不是空断言）")
    r2 = pg.evaluate(PAINT, {"markup": faved, "legacy": True})
    check("撤回修复 ⇒ 文案折成两行（用户截图那个现象）", r2["labelLines"] >= 2,
          f"lines {r2['labelLines']} / label {r2['labelW']}×{r2['labelH']}")
    check("  那两行是**上下叠**的（横向折行，不是竖排的一列）",
          len(r2["lineTops"]) >= 2 and r2["lineTops"][1] > r2["lineTops"][0],
          f"tops {r2['lineTops']} / label {r2['labelW']}×{r2['labelH']}")
    check("  修好之后只有一列（tops 只有一个）",
          len(r["lineTops"]) == 1, f"tops {r['lineTops']}")
    r3 = pg.evaluate(PAINT, {"markup": faved, "legacy": True})
    check("  对照可复现（第二次同样结果）", r3["labelLines"] == r2["labelLines"],
          f"{r3['labelLines']} vs {r2['labelLines']}")

    print("④ 图标与文案是两个子元素，图标 aria-hidden 且与眼睛同尺寸（用户第 4 条）")
    check("图标是 svg（不再是文本字形 ★ —— 与同一排的描边眼睛同源）",
          r["starTag"] == "svg", r["starTag"])
    check("aria-hidden = true（读屏只念「已收藏」）", r["starHidden"] == "true",
          str(r["starHidden"]))
    check("图标 14px = 浏览数那只眼睛的尺寸（同一排三件同尺寸）",
          abs(r["starW"] - 14) < 0.5 and abs(r["viewIconW"] - 14) < 0.5,
          f'star {r["starW"]} / eye {r["viewIconW"]}')
    check("图标与文案没有合并成一个元素（文案仍在 span.readFavLabel 里）",
          r["labelText"] == "已收藏", r["labelText"])

    print("⑤ 三态色一字未改")
    check("已收藏 = 河灯金 #ffcc7c", r["btnBg"] in ("rgb(255, 204, 124)",), r["btnBg"])
    r4 = pg.evaluate(PAINT, {"markup": plain})
    check("未收藏 = 透明底 + 浅色描边", r4["btnBg"] in ("rgba(0, 0, 0, 0)", "transparent"),
          r4["btnBg"])
    check("  描边仍在（rgba(255,241,235,.55)）", "255, 241, 235" in r4["btnBorderColor"],
          r4["btnBorderColor"])
    check("  未收藏文案 = 收藏（两字）", r4["labelText"] == "收藏", r4["labelText"])

    print("⑥ 窄屏（327px，用户截图那档）同样不折")
    pg.set_viewport_size({"width": 327, "height": 800})
    r5 = pg.evaluate(PAINT, {"markup": faved})
    check("文案仍是一个行盒", r5["labelLines"] == 1, str(r5["labelLines"]))
    check("wrap 仍未被挤小", r5["wrapW"] >= r5["btnW"] - 0.5, f"wrap {r5['wrapW']} / btn {r5['btnW']}")
    check("竖排仍生效", r5["writingMode"] == "vertical-rl", r5["writingMode"])

    print("⑦ 布局锁死：四种标题长度下右区/日期几何逐字相同（用户第 4 条）")
    pg.set_viewport_size({"width": 1280, "height": 900})
    titles = ["短文", "一篇中等长度的文章标题",
              "一篇标题特别长的文章：从零开始把站内对话助手接进个人博客的完整记录与踩坑清单（下篇）",
              "一篇标题特别长的文章：从零开始把站内对话助手接进个人博客的完整记录与踩坑清单（下篇）"
              "——再补一段足够长的副标题把这一行彻底撑满看看会发生什么"]
    got = []
    for t in titles:
        got.append(pg.evaluate(PAINT, {"markup": MARKUP.format(title=t, faved=" isFaved",
                                                               text="已收藏")}))
    key = lambda r: (round(r["dateLeft"], 1), round(r["dateTop"], 1),
                     round(r["favLeft"], 1), round(r["likeLeft"], 1), round(r["infoH"], 1))
    check("★ 四档标题下（日期 x/y、收藏左缘、点赞左缘、卡片高）逐字相同",
          len({key(x) for x in got}) == 1, str([key(x) for x in got]))
    # ⚠️ `Range` 数的是**排版出来的**行盒，被 `-webkit-line-clamp` 裁掉的那几行仍在
    # 布局里 ⇒ 超长标题这里读到 4 而不是 2。这正是我们要的证据：标题远超两行，
    # 而盒高被上面那条判据钉死在两行。
    check("  · 标题确实长出来了（否则这个场景没被复现）：一行 → 四行",
          got[0]["titleLines"] == 1 and got[-1]["titleLines"] >= 3,
          f'{got[0]["titleLines"]} → {got[-1]["titleLines"]}')
    check("  · 三行标题被截到两行（高度封顶，卡片不会被拉高）",
          got[-1]["titleH"] <= got[0]["titleH"] + 0.5,
          f'{got[0]["titleH"]} vs {got[-1]["titleH"]}')
    check("  · 一行的标题也占两行的高度（高度恒定靠的是预留，不是靠标题别太长）",
          abs(got[0]["titleH"] - got[-1]["titleH"]) < 0.5,
          f'{got[0]["titleH"]} vs {got[-1]["titleH"]}')

    print("⑦b 反向对照：拆回平级三项 + `space-between`，日期当场漂走")
    legacy = MARKUP.replace('<div class="readMain">', '<div style="display:contents">')
    lr = pg.evaluate(PAINT, {"markup": legacy.format(title=titles[0], faved=" isFaved",
                                                     text="已收藏"), "legacy": True})
    lr2 = pg.evaluate(PAINT, {"markup": legacy.format(title=titles[-1], faved=" isFaved",
                                                      text="已收藏"), "legacy": True})
    check("  拆回平级后日期位置确实随标题长度变（⑦ 不是空断言）",
          abs(lr["dateLeft"] - lr2["dateLeft"]) > 40,
          f'{lr["dateLeft"]} → {lr2["dateLeft"]}')
    check("  同一份标记、只换标题 ⇒ 收藏簇也跟着挪（旧形态就是三区一起漂）",
          abs(lr["favLeft"] - lr2["favLeft"]) > 20,
          f'{lr["favLeft"]} → {lr2["favLeft"]}')

    check("无 JS 运行时报错", not errs, "; ".join(errs[:2]))
    br.close()

shutil.rmtree(SANDBOX, ignore_errors=True)
print(f"\n{'✗' if FAIL else '✓'} read-fav-vertical：{PASS} 通过 / {FAIL} 失败")
raise SystemExit(1 if FAIL else 0)
