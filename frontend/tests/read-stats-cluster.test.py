#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""文章横幅「读数四件」= 四件同形的一列（20260926 起；20261001 改形态；20261003 改方向）。

  python3 tests/read-stats-cluster.test.py

沿革：本文件原名 `read-fav-vertical.test.py`，锁的是"收藏按钮竖排"那套（20260926）。
20261001 用户第 1 条把那一版整体否了 ——「详情页三图标样式和布局太丑了，大小不一，
排列奇怪」：

    实测（1280×900，线上）            宽 × 高    内边距      字号   描边 α
    .readFavWrap  .readFavBtn        32 × 62    6px 8px     13    .55   ← 竖排
    .readViews                       59 × 24    2px 8px     12    .35
    .readLikeBtn                     64 × 30    4px 10px    13    .55

一件竖的、两件横的，高度差到 2.6 倍 —— 排在一行里怎么摆都对不齐。所以 20261001 改成
一簇 `.readStats` + 三件共用几何 `.readStat`，竖排随之取消。

**20261003 用户第 5 条把方向又改回来了**：「点赞收藏观看评论图标不要横向平铺会影响
标题居中显示，改为纵向排列」——并补上第四件「讨论」。这一次的竖排与 20260926 那一版
**不是同一件事**：那一版是"一件竖、两件横"的混搭（几何不齐），现在是**四件同形、整簇
成一列**，`.readStat` 那份几何一个字都没动，改的只是它摆的方向。

为什么横排会把标题挤偏（这是本条修复的**因果**，不是副作用）：
`.readInfo` 是三列 [作者 | 中区标题+日期 | 本簇]，中区 `flex: 1 1 auto` 吃余量 ⇒
**中区中线 = 卡片中线 + (作者宽 − 簇宽)/2**。横排时簇宽 ≈313px、竖排后 ≈79px（实测，
见本文件 ①c / ⑦b 两组），中区中线因此从偏 −136px 回到偏 −19px。⚠️ 所以"簇变窄"必须
被锁住：簇里任何一件变宽都会把标题重新推偏（`.readFavLabel` 的 `3em` 与数字的 `4ch`
就是为此存在的，判据在 ②b）。

为什么用无头浏览器而不是 node 桩：这是**布局**问题（flex 收缩、行盒、等高、绝对定位盒
是否越出 overflow:hidden 的父盒），桩里算不出这些。真 CSS = node 侧真编译的 `.sass` +
仓库里那份 `* { box-sizing: border-box }` 重置（`src/frontHome/main.css`），页面里手写与
`index.tsx` 同形的标记（不挂 React——类名与结构就是全部接口）。

锁十二组：
  ① **四件同形**（正面判据）：高度/圆角/描边宽/描边色/内边距/字号六项逐项相等，且换内容
     也不变（收藏 ⇄ 已收藏、数字一位 ⇄ 四位）；
     ①b 反向对照：把旧的三套几何内联写回去 ⇒ 高度当场不等（证明 ① 抓得住"大小不一"）；
     ①c ★**同一列**：四件横向中心相同、按 DOM 顺序自上而下、互不重叠；**反向对照**：
     把 `flex-direction` 写回 `row` ⇒ 四个中心当场各不相同、整簇由竖变横；
  ② 整簇 `flex: 0 0 auto`（不被挤窄的那一份），高度 = 4×件高 + 3×间距；
     ②b 文案/数字变长时整簇**不挪位**（`.readFavLabel{min-width:3em}`、数字 `4ch`）；
     **反向对照**：四条定宽一起抹掉 ⇒ 簇宽与左缘当场变；
  ③ **挤压回归**（20260926 那件事）：超长标题下整簇不被挤窄；
     ③b 反向对照：四条防线一起撤 ⇒ 文案**确实**折成两行；
  ④ 图标：四件的 svg 同尺寸 14px、`aria-hidden`，文案仍在 `span.readFavLabel` 里；
  ⑤ 三态色一字未改；讨论数是**读数不是按钮**（字色与浏览同档、比两个按钮淡）；
  ⑥ ★手机档（327px / 768px 两档）：四件各自收成 24px 高 / 4px 间距，**且整个读数盒
     不越出封面顶**；**反向对照**：把手机档那三条覆盖撤回 200px 那一版 ⇒ 上沿当场越界；
  ⑦ 布局锁死：四种标题长度下日期与右区的坐标逐字相同（20261001 用户第 4 条）；
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

