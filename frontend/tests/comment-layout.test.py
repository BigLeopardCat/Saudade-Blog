# -*- coding: utf-8 -*-
"""讨论区几何与深链沙箱（20261003）：计数搬进输入框 / 按钮贴着输入框 / 未登录态 / ?cid= 定位
/ 回复标记另起一行。

## 这个沙箱为什么必须有

`antd` 的 `showCount` 计数是**挂在输入框下方、不占布局空间**的绝对定位元素——
`rc-textarea` 渲染 `span.ant-input-data-count`，`antd/es/input/style/textarea.js` 给它
`position: absolute; bottom: -(fontSize × lineHeight) = -22px; insetInlineEnd: 0`。
原来为了不让它压住下一行，给输入框挂了全站那 22px 的 `counter-room`（`src/index.css`）
——**那一整行空白正是「发表评论按钮离输入框太远」**（用户 20261003 第 3 条原话：
「把字数统计文本移入输入框就能腾出空间，减小按钮到输入框的缝隙了」）。

修法 = 把计数按进框内的右下角（`CommentSection/index.sass` 里那三条），
输入框挂的 `counter-room` 随之摘掉。于是本文件判**两件事，缺一不可**：
  ① fixed 变体：计数**整个落在输入框盒子里**，且输入框到按钮行的缝隙很小；
  ② broken 变体（还原改之前的形态：挂回 `counter-room` + 摘掉按进框内那条 `bottom`）：
     计数**必须落到框外**、**必须压住按钮行**、缝隙**必须变回 30px**。
没有 ②，① 就有可能是永真的——"计数在框里"这类断言最容易在元素根本不存在时也是绿的。

## 沙箱三件事（与既有 .test.py 同recipe；本机不能 vite build，见 CLAUDE.md §2）

  · `src` 整棵拷进临时目录，**就地**替换 `apis/CommentMethods.tsx` 与 `apis/getToken.tsx`
    两个叶子模块（相对路径的模块没法用 `--alias:` 桩）；
  · **antd 用真身**——被测的就是它的计数几何，桩掉等于把判据桩掉；
    组件的 `.sass` 用 programmatic API 编译，**并把 `src/index.css` 原样 <link> 进来**
    （20260929 教训：沙箱里没有全站样式表时 `.counter-room` 这类全局规则压根不存在，
    几何断言会红，而线上是好的）；
  · 真 react-dom 渲染 → Playwright 断言。

用法（仓库任意位置）：python3 frontend/tests/comment-layout.test.py
"""
import json
import pathlib
import shutil
import subprocess
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[2]
FE = ROOT / "frontend"

# 与 dark-mode-contrast / login-page / dashboard-sidebar 同一个串：esbuild 的 iife 输出里
# `import.meta` 是空对象，`import.meta.env.X` 会当场抛 TypeError（整页白屏）。
DEFINE = ('import.meta.env={"VITE_HTTP_BASEURL":"","VITE_CDN_BASEURL":"",'
          '"MODE":"production","DEV":false,"PROD":true,"BASE_URL":"/"}')

FAILS = []


def check(desc, cond, detail=""):
    print(("  ✅ " if cond else "  ❌ ") + desc + (f"  [{detail}]" if detail else ""))
    if not cond:
        FAILS.append(desc)


# ── 夹具：30 条顶层 + 两条回复（回复的回复仍挂在第一条回复的顶层下，测分组） ──────
def fixture_comments():
    items = []
    for i in range(1, 31):
        items.append({
            "id": i, "noteId": 1, "content": f"第 {i} 条顶层评论，用来把页面撑高一点。",
            "parentId": None, "rootId": None, "replyToUid": None, "replyToNickname": None,
            "userId": 700 + i, "nickname": f"访客{i}", "avatar": "",
            "role": "admin" if i == 3 else "user", "mine": i in (2, 30),
            "createdAt": "2026-10-03 12:00:00",
        })
    items.append({
        "id": 41, "noteId": 1, "content": "回复最后一条顶层。", "parentId": 30, "rootId": 30,
        "replyToUid": 730, "replyToNickname": "访客30", "userId": 801, "nickname": "甲",
        "avatar": "", "role": "secretary", "mine": False, "createdAt": "2026-10-03 12:01:00",
    })
    # **深链目标**：回复的回复——它仍挂在顶层 30 下（服务端派生 rootId），排在整个讨论区最后一行
    items.append({
        "id": 42, "noteId": 1, "content": "回复的回复。", "parentId": 41, "rootId": 30,
        "replyToUid": 801, "replyToNickname": "甲", "userId": 802, "nickname": "乙",
        "avatar": "", "role": "zako", "mine": False, "createdAt": "2026-10-03 12:02:00",
    })
    return items


COMMENTS_JSON = json.dumps(fixture_comments(), ensure_ascii=False)

