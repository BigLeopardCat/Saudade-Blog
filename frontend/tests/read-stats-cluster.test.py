#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""文章横幅「读数四件」= 2×2 的四个等大格子（20260926 起；20261001 改形态；20261003 改排布）。

  python3 tests/read-stats-cluster.test.py

沿革：本文件原名 `read-fav-vertical.test.py`，锁的是"收藏按钮竖排"那套（20260926）。
20261001 用户第 1 条把那一版整体否了 ——「详情页三图标样式和布局太丑了，大小不一，
排列奇怪」：

    实测（1280×900，线上）            宽 × 高    内边距      字号   描边 α
    .readFavWrap  .readFavBtn        32 × 62    6px 8px     13    .55   ← 竖排
    .readViews                       59 × 24    2px 8px     12    .35
    .readLikeBtn                     64 × 30    4px 10px    13    .55

一件竖的、两件横的，高度差到 2.6 倍 —— 排在一行里怎么摆都对不齐。所以 20261001 改成
一簇 `.readStats` + 三件共用几何 `.readStat`。此后这一簇的**排布**改过三次，`.readStat`
那份几何**一次都没动**（"大小不一"的判据因此一直有效）：

    20261001  一行三件      —— 治"大小不一"
    20261003a 竖排一列四件  —— 治"横排 260px 把标题挤偏"
    20261003b **2×2 四件**  —— 用户第 2 条「右侧是四个数据组件 2*2 排布」

为什么 2×2 之后就**不必再管簇的宽度**了：挤偏的成因是"中区吃余量 ⇒ 中区中线 =
卡片中线 + (左区宽 − 右区宽)/2"，它成立的前提是`.readInfo` 是 **flex 行**。本轮改成
**三列车格**、两条侧轨写同一个变量（`.readInfo` 的 `--read-side`）⇒ 中区中线与卡片
中线**结构上重合**，与两边装什么都无关。判据因此升级成一条更强的不变量：
**中区中线与卡片中线差 < 1px**（①c 与 ⑦ 两组都量它），且**左区与右区的宽度逐字相等**（②）。

为什么用无头浏览器而不是 node 桩：这是**布局**问题（行盒、等高、格子的宽高、绝对定位盒
是否越出 overflow:hidden 的父盒），桩里算不出这些。真 CSS = node 侧真编译的 `.sass` +
仓库里那份 `* { box-sizing: border-box }` 重置（`src/frontHome/main.css`），页面里手写与
`index.tsx` 同形的标记（不挂 React——类名与结构就是全部接口）。

锁十二组：
  ① **四件同形**（正面判据）：高度/圆角/描边宽/描边色/内边距/字号六项逐项相等，且换内容
     也不变（收藏 ⇄ 已收藏、数字一位 ⇄ 四位）；
     ①b 反向对照：把旧的三套几何内联写回去 ⇒ 高度当场不等（证明 ① 抓得住"大小不一"）；
     ①c ★**2×2**：横向中心恰好两个值、纵向中心恰好两个值、四个格子等大，且按 DOM 顺序
     落在左上/右上/左下/右下；**反向对照**：把列数写回 1 ⇒ ①c 当场不成立；
  ② ★**两条侧轨等宽**（结构性居中的唯一来源）：左区、右区宽度逐字相等，簇高 = 2×件高 +
     间距；**中区中线与卡片中线差 < 1px**；
     ②b 文案/数字变长时**件内内容**不挪（`.readFavLabel{min-width:3em}`、数字 `4ch`），
     且内容始终装得下格子（`scrollWidth ≤ clientWidth`）；**反向对照**：把两条定宽一起
     抹掉 ⇒ 文案当场宽 13px（图标跟着跳）；
  ③ **挤压回归**（20260926 那件事）：超长标题下四个格子与两条侧轨逐字不动；
     ③b 反向对照：把中区轨道写成 `1fr`（少了 `minmax(0, …)`）⇒ 一格长词当场把整行顶出卡片；
  ④ 图标：四件的 svg 同尺寸 14px、`aria-hidden`，文案仍在 `span.readFavLabel` 里；
  ⑤ 三态色一字未改；讨论数是**读数不是按钮**（字色与浏览同档、比两个按钮淡）；
  ⑥ ★手机档（327px / 768px 两档）：`.readInfo` 落成**单列**（手机的三列放不下）、
     四件收成 24px 高 / 4px 间距，**且整个信息盒不越出封面顶**；
     **反向对照**：把封面高撤回 200px ⇒ 上沿当场越界；
  ⑦ 布局锁死：四种标题长度下中区、右区、左区、卡片高的坐标逐字相同，且每次中区都居中；
     ⑦b 反向对照：把两条侧轨写成**不等宽** ⇒ 中区当场偏 40px（居中靠的就是"等宽"这一条）。
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

