# -*- coding: utf-8 -*-
"""文章网格：**一格一张卡、卡必须填满那一格**（用户第六报）。

  python3 tests/article-grid.test.py

用户原话：「6.某些分辨率下会出现文章卡片大小不一。」

根因是**量出来的**，不是看出来的（真 `index.sass` + 真 Chromium，逐档扫 375→2560）：

  `.allArticles` 是 `repeat(auto-fit, minmax(340px, 1fr))` 的网格，网格项 `.article`
  是 `display: flex` —— 但那条 `display: flex` 只为**纵轴**而写（同行卡片拉齐到整行高），
  横轴上谁也没说话。于是卡（`.ArticleCard`，`.article` 的 flex 子项）按 `flex-basis: auto`
  取**内容宽度**：内容比格子宽的卡被压回格子宽，内容短的卡就停在原地 —— 同一排里窄一截。

  实测（修复前）：

    · 1440 屏三列（格子 412px）：短标题 + 无标签那张只有 **265px**，邻居 412px；
    · 1280 屏同一排里出现过**三个**宽度：265 / 344 / 364；
    · 375 屏（手机两列、格子 172px）也一样：112 / 124 vs 172。

  所以它不是"某些分辨率"的问题、是**每一档**都有，只是格子越宽、内容撑不满的卡越多、
  越扎眼 —— 这正是用户在大屏上把它看出来的原因。修法 = `.ArticleCard` 补一条
  `flex: 1 1 auto`（与旁边 `.ArticleContent` 那条同一个写法）。

为什么必须另起一个套件：`article-card-hover.test.py` 的桩把网格钉成**单列 341px**
（`style="width:341px;grid-template-columns:repeat(1,1fr)"`）—— 一列一卡，"同排是否等宽"
在那个沙箱里根本不存在，量不到这个缺陷。

判据三组：① 同排等宽（用户看得见的那件事）；② 那个宽度**等于网格轨道宽**（证明是"填满格子"
而不是"碰巧大家都一样窄"）；③ **负空间**——把 `flex: 1 1 auto` 换回初始值 `0 1 auto`，
缺陷必须重现（不然这一组是空判据，"以后谁把这条删了"照样绿）。

本机无中文字体（汉字是 .notdef 方块），所以桩里的标题/简介一律写字面量，
量的是**盒子**不是字形 —— 方块一样撑宽度，判据不受影响。
"""
import functools
import http.server
import pathlib
import shutil
import subprocess
import sys
import tempfile
import threading

FE = pathlib.Path(__file__).resolve().parent.parent
SASS_FILE = FE / "src/frontHome/Content/ContentHome/index.sass"
RESET_CSS = FE / "src/frontHome/main.css"

PASS, FAIL = 0, 0


def check(desc: str, cond: bool, detail: str = "") -> None:
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"  ✓ {desc}")
    else:
        FAIL += 1
        print(f"  ✗ {desc}" + (f"  → {detail}" if detail else ""))


# 内容形状 = **线上六篇真实的标题与简介**（20261001 从 `GET /api/public/notes` 抄下来的
# 字面量，只抄字、不抄 id）。用真数据不是洁癖：缺陷的触发条件是"卡的自然宽度 < 格子宽"，
# 而自然宽度由标题与简介**共同**决定（`.descSlot` 里的简介不是绝对定位、它是撑宽的一份子）。
# 线上正好有两篇是「六字标题 + 简介只有一个空格」（`我，管理员！` / `Git从入门到入土`）——
# 那就是用户看到的那张窄卡。桩里要是全写长简介，这个缺陷就量不到了。
SHAPES = [
    ("我，管理员！", " ", 0),
    ("文章向量空间图谱项目文档", "本文是首页「向量图谱」展示柜的完整技术记录", 3),
    ("Python asyncio 异步并发：进程、线程、协程、任务与事件循环",
     "本文从操作系统到 Python，系统梳理了进程、线程、协程、任务与事件循环的来龙去脉。", 6),
    ("IoT 设备接入物联网平台指南", "IoT 设备接入物联网平台指南", 0),
    ("Saudade Blog AI Agent（泠月喵）架构文档",
     "面向维护者的全链路技术文档。覆盖看板娘对话系统的每一个环节。", 10),
    ("Git从入门到入土", " ", 2),
]

STATS = ('<div class="ArticleStats">'
         '<span class="ArticleStat" title="阅读量"><span class="ArticleStatNum">128</span></span>'
         '<span class="ArticleStat" title="点赞数"><span class="ArticleStatNum">36</span></span>'
         '<span class="ArticleStat" title="收藏数"><span class="ArticleStatNum">12</span></span>'
         '</div>')


def tags(n: int) -> str:
    """标签：antd Tag 的实测几何（height 22 / margin 5 / padding 0 7）。沙箱里没有 antd 的
    CSS，所以按它的尺寸手写（与 `article-card-hover.test.py` 同一份口径）。"""
    return '<div class="tags" style="width:100%;margin-top:10px">' + "".join(
        f'<span style="display:inline-block;height:22px;line-height:22px;margin:5px;'
        f'padding:0 7px;border:1px solid #d9d9d9;border-radius:4px;font-size:12px">标签{i}</span>'
        for i in range(n)) + "</div>"