STUB_COMMENTS = '''\
/**
 * 沙箱桩：把 `window.__comments` 按**真接口的信封形状**回给组件
 * （真实现见 `src/apis/CommentMethods.tsx`，成功判据是 `code === 200` 而不是 HTTP 状态码）。
 * 只有读要被量；写不被本套件触碰，回一个最小的成功信封即可。
 */
const env = (data: any) => ({ status: 200, data: { code: 200, message: 'ok', data } });

export const listComments = () =>
    Promise.resolve(env(((window as any).__comments || [])));

export const createComment = () => Promise.resolve(env({ id: 999, approved: 1 }));

export const deleteMyComment = () => Promise.resolve(env('ok'));
'''

STUB_TOKEN = '''\
/** 沙箱桩：真实现读 localStorage 的 `tokenKey`（file:// 下不可靠），改读 `window.__BOOT.token`。 */
const getToken = () => (((window as any).__BOOT || {}).token ?? null);
export default getToken;
'''

ENTRY = '''\
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import CommentSection from './src/components/CommentSection/index.tsx';

(window as any).__comments = %s;

const root = createRoot(document.getElementById('root')!);

/** 挂载/重挂：换 path 或 token 都必须**整棵重挂**——MemoryRouter 的 initialEntries
 *  只在挂载时读一次，改 prop 不会换 location；而 getToken 是渲染期读的，
 *  不重挂就读不到新的 token。key 变一位即强制重挂。 */
(window as any).__mount = (path: string, token: string | null) => {
    (window as any).__BOOT = { path, token };
    root.render(
        React.createElement(MemoryRouter, { initialEntries: [path], key: path + '|' + token },
            React.createElement(CommentSection, { noteId: 1 })),
    );
};

const boot = (window as any).__BOOT || {};
(window as any).__mount(boot.path || '/article/1', boot.token ?? 't');
''' % COMMENTS_JSON


SASS_SRC = FE / "src/components/CommentSection/index.sass"
# 红基线只动两处，正是"改之前的样子"——两处都在沙箱那份拷贝上打，`FE` 里一字不动：
#   ① tsx：输入框挂回全站那 22px 的 `.counter-room`（当年给吊在框下方的计数腾的地方）；
#   ② sass：摘掉把计数按进框内右下角的那条 `bottom: 4px` ⇒ 落回 antd 的 `bottom: -22px`。
TA_REF = "                        ref={taRef}\n"
ROOM_ATTR = '                        className="counter-room"\n'
COUNT_BOTTOM = "                bottom: 4px\n"

# ── 红基线 C（⑨b）：把「回复 @某人」退回**身份行行首**（20261003 用户第 3 条报的那一版）。
# 两处一起退才算真还原：DOM 退回 `.commentMeta` 的首位，CSS 退回"行内小字"（不带 display/边距）。
# 只在沙箱拷贝上打补丁，`FE` 里一字不动。
TSX_META_OPEN = '                <div className="commentMeta">\n'
TSX_REPLY_NEW = """                {isReply && (
                    <div className="commentReplyTo">
                        回复 @{c.replyToNickname || '已注销用户'}
                    </div>
                )}
"""
TSX_REPLY_OLD = """                    {isReply && (
                        <span className="commentReplyTo">
                            回复 @{c.replyToNickname || '已注销用户'}
                        </span>
                    )}
"""
SASS_REPLY_NEW = """        .commentReplyTo
            display: block
            margin: 2px 0 4px
            font-size: 0.8rem
"""
SASS_REPLY_OLD = """        .commentReplyTo
            font-size: 0.8rem
"""