# 与 index.tsx 同形的标记：三区并列（作者 / 标题 / 读数四件）。
# ⚠️ 这一版的结构**本身**就是判据的一部分：两条侧轨的宽度由 `.readInfo` 的列模板决定，
# 夹具少一个区（或把某区嵌进另一区）就会让"结构性居中"那条判据失去意义。
# 头像写死 40×40 的内联样式 —— 线上那件是 antd `Avatar size={40}`（尺寸来自它的内联样式），
# 夹具不挂 React，就把这个数写在这里（只有它影响左区的高度）。
MARKUP = """
<div class="readContainer">
  <div class="readCover" id="cover">
    <div class="readInfo" id="info">
      <div class="readAuthor" id="author">
        <div class="readAuthorRow" id="arow">
          <span class="frontAvatar" id="av" style="width:40px;height:40px;display:inline-block">头</span>
          <span class="readAuthorName" id="name">{author}</span>
        </div>
        <div class="readTimes" id="times">
          <span id="pub">发布于 2026-10-01</span>
          <span id="upd">更新于 2026-10-03</span>
        </div>
      </div>
      <div class="readMain" id="main">
        <h1 id="title">{title}</h1>
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

# ①c 的反向对照：把列数写回 1（= 20261003a 那一版竖排一列）。四条列宽判据当场不成立。
LEGACY_ONE_COL = "#wrap { grid-template-columns: 1fr !important; }"

# ②b 的反向对照：把两件定宽一起抹掉（文案 3em + 数字 4ch）。判的是**件内内容**的宽度
# ——格子本身是定宽的，内容变宽不会再动格子，但图标会在胶囊里左右跳（这就是它俩存在的理由）。
LEGACY_MINW = ("#label { min-width: 0 !important; }"
               "#viewsnum, #likenum, #commentnum { min-width: 0 !important; }")

# ⑦b 的反向对照：两条侧轨**不等宽**（左 180 / 右 260）⇒ 中区中线当场偏 40px。
# 这一条比"当年那套 flex 到底漂多少"更直接：居中靠的就是"等宽"这一条，不是别的。
LEGACY_ASYM = "#info { grid-template-columns: 180px 1fr 260px !important; }"

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
  // 反向对照的样式表是**累加**在页面上的，每次重画先清掉上一张（只清我们加的那些）。
  for (const s of [...document.querySelectorAll('style[id^="legacy"]')]) s.remove();
  document.getElementById('root').innerHTML = o.markup;
  if (o.css) {
    const s = document.createElement('style');
    s.id = o.legacy || 'legacy'; s.textContent = o.css;
    document.head.appendChild(s);
  }
  const box = (id) => {
    const el = document.getElementById(id);
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return {
      w: r.width, h: r.height, left: r.left, right: r.right,
      cx: r.left + r.width / 2, cy: r.top + r.height / 2,
      top: r.top, bottom: r.bottom,
      sw: el.scrollWidth, cw: el.clientWidth,
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
    author: box('author'), arow: box('arow'), av: box('av'), name: box('name'),
    times: box('times'), label: box('label'), viewsnum: box('viewsnum'),
    wrapGap: parseFloat(getComputedStyle(document.getElementById('wrap')).gap) || 0,
    labelText: document.getElementById('label').textContent,
    labelLines: rng('label').length,
    titleLines: rng('title').length,
    titleW: document.getElementById('title').getBoundingClientRect().width,
    titleH: document.getElementById('title').getBoundingClientRect().height,
    infoH: document.querySelector('.readInfo').getBoundingClientRect().height,
  };
}"""