def card(i: int) -> str:
    title, desc, ntags = SHAPES[i % len(SHAPES)]
    # ⚠️ 选择器链一层都不能缺（`.ContentContainer .allArticles .ArticleCard …`）——
    # 缺一层整套规则静默失效、量出来全是浏览器默认值。标记与 `Article.tsx` 同形。
    return f"""
  <div class="article" id="art{i}">
    <div class="ArticleCard" id="card{i}">
      <div class="ArticleCover" id="cover{i}"></div>
      <div class="ArticleContent" id="content{i}">
        <div class="ArticleHead"><h4 style="color:#5a8fbf"># 编程随笔</h4>{STATS}</div>
        <h3 class="ArticleTitle">{title}</h3>
        <div class="descSlot"><p class="ArticleDescription">{desc}</p></div>
        <div style="width:100%;margin-top:auto;flex-shrink:0">
          {tags(ntags)}
          <div class="ArticleFooter" style="display:flex;align-items:center;padding-bottom:20px;margin-top:10px">
            <span style="display:inline-block;width:40px;height:40px;border-radius:50%;background:#ccc;margin-right:10px"></span>
            <span style="font-weight:bold;margin-right:10px;line-height:22px;font-size:14px">林陌青川</span>
            <div style="position:relative;display:flex;flex-direction:column">
              <span style="font-size:12px;color:#7f7e7e;line-height:22px">发布于 2026-09-30</span>
              <span style="position:absolute;top:100%;margin-top:6px;left:0;font-size:12px;color:#7f7e7e;line-height:22px;white-space:nowrap">更新于 2026-09-30</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>"""


N_CARDS = 12
# 逐档扫：手机两列（375/414/640）、≤768 与 769–820 两个媒体块（768/800）、
# 桌面 2/3/4/5/6 列的各个台阶。**必须都扫**——这个缺陷在每一档都存在，
# 只测一个宽度等于只测了"这一档恰好"。
WIDTHS = [375, 414, 640, 768, 800, 1024, 1280, 1366, 1440, 1680, 1920, 2560]

# 读数：每张卡的偏移盒（`offsetWidth/offsetHeight` 不受 CSS transform 影响 ——
# 卡片有 `&:hover { transform: scale(1.03) }`，用 rect 会把缩放读成尺寸变化）
# + 网格的轨道宽（`gridTemplateColumns` 的 px 列表）。
MEASURE = """() => {
  const grid = document.querySelector('.allArticles');
  const tracks = getComputedStyle(grid).gridTemplateColumns
    .split(' ').map(parseFloat).filter(w => w > 0.5);
  return {
    tracks,
    cards: [...document.querySelectorAll('.ArticleCard')].map(c => ({
      w: c.offsetWidth,
      h: c.offsetHeight,
      top: Math.round(c.getBoundingClientRect().top),
    })),
  };
}"""

# 负空间用的对照声明：`flex: 0 1 auto` 就是 flex 的**初始值**（= 修复前的行为）。
UNDO = '.allArticles > .article > .ArticleCard { flex: 0 1 auto !important }'


def build() -> pathlib.Path:
    sb = pathlib.Path(tempfile.mkdtemp(prefix="article-grid-"))
    r = subprocess.run(["node", "-e",
                        'const sass=require("sass");'
                        'process.stdout.write(sass.compile(process.argv[1]).css.toString());',
                        str(SASS_FILE)],
                       cwd=str(FE), capture_output=True)
    if r.returncode != 0:
        raise SystemExit("sass 编译失败：\n" + r.stderr.decode("utf-8", "replace"))
    (sb / "index.html").write_text(
        '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">'
        '<style>' + RESET_CSS.read_text(encoding="utf-8") + '</style>'
        '<style>' + r.stdout.decode("utf-8") + '</style></head><body>'
        '<div class="ContentContainer">'
        '<div class="allArticles">'
        + "".join(card(i) for i in range(N_CARDS))
        + '</div></div></body></html>', encoding="utf-8")
    return sb


def rows_of(cards):
    """按视口内的 top 归并成"排"。浮点像素会差一两像素，按 4px 容差吸附。"""
    rows = []
    for c in sorted(cards, key=lambda c: (c["top"], c["w"])):
        for row in rows:
            if abs(row[0]["top"] - c["top"]) <= 4:
                row.append(c)
                break
        else:
            rows.append([c])
    return rows