def build(variant: str) -> pathlib.Path:
    """variant:
    'fixed'  src 原样；
    'broken' 改之前的样子（tsx 挂回 counter-room + sass 摘掉按进框内那条）——红基线 A；
    'bare'   只摘掉按进框内那条（= 20261003 早上用户报重叠时的样子）——红基线 B；
    'replyto-old' 「回复 @某人」退回身份行行首（20261003 用户第 3 条报的那一版）——红基线 C。
    三个红基线各自翻的是不同的那几条判据，所以三个都要跑：
    A 翻的是「缝隙」与「落在框内」，B 翻的是「计数与按钮不相交」（当年那 22px 就是为它加的），
    C 翻的是 ⑨ 里「回复标记另有自己的一行」。"""
    sb = pathlib.Path(tempfile.mkdtemp(prefix=f"comment-layout-{variant}-"))
    shutil.copytree(FE / "src", sb / "src")
    (sb / "node_modules").symlink_to(FE / "node_modules")

    # ① 就地替换两个叶子模块（相对路径 import 没法 --alias:）
    (sb / "src/apis/CommentMethods.tsx").write_text(STUB_COMMENTS, encoding="utf-8")
    (sb / "src/apis/getToken.tsx").write_text(STUB_TOKEN, encoding="utf-8")

    if variant == "replyto-old":
        p = sb / "src/components/CommentSection/index.tsx"
        src = p.read_text(encoding="utf-8")
        assert src.count(TSX_REPLY_NEW) == 1, "红基线 C 没找到「另起一行」那段 JSX"
        assert src.count(TSX_META_OPEN) == 1, "红基线 C 没找到 `.commentMeta` 的开标签"
        src = src.replace(TSX_REPLY_NEW, "", 1)                     # 新的删掉
        src = src.replace(TSX_META_OPEN, TSX_META_OPEN + TSX_REPLY_OLD, 1)  # 旧的插回行首
        p.write_text(src, encoding="utf-8")
        s = sb / "src/components/CommentSection/index.sass"
        txt = s.read_text(encoding="utf-8")
        assert txt.count(SASS_REPLY_NEW) == 1, "红基线 C 没找到块级那三条声明"
        s.write_text(txt.replace(SASS_REPLY_NEW, SASS_REPLY_OLD, 1), encoding="utf-8")

    sass_src = SASS_SRC
    if variant in ("broken", "bare", "replyto-old"):
        s = sb / "src/components/CommentSection/index.sass"
        txt = s.read_text(encoding="utf-8")
        assert txt.count(COUNT_BOTTOM) == 1, "红基线补丁没找到把计数按进框内的 `bottom: 4px`"
        s.write_text(txt.replace(COUNT_BOTTOM, "", 1), encoding="utf-8")
        sass_src = s  # 沙箱里那份（整棵 src 已拷过来，相对 import 照样解析）

    if variant == "broken":
        p = sb / "src/components/CommentSection/index.tsx"
        src = p.read_text(encoding="utf-8")
        assert src.count(TA_REF) == 1, "红基线补丁没找到 `ref={taRef}`"
        p.write_text(src.replace(TA_REF, TA_REF + ROOM_ATTR, 1), encoding="utf-8")

    (sb / "entry.tsx").write_text(ENTRY, encoding="utf-8")

    # ② sass 用 programmatic API 编译（CLI 在 Node 18 上因 chokidar 的 ERR_REQUIRE_ESM 崩）
    subprocess.run(["node", "-e",
                    "const s=require('sass');const r=s.compile(process.argv[1],{style:'expanded'});"
                    "require('fs').writeFileSync(process.argv[2],r.css);",
                    str(sass_src), str(sb / "comment.css")],
                   cwd=str(FE), check=True)
    # ③ 全站样式表**逐字节**带进来（.counter-room 就住在这里）
    shutil.copyfile(FE / "src/index.css", sb / "global.css")

    # ④ 打包：.sass 的裸 import 被 text loader 吞掉，CSS 由页面单独引入
    subprocess.run([str(FE / "node_modules/.bin/esbuild"), "entry.tsx",
                    "--bundle", "--format=iife", "--outfile=bundle.js",
                    "--loader:.sass=text", "--jsx=automatic", f"--define:{DEFINE}"],
                   cwd=str(sb), check=True, capture_output=True)

    (sb / "index.html").write_text(
        '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">'
        '<link rel="stylesheet" href="global.css">'
        '<link rel="stylesheet" href="comment.css"></head><body><div id="root"></div>'
        '<script src="bundle.js"></script></body></html>', encoding="utf-8")
    return sb


def box(pg, sel):
    """元素盒子；元素不存在回 None。"""
    return pg.evaluate(
        "s => { const el = document.querySelector(s); if (!el) return null;"
        " const r = el.getBoundingClientRect();"
        " return {x: r.x, y: r.y, w: r.width, h: r.height, right: r.right, bottom: r.bottom}; }",
        sel)


def overlap(a, b):
    """两个盒子相交区域的较短边（px）。<= 0 = 不相交。"""
    if not a or not b:
        return 0.0
    ox = min(a["right"], b["right"]) - max(a["x"], b["x"])
    oy = min(a["bottom"], b["bottom"]) - max(a["y"], b["y"])
    return min(ox, oy)


COUNT = ".ant-input-data-count"
TEXTAREA = ".commentComposer textarea"
FOOT = ".commentComposerFoot"
SUBMIT = ".commentSubmit"

