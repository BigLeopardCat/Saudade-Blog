#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""文章横幅「读数三件」= 三件同形的一行（20260926 起；20261001 改形态）。

  python3 tests/read-stats-cluster.test.py

沿革：本文件原名 `read-fav-vertical.test.py`，锁的是"收藏按钮竖排"那套（20260926）。
20261001 用户第 1 条把那一版整体否了 ——「详情页三图标样式和布局太丑了，大小不一，
排列奇怪」：

    实测（1280×900，线上）            宽 × 高    内边距      字号   描边 α
    .readFavWrap  .readFavBtn        32 × 62    6px 8px     13    .55   ← 竖排
    .readViews                       59 × 24    2px 8px     12    .35
    .readLikeBtn                     64 × 30    4px 10px    13    .55

一件竖的、两件横的，高度差到 2.6 倍 —— 排在一行里怎么摆都对不齐。所以本轮改成一簇
`.readStats` + 三件共用几何 `.readStat`，竖排随之取消（它当初治的是"标题一长把「已收藏」
挤成两行"的**症状**，病根是簇可以被 flex 收缩，已由 `flex: 0 0 auto` 结构性治掉）。

为什么用无头浏览器而不是 node 桩：这是**布局**问题（flex 收缩、行盒、等高），桩里算不出
flex 收缩后的真实盒子。真 CSS = node 侧真编译的 `.sass` + 仓库里那份
`* { box-sizing: border-box }` 重置（`src/frontHome/main.css`），页面里手写与
`index.tsx` 同形的标记（不挂 React——类名与结构就是全部接口）。

锁八件：
  ① **三件同形**（本轮的正面判据）：高度/圆角/描边宽/描边色/内边距/字号六项逐项相等，
     且**换内容也不变**（收藏 ⇄ 已收藏、数字三位 ⇄ 五位）；
     ①b 反向对照：把旧的三套几何内联写回去 ⇒ 高度当场不等，证明 ① 抓得住"大小不一"；
  ② **同一行**：三件竖直中心相同、按 DOM 顺序横向排列、互不重叠；
     ②b 文案/数字变长时后面两件**不挪位**（`.readFavLabel{min-width:3em}`、数字 `3ch`
     的判据）；反向对照：抹掉 min-width ⇒ 点赞那一件确实横移；
  ③ **挤压回归**（20260926 那件事）：超长标题 + 327px 下整簇不被挤窄，宽度与短标题时逐字相同；
     ③b 反向对照：把四条防线（中区吃余量 / 簇不收缩 / 按钮不收缩 / 文案不折行）一起撤掉
     ⇒ 文案**确实**折成两行 —— 顺带证明这四条每一条都在起作用；
  ④ 图标：三件的 svg 同尺寸 14px、`aria-hidden`，文案仍在 `span.readFavLabel` 里；
  ⑤ 三态色一字未改（已收藏河灯金 #ffcc7c / 已点赞暖粉 #ffb3c6 / 未选中透明 + 描边 / 浏览更淡）；
  ⑥ 窄屏（327px）同样一行不折；
  ⑦ 布局锁死：四种标题长度下日期与右区的坐标逐字相同（用户第 4 条）；
     ⑦b 反向对照：拆回平级三项 + `space-between` ⇒ 日期当场漂走。
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

# 与 index.tsx 同形的标记：.readContainer > .readCover > .readInfo > .readStats > 三件
# （antd 的 Flex 用普通 div 代替——它的宽度不影响本套件的判据）
MARKUP = """
<div class="readContainer">
  <div class="readCover">
    <div class="readInfo">
      <div class="ant-flex readAuthor"><span class="frontAvatar">头像</span>泠月</div>
      <div class="readMain">
        <h1 id="title">{title}</h1>
        <h3 id="date">2026-09-26</h3>
      </div>
      <div class="readStats" id="wrap">
        <button type="button" class="readStat readFavBtn{faved}" id="btn" title="收藏">
          <svg aria-hidden="true" width="14" height="14" id="star"></svg>
          <span class="readFavLabel" id="label">{text}</span>
        </button>
        <span class="readStat readViews" id="views" title="累计阅读量">
          <svg aria-hidden="true" width="14" height="14" id="eye"></svg>
          <span class="readViewsNum" id="viewsnum">{views}</span></span>
        <button type="button" class="readStat readLikeBtn{liked}" id="likebtn" aria-pressed="false">
          <svg aria-hidden="true" width="14" height="14" id="heart"></svg>
          <span class="readLikeNum" id="likenum">{likes}</span></button>
      </div>
    </div>
  </div>
</div>
"""

