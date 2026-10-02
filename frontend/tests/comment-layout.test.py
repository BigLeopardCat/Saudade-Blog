# -*- coding: utf-8 -*-
"""讨论区几何与深链沙箱（20261003）：计数不压按钮 / 表情面板不盖计数 / 未登录态 / ?cid= 定位。

## 这个沙箱为什么必须有

`antd` 的 `showCount` 计数是**挂在输入框下方、不占布局空间**的绝对定位元素——
`rc-textarea` 渲染 `span.ant-input-data-count`，`antd/es/input/style/textarea.js` 给它
`position: absolute; bottom: -(fontSize × lineHeight) = -22px; insetInlineEnd: 0`。
下一行就是 `.commentComposerFoot`（表情按钮 + 发表评论），**不腾地方就正好压住右边那颗按钮**。
20261003 用户报的"字数限制计数文本和其他组件重叠遮挡"就是这一条；修法是给输入框挂
`counter-room`（`src/index.css` 里那 22px，全站六个消费方共用一份值）。

于是本文件判**两件事，缺一不可**：
  ① fixed 变体：计数与 `.commentSubmit` / `.commentComposerFoot` **不相交**；
  ② broken 变体（拷贝一份 src、把 `className="counter-room"` 删掉）：**必须相交**。
没有 ②，① 就有可能是永真的——"某某没重叠"这类断言最容易在元素根本不存在时也是绿的。

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


def build(variant: str) -> pathlib.Path:
    """variant: 'fixed'（src 原样）/ 'broken'（把 counter-room 摘掉，做红基线）。"""
    sb = pathlib.Path(tempfile.mkdtemp(prefix=f"comment-layout-{variant}-"))
    shutil.copytree(FE / "src", sb / "src")
    (sb / "node_modules").symlink_to(FE / "node_modules")

    # ① 就地替换两个叶子模块（相对路径 import 没法 --alias:）
    (sb / "src/apis/CommentMethods.tsx").write_text(STUB_COMMENTS, encoding="utf-8")
    (sb / "src/apis/getToken.tsx").write_text(STUB_TOKEN, encoding="utf-8")

    if variant == "broken":
        p = sb / "src/components/CommentSection/index.tsx"
        src = p.read_text(encoding="utf-8")
        # 只摘掉那一行属性本身，注释留着（注释不影响渲染）
        assert '                        className="counter-room"\n' in src, "broken 变体没找到 counter-room 属性"
        p.write_text(src.replace('                        className="counter-room"\n', "", 1),
                     encoding="utf-8")

    (sb / "entry.tsx").write_text(ENTRY, encoding="utf-8")

    # ② sass 用 programmatic API 编译（CLI 在 Node 18 上因 chokidar 的 ERR_REQUIRE_ESM 崩）
    subprocess.run(["node", "-e",
                    "const s=require('sass');const r=s.compile(process.argv[1],{style:'expanded'});"
                    "require('fs').writeFileSync(process.argv[2],r.css);",
                    str(FE / "src/components/CommentSection/index.sass"), str(sb / "comment.css")],
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
FOOT = ".commentComposerFoot"
SUBMIT = ".commentSubmit"

FIXED = build("fixed")
BROKEN = build("broken")

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

    print("\n② 几何：计数不压着下面那一行（用户 20261003 报的正是这里）")
    c = box(pg, COUNT)
    f = box(pg, FOOT)
    s = box(pg, SUBMIT)
    check("计数元素有实际尺寸（不是 display:none 这类「靠藏起来达标」）",
          bool(c) and c["w"] > 0 and c["h"] > 0, c)
    check("计数与「发表评论」按钮不相交", overlap(c, s) <= 0,
          f"相交 {overlap(c, s):.1f}px  count={c} submit={s}")
    check("计数与整行 .commentComposerFoot 不相交", overlap(c, f) <= 0,
          f"相交 {overlap(c, f):.1f}px  count={c} foot={f}")
    check("计数的下缘不越过按钮行的上缘", bool(c) and bool(f) and c["bottom"] <= f["y"] + 0.5,
          f"count.bottom={c and round(c['bottom'], 1)} foot.top={f and round(f['y'], 1)}")

    print("\n②b 计数文本变长（0 → 300）后仍在同一位置：修的不是「初始那串短文本恰好塞得下」")
    pg.fill(".commentComposer textarea", "字" * 300)
    pg.wait_for_timeout(200)
    c2 = box(pg, COUNT)
    check("计数已更新为「300 / 300」", pg.locator(COUNT).inner_text().strip() == "300 / 300",
          pg.locator(COUNT).inner_text().strip())
    check("长计数仍不压按钮", overlap(c2, box(pg, SUBMIT)) <= 0 and overlap(c2, box(pg, FOOT)) <= 0,
          f"相交 {overlap(c2, box(pg, SUBMIT)):.1f}px")

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
    check("命中的正是 #C42", pg.get_attribute(".comment-hit", "data-cid") == "42",
          pg.get_attribute(".comment-hit", "data-cid"))
    hit = box(pg, ".comment-hit")
    check("页面确实滚下去了（不是本来就在视口里）", pg.evaluate("window.scrollY") > 0,
          pg.evaluate("window.scrollY"))
    check("命中行落在视口内",
          bool(hit) and hit["y"] >= -1 and hit["bottom"] <= 900 + 1, hit)
    check("命中的是最后一行（目标是回复的回复，排在讨论区末尾）",
          pg.evaluate("document.querySelector('.comment-hit').parentElement === "
                      "document.querySelector('.commentList').lastElementChild"), True)
    pg.close()

    # ══ 二、红基线：同一个组件、摘掉 counter-room ═══════════════════════════
    print("\n⑧ 红基线（broken 变体）：没有那 22px 时，计数**必须**压住按钮")
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
    sb_ = box(pg2, SUBMIT)
    fb = box(pg2, FOOT)
    check("对照组里计数**确实**与按钮重叠（⇒ ② 那几条断言是有牙的，不是永真）",
          overlap(cb, sb_) > 2, f"相交 {overlap(cb, sb_):.1f}px")
    check("对照组里计数也确实压着整行按钮区", overlap(cb, fb) > 2, f"相交 {overlap(cb, fb):.1f}px")
    # 两边的计数与按钮各自的位置都该是一样的——差别只在有没有那 22px（防"对照组其实是另一个页面"）
    check("两组的计数上缘一致（对照组只是少了 22px，不是别的东西在动）",
          bool(c) and bool(cb) and abs(c["y"] - cb["y"]) < 1.5,
          f"fixed={c and round(c['y'], 1)} broken={cb and round(cb['y'], 1)}")
    pg2.close()
    br.close()

print(f"\ncomment-layout: {'全绿' if not FAILS else str(len(FAILS)) + ' 条红'}\n")
sys.exit(1 if FAILS else 0)