# ⑨ 用：回复行里那几件的盒子与**文档顺序**。判"另起一行"要看几何，判"没插在头像与昵称
# 之间"要看顺序与水平带 —— 光看 CSS 里写没写 `display: block` 是证明不了这两件事的。
REPLY_GEOM = """() => {
  const rows = document.querySelectorAll('.commentRow.isReply');
  const row = rows[0];
  if (!row) return { rows: 0 };
  const q = (s) => row.querySelector(s);
  const b = (e) => { const r = e.getBoundingClientRect();
    return {x: r.x, y: r.y, w: r.width, h: r.height, right: r.right, bottom: r.bottom}; };
  const before = (a, b) => !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
  const meta = q('.commentMeta'), name = q('.commentName'), av = q('.commentAvatar');
  const rt = q('.commentReplyTo'), body = q('.commentBody');
  return {
    rows: rows.length,
    topRowsWithRt: [...document.querySelectorAll('.commentRow:not(.isReply)')]
        .filter(r => r.querySelector('.commentReplyTo')).length,
    meta: b(meta), name: b(name), av: av ? b(av) : null,
    rt: rt ? b(rt) : null, body: body ? b(body) : null,
    rtInsideMeta: !!rt && meta.contains(rt),
    nameBeforeRt: !!rt && before(name, rt),
    rtBeforeBody: !!rt && before(rt, body),
  };
}"""

# 计数该有多大地方待着：它在框内右下角（`bottom:4px` + `line-height:16px`）⇒ 与框底
# 只差几像素。**判"在框里"用 `inside()`，不是判"不相交"**——不相交在它被藏起来、
# 或者跑到八百里外时同样是绿的。
def inside(inner, outer, slack=0.5):
    return bool(inner) and bool(outer) and (
        inner["x"] >= outer["x"] - slack and inner["right"] <= outer["right"] + slack
        and inner["y"] >= outer["y"] - slack and inner["bottom"] <= outer["bottom"] + slack)

FIXED = build("fixed")
BROKEN = build("broken")
BARE = build("bare")
REPLY_OLD = build("replyto-old")

print(f"沙箱：{FIXED}")

from playwright.sync_api import sync_playwright  # noqa: E402