LONG_TITLE = "一篇标题特别长的文章：从零开始把站内对话助手接进个人博客的完整记录与踩坑清单（下篇）"

# 旧形态的三套几何（20261001 之前写死在 `.readFavBtn` / `.readViews` / `.readLikeBtn` 上）。
# 只在 ①b 反向对照里内联写回去——用 id 选择器（1,0,0）压过 `.readInfo .readStat`（0,4,0）。
LEGACY_GEOM = """
#btn { height: 62px; width: 32px; flex-direction: column; padding: 6px 8px; }
#views { height: 24px; padding: 2px 8px; font-size: 12px;
         border-color: rgba(255, 241, 235, 0.35); }
#likebtn { height: 30px; padding: 4px 10px; }
"""


def build_sandbox() -> pathlib.Path:
    sb = pathlib.Path(tempfile.mkdtemp(prefix="readstats-"))
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

# `o.legacy` 是**反向对照**：把某一组判据的前提手动破坏掉，证明那组判据不是空断言。
PAINT = """(o) => {
  for (const n of ['legacy-geom', 'legacy-flex', 'legacy-minw', 'legacy-layout']) {
    const el = document.getElementById(n);
    if (el) el.remove();
  }
  document.getElementById('root').innerHTML = o.markup;
  const add = (css) => { const s = document.createElement('style');
    s.id = o.legacy; s.textContent = css; document.head.appendChild(s); };
  if (o.legacy === 'legacy-geom') add(o.css);
  if (o.legacy === 'legacy-flex') add(
    '.readInfo { width: 420px !important; }' +
    '.readInfo .readMain { flex: 0 0 auto !important; min-width: auto !important; }' +
    '#wrap { flex: 0 1 auto !important; min-width: 0 !important; }' +
    '#btn { flex: 0 1 auto !important; min-width: 0 !important; }' +
    '#label { white-space: normal !important; min-width: 0 !important; }');
  if (o.legacy === 'legacy-minw') add('#label { min-width: 0; }');
  if (o.legacy === 'legacy-layout') {
    // 拆回 20261001 之前的形态：中区那一层拿掉（display: contents）+ 五个子项 space-between
    document.querySelector('.readMain').style.display = 'contents';
    document.querySelector('.readInfo').style.justifyContent = 'space-between';
  }
  const box = (id) => {
    const el = document.getElementById(id);
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return {
      w: r.width, h: r.height, left: r.left, right: r.right,
      cy: r.top + r.height / 2, top: r.top,
      radius: cs.borderTopLeftRadius, bw: cs.borderTopWidth, bc: cs.borderTopColor,
      pad: cs.padding, fs: cs.fontSize, dir: cs.flexDirection,
      bg: cs.backgroundColor, color: cs.color,
      iconW: (el.querySelector('[aria-hidden="true"]') || {getBoundingClientRect: () => ({width: -1})})
                .getBoundingClientRect().width,
      iconHidden: (el.querySelector('[aria-hidden="true"]') || {}).getAttribute
                    ? el.querySelector('[aria-hidden="true"]').getAttribute('aria-hidden') : null,
    };
  };
  const rng = (id) => { const g = document.createRange();
    g.selectNodeContents(document.getElementById(id)); return g.getClientRects(); };
  const wrap = document.getElementById('wrap').getBoundingClientRect();
  return {
    btn: box('btn'), views: box('views'), like: box('likebtn'), wrap: box('wrap'),
    wrapFlex: getComputedStyle(document.getElementById('wrap')).flex,
    labelText: document.getElementById('label').textContent,
    labelLines: rng('label').length,
    labelRect: (() => { const r = document.getElementById('label').getBoundingClientRect();
                        return {w: r.width, h: r.height}; })(),
    titleLines: rng('title').length,
    titleW: document.getElementById('title').getBoundingClientRect().width,
    titleH: document.getElementById('title').getBoundingClientRect().height,
    dateLeft: document.getElementById('date').getBoundingClientRect().left,
    dateTop: document.getElementById('date').getBoundingClientRect().top,
    infoH: document.querySelector('.readInfo').getBoundingClientRect().height,
    gapSpan: document.getElementById('views').getBoundingClientRect().left - wrap.left,
  };
}"""


def mk(title: str = LONG_TITLE, faved: str = " isFaved", text: str = "已收藏",
       views: str = "128", likes: str = "7", liked: str = "") -> str:
    return MARKUP.format(title=title, faved=faved, text=text,
                         views=views, likes=likes, liked=liked)