def mk(title: str = LONG_TITLE, faved: str = " isFaved", text: str = "已收藏",
       views: str = "128", likes: str = "7", liked: str = "", comments: str = "3",
       author: str = "泠月") -> str:
    return MARKUP.format(title=title, faved=faved, text=text, author=author,
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

    print("①c ★2×2（20261003 用户第 2 条「右侧是四个数据组件 2*2 排布」）")
    cx = [round(r[k]["cx"], 1) for k in ITEMS]
    cy = [round(r[k]["cy"], 1) for k in ITEMS]
    check("四件横向中心恰好两个值（落成两列）", len(set(cx)) == 2, str(cx))
    check("  四件纵向中心恰好两个值（落成两行）", len(set(cy)) == 2, str(cy))
    # DOM 顺序 = 阅读顺序：收藏→浏览→点赞→讨论 应落在 左上→右上→左下→右下。
    # 具体地：奇偶配对（第 1/3 件同列、第 2/4 件同列）且第 1 件在第 2 件左边。
    check("  按 DOM 顺序落在 左上 → 右上 → 左下 → 右下",
          cx[0] == cx[2] and cx[1] == cx[3] and cy[0] == cy[1] and cy[2] == cy[3]
          and cx[0] < cx[1] and cy[0] < cy[2],
          str([(k, round(r[k]["cx"], 1), round(r[k]["cy"], 1)) for k in ITEMS]))
    check("  四个格子等宽等高（`1fr 1fr` + grid 默认 stretch）",
          len({round(r[k]["w"], 1) for k in ITEMS}) == 1
          and len({round(r[k]["h"], 1) for k in ITEMS}) == 1,
          str([(round(r[k]["w"], 1), round(r[k]["h"], 1)) for k in ITEMS]))
    # ★ 用户第 2 条第一句就是「现在标题没有居中」。这条判据量的是**结构**：
    # 中区的中线是不是落在这张卡的中线上。旧 flex 版这里偏 ±30px 都算"看着还行"
    # （因为靠"两边碰巧差不多宽"），所以阈值从 30px 收到 1px。
    off = r["main"]["cx"] - r["info"]["cx"]
    check(f"  ★中区中线与卡片中线差 {off:+.1f}px（< 1px —— 结构性居中，不是「看着还行」）",
          abs(off) < 1, f"{off:+.1f}px")

    print("①c′ 反向对照：把列数写回 1 ⇒ ①c 的四条判据当场不成立")
    r1 = pg.evaluate(PAINT, {"markup": mk(), "legacy": "legacy-onecol", "css": LEGACY_ONE_COL})
    one_cx = [round(r1[k]["cx"], 1) for k in ITEMS]
    check("  一列时横向中心只剩一个值（①c「恰好两个值」当场不成立）",
          len(set(one_cx)) == 1, str(one_cx))
    check("  且四件的竖直中心各不相同（①c「恰好两个值」当场不成立）",
          len({round(r1[k]["cy"], 1) for k in ITEMS}) == len(ITEMS),
          str([round(r1[k]["cy"], 1) for k in ITEMS]))
    # ⚠️ 这里曾经有一条"整簇变窄 ⇒ 标题归位"的因果判据。**现在没有了**：簇的宽度由
    # 侧轨定死（180px），它在列里怎么排都不影响中区。这正是本轮的结构性改善——
    # 标题的居中不再依赖"簇有多宽"，所以也没有"簇一变宽标题就偏"这条回归路径。
    check("  一列时整簇的宽度/左缘逐字不变（标题居中不再受簇的排布影响）",
          abs(r1["wrap"]["w"] - r["wrap"]["w"]) < 0.5
          and abs(r1["wrap"]["left"] - r["wrap"]["left"]) < 0.5,
          f'{round(r1["wrap"]["w"],1)}@{round(r1["wrap"]["left"],1)} vs '
          f'{round(r["wrap"]["w"],1)}@{round(r["wrap"]["left"],1)}')

    print("② ★两条侧轨等宽（结构性居中的唯一来源）+ 整簇 = 2×2 的格数账")
    check(f"★左区与右区宽度逐字相等（同一个 `--read-side` 写两遍，实得 {r['wrap']['w']:.0f}px）",
          abs(r["author"]["w"] - r["wrap"]["w"]) < 0.5,
          f'{round(r["author"]["w"],1)} vs {round(r["wrap"]["w"],1)}')
    check("  侧轨 = 180px（左区里那行「发布于 2026-10-01」@12px 定出来的）",
          abs(r["wrap"]["w"] - 180) < 0.5, f'{round(r["wrap"]["w"],1)}')
    # 中区拿到的是 880 − 2×24（卡片内边距）− 2×180（侧轨）− 2×24（列间距）= 424px。
    # 这是"标题有多少余量"的唯一一处锁：改 `--read-side` / 卡片宽 / 间距都会动它。
    check(f"  中区轨道宽 {r['main']['w']:.0f}px = 880 − 2×24 − 2×180 − 2×24 = 424",
          abs(r["main"]["w"] - 424) < 0.5, f'{round(r["main"]["w"],1)}')
    expect_h = 2 * r["btn"]["h"] + r["wrapGap"]
    check(f"整簇高 = 两行 + 一道间距（{expect_h:.1f}px，不是四行）",
          abs(r["wrap"]["h"] - expect_h) < 0.5,
          f'{round(r["wrap"]["h"],1)} vs {expect_h}')
    check("  整簇宽 = 两格 + 一道间距（同一条 `1fr 1fr` 列宽，实得 2×87 + 6 = 180）",
          abs(r["wrap"]["w"] - (2 * r["btn"]["w"] + r["wrapGap"])) < 0.5,
          f'{round(r["wrap"]["w"],1)} vs {round(2 * r["btn"]["w"] + r["wrapGap"],1)}')

    print("②b 文案/数字变长时件内内容**不挪位**，且内容始终装得下格子")
    # ⚠️ 判据从"整簇的宽/左缘"改成了"**件内内容**的宽"。格子现在是定宽的
    # （(180−6)/2 = 87px，由轨道算出来），文案变长只会在胶囊里把图标挤来挤去
    # ——那正是 `3em` / `4ch` 这两条定宽存在的理由。
    two = pg.evaluate(PAINT, {"markup": mk(faved="", text="收藏", views="7", likes="0",
                                           comments="0")})
    r4 = pg.evaluate(PAINT, {"markup": mk(faved=" isFaved", text="已收藏", views="1234",
                                          likes="9999", comments="1234")})
    check("收藏（两字）⇄ 已收藏（三字）：`3em` 兜住 ⇒ 文案盒宽度逐字不变",
          abs(two["label"]["w"] - r4["label"]["w"]) < 0.5,
          f'{round(two["label"]["w"],1)} vs {round(r4["label"]["w"],1)}')
    # 4ch 的覆盖范围就是 1–4 位（`min-width` 兜底不封顶，5 位会变宽——那是刻意的，
    # 见 sass 里那段注释）。判据取 4 位正是那道坎：999 → 1000。
    check("  数字 1 位 ⇄ 4 位：`4ch` 兜住 ⇒ 数字盒宽度逐字不变",
          abs(two["viewsnum"]["w"] - r4["viewsnum"]["w"]) < 0.5,
          f'{round(two["viewsnum"]["w"],1)} vs {round(r4["viewsnum"]["w"],1)}')
    check("  换内容后四件的盒子（宽/高）与整簇位置都不动（格子是定宽的）",
          all(abs(two[k]["w"] - r4[k]["w"]) < 0.5 and abs(two[k]["h"] - r4[k]["h"]) < 0.5
              for k in ITEMS)
          and abs(two["wrap"]["left"] - r4["wrap"]["left"]) < 0.5,
          str([(k, round(two[k]["w"], 1), round(r4[k]["w"], 1)) for k in ITEMS]))
    # 格子只有 87px 宽，内容再宽就会画出胶囊之外（`.readStats` 的 `min-width: 0`
    # 只保证"不让格子顶宽"，不保证"内容装得下"）——所以这一条要单独量。
    for tag, rr in (("最窄（收藏 / 一位数字）", two), ("最宽（已收藏 / 四位数字）", r4)):
        check(f"  {tag}：四件的内容都装得下格子（scrollWidth ≤ clientWidth）",
              all(rr[k]["sw"] <= rr[k]["cw"] + 0.5 for k in ITEMS),
              str([(k, rr[k]["sw"], rr[k]["cw"]) for k in ITEMS]))
    rmin = pg.evaluate(PAINT, {"markup": mk(faved="", text="收藏", views="7", likes="0",
                                            comments="0"),
                               "legacy": "legacy-minw", "css": LEGACY_MINW})
    check("  反向对照：把两条定宽抹掉后文案盒**确实**缩了 13px（②b 不是空断言）",
          rmin["label"]["w"] < two["label"]["w"] - 10,
          f'{round(two["label"]["w"],1)} → {round(rmin["label"]["w"],1)}')

    print("③ 超长标题下四个格子与两条侧轨逐字不动")
    rnat = pg.evaluate(PAINT, {"markup": mk(title="短标题")})
    check("与短标题时（中区宽/左缘、整簇左缘、左区宽、卡片高）逐字相等",
          (round(r["main"]["w"], 1), round(r["main"]["left"], 1),
           round(r["wrap"]["left"], 1), round(r["author"]["w"], 1),
           round(r["infoH"], 1))
          == (round(rnat["main"]["w"], 1), round(rnat["main"]["left"], 1),
              round(rnat["wrap"]["left"], 1), round(rnat["author"]["w"], 1),
              round(rnat["infoH"], 1)),
          f'{r["infoH"]:.1f} / {rnat["infoH"]:.1f}')
    check("标题确实占掉了空间（否则这个场景没被复现）", r["titleW"] > 300, f'{r["titleW"]}')
    check("文案只有一个行盒（没折成两行）", r["labelLines"] == 1, str(r["labelLines"]))

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

    print("⑥ ★手机档（327px / 768px）：三区落成单列，四件仍 2×2 并收成 24px/4px")
    pg.set_viewport_size({"width": 768, "height": 900})
    r6 = pg.evaluate(PAINT, {"markup": mk()})
    check("文案仍是一个行盒", r6["labelLines"] == 1, str(r6["labelLines"]))
    check("四件仍同高、且收成 24px（不是桌面档的 30px）",
          len({round(r6[k]["h"], 1) for k in ITEMS}) == 1 and abs(r6["btn"]["h"] - 24) < 0.5,
          str([round(r6[k]["h"], 1) for k in ITEMS]))
    check("间距收成 4px", abs(r6["wrapGap"] - 4) < 0.5, str(r6["wrapGap"]))
    check("四件仍是 2×2（列变窄了，排布不跟着改）",
          len({round(r6[k]["cx"], 1) for k in ITEMS}) == 2
          and len({round(r6[k]["cy"], 1) for k in ITEMS}) == 2,
          str([(k, round(r6[k]["cx"], 1), round(r6[k]["cy"], 1)) for k in ITEMS]))
    # ★ 手机档三区**必须回落成单列**：`.readInfo` 宽 = 100% − 32px ≈ 343px（768px 档
    # 也才 736px），三条 180px 的轨道根本摆不下。单列的判据 = 三区同左同宽 + 依次向下。
    check("★三区落成单列（同左缘、同宽、依次向下）",
          abs(r6["author"]["left"] - r6["main"]["left"]) < 0.5
          and abs(r6["main"]["left"] - r6["wrap"]["left"]) < 0.5
          and abs(r6["author"]["w"] - r6["wrap"]["w"]) < 0.5
          and r6["author"]["bottom"] <= r6["main"]["top"] + 0.5
          and r6["main"]["bottom"] <= r6["wrap"]["top"] + 0.5,
          str([(k, round(r6[k]["left"], 1), round(r6[k]["top"], 1)) for k in
               ("author", "main", "wrap")]))
    # ★ 这条是 20261003 把封面从 200 抬到 260 的全部理由：`.readInfo` 是
    # `bottom: B` + `translateX(-50%)` 的绝对定位盒，`.readCover` 又是 `overflow: hidden`
    # ⇒ 上沿 = 封面高 − B − 盒高（三区竖着叠起来之后盒高从 68 涨到 226）。
    check(f"  ★整个信息盒不越出封面顶（信息盒上沿 {r6['info']['top']:.0f} / 封面 top 0）",
          r6["wrap"]["top"] >= 0 and r6["info"]["top"] >= 0,
          f'info top {r6["info"]["top"]:.1f} / wrap top {r6["wrap"]["top"]:.1f}')
    for w in (327, 768):
        pg.set_viewport_size({"width": w, "height": 800})
        rw = pg.evaluate(PAINT, {"markup": mk()})
        check(f"  {w}px 档同样不越界（上沿 {rw['info']['top']:.0f}、簇 {rw['wrap']['top']:.0f}）",
              rw["info"]["top"] >= 0 and rw["wrap"]["top"] >= 0,
              f'info {rw["info"]["top"]:.1f} / wrap {rw["wrap"]["top"]:.1f}')
    check("  327px 与 768px 同属手机档：四件几何逐字相同",
          abs(r6["wrap"]["w"] - rw["wrap"]["w"]) < 0.5
          and abs(r6["wrap"]["h"] - rw["wrap"]["h"]) < 0.5,
          f'{round(r6["wrap"]["w"],1)}x{round(r6["wrap"]["h"],1)} vs '
          f'{round(rw["wrap"]["w"],1)}x{round(rw["wrap"]["h"],1)}')

    print("⑥b 反向对照：把手机档那三条覆盖撤回 200px 那一版 ⇒ 上沿当场越界")
    rm = pg.evaluate(PAINT, {"markup": mk(), "legacy": "legacy-mobile", "css": LEGACY_MOBILE})
    check(f"  撤回后整盒上沿 = {rm['info']['top']:.0f}px（负 = 被 `overflow: hidden` 裁掉）"
          "——⑥ 那条判据确实有牙",
          rm["info"]["top"] < -5, f'info top {rm["info"]["top"]:.1f}')
    # 绝对定位盒是**底边锚定**的：越界时被裁掉的是**最上面那一区**（作者行），
    # 不是读数簇（它在最下面，反而还在页面里）。这条断言与上一版正好相反——
    # 上一版三区还并排、读数簇贴着上边。
    check(f"  裁掉的正好是最上面那一区（作者行 top {rm['author']['top']:.0f}px）",
          rm["author"]["top"] < 0, f'{rm["author"]["top"]:.1f}')

    print("⑦ 布局锁死：四种标题长度下三区几何逐字相同，且每次都居中（20261001 第 4 条）")
    pg.set_viewport_size({"width": 1280, "height": 900})
    titles = ["短文", "一篇中等长度的文章标题",
              "一篇标题特别长的文章：从零开始把站内对话助手接进个人博客的完整记录与踩坑清单（下篇）",
              "一篇标题特别长的文章：从零开始把站内对话助手接进个人博客的完整记录与踩坑清单（下篇）"
              "——再补一段足够长的副标题把这一行彻底撑满看看会发生什么"]
    got = [pg.evaluate(PAINT, {"markup": mk(title=t)}) for t in titles]
    key = lambda x: (round(x["main"]["left"], 1), round(x["main"]["w"], 1),
                     round(x["wrap"]["left"], 1), round(x["author"]["left"], 1),
                     round(x["infoH"], 1))
    check("★ 四档标题下（中区左缘/宽、整簇左缘、左区左缘、卡片高）逐字相同",
          len({key(x) for x in got}) == 1, str([key(x) for x in got]))
    check("  ★四档都是居中的（中区中线 = 卡片中线，与标题多长无关）",
          all(abs(x["main"]["cx"] - x["info"]["cx"]) < 1 for x in got),
          str([round(x["main"]["cx"] - x["info"]["cx"], 1) for x in got]))
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

    print("⑦b 反向对照：两条侧轨写成不等宽 ⇒ 中区当场偏 40px（居中靠的就是「等宽」）")
    asym = pg.evaluate(PAINT, {"markup": mk(title=titles[0]),
                               "legacy": "legacy-asym", "css": LEGACY_ASYM})
    off_asym = asym["main"]["cx"] - asym["info"]["cx"]
    check(f"  左 180 / 右 260 时中区偏 {off_asym:+.1f}px（①c 与 ⑦ 的 < 1px 确实有牙）",
          abs(off_asym) > 30, f"{off_asym:+.1f}px")
    # 顺带说明**为什么**这一条是"结构性"的：偏的正是两条轨道宽度差的一半
    # （(260 − 180) / 2 = 40），与标题多长、四件多宽都无关。
    check("  偏移量 = 两轨宽度差的一半（(260 − 180)/2 = 40）——与内容无关",
          abs(abs(off_asym) - 40) < 1, f'{abs(off_asym):.1f}')

    check("无 JS 运行时报错", not errs, "; ".join(errs[:2]))
    br.close()

shutil.rmtree(SANDBOX, ignore_errors=True)
print(f"\n{'✗' if FAIL else '✓'} read-stats-cluster：{PASS} 通过 / {FAIL} 失败")
raise SystemExit(1 if FAIL else 0)