def main() -> int:
    sb = build()

    class _Quiet(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *a, **k):
            return None

    srv = http.server.ThreadingHTTPServer(
        ("127.0.0.1", 0), functools.partial(_Quiet, directory=str(sb)))
    threading.Thread(target=srv.serve_forever, daemon=True).start()

    from playwright.sync_api import sync_playwright  # noqa: E402
    url = f"http://127.0.0.1:{srv.server_address[1]}/index.html"

    with sync_playwright() as p:
        br = p.chromium.launch()
        pg = br.new_page(viewport={"width": 1440, "height": 900})
        errs = []
        pg.on("pageerror", lambda e: errs.append(str(e)))
        pg.goto(url)
        pg.wait_for_timeout(300)

        # ── 一、同排等宽 ────────────────────────────────────────────────────
        print("\n【一】每一档视口：同一排里的卡**只有一种宽度**")
        bad = []
        for w in WIDTHS:
            pg.set_viewport_size({"width": w, "height": 900})
            pg.wait_for_timeout(120)
            m = pg.evaluate(MEASURE)
            for row in rows_of(m["cards"]):
                ws = sorted({c["w"] for c in row})
                if len(ws) > 1:
                    bad.append((w, len(row), ws))
        check("★ 12 档视口 × 每一排：同排卡片宽度只有一种"
              "（修复前 1280 屏同一排里出现过 265 / 344 / 364 三种）",
              not bad, "; ".join(f"{w}px 排{len(r)}张 → {ws}" for w, r, ws in bad[:4]))

        # ── 二、那个宽度 = 网格轨道宽（"填满格子"而不是"碰巧都窄"）────────────
        print("\n【二】卡宽 = 网格轨道宽（真的填满了那一格）")
        off = []
        for w in WIDTHS:
            pg.set_viewport_size({"width": w, "height": 900})
            pg.wait_for_timeout(120)
            m = pg.evaluate(MEASURE)
            track = max(m["tracks"]) if m["tracks"] else 0
            for row in rows_of(m["cards"]):
                for c in row:
                    if abs(c["w"] - track) > 1:
                        off.append((w, c["w"], round(track, 1)))
        check("★ 每张卡的宽都等于它所在轨道的宽（±1px）——"
              "只判'同排等宽'的话，'整排一起窄'这种退化照样绿",
              not off, "; ".join(f"{w}px 卡{cw} vs 轨道{tw}" for w, cw, tw in off[:4]))

        # ── 三、同行等高（纵轴那条老契约，顺手守住不被这次改动带歪）──────────
        print("\n【三】同行等高（`.article` 的 flex 拉伸仍在）")
        badh = []
        for w in WIDTHS:
            pg.set_viewport_size({"width": w, "height": 900})
            pg.wait_for_timeout(120)
            m = pg.evaluate(MEASURE)
            for row in rows_of(m["cards"]):
                hs = sorted({c["h"] for c in row})
                if len(hs) > 1:
                    badh.append((w, len(row), hs))
        check("★ 同一排卡片等高（内容多的把这一排撑高，其余跟着长）",
              not badh, "; ".join(f"{w}px 排{len(r)}张 → {hs}" for w, r, hs in badh[:4]))

        # ── 四、负空间：把这条声明换回初始值，缺陷必须重现 ───────────────────
        print("\n【四】负空间：抹掉 `flex: 1 1 auto` ⇒ 「同排不等宽」必须重现")
        pg.add_style_tag(content=UNDO)
        revived = []
        for w in WIDTHS:
            pg.set_viewport_size({"width": w, "height": 900})
            pg.wait_for_timeout(120)
            m = pg.evaluate(MEASURE)
            for row in rows_of(m["cards"]):
                if len({c["w"] for c in row}) > 1:
                    revived.append(w)
                    break
        # ⚠️ 只要求 **≥640px 的每一档**重现，不要求手机那两档（375/414）。这不是放水——
        # 缺陷的触发条件是"卡的自然宽度**小于**格子宽"，而最窄的两档只有两列（格子 172 /
        # 191px），比**任何一张卡**的自然宽度都窄 ⇒ 张张都被压回格子宽 ⇒ 那一档本来就
        # 等宽。实测也确实如此（375/414 全等于轨道宽，其余十档都重现）。真实站点同理：
        # 用户是在大屏上看出来的。写死"12/12"会变成一条**靠环境凑出来**的判据。
        desktop = [w for w in WIDTHS if w >= 640]
        check(f"★ 换回 `flex: 0 1 auto` 后，≥640px 的每一档（{len(desktop)} 档）"
              "都重现「同排不等宽」（⇒ 第一组的判据咬得住这个缺陷，不是空判据）",
              all(w in revived for w in desktop),
              f"重现档位 {revived}；缺 {[w for w in desktop if w not in revived]}")
        pg.evaluate("() => [...document.querySelectorAll('style')].pop().remove()")
        pg.wait_for_timeout(150)
        pg.set_viewport_size({"width": 1440, "height": 900})
        pg.wait_for_timeout(150)
        m = pg.evaluate(MEASURE)
        check("（对照）摘掉那条覆盖后同排又齐回来",
              all(len({c["w"] for c in row}) == 1 for row in rows_of(m["cards"])),
              str([sorted({c["w"] for c in r}) for r in rows_of(m["cards"])]))

        check("全程无页面异常", not errs, "; ".join(errs[:3]))
        pg.close()
        br.close()

    print()
    if FAIL:
        print(f"❌ article-grid：{PASS} 通过 / {FAIL} 失败")
        return 1
    print(f"✅ article-grid：{PASS} 通过 / 0 失败")
    return 0


sys.exit(main())