# 与 index.tsx 同形的标记：.readContainer > .readCover > .readInfo > .readStats > 四件
# （antd 的 Flex 用普通 div 代替——它的宽度不影响本套件的判据）
MARKUP = """
<div class="readContainer">
  <div class="readCover" id="cover">
    <div class="readInfo" id="info">
      <div class="ant-flex readAuthor" id="author"><span class="frontAvatar">头像</span>泠月</div>
      <div class="readMain" id="main">
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
        <span class="readStat readComments" id="comments" title="讨论数">
          <svg aria-hidden="true" width="14" height="14" id="bubble"></svg>
          <span class="readCommentNum" id="commentnum">{comments}</span></span>
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

# ①c 的反向对照：把方向写回横排（= 用户第 5 条报的那一版）。
LEGACY_ROW = "#wrap { flex-direction: row !important; }"

# ②b 的反向对照：把**全部**四条定宽一起抹掉。只抹 `#label` 是不够的（实测）——
# 竖排 `align-items: stretch` 下簇宽 = 最宽那一件的自然宽，抹掉 label 的 min-width 后
# 最宽的变成了带 4ch 数字的那几件，簇宽纹丝不动。要证明定宽在起作用，就得把
# 3em（文案）与 4ch（三个数字）一起撤掉。
LEGACY_MINW = ("#label { min-width: 0 !important; }"
               "#viewsnum, #likenum, #commentnum { min-width: 0 !important; }")

# ⑥ 的反向对照：把手机档那三条覆盖撤回 20261003 之前的 200px 那一版
# （封面高、`.readInfo` 的 bottom/内边距、四件的 24px/4px）。
# 全部用 id 选择器 + `!important`：与 sass 里那几条同是 `!important`，靠**特异性**取胜。
LEGACY_MOBILE = """
#cover { height: 200px !important; }
#info { bottom: 25px !important; padding: 16px 24px !important; }
#wrap { gap: 6px !important; }
#wrap .readStat { height: 30px !important; font-size: 13px !important; padding: 0 10px !important; }
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
  for (const n of ['legacy-geom', 'legacy-flex', 'legacy-minw', 'legacy-layout',
                   'legacy-row', 'legacy-mobile']) {
    const el = document.getElementById(n);
    if (el) el.remove();
  }
  document.getElementById('root').innerHTML = o.markup;
  const add = (css) => { const s = document.createElement('style');
    s.id = o.legacy; s.textContent = css; document.head.appendChild(s); };
  if (o.legacy === 'legacy-geom') add(o.css);
  if (o.legacy === 'legacy-row') add(o.css);
  if (o.legacy === 'legacy-minw') add(o.css);
  if (o.legacy === 'legacy-mobile') add(o.css);
  if (o.legacy === 'legacy-flex') add(
    '.readInfo { width: 420px !important; }' +
    '.readInfo .readMain { flex: 0 0 auto !important; min-width: auto !important; }' +
    '#wrap { flex: 0 1 auto !important; min-width: 0 !important; }' +
    '#btn { flex: 0 1 auto !important; min-width: 0 !important; }' +
    '#label { white-space: normal !important; min-width: 0 !important; }');
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
      cx: r.left + r.width / 2, cy: r.top + r.height / 2,
      top: r.top, bottom: r.bottom,
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
  return {
    btn: box('btn'), views: box('views'), like: box('likebtn'), com: box('comments'),
    wrap: box('wrap'), cover: box('cover'), info: box('info'), main: box('main'),
    wrapFlex: getComputedStyle(document.getElementById('wrap')).flex,
    wrapGap: parseFloat(getComputedStyle(document.getElementById('wrap')).gap) || 0,
    labelText: document.getElementById('label').textContent,
    labelLines: rng('label').length,
    titleLines: rng('title').length,
    titleW: document.getElementById('title').getBoundingClientRect().width,
    titleH: document.getElementById('title').getBoundingClientRect().height,
    dateLeft: document.getElementById('date').getBoundingClientRect().left,
    dateTop: document.getElementById('date').getBoundingClientRect().top,
    infoH: document.querySelector('.readInfo').getBoundingClientRect().height,
  };
}"""


def mk(title: str = LONG_TITLE, faved: str = " isFaved", text: str = "已收藏",
       views: str = "128", likes: str = "7", liked: str = "", comments: str = "3") -> str:
    return MARKUP.format(title=title, faved=faved, text=text,
                         views=views, likes=likes, liked=liked, comments=comments)


ITEMS = ("btn", "views", "like", "com")
NAMES = {"btn": "收藏按钮", "views": "浏览读数", "like": "点赞按钮", "com": "讨论读数"}

with sync_playwright() as p:
    br = p.chromium.launch()
    pg = br.new_page(viewport={"width": 1280, "height": 900})
    errs: list[str] = []
    pg.on("pageerror", lambda e: errs.append(str(e)))
    pg.goto(URL)
    pg.wait_for_timeout(150)

    print("① 四件同形：六项几何逐项相等，且换内容也不变（20261001 用户第 1 条「大小不一」）")
    # ⚠️ 这一组必须量**未选中态**：`.isFaved` / `.isLiked` 是**故意**改底色与描边色的
    # （已收藏＝河灯金实心），拿选中态去比"四件颜色相同"必然不等 —— 那是断言写错了，
    # 不是样式错了。选中态本身由 ⑤ 组单独锁。
    r = pg.evaluate(PAINT, {"markup": mk(faved="", text="收藏")})
    parts = [(NAMES[k], r[k]) for k in ITEMS]
    for prop, label in (("h", "高度"), ("radius", "圆角"), ("bw", "描边宽"),
                        ("bc", "描边色"), ("pad", "内边距"), ("fs", "字号")):
        vals = [x[1][prop] for x in parts]
        check(f"{label} 四件相同（{vals[0]}）", len(set(vals)) == 1,
              str({n: v for (n, _), v in zip(parts, vals)}))
    # 换内容：文案两字 ⇄ 三字、数字一位 ⇄ 四位 —— 高度都不许动（定高的意义就在这里）
    hs = set()
    for f, t, v, lk, cm in (("", "收藏", "7", "0", "0"),
                            (" isFaved", "已收藏", "1234", "9999", "1234")):
        rr = pg.evaluate(PAINT, {"markup": mk(faved=f, text=t, views=v, likes=lk, comments=cm)})
        hs.add(tuple(round(rr[k]["h"], 1) for k in ITEMS))
    check("  换内容（收藏⇄已收藏、数字 1 位⇄4 位）后四件高度仍逐件不变",
          len(hs) == 1, str(hs))

    print("①b 反向对照：把旧的三套几何写回去 ⇒ 高度当场不等（证明 ① 不是空断言）")
    rlg = pg.evaluate(PAINT, {"markup": mk(), "legacy": "legacy-geom", "css": LEGACY_GEOM})
    old = [round(rlg[k]["h"], 1) for k in ITEMS]
    check(f"  旧几何下四件高度是三个不同的值（{old}）——这就是用户看到的那一版",
          len(set(old)) == 3, str(old))
    check("  且最高/最矮是 2.6 倍上下（竖排胶囊 62 / 读数 24）",
          max(old) / min(old) > 2.4, f"{max(old)} / {min(old)}")

    print("①c ★同一列（20261003 用户第 5 条「改为纵向排列」）")
    cy = [round(r[k]["cy"], 1) for k in ITEMS]
    check("四件的竖直中心两两不同 —— 不是横排",
          len(set(cy)) == len(cy), str(cy))
    check("  按 DOM 顺序自上而下、互不重叠（收藏 → 浏览 → 点赞 → 讨论）",
          all(r[a]["bottom"] <= r[b]["top"] + 0.5 for a, b in zip(ITEMS, ITEMS[1:])),
          str([(k, round(r[k]["top"], 1), round(r[k]["bottom"], 1)) for k in ITEMS]))
    check("  四件横向中心相同（`align-items: stretch` 的等宽一列，不是犬牙交错）",
          max(r[k]["cx"] for k in ITEMS) - min(r[k]["cx"] for k in ITEMS) < 0.5,
          str([round(r[k]["cx"], 1) for k in ITEMS]))
    # ★ 这条才是用户报的那件事本身：横排把中区标题推偏多少
    off_col = r["main"]["cx"] - r["info"]["cx"]
    check(f"  · 中区中线与卡片中线只差 {off_col:+.1f}px（横排时差一个数量级，见下）",
          abs(off_col) < 30, f"{off_col:+.1f}px")

    print("①c′ 反向对照：把方向写回 `row` ⇒ 四个中心当场各不相同、整簇由竖变横")
    rrow = pg.evaluate(PAINT, {"markup": mk(), "legacy": "legacy-row", "css": LEGACY_ROW})
    row_cy = [round(rrow[k]["cy"], 1) for k in ITEMS]
    check("  row 下四件竖直中心相同（①c「不是横排」的判据确实有牙）",
          max(row_cy) - min(row_cy) < 0.5, str(row_cy))
    row_cx = [round(rrow[k]["cx"], 1) for k in ITEMS]
    check("  row 下四件横向中心各不相同（①c「同一列」当场不成立）",
          len(set(row_cx)) == len(row_cx), str(row_cx))
    check(f"  row 的簇宽 {rrow['wrap']['w']:.0f} > 竖排 {r['wrap']['w']:.0f} 的 3 倍"
          "（「簇变窄」是标题归位的因果）",
          rrow["wrap"]["w"] > 3 * r["wrap"]["w"],
          f'{round(rrow["wrap"]["w"],1)} vs {round(r["wrap"]["w"],1)}')
    off_row = rrow["main"]["cx"] - rrow["info"]["cx"]
    check(f"  row 下中区中线偏 {off_row:+.1f}px（vs 竖排 {off_col:+.1f}px）——正是用户看到的那一偏",
          abs(off_row) > 100, f"{off_row:+.1f}px")

    print("② 一列：整簇不收缩、高度 = 4×件高 + 3×间距")
    check("整簇的 flex 是 0 0 auto（不收缩的那一份）", r["wrapFlex"] == "0 0 auto", r["wrapFlex"])
    expect_h = 4 * r["btn"]["h"] + 3 * r["wrapGap"]
    check(f"整簇高度 = 四件 + 三道间距（{expect_h:.1f}px，没有多余的行高把它撑开）",
          abs(r["wrap"]["h"] - expect_h) < 0.5,
          f'{r["wrap"]["h"]} vs {expect_h}')
    check("  整簇宽度 = 单件宽度（`stretch` 让四件同宽，簇不额外长胖）",
          abs(r["wrap"]["w"] - r["btn"]["w"]) < 0.5,
          f'{round(r["wrap"]["w"],1)} vs {round(r["btn"]["w"],1)}')

    print("②b 文案/数字变长时整簇**不挪位**（定宽 min-width 的判据）")
    # ⚠️ 量的是**整簇的左缘/宽度**，不是任何一件的。整簇在这个 flex 行里是最后一项、
    # 右缘被 `.readInfo` 的右内边距钉死（中间那区 `flex: 1 1 auto` 会把任何富余/亏空
    # 吃掉），所以"某一件变宽了"表现为**整簇向左长**——变的是左缘与簇宽。
    # 竖排之后多一层：`align-items: stretch` 下**簇宽 = 最宽那一件的自然宽**，
    # 所以任何一件变宽都会把四件一起撑宽（而不是只撑自己）——这正是下面反向对照要证的。
    two = pg.evaluate(PAINT, {"markup": mk(faved="", text="收藏", views="7", likes="0",
                                           comments="0")})
    check("收藏（两字）⇄ 已收藏（三字）：整簇宽度与左缘都不动",
          abs(two["wrap"]["w"] - r["wrap"]["w"]) < 0.5
          and abs(two["wrap"]["left"] - r["wrap"]["left"]) < 0.5,
          f'{round(two["wrap"]["w"],1)} → {round(r["wrap"]["w"],1)} / '
          f'{round(two["wrap"]["left"],1)} → {round(r["wrap"]["left"],1)}')
    # 4ch 的覆盖范围就是 1–4 位（`min-width` 兜底不封顶，5 位会变宽——那是刻意的，
    # 见 sass 里那段注释）。判据取 4 位正是那道坎：999 → 1000。
    r4 = pg.evaluate(PAINT, {"markup": mk(faved="", text="收藏", views="1234", likes="9999",
                                          comments="1234")})
    check("  三个数字 1 位 ⇄ 4 位：整簇宽度与左缘都不动",
          abs(r4["wrap"]["w"] - r["wrap"]["w"]) < 0.5
          and abs(r4["wrap"]["left"] - r["wrap"]["left"]) < 0.5,
          f'{round(r["wrap"]["w"],1)} → {round(r4["wrap"]["w"],1)} / '
          f'{round(r["wrap"]["left"],1)} → {round(r4["wrap"]["left"],1)}')
    rmin = pg.evaluate(PAINT, {"markup": mk(faved="", text="收藏", views="7", likes="0",
                                            comments="0"),
                               "legacy": "legacy-minw", "css": LEGACY_MINW})
    check("  反向对照：把四条定宽一起抹掉后**确实**变窄/挪位（②b 不是空断言）",
          rmin["wrap"]["w"] < two["wrap"]["w"] - 5
          or abs(rmin["wrap"]["left"] - two["wrap"]["left"]) > 5,
          f'有 {round(two["wrap"]["w"],1)}@{round(two["wrap"]["left"],1)} / '
          f'无 {round(rmin["wrap"]["w"],1)}@{round(rmin["wrap"]["left"],1)}')

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
          rsq["wrap"]["w"] < r["wrap"]["w"] - 5,
          f'{round(r["wrap"]["w"],1)} → {round(rsq["wrap"]["w"],1)}')
    check("  文案当场折成两行（用户 20260926 报的「已收」「藏」）",
          rsq["labelLines"] >= 2, f'lines {rsq["labelLines"]}')
    check("  修好之后只有一个行盒（white-space: nowrap 是结构性的，不是碰巧）",
          r["labelLines"] == 1, str(r["labelLines"]))

    print("④ 图标：四件同尺寸 14px、aria-hidden，文案仍在 span.readFavLabel")
    for name, part in parts:
        check(f"{name} 的图标是 svg 且 14px（与同一列另三件同源）",
              abs(part["iconW"] - 14) < 0.5, f'{part["iconW"]}')
        check(f"  {name} 的图标 aria-hidden = true（读屏不念图形）",
              part["iconHidden"] == "true", str(part["iconHidden"]))
    rfav0 = pg.evaluate(PAINT, {"markup": mk()})
    check("收藏文案仍在 span.readFavLabel 里（图标与文案是两个子元素）",
          rfav0["labelText"] == "已收藏", rfav0["labelText"])

    print("⑤ 三态色一字未改；讨论数与浏览同属「读数」档")
    rfav = pg.evaluate(PAINT, {"markup": mk()})
    check("已收藏 = 河灯金 #ffcc7c 实心", rfav["btn"]["bg"] == "rgb(255, 204, 124)",
          rfav["btn"]["bg"])
    check("未收藏 = 透明底 + 浅色描边（第一件就是这一态）",
          r["btn"]["bg"] in ("rgba(0, 0, 0, 0)", "transparent"), r["btn"]["bg"])
    check("  描边仍在（rgba(255,241,235,.55)）", "255, 241, 235" in r["btn"]["bc"],
          r["btn"]["bc"])
    check("  未收藏文案 = 收藏（两字）", r["labelText"] == "收藏", r["labelText"])
    liked = pg.evaluate(PAINT, {"markup": mk(liked=" isLiked")})
    check("已点赞 = 暖粉 #ffb3c6（与收藏的金区分开）",
          liked["like"]["bg"] == "rgb(255, 179, 198)", liked["like"]["bg"])
    check("浏览是读数不是按钮：字色比两个按钮淡一档",
          r["views"]["color"] != r["btn"]["color"], f'{r["views"]["color"]} / {r["btn"]["color"]}')
    check("讨论数同属读数档：字色与浏览逐字相同（不给它一个「能点」的外观）",
          r["com"]["color"] == r["views"]["color"],
          f'{r["com"]["color"]} / {r["views"]["color"]}')
    check("  四件的描边色本来就相同（20261001 把它统一成一条）",
          len({r[k]["bc"] for k in ITEMS}) == 1, str({k: r[k]["bc"] for k in ITEMS}))

    print("⑥ ★手机档（327px / 768px）：四件收成 24px/4px，且整个读数盒不越封面顶")
    pg.set_viewport_size({"width": 768, "height": 900})
    r6 = pg.evaluate(PAINT, {"markup": mk()})
    check("文案仍是一个行盒", r6["labelLines"] == 1, str(r6["labelLines"]))
    check("四件仍同高、且收成 24px（不是桌面档的 30px）",
          len({round(r6[k]["h"], 1) for k in ITEMS}) == 1 and abs(r6["btn"]["h"] - 24) < 0.5,
          str([round(r6[k]["h"], 1) for k in ITEMS]))
    check("间距收成 4px", abs(r6["wrapGap"] - 4) < 0.5, str(r6["wrapGap"]))
    check("整簇仍是一列（四件横向中心相同、竖直中心各不相同）",
          max(r6[k]["cx"] for k in ITEMS) - min(r6[k]["cx"] for k in ITEMS) < 0.5
          and len({round(r6[k]["cy"], 1) for k in ITEMS}) == len(ITEMS),
          str([round(r6[k]["cy"], 1) for k in ITEMS]))
    # ★ 这条是 20261003 把封面从 200 抬到 240 的全部理由：`.readInfo` 是
    # `bottom: B` + `translateY(-50%)` 的绝对定位盒，`.readCover` 又是 `overflow: hidden`
    # ⇒ 上沿 = 封面高 − B − 1.5×盒高。四件竖排把盒高从 68 撑到 138，200 档算不平。
    check(f"  ★整簇上沿不越出封面（簇 top {r6['wrap']['top']:.0f} / 封面 top 0）",
          r6["wrap"]["top"] >= 0 and r6["info"]["top"] >= 0,
          f'info top {r6["info"]["top"]:.1f} / wrap top {r6["wrap"]["top"]:.1f}')
    for w in (327, 768):
        pg.set_viewport_size({"width": w, "height": 800})
        rw = pg.evaluate(PAINT, {"markup": mk()})
        check(f"  {w}px 档同样不越界（上沿 {rw['info']['top']:.0f}、簇 {rw['wrap']['top']:.0f}）",
              rw["info"]["top"] >= 0 and rw["wrap"]["top"] >= 0,
              f'info {rw["info"]["top"]:.1f} / wrap {rw["wrap"]["top"]:.1f}')
    check("  327px 与 768px 同属手机档：簇几何逐字相同",
          abs(r6["wrap"]["w"] - rw["wrap"]["w"]) < 0.5
          and abs(r6["wrap"]["h"] - rw["wrap"]["h"]) < 0.5,
          f'{round(r6["wrap"]["w"],1)}x{round(r6["wrap"]["h"],1)} vs '
          f'{round(rw["wrap"]["w"],1)}x{round(rw["wrap"]["h"],1)}')

    print("⑥b 反向对照：把手机档那三条覆盖撤回 200px 那一版 ⇒ 上沿当场越界")
    rm = pg.evaluate(PAINT, {"markup": mk(), "legacy": "legacy-mobile", "css": LEGACY_MOBILE})
    check(f"  撤回后整盒上沿 = {rm['info']['top']:.0f}px（负 = 被 `overflow: hidden` 裁掉）"
          "——⑥ 那条判据确实有牙",
          rm["info"]["top"] < -5, f'info top {rm["info"]["top"]:.1f}')
    check(f"  裁掉的正好是最上面那件（收藏 top {rm['btn']['top']:.0f}px）",
          rm["btn"]["top"] < 0, f'{rm["btn"]["top"]:.1f}')

    print("⑦ 布局锁死：四种标题长度下右区/日期几何逐字相同（20261001 用户第 4 条）")
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

    print("⑦b 反向对照：拆回平级五项 + `space-between`，日期当场漂走")
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