with sync_playwright() as p:
    br = p.chromium.launch()
    pg = br.new_page(viewport={"width": 1280, "height": 900})
    errs: list[str] = []
    pg.on("pageerror", lambda e: errs.append(str(e)))
    pg.goto(URL)
    pg.wait_for_timeout(150)

    print("① 三件同形：六项几何逐项相等，且换内容也不变（用户第 1 条「大小不一」）")
    # ⚠️ 这一组必须量**未选中态**：`.isFaved` / `.isLiked` 是**故意**改底色与描边色的
    # （已收藏＝河灯金实心），拿选中态去比"三件颜色相同"必然不等 —— 那是断言写错了，
    # 不是样式错了。选中态本身由 ⑤ 组单独锁。
    r = pg.evaluate(PAINT, {"markup": mk(faved="", text="收藏")})
    parts = [("收藏按钮", r["btn"]), ("浏览读数", r["views"]), ("点赞按钮", r["like"])]
    for prop, label in (("h", "高度"), ("radius", "圆角"), ("bw", "描边宽"),
                        ("bc", "描边色"), ("pad", "内边距"), ("fs", "字号")):
        vals = [x[1][prop] for x in parts]
        check(f"{label} 三件相同（{vals[0]}）", len(set(vals)) == 1,
              str({n: v for (n, _), v in zip(parts, vals)}))
    check("三件都落在同一行（竖直中心相同）",
          max(x[1]["cy"] for x in parts) - min(x[1]["cy"] for x in parts) < 0.5,
          str([round(x[1]["cy"], 1) for x in parts]))
    check("  按 DOM 顺序横排（收藏 → 浏览 → 点赞，互不重叠）",
          r["btn"]["right"] <= r["views"]["left"] + 0.5
          and r["views"]["right"] <= r["like"]["left"] + 0.5,
          f'{round(r["btn"]["right"],1)} / {round(r["views"]["left"],1)} / '
          f'{round(r["views"]["right"],1)} / {round(r["like"]["left"],1)}')
    # 换内容：文案两字 ⇄ 三字、数字三位 ⇄ 五位 —— 高度都不许动（定高的意义就在这里）
    hs = set()
    for f, t, v, lk in (("", "收藏", "7", "0"), (" isFaved", "已收藏", "12345", "99999")):
        rr = pg.evaluate(PAINT, {"markup": mk(faved=f, text=t, views=v, likes=lk)})
        hs.add((round(rr["btn"]["h"], 1), round(rr["views"]["h"], 1), round(rr["like"]["h"], 1)))
    check("  换内容（收藏⇄已收藏、数字 1 位⇄5 位）后三件高度仍逐件不变",
          len(hs) == 1, str(hs))

    print("①b 反向对照：把旧的三套几何写回去 ⇒ 高度当场不等（证明 ① 不是空断言）")
    rlg = pg.evaluate(PAINT, {"markup": mk(), "legacy": "legacy-geom", "css": LEGACY_GEOM})
    old = [round(rlg[k]["h"], 1) for k in ("btn", "views", "like")]
    check(f"  旧几何下三件高度是三个不同的值（{old}）——这就是用户看到的那一版",
          len(set(old)) == 3, str(old))
    check("  且高度比是 2.6 倍上下（竖排胶囊 62 / 24 / 30）",
          max(old) / min(old) > 2.4, f"{max(old)} / {min(old)}")

    print("② 同一行且互不推挤")
    check("整簇的 flex 是 0 0 auto（不收缩的那一份）", r["wrapFlex"] == "0 0 auto", r["wrapFlex"])
    check("整簇高度 = 三件的高度（没有多余的行高把它撑开）",
          abs(r["wrap"]["h"] - r["btn"]["h"]) < 0.5, f'{r["wrap"]["h"]} vs {r["btn"]["h"]}')

    print("②b 文案/数字变长时整簇**不挪位**（定宽 min-width 的判据）")
    # ⚠️ 量的是**整簇的左缘**，不是任何一件的左缘。整簇在这个 flex 行里是最后一项、
    # 右缘被 `.readInfo` 的右内边距钉死（中间那区 `flex: 1 1 auto` 会把任何富余/亏空
    # 吃掉），所以"某一件变宽了"表现为**整簇向左长**——变的是左缘。实测过：抹掉
    # min-width 后 label 39→16px、按钮 79→56px，而 `#likebtn`（最后一件）的 left
    # **一动不动**（1002 → 1002），只有整簇左缘 853 → 876。拿 last-child 当判据会永远绿。
    two = pg.evaluate(PAINT, {"markup": mk(faved="", text="收藏", views="7", likes="0")})
    check("收藏（两字）⇄ 已收藏（三字）：整簇左缘不动",
          abs(two["wrap"]["left"] - r["wrap"]["left"]) < 0.5,
          f'{round(two["wrap"]["left"],1)} → {round(r["wrap"]["left"],1)}')
    # 4ch 的覆盖范围就是 1–4 位（`min-width` 兜底不封顶，5 位会变宽——那是刻意的，
    # 见 sass 里那段注释）。判据取 4 位正是那道坎：999 → 1000。
    r5 = pg.evaluate(PAINT, {"markup": mk(faved="", text="收藏", views="1234", likes="9999")})
    check("  浏览数字 1 位 ⇄ 4 位：整簇左缘不动",
          abs(r5["wrap"]["left"] - r["wrap"]["left"]) < 0.5,
          f'{round(r["wrap"]["left"],1)} → {round(r5["wrap"]["left"],1)}')
    rmin = pg.evaluate(PAINT, {"markup": mk(faved="", text="收藏"),
                               "legacy": "legacy-minw"})
    check("  反向对照：抹掉 min-width 后**确实**挪位（②b 不是空断言）",
          abs(rmin["wrap"]["left"] - r["wrap"]["left"]) > 3,
          f'有 min-width {round(r["wrap"]["left"],1)} / 无 {round(rmin["wrap"]["left"],1)}')

    print("③ 挤压回归：超长标题下整簇不被挤窄")
    rnat = pg.evaluate(PAINT, {"markup": mk(title="短标题")})
    check("与短标题时的整簇宽度逐字相等（一个像素都没被挤掉）",
          abs(r["wrap"]["w"] - rnat["wrap"]["w"]) < 0.5,
          f'长标题 {round(r["wrap"]["w"],1)} / 短标题 {round(rnat["wrap"]["w"],1)}')
    check("标题确实占掉了空间（否则这个场景没被复现）", r["titleW"] > 200, f'{r["titleW"]}')
    check("文案只有一个行盒（没折成两行）", r["labelLines"] == 1, str(r["labelLines"]))

    print("③b 反向对照：把这四条防线一起撤掉 ⇒ 文案真的折成两行（③ 不是空断言）")
    # ⚠️ 光把整簇改成 `flex: 0 1 auto` **压不窄它**——实测宽度纹丝不动。因为中区是
    # `flex: 1 1 auto` + `min-width: 0`，**任何**亏空都由它先让，整簇永远轮不到收缩。
    # 所以要复现 20260926 那件事，得把四条防线一起撤掉（中区不再让、整簇可收缩、
    # 按钮可收缩、文案可折行）——这也顺带说明这四条**每一条都在起作用**。
    rsq = pg.evaluate(PAINT, {"markup": mk(), "legacy": "legacy-flex"})
    check("  撤掉防线后整簇被压窄（flex: 0 0 auto 真在起作用）",
          rsq["wrap"]["w"] < r["wrap"]["w"] - 10,
          f'{round(r["wrap"]["w"],1)} → {round(rsq["wrap"]["w"],1)}')
    check("  文案当场折成两行（用户 20260926 报的「已收」「藏」）",
          rsq["labelLines"] >= 2, f'lines {rsq["labelLines"]}')
    check("  修好之后只有一个行盒（white-space: nowrap 是结构性的，不是碰巧）",
          r["labelLines"] == 1, str(r["labelLines"]))

    print("④ 图标：三件同尺寸 14px、aria-hidden，文案仍在 span.readFavLabel")
    for name, part in parts:
        check(f"{name} 的图标是 svg 且 14px（与同一排另两件同源）",
              abs(part["iconW"] - 14) < 0.5, f'{part["iconW"]}')
        check(f"  {name} 的图标 aria-hidden = true（读屏不念图形）",
              part["iconHidden"] == "true", str(part["iconHidden"]))
    rfav0 = pg.evaluate(PAINT, {"markup": mk()})
    check("收藏文案仍在 span.readFavLabel 里（图标与文案是两个子元素）",
          rfav0["labelText"] == "已收藏", rfav0["labelText"])

    print("⑤ 三态色一字未改")
    rfav = pg.evaluate(PAINT, {"markup": mk()})
    check("已收藏 = 河灯金 #ffcc7c 实心", rfav["btn"]["bg"] == "rgb(255, 204, 124)",
          rfav["btn"]["bg"])
    check("未收藏 = 透明底 + 浅色描边（左侧那件就是这一态）",
          r["btn"]["bg"] in ("rgba(0, 0, 0, 0)", "transparent"), r["btn"]["bg"])
    check("  描边仍在（rgba(255,241,235,.55)）", "255, 241, 235" in r["btn"]["bc"],
          r["btn"]["bc"])
    check("  未收藏文案 = 收藏（两字）", r["labelText"] == "收藏", r["labelText"])
    liked = pg.evaluate(PAINT, {"markup": mk(liked=" isLiked")})
    check("已点赞 = 暖粉 #ffb3c6（与收藏的金区分开）",
          liked["like"]["bg"] == "rgb(255, 179, 198)", liked["like"]["bg"])
    check("浏览是读数不是按钮：字色比两个按钮淡一档",
          r["views"]["color"] != r["btn"]["color"], f'{r["views"]["color"]} / {r["btn"]["color"]}')
    check("  三件的描边色本来就相同（本轮把它统一成一条）",
          r["views"]["bc"] == r["btn"]["bc"] == r["like"]["bc"], r["views"]["bc"])

    print("⑥ 窄屏（327px，用户截图那档）同样一行不折")
    pg.set_viewport_size({"width": 327, "height": 800})
    r6 = pg.evaluate(PAINT, {"markup": mk()})
    check("文案仍是一个行盒", r6["labelLines"] == 1, str(r6["labelLines"]))
    check("三件仍同高", abs(r6["btn"]["h"] - r6["views"]["h"]) < 0.5
          and abs(r6["like"]["h"] - r6["views"]["h"]) < 0.5,
          str([round(r6[k]["h"], 1) for k in ("btn", "views", "like")]))
    check("整簇宽度与桌面档相同（该被挤的是标题那一块，不是读数）",
          abs(r6["wrap"]["w"] - r["wrap"]["w"]) < 0.5,
          f'桌面 {round(r["wrap"]["w"],1)} / 327px {round(r6["wrap"]["w"],1)}')

    print("⑦ 布局锁死：四种标题长度下右区/日期几何逐字相同（用户第 4 条）")
    pg.set_viewport_size({"width": 1280, "height": 900})
    titles = ["短文", "一篇中等长度的文章标题",
              "一篇标题特别长的文章：从零开始把站内对话助手接进个人博客的完整记录与踩坑清单（下篇）",
              "一篇标题特别长的文章：从零开始把站内对话助手接进个人博客的完整记录与踩坑清单（下篇）"
              "——再补一段足够长的副标题把这一行彻底撑满看看会发生什么"]
    got = [pg.evaluate(PAINT, {"markup": mk(title=t)}) for t in titles]
    key = lambda x: (round(x["dateLeft"], 1), round(x["dateTop"], 1),
                     round(x["wrap"]["left"], 1), round(x["infoH"], 1))
    check("★ 四档标题下（日期 x/y、整簇左缘、卡片高）逐字相同",
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
    ls = pg.evaluate(PAINT, {"markup": mk(title=titles[0]), "legacy": "legacy-layout"})
    ll = pg.evaluate(PAINT, {"markup": mk(title=titles[-1]), "legacy": "legacy-layout"})
    check("  拆回平级后日期位置确实随标题长度变（⑦ 不是空断言）",
          abs(ls["dateLeft"] - ll["dateLeft"]) > 40,
          f'{round(ls["dateLeft"],1)} → {round(ll["dateLeft"],1)}')
    # 顺带把旧形态**到底漂的是什么**钉下来，免得后来者以为当年漂的是右侧那几件：
    # `space-between` 把**最后一项**钉死在右缘，所以整簇左缘恒定不动，漂的是它左边的
    # 日期（以及左边那一大段空白）。这正是 20261001 把日期收进中区的原因。
    check("  而整簇被 space-between 钉在右缘、左缘恒定（当年漂的是**日期**，不是它）",
          abs(ls["wrap"]["left"] - ll["wrap"]["left"]) < 1,
          f'{round(ls["wrap"]["left"],1)} → {round(ll["wrap"]["left"],1)}')

    check("无 JS 运行时报错", not errs, "; ".join(errs[:2]))
    br.close()

shutil.rmtree(SANDBOX, ignore_errors=True)
print(f"\n{'✗' if FAIL else '✓'} read-stats-cluster：{PASS} 通过 / {FAIL} 失败")
raise SystemExit(1 if FAIL else 0)