with sync_playwright() as p:
    br = p.chromium.launch()

    # ══ 一、fixed 变体 ══════════════════════════════════════════════════════
    pg = br.new_page(viewport={"width": 1280, "height": 900})
    errs = []
    pg.on("pageerror", lambda e: errs.append(str(e)))
    pg.add_init_script("window.__BOOT = { path: '/article/1', token: 't' };")
    pg.goto(FIXED.as_uri() + "/index.html")
    pg.wait_for_selector(".commentComposer", timeout=8000)
    pg.wait_for_timeout(300)

    print("① 结构：真 antd 渲染出的计数确实在（判据不能建在空气上）")
    check("无 JS 运行时报错", not errs, "; ".join(errs[:2]))
    check("讨论区已渲染", pg.locator(".commentSection").count() == 1)
    check("已登录 → 输入区在、登录提示不在",
          pg.locator(".commentComposer").count() == 1 and pg.locator(".commentLoginTip").count() == 0)
    check("评论列表渲染出 30 个顶层线程", pg.locator(".commentThread").count() == 30,
          pg.locator(".commentThread").count())
    check("回复排在它所属的顶层之下（.isReply 两个）", pg.locator(".commentRow.isReply").count() == 2,
          pg.locator(".commentRow.isReply").count())
    check("计数元素只有一个（antd showCount 的契约元素）", pg.locator(COUNT).count() == 1,
          pg.locator(COUNT).count())
    check("初始计数文本 = 「0 / 300」", pg.locator(COUNT).inner_text().strip() == "0 / 300",
          pg.locator(COUNT).inner_text().strip())
    check("发表按钮在", pg.locator(SUBMIT).inner_text().strip() == "发表评论")

    print("\n② 几何：计数在输入框**里**，且按钮贴着输入框（用户 20261003 第 3 条报的正是这里）")
    c = box(pg, COUNT)
    t = box(pg, TEXTAREA)
    f = box(pg, FOOT)
    s = box(pg, SUBMIT)
    check("计数元素有实际尺寸（不是 display:none 这类「靠藏起来达标」）",
          bool(c) and c["w"] > 0 and c["h"] > 0, c)
    check("★ 计数整个落在输入框盒子之内（`inset-inline-end:10px; bottom:4px`）",
          inside(c, t),
          f"count={c} textarea={t}")
    check("计数贴着框底（不是「框恰好很大所以进去也算」）",
          bool(c) and bool(t) and 0 < t["bottom"] - c["bottom"] <= 8,
          f"离框底 {t and c and round(t['bottom'] - c['bottom'], 1)}px")
    check("计数与「发表评论」按钮不相交", overlap(c, s) <= 0,
          f"相交 {overlap(c, s):.1f}px  count={c} submit={s}")
    check("计数与整行 .commentComposerFoot 不相交", overlap(c, f) <= 0,
          f"相交 {overlap(c, f):.1f}px  count={c} foot={f}")
    check("★ 输入框到按钮行的缝隙很小（≤12px；改之前是 22+8=30px，这正是「按钮太远」）",
          bool(t) and bool(f) and 0 <= f["y"] - t["bottom"] <= 12,
          f"缝隙 {t and f and round(f['y'] - t['bottom'], 1)}px")

    print("\n②b 计数文本变长（0 → 300）后仍在框内同一角：修的不是「初始那串短文本恰好塞得下」")
    pg.fill(TEXTAREA, "字" * 300)
    pg.wait_for_timeout(200)
    c2 = box(pg, COUNT)
    check("计数已更新为「300 / 300」", pg.locator(COUNT).inner_text().strip() == "300 / 300",
          pg.locator(COUNT).inner_text().strip())
    check("长计数仍在框内、仍不压按钮",
          inside(c2, box(pg, TEXTAREA)) and overlap(c2, box(pg, SUBMIT)) <= 0
          and overlap(c2, box(pg, FOOT)) <= 0,
          f"相交 {overlap(c2, box(pg, SUBMIT)):.1f}px")
    # 最后一行文字的下缘 = 框底 − padding-bottom；计数占掉的是「框底往上 4 + 16 = 20px」。
    # 所以判据 = padding-bottom 必须比计数占的那一段还多出一点（`index.sass` 写的是 26）。
    # 这一条量的是"文字与数字在同一块地方却撞不上"，**不是**"CSS 里写了 26px"。
    room = pg.evaluate(
        "() => { const ta = document.querySelector('.commentComposer textarea');"
        " const c = document.querySelector('.ant-input-data-count');"
        " if (!ta || !c) return null;"
        " const t = ta.getBoundingClientRect(), k = c.getBoundingClientRect();"
        " return {pad: parseFloat(getComputedStyle(ta).paddingBottom),"
        "         need: Math.round(k.height + (t.bottom - k.bottom))}; }")
    check("★ 计数占掉的那一段高度（下偏移 + 字高）被 padding-bottom 完整让开",
          bool(room) and room["pad"] >= room["need"] + 2,
          f"padding-bottom={room and room['pad']} 计数占 {room and room['need']}")

    print("\n③ 表情面板：往上弹，不盖住计数")
    pg.fill(".commentComposer textarea", "")
    pg.click(".commentStickerBtn")
    pg.wait_for_timeout(250)
    check("面板已展开", pg.locator(".commentStickerPanel").count() == 1)
    pn = box(pg, ".commentStickerPanel")
    check("面板与计数不相交", overlap(pn, box(pg, COUNT)) <= 0,
          f"相交 {overlap(pn, box(pg, COUNT)):.1f}px")
    check("面板整个在视口内（往上弹而不是顶出去）",
          bool(pn) and pn["y"] >= 0 and pn["bottom"] <= 900 + 0.5,
          f"panel={pn}")
    pg.keyboard.press("Escape")
    pg.wait_for_timeout(150)
    check("Esc 关面板", pg.locator(".commentStickerPanel").count() == 0)

    print("\n④b 点表情插进输入框的是 `:名字:` 文本，不是标签")
    pg.click(".commentStickerBtn")
    pg.wait_for_timeout(200)
    first = pg.locator(".commentStickerItem").first
    name = first.get_attribute("title") or ""
    first.click()
    pg.wait_for_timeout(200)
    val = pg.input_value(".commentComposer textarea")
    check("插入的是冒号名字（渲染才由 markdown 管线转成 img.sticker）",
          val == name and val.startswith(":") and val.endswith(":"), val)
    check("插入后计数跟着走", pg.locator(COUNT).inner_text().strip().startswith(str(len(val))),
          pg.locator(COUNT).inner_text().strip())

    print("\n⑤ 预览（20261003 新加）：写的人当场看见读的人会看到什么")
    pg.fill(".commentComposer textarea", "")
    check("默认收起", pg.locator(".commentPreview").count() == 0)
    pg.click(".commentPreviewBtn")
    pg.wait_for_timeout(200)
    check("点开出现 .commentPreview", pg.locator(".commentPreview").count() == 1)
    check("空草稿给的是提示句、不是空白框",
          pg.locator(".commentPreviewEmpty").count() == 1
          and pg.locator(".commentPreview .commentBody").count() == 0,
          pg.locator(".commentPreview").inner_text().strip()[:40])
    # 主人担心的正是这件事：不认识 markdown 的人打了 `_x_` / `2*3*4`，自己看不见被吃掉了。
    pg.fill(".commentComposer textarea", "_下划线_ 与 2*3*4 还有 :头疼:")
    pg.wait_for_timeout(250)
    ems = pg.locator(".commentPreview .commentBody em").all_inner_texts()
    check("预览里 `_下划线_` 真的变成了 <em>（这就是「写的人看不见、读的人才看得见」那件事）",
          "下划线" in ems, f"em={ems}")
    check("预览里 `2*3*4` 中间那段也被吃成 <em>（同一类风险的第二个例子）",
          "3" in ems and len(ems) == 2, f"em={ems}")
    check("预览里表情已经是图（img.sticker），不是 `:头疼:` 四个字",
          pg.locator(".commentPreview .commentBody img.sticker").count() == 1
          and ":头疼:" not in pg.locator(".commentPreview .commentBody").inner_text(),
          pg.locator(".commentPreview .commentBody img.sticker").count())

    PROPS = ["font-size", "line-height", "margin-top", "color"]

    def styles(sel):
        return pg.evaluate(
            "([s, ps]) => { const el = document.querySelector(s); if (!el) return null;"
            " const c = getComputedStyle(el); const o = {};"
            " ps.forEach(p => o[p] = c.getPropertyValue(p)); return o; }", [sel, PROPS])

    pub, pre = styles(".commentRow .commentBody"), styles(".commentPreview .commentBody")
    check("预览正文与已发布正文**同一套排版**（字号/行距/上边距/颜色逐项相同）",
          bool(pub) and pub == pre, f"published={pub} preview={pre}")
    pub_p, pre_p = styles(".commentRow .commentBody p"), styles(".commentPreview .commentBody p")
    check("段落的边距也同款（预览若另有一套，它就只是在骗人）",
          bool(pub_p) and pub_p == pre_p, f"published={pub_p} preview={pre_p}")
    check("预览展开后计数仍不压按钮（预览在按钮行**下面**，不该动上面那一行）",
          overlap(box(pg, COUNT), box(pg, SUBMIT)) <= 0
          and overlap(box(pg, COUNT), box(pg, FOOT)) <= 0)

    pg.click(".commentPreviewBtn")
    pg.wait_for_timeout(200)
    check("再点一次收起", pg.locator(".commentPreview").count() == 0)

    print("\n⑥ 未登录：只给登录提示，不给输入区")
    pg.evaluate("window.__mount('/article/1', null)")
    pg.wait_for_timeout(400)
    check("登录提示在", pg.locator(".commentLoginTip").count() == 1)
    check("输入区不在", pg.locator(".commentComposer").count() == 0)
    check("计数元素整个不在（没登录就没有输入框）", pg.locator(COUNT).count() == 0)
    check("讨论列表照常可读（读不要求登录）", pg.locator(".commentThread").count() == 30)

    print("\n⑦ 通知深链 ?cid=42：定位到最后一行并高亮（回复的回复也定得到）")
    pg.evaluate("window.__mount('/article/1?cid=42', 't')")
    pg.wait_for_selector(".comment-hit", timeout=8000)
    pg.wait_for_timeout(400)
    check("恰好一行带 .comment-hit", pg.locator(".comment-hit").count() == 1,
          pg.locator(".comment-hit").count())
    check("命中的正是评论 42", pg.get_attribute(".comment-hit", "data-cid") == "42",
          pg.get_attribute(".comment-hit", "data-cid"))
    hit = box(pg, ".comment-hit")
    check("页面确实滚下去了（不是本来就在视口里）", pg.evaluate("window.scrollY") > 0,
          pg.evaluate("window.scrollY"))
    check("命中行落在视口内",
          bool(hit) and hit["y"] >= -1 and hit["bottom"] <= 900 + 1, hit)
    check("命中的是最后一行（目标是回复的回复，排在讨论区末尾）",
          pg.evaluate("document.querySelector('.comment-hit').parentElement === "
                      "document.querySelector('.commentList').lastElementChild"), True)

    print("\n⑦b 身份行：昵称后面跟的是作者的 UID（20261003 主人第 4 条）")
    idrow = pg.evaluate("""() => {
        const row = document.querySelector('#c-42');
        const uid = row.querySelector('.commentUid');
        const name = row.querySelector('.commentName');
        const idSpan = row.querySelector('.commentId');
        return {
            text: uid ? uid.textContent.trim() : null,
            oldSpanGone: !idSpan,
            cid: row.dataset.cid,
            uidFont: uid ? parseFloat(getComputedStyle(uid).fontSize) : 0,
            nameFont: parseFloat(getComputedStyle(name).fontSize),
            hashC: /#C/.test(row.textContent),
        };
    }""")
    # 夹具里 #42 这条的 `userId` 是 802、而它自己的评论 id 是 42 —— 两个数**故意不同**，
    # 写错（把评论 id 当身份显示）当场就红，不用靠人去比对。
    check("身份行写的是 UID:<作者 uid>（802），不是这条的评论 id 42",
          idrow["text"] == "UID:802", idrow["text"])
    check("整行里不再出现 #C（评论 id 不再露给人看）", not idrow["hashC"])
    check("评论 id 仍在 data-cid 上（深链 ?cid= 与高亮靠它）", idrow["cid"] == "42", idrow["cid"])
    check("★ 这行字比昵称明显小（主人：「可以非常小」）", idrow["uidFont"] < idrow["nameFont"] - 3,
          f'uid {idrow["uidFont"]}px vs 昵称 {idrow["nameFont"]}px')

    print("\n⑨ 「回复 @某人」另起一行，不再隔断头像与昵称（20261003 用户第 3 条）")
    # 用户原话：「回复评论，应该是头像右上角是对应用户昵称，徽章，UID，另起一行回复 @xxx，
    # 现在的布局回复 @xx 直接把头像和昵称隔断了」。根因是**纯 DOM 顺序**：那个节点当年挂在
    # `.commentMeta` 的**首位**，于是它排在昵称之前、左边紧挨头像。
    # 这一组量三件事：身份行里没有它、它自己占一行、它不在头像与昵称之间。
    rg = pg.evaluate(REPLY_GEOM)
    check("前提：回复行有两条（夹具里 41 / 42）", rg["rows"] == 2, rg["rows"])
    check("顶层评论不渲染这个节点（只有回复才有）", rg["topRowsWithRt"] == 0,
          rg["topRowsWithRt"])
    check("★它不在身份行 `.commentMeta` 里（结构判据）", not rg["rtInsideMeta"],
          rg["rtInsideMeta"])
    check("★DOM 顺序：昵称在前、它在前、正文在后（谁 → 回复谁 → 正文）",
          rg["nameBeforeRt"] and rg["rtBeforeBody"],
          f'nameBeforeRt={rg["nameBeforeRt"]} rtBeforeBody={rg["rtBeforeBody"]}')
    check("★几何：它有自己的一行——上缘落在身份行之下",
          bool(rg["rt"]) and rg["rt"]["y"] >= rg["meta"]["bottom"] - 1,
          f'rt.y={rg["rt"] and round(rg["rt"]["y"], 1)} meta.bottom={round(rg["meta"]["bottom"], 1)}')
    check("  且紧贴身份行（≤8px，不是飘到别处去）",
          bool(rg["rt"]) and 0 <= rg["rt"]["y"] - rg["meta"]["bottom"] <= 8,
          f'缝隙 {rg["rt"] and round(rg["rt"]["y"] - rg["meta"]["bottom"], 1)}px')
    check("  与昵称**不在同一水平带**（纵向不相交 ⇒ 视觉上不可能夹在头像与昵称之间）",
          bool(rg["rt"]) and min(rg["rt"]["bottom"], rg["name"]["bottom"])
          - max(rg["rt"]["y"], rg["name"]["y"]) <= 0,
          f'rt={round(rg["rt"]["y"], 1)}..{round(rg["rt"]["bottom"], 1)} '
          f'name={round(rg["name"]["y"], 1)}..{round(rg["name"]["bottom"], 1)}')
    check("  左缘与身份行对齐（另起一行，不是缩进到别处）",
          bool(rg["rt"]) and abs(rg["rt"]["x"] - rg["meta"]["x"]) < 1.5,
          f'rt.x={rg["rt"] and round(rg["rt"]["x"], 1)} meta.x={round(rg["meta"]["x"], 1)}')
    pg.close()

    # ══ 二、红基线 A：还原改之前的形态（counter-room 挂回来 + 计数落回框外）══════════
    print("\n⑧ 红基线 A（broken 变体）：计数落回框外、缝隙变回 30px")
    pg2 = br.new_page(viewport={"width": 1280, "height": 900})
    errs2 = []
    pg2.on("pageerror", lambda e: errs2.append(str(e)))
    pg2.add_init_script("window.__BOOT = { path: '/article/1', token: 't' };")
    pg2.goto(BROKEN.as_uri() + "/index.html")
    pg2.wait_for_selector(".commentComposer", timeout=8000)
    pg2.wait_for_timeout(300)
    check("对照组页面本身是好的（没有 JS 错误、计数在）",
          not errs2 and pg2.locator(COUNT).count() == 1, "; ".join(errs2[:1]))
    cb = box(pg2, COUNT)
    tb = box(pg2, TEXTAREA)
    fb = box(pg2, FOOT)
    check("★ 对照组里计数**落到框外**（吊在下方 −22px ⇒ 下缘越过输入框底）"
          "—— ⇒ ② 那条「落在输入框盒子之内」有牙",
          bool(cb) and bool(tb) and cb["bottom"] > tb["bottom"] + 6,
          f"count.bottom={cb and round(cb['bottom'], 1)} textarea.bottom={tb and round(tb['bottom'], 1)}")
    check("★ 对照组里缝隙变回 31px（22 的 counter-room + 8 的 margin-top）"
          "—— ⇒ ② 那条「缝隙 ≤12px」量的正是这一处修复",
          bool(tb) and bool(fb) and fb["y"] - tb["bottom"] > 28,
          f"缝隙 {tb and fb and round(fb['y'] - tb['bottom'], 1)}px")
    # 防"对照组其实是另一个页面"：两组的输入框上缘该是同一条线（差别只在框内让位与那 22px）
    check("两组的输入框上缘一致（差别只在计数与那 22px，不是别的东西在动）",
          bool(t) and bool(tb) and abs(t["y"] - tb["y"]) < 1.5,
          f"fixed={t and round(t['y'], 1)} broken={tb and round(tb['y'], 1)}")
    pg2.close()

    # ══ 三、红基线 B：只摘掉「按进框内」那条（= 20261003 早上用户报重叠时的样子）══════
    print("\n⑧b 红基线 B（bare 变体）：计数落到框外**并且**压住按钮行")
    pg3 = br.new_page(viewport={"width": 1280, "height": 900})
    errs3 = []
    pg3.on("pageerror", lambda e: errs3.append(str(e)))
    pg3.add_init_script("window.__BOOT = { path: '/article/1', token: 't' };")
    pg3.goto(BARE.as_uri() + "/index.html")
    pg3.wait_for_selector(".commentComposer", timeout=8000)
    pg3.wait_for_timeout(300)
    check("对照组页面本身是好的（没有 JS 错误、计数在）",
          not errs3 and pg3.locator(COUNT).count() == 1, "; ".join(errs3[:1]))
    c3 = box(pg3, COUNT)
    check("★ 对照组里计数落到框外",
          bool(c3) and bool(box(pg3, TEXTAREA)) and c3["bottom"] > box(pg3, TEXTAREA)["bottom"] + 6,
          f"count.bottom={c3 and round(c3['bottom'], 1)}")
    check("★ 对照组里计数**确实**盖住「发表评论」按钮"
          "—— ⇒ ② 那两条「不相交」有牙（当年那 22px 的 counter-room 就是为它加的）",
          overlap(c3, box(pg3, SUBMIT)) > 2, f"相交 {overlap(c3, box(pg3, SUBMIT)):.1f}px")
    check("对照组里计数也确实压着整行按钮区", overlap(c3, box(pg3, FOOT)) > 2,
          f"相交 {overlap(c3, box(pg3, FOOT)):.1f}px")
    pg3.close()

    # ══ 四、红基线 C：把「回复 @某人」退回身份行行首 ═══════════════════════════════
    print("\n⑨b 红基线 C（replyto-old 变体）：回复标记回到行首，头像与昵称被它隔断")
    pg4 = br.new_page(viewport={"width": 1280, "height": 900})
    errs4 = []
    pg4.on("pageerror", lambda e: errs4.append(str(e)))
    pg4.add_init_script("window.__BOOT = { path: '/article/1', token: 't' };")
    pg4.goto(REPLY_OLD.as_uri() + "/index.html")
    pg4.wait_for_selector(".commentComposer", timeout=8000)
    pg4.wait_for_timeout(300)
    check("对照组页面本身是好的（没有 JS 错误、回复行还在）",
          not errs4 and pg4.locator(".commentRow.isReply").count() == 2, "; ".join(errs4[:1]))
    o = pg4.evaluate(REPLY_GEOM)
    check("★对照组里它**就在**身份行内（⑨ 那条「不在身份行里」有牙）",
          o["rtInsideMeta"] is True, o["rtInsideMeta"])
    check("★对照组里昵称排在它**之后**（⑨ 那条 DOM 顺序判据有牙）",
          o["nameBeforeRt"] is False, o["nameBeforeRt"])
    # 这条是用户报的那句话的**几何翻译**：它横插在头像右缘与昵称左缘之间，
    # 且与昵称处在同一水平带 —— 于是"头像 / 回复@xx / 昵称"排成一行。
    check("★对照组里头像与昵称确实被它隔开（它落在两者的水平之间、同一水平带）",
          bool(o["av"]) and bool(o["rt"]) and bool(o["name"])
          and o["av"]["right"] <= o["rt"]["x"] + 0.5
          and o["rt"]["right"] <= o["name"]["x"] + 0.5
          and min(o["rt"]["bottom"], o["name"]["bottom"])
          - max(o["rt"]["y"], o["name"]["y"]) > 0,
          f'av.right={o["av"] and round(o["av"]["right"], 1)} '
          f'rt={o["rt"] and round(o["rt"]["x"], 1)}..{o["rt"] and round(o["rt"]["right"], 1)} '
          f'name.x={round(o["name"]["x"], 1)}')
    pg4.close()
    br.close()

print(f"\ncomment-layout: {'全绿' if not FAILS else str(len(FAILS)) + ' 条红'}\n")
sys.exit(1 if FAILS else 0)
