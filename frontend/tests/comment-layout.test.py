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

另外 ⑫（20261005 用户第 3 条「赞和踩不在同一水平线，好像踩高了一点」）量的是**图标
墨迹**：把真 `<svg>` 栅格化到 canvas 再扫非透明行——两个 svg 盒子的几何在旧稿里逐项
相等，量盒子永远全绿，而差在字形内部的墨迹上。带一条**冻结字面**（20261005 改动前那版
几何）的红基线——基线的取法钉在时间上，不钉在当前提交上（见下面 `OLD_ICON` 的头注）。

用法（仓库任意位置）：python3 frontend/tests/comment-layout.test.py
"""
import json
import pathlib
import re
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
    """30 条顶层 + 2 条回复。

    每行那三个投票字段（`up`/`down`/`myVote`，20261003 用户第 4 条）**不是随手填的**——
    取值刻意造成"按票数高亮"与"按 `myVote` 高亮"给出**相反**答案的那一组，
    于是 ⑪ 里那条断言真能分辨两种写法（否则它只是"class 里有 isOn"这种谁都能过的空话）：

      · #1  up=3  down=7  myVote= 1 ⇒ 票多的是**踩**，我投的是**赞**
      · #30 up=12 down=0  myVote=-1 ⇒ 票多的是**赞**，我投的是**踩**（#1 的反向）
      · #2  up=0  down=0  myVote= 0 ⇒ 两个计数都是 0 ⇒ 数字必须**一颗都不显示**
      · 其余全 0（同上，一排 `👍0 👎0` 正是要量掉的那种噪声）

    #2 与 #30 的 `mine` 都是 True ⇒ 它们同时充当"按钮顺序 回复 → 赞 → 踩 → 删除"的样本。
    """
    items = []
    votes = {1: (3, 7, 1), 30: (12, 0, -1)}
    for i in range(1, 31):
        up, down, myvote = votes.get(i, (0, 0, 0))
        items.append({
            "id": i, "noteId": 1, "content": f"第 {i} 条顶层评论，用来把页面撑高一点。",
            "parentId": None, "rootId": None, "replyToUid": None, "replyToNickname": None,
            "userId": 700 + i, "nickname": f"访客{i}", "avatar": "",
            "role": "admin" if i == 3 else "user", "mine": i in (2, 30),
            "createdAt": "2026-10-03 12:00:00",
            "up": up, "down": down, "myVote": myvote,
        })
    items.append({
        "id": 41, "noteId": 1, "content": "回复最后一条顶层。", "parentId": 30, "rootId": 30,
        "replyToUid": 730, "replyToNickname": "访客30", "userId": 801, "nickname": "甲",
        "avatar": "", "role": "secretary", "mine": False, "createdAt": "2026-10-03 12:01:00",
        "up": 0, "down": 0, "myVote": 0,
    })
    # **深链目标**：回复的回复——它仍挂在顶层 30 下（服务端派生 rootId），排在整个讨论区最后一行
    items.append({
        "id": 42, "noteId": 1, "content": "回复的回复。", "parentId": 41, "rootId": 30,
        "replyToUid": 801, "replyToNickname": "甲", "userId": 802, "nickname": "乙",
        "avatar": "", "role": "zako", "mine": False, "createdAt": "2026-10-03 12:02:00",
        "up": 0, "down": 0, "myVote": 0,
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

/** 投票（⑪ 组要量的那一条）。三件事都记在 window 上，判据才拿得到：
 *
 *  · `window.__votes` —— **发出去的** `[id, value]` 序列。断言"点了赞发的是 1、
 *    再点一次发的是 0（撤回）"只能看这里，不能看界面（界面在乐观更新之后就已经变了，
 *    两种写法长得一模一样）；
 *  · `window.__voteFail` —— 置真则回一个 `code: 500` 的信封。**失败必须回滚**这条
 *    要它才量得出来（不回滚的实现在这里会留下一个假的乐观值）；
 *  · `window.__voteHold` —— 置真则**不回**，把 resolve 挂到 `window.__voteRelease()`
 *    上。乐观更新是"点下去当场就变"，不把它按住就永远看不见中间那一瞬。
 *
 *  回执的数是**服务端口径**，故意与"本地自增"不同（夹具里 #30 是 up=12）：
 *  若前端显示的是自己算的账，⑪ 里那条"数字换成回执给的 7"当场就红。 */
export const voteComment = (id: number, value: number) => {
    const w = window as any;
    (w.__votes = w.__votes || []).push([id, value]);
    const up = value === 1 ? 7 : value === 0 ? 0 : 4;
    const down = value === -1 ? 9 : value === 0 ? 0 : 2;
    const apply = () => {
        // 票数是**聚合值**：回执就是服务端算完的事实，顺手把它写回"服务端那份库"
        // （`window.__comments`）。否则中途任何一次重拉/重挂都会退回夹具的旧数——
        // 那种红查起来极贵，而且它不是产品缺陷，是桩没跟上。
        const row = (w.__comments || []).find((c: any) => c.id === id);
        if (row) { row.up = up; row.down = down; row.myVote = value; }
        return env({ up, down, myVote: value });
    };
    if (w.__voteFail) {
        return Promise.resolve({ status: 200, data: { code: 500, message: '投票没成功', data: null } });
    }
    if (w.__voteHold) {
        return new Promise((resolve) => { w.__voteRelease = () => resolve(apply()); });
    }
    return Promise.resolve(apply());
};
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

# ── 红基线 D（⑩b）：把「回复」退回**只能开在页面顶部那个输入框**——20261003 用户第 3 条
# 报的那一版（「评论很靠下时每次回复都要滚到顶部输入框」）。四处在沙箱拷贝上打补丁，
# `FE` 里一字不动：点「回复」设回顶层状态、顶层框渲染回那条「正在回复 @xx」、
# state 声明补回来、提交时带上被回复的那条 id。
# **它翻的是 ⑩ 的结构判据**（行内框不存在 ⇒ "住在这一行的 .commentMain 里"当场红），
# 以及"顶层框里没有那条回复栏"。
TSX_OPEN_INLINE = "onClick={() => openReply(c)}"
TSX_OPEN_TOP = "onClick={() => setTopReply(c)}"
TSX_TOP_COMPOSER = '                <div className="commentComposer">\n'
TSX_TOP_BAR = ('                <div className="commentComposer">\n'
               '                    {topReply && (\n'
               '                        <div className="commentReplyBar">\n'
               '                            <span>正在回复 @{topReply.nickname}</span>\n'
               '                            <button type="button" onClick={() => setTopReply(null)}>取消</button>\n'
               '                        </div>\n'
               '                    )}\n')
TSX_BUSY_STATE = "    const [busy, setBusy] = useState(false)\n"
TSX_TOPREPLY_STATE = TSX_BUSY_STATE + \
    "    const [topReply, setTopReply] = useState<CommentItem | null>(null)\n"
TSX_POST_NULL = "await postComment(text, null)"
TSX_POST_TOP = "await postComment(text, topReply?.id ?? null)"

# ── 红基线 E（⑪e）：把「我投过没投过」换成**票多的那一侧**高亮——这是同族网页里最常见的
# 那种写法，也正是用户第 4 条要量掉的那件事（读者会把它读成"这是我投的"）。只改一句，
# 其余一字不动 ⇒ 对照组红的只可能是 ⑪ 里那两条高亮判据（同一页的计数判据仍该是绿的）。
TSX_VOTE_ON = "                        const on = c.myVote === dir\n"
TSX_VOTE_BY_COUNT = "                        const on = dir === 1 ? c.up > c.down : c.down > c.up\n"


def build(variant: str) -> pathlib.Path:
    """variant:
    'fixed'  src 原样；
    'broken' 改之前的样子（tsx 挂回 counter-room + sass 摘掉按进框内那条）——红基线 A；
    'bare'   只摘掉按进框内那条（= 20261003 早上用户报重叠时的样子）——红基线 B；
    'replyto-old' 「回复 @某人」退回身份行行首（20261003 用户第 3 条报的那一版）——红基线 C；
    'reply-top'  「回复」退回"只能开在页面顶部那个输入框"——红基线 D；
    'vote-by-count' 高亮从 `myVote` 换成"票多的那一侧"——红基线 E。
    五个红基线各自翻的是不同的那几条判据，所以五个都要跑：
    A 翻的是「缝隙」与「落在框内」，B 翻的是「计数与按钮不相交」（当年那 22px 就是为它加的），
    C 翻的是 ⑨ 里「回复标记另有自己的一行」，D 翻的是 ⑩ 里「回复框住在被回复的那一行里」，
    E 翻的是 ⑪ 里「高亮跟着 myVote 走」（夹具里 #1/#30 的票数与 myVote 方向**相反**，
    就是为了让这一条分辨得出两种写法）。"""
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

    if variant == "reply-top":
        p = sb / "src/components/CommentSection/index.tsx"
        src = p.read_text(encoding="utf-8")
        for old, new, what in (
            (TSX_OPEN_INLINE, TSX_OPEN_TOP, "「回复」那颗按钮的 onClick"),
            (TSX_TOP_COMPOSER, TSX_TOP_BAR, "顶层 composer 的开标签"),
            (TSX_BUSY_STATE, TSX_TOPREPLY_STATE, "`busy` 那句 state 声明"),
            (TSX_POST_NULL, TSX_POST_TOP, "顶层框提交时传的 parentId"),
        ):
            assert src.count(old) == 1, f"红基线 D 没找到{what}"
            src = src.replace(old, new, 1)
        p.write_text(src, encoding="utf-8")

    if variant == "vote-by-count":
        p = sb / "src/components/CommentSection/index.tsx"
        src = p.read_text(encoding="utf-8")
        assert src.count(TSX_VOTE_ON) == 1, "红基线 E 没找到「高亮看 myVote」那句"
        p.write_text(src.replace(TSX_VOTE_ON, TSX_VOTE_BY_COUNT, 1), encoding="utf-8")

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

# ⑪ 用：一行评论的动作区读成一份结构化快照——按钮顺序（`aria-label` 兜底取文本）、
# 哪一颗亮着、`aria-pressed`、两颗钮各自的数字（没有 `.commentVoteNum` 记 null，
# 于是"0 不显示数字"与"数字换成了回执那个值"是同一处量的）、颜色、disabled。
# **数量、顺序、状态一起取**：分开取会给出"读了三次 DOM"的假象，中间任何一次重绘
# 都可能让三条判据各自看到不同的一瞬。
VOTE_ROW = """(cid) => {
  const row = document.querySelector('#c-' + cid);
  if (!row) return null;
  const v = [...row.querySelectorAll('.commentVote')];
  return {
    labels: [...row.querySelectorAll('.commentActions button')].map(
        (b) => b.getAttribute('aria-label') || (b.textContent || '').trim()),
    on: v.map((x) => x.classList.contains('isOn')),
    pressed: v.map((x) => x.getAttribute('aria-pressed')),
    nums: v.map((x) => { const n = x.querySelector('.commentVoteNum'); return n ? n.textContent : null; }),
    colors: v.map((x) => getComputedStyle(x).color),
    disabled: v.map((x) => x.disabled),
  };
}"""

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

# ⑫ 用：把一枚真 svg **栅格化**再扫非透明行 —— 得到的是"这颗图标在屏幕上占哪几条像素行"，
# 也就是用户看得见的那条边。**不能量盒子**：旧稿里两颗 svg 的盒子逐项相等（同 14px、
# 同 viewBox、同一条镜像路径），量盒子永远全绿，而人眼看到的差在**字形内部的墨迹**上。
# 做法：克隆 → 把 width/height 写成 480（= 20px / 用户单位，够分辨 0.25 个单位）、
# 把 `stroke` 从 `currentColor` 钉成黑（离线 svg 里 `color` 取初值，钉死免得受主题影响）
# → XMLSerializer → data URL → canvas.drawImage → 扫 alpha。
INK_HELPER = """() => {
  window.__inkOf = (svg) => new Promise((res) => {
    const S = 24 * 20;
    const c = svg.cloneNode(true);
    c.setAttribute('width', String(S));
    c.setAttribute('height', String(S));
    c.setAttribute('stroke', '#000');
    c.removeAttribute('style');
    const url = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(
      new XMLSerializer().serializeToString(c));
    const img = new Image();
    img.onload = () => {
      const cv = document.createElement('canvas');
      cv.width = S; cv.height = S;
      const ctx = cv.getContext('2d');
      ctx.drawImage(img, 0, 0, S, S);
      const d = ctx.getImageData(0, 0, S, S).data;
      let top = -1, bottom = -1;
      for (let y = 0; y < S; y++) {
        for (let x = 0; x < S; x++) {
          if (d[(y * S + x) * 4 + 3] > 8) { if (top < 0) top = y; bottom = y; break; }
        }
      }
      // 行号 → 用户单位（`bottom + 1` 是因为第 bottom 行覆盖 [bottom, bottom+1] 那一段）
      res(top < 0 ? null : {
        top: +(top / 20).toFixed(2), bottom: +((bottom + 1) / 20).toFixed(2),
        cy: +((((top + bottom + 1) / 2) / 20)).toFixed(2),
        h: +(((bottom - top + 1) / 20)).toFixed(2),
      });
    };
    img.onerror = () => res(null);
    img.src = url;
  });
}"""
INK_OF = """(sel) => { const e = document.querySelector(sel); return e ? window.__inkOf(e) : null }"""
# 红基线用：把一段 svg 源码塞进一个**游离**节点（不必挂进文档）再量同一件事。
OLD_INK = """(html) => {
  const host = document.createElement('div');
  host.innerHTML = html;
  const svg = host.querySelector('svg');
  return svg ? window.__inkOf(svg) : null;
}"""

# ⑫ 的红基线 = **20261005 改动前**那一版两枚拇指的几何（下面两段字面，逐字抄自改动前的
# `NoteStatIcons/index.tsx`）。与 `mermaid-mobile-zoom.test.py` 同一取法：换臂跑同一套
# 判据，读几何不读"看起来对"。
#
# ⚠️ 它**不能**写成 `git show HEAD:`：这条基线要的是"改动前那个形状"，而 `git show HEAD`
# 在改动**提交之后**取到的就是改动后的文件 —— 两条臂逐字相同，红基线当场失效
# （20261005 实测：提交前绿、提交后红，报的是"赞 12 / 踩 12"）。基线的取法必须钉在
# **时间**上（一个冻结的字面），不能钉在"当前提交"上。要换这两段，就是**改判据本身**
# （说明对齐的基准变了），不能顺手跟着工作区刷新。
#
# 属性写成连字符小写：这一臂把 svg 源码塞进 `innerHTML`，驼峰属性名在 HTML 里不生效
# （`strokeWidth` 不在 HTML 解析器的 SVG 属性修正表里，认不出来就整条丢掉 ⇒ 描边退回
# 默认的 1），量到的就不是"改动前的几何"而是"改动前的几何 + 一个错的描边"（实测墨迹高
# 20.8 而不是 21.6，红基线就成了假红）。`viewBox` 例外：它在修正表里，保持驼峰。
_SVG_HEAD = ('<svg aria-hidden="true" viewBox="0 0 24 24" width="14" height="14" fill="none"'
             ' stroke="currentColor" stroke-width="1.8" stroke-linejoin="round">')
OLD_ICON = {
    "ThumbUpIcon": _SVG_HEAD
    + '<path d="M13.8 9V5.3a2.8 2.8 0 0 0-2.8-2.8l-3.9 8.9v10.9h11.2a2 2 0 0 0 1.97-1.65l1.4-9.1a2 2 0 0 0-1.97-2.35z" />'
    + '<path d="M7.1 22.3H4.5a2.4 2.4 0 0 1-2.4-2.4v-7a2.4 2.4 0 0 1 2.4-2.4h2.6" /></svg>',
    "ThumbDownIcon": _SVG_HEAD
    + '<path d="M13.8 15v3.7a2.8 2.8 0 0 1-2.8 2.8l-3.9-8.9V1.7h11.2a2 2 0 0 1 1.97 1.65l1.4 9.1a2 2 0 0 1-1.97 2.35z" />'
    + '<path d="M7.1 1.7H4.5a2.4 2.4 0 0 0-2.4 2.4v7a2.4 2.4 0 0 0 2.4 2.4h2.6" /></svg>',
}

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
REPLY_TOP = build("reply-top")
VOTE_BY_COUNT = build("vote-by-count")

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

    print("\n⑩ 回复框就地展开（用户 20261003 第 3 条：评论很靠下时不必滚回顶部输入框）")
    # 先把最后一条顶层评论（#30）滚到视野中间——**这正是用户说的"很靠下"那个位置**。
    # 不先滚下去，下面那条"视线没被甩回顶部"就测不出东西来（页面本来就在顶部）。
    pg.evaluate("document.querySelector('#c-30').scrollIntoView({block:'center',behavior:'auto'})")
    pg.wait_for_timeout(250)
    y_before = pg.evaluate("window.scrollY")
    check("前提：页面确实滚下去了（否则这组判据量的是页面顶部那条评论）",
          y_before > 400, f"scrollY={y_before}")

    def open_reply(cid):
        pg.locator(f"#{cid} .commentActions button").first.click()
        pg.wait_for_timeout(350)

    open_reply("c-30")
    check("行内回复框恰好一个，带 .commentComposer.isInline",
          pg.locator(".commentComposer.isInline").count() == 1,
          pg.locator(".commentComposer.isInline").count())
    check("★它就住在被回复的**那一行**的 .commentMain 里（结构判据）",
          pg.evaluate("() => { const b = document.querySelector('.commentComposer.isInline');"
                      " return !!b && !!b.closest('.commentMain')"
                      " && (b.closest('.commentRow') || {}).id === 'c-30'; }"))
    check("★焦点已经落进行内那个 textarea（点完就能直接打字）",
          pg.evaluate("() => document.activeElement === "
                      "document.querySelector('.commentComposer.isInline textarea')"))
    check("★行内框整个落在视口里（展开的目的就是「不用滚」）",
          inside(box(pg, ".commentComposer.isInline"),
                 {"x": 0, "y": 0, "w": 1280, "h": 900, "right": 1280, "bottom": 900}),
          box(pg, ".commentComposer.isInline"))
    check("★视线没被甩回顶部（滚过的那一段还在）",
          pg.evaluate("window.scrollY") > y_before * 0.6,
          f"before={y_before} now={pg.evaluate('window.scrollY')}")
    check("★行内框紧贴它回复的那条评论（≤60px；红基线 D 里它会离这条评论两千多像素）",
          bool(box(pg, "#c-30 .commentBody")) and 0 <=
          box(pg, ".commentComposer.isInline")["y"] - box(pg, "#c-30 .commentBody")["bottom"] <= 60,
          f'缝隙 {round(box(pg, ".commentComposer.isInline")["y"] - box(pg, "#c-30 .commentBody")["bottom"], 1)}px')
    check("行内框里写明「正在回复 @谁」",
          pg.locator(".commentComposer.isInline .commentReplyBar span").inner_text().strip()
          == "正在回复 @访客30",
          pg.locator(".commentComposer.isInline .commentReplyBar span").inner_text().strip())
    check("★顶层那个输入框里**没有**那条回复栏（回复不再走顶部那条老路）",
          pg.locator(".commentComposer:not(.isInline) .commentReplyBar").count() == 0,
          pg.locator(".commentComposer:not(.isInline) .commentReplyBar").count())
    check("顶层框只发顶层评论：按钮文案是「发表评论」不是「回复」",
          pg.locator(".commentComposer:not(.isInline) .commentSubmit").inner_text().strip() == "发表评论",
          pg.locator(".commentComposer:not(.isInline) .commentSubmit").inner_text().strip())

    print("\n⑩b 同时只开一个；Esc 与「取消」都能收起")
    open_reply("c-29")
    check("换一行点「回复」：行内框仍只有一个（上一行自动收起）",
          pg.locator(".commentComposer.isInline").count() == 1,
          pg.locator(".commentComposer.isInline").count())
    check("  且开在新点的那一行（c-29）",
          pg.evaluate("() => (document.querySelector('.commentComposer.isInline')"
                      ".closest('.commentRow') || {}).id") == "c-29")
    pg.keyboard.press("Escape")
    pg.wait_for_timeout(250)
    check("Esc 收起行内框（焦点在框里，键意与表情面板一致）",
          pg.locator(".commentComposer.isInline").count() == 0,
          pg.locator(".commentComposer.isInline").count())
    open_reply("c-28")
    pg.locator(".commentComposer.isInline .commentReplyBar button").click()
    pg.wait_for_timeout(250)
    check("「取消」也收起", pg.locator(".commentComposer.isInline").count() == 0,
          pg.locator(".commentComposer.isInline").count())

    print("\n⑩c 就地发出去（不是「打开一个框然后逼你回顶部提交」）")
    # 顶层框里那段草稿是 ⑤ 留下的（`_下划线_ …`）——**故意不清理**：这样下面那条
    # 「两个框的草稿互不干扰」才不是说空话（空草稿被"保持为空"是最容易假绿的一种）。
    top_before = pg.input_value(".commentComposer:not(.isInline) textarea")
    check("前提：顶层框里本来就有一段落草稿（不是空的——空的「没被动过」证明不了什么）",
          top_before.strip() != "", top_before)
    open_reply("c-27")
    pg.fill(".commentComposer.isInline textarea", "就地回复一条")
    pg.locator(".commentComposer.isInline .commentSubmit").click()
    pg.wait_for_timeout(400)
    check("发送后行内框收起（回复已提交）",
          pg.locator(".commentComposer.isInline").count() == 0,
          pg.locator(".commentComposer.isInline").count())
    check("顶层框那段草稿一字未动（两个框的草稿互不干扰）",
          pg.input_value(".commentComposer:not(.isInline) textarea") == top_before,
          pg.input_value(".commentComposer:not(.isInline) textarea"))
    pg.evaluate("window.scrollTo(0, 0)")
    pg.wait_for_timeout(150)

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

    # ══ ⑪ 赞 / 踩（20261003 用户第 4 条「讨论区评论增加点赞和踩」）══════════════════
    print("\n⑪ 赞 / 踩：高亮跟 myVote（不是票多的那侧）、计数为 0 不显示数字、按钮顺序")
    # 夹具那三个数是这组判据的**前提**，所以先把它本身量一遍：如果哪天有人"顺手"把
    # #1 改成 up=7/down=3，⑪ 里"高亮跟 myVote"那条会变成按票数高亮也照样通过
    # ——判据还在，牙没了。这种退化必须是红的（同 ② 组"前提：计数确实在"那条的取向）。
    fx = pg.evaluate("() => (window.__comments || [])"
                     ".filter((c) => [1, 2, 30].includes(c.id))"
                     ".map((c) => [c.id, c.up, c.down, c.myVote])")
    check("前提：夹具里 #1 是「踩的票多、我投赞」，#2 两个数都是 0，"
          "#30 是 #1 的反向 —— 少了这组刻意相反的取值，下面的高亮判据就退化成永真",
          fx == [[1, 3, 7, 1], [2, 0, 0, 0], [30, 12, 0, -1]], fx)
    check("前提：32 行各两颗钮（赞 / 踩）都渲染出来了",
          pg.locator(".commentVote").count() == 64, pg.locator(".commentVote").count())

    r30 = pg.evaluate(VOTE_ROW, 30)
    r1 = pg.evaluate(VOTE_ROW, 1)
    r2 = pg.evaluate(VOTE_ROW, 2)
    check("按钮顺序 回复 → 赞 → 踩 → 删除（删除仍是最后一颗：破坏性动作排最后）",
          r30["labels"] == ["回复", "赞", "踩", "删除"], r30["labels"])
    check("  别人的评论没有「删除」（顺序判据不是靠最后那颗凑出来的）",
          r1["labels"] == ["回复", "赞", "踩"], r1["labels"])
    check("★高亮跟着 myVote 走：#1 我投的是赞 ⇒ 赞亮、踩不亮（可是踩 7 票 > 赞 3 票）",
          r1["on"] == [True, False] and r1["pressed"] == ["true", "false"],
          f'on={r1["on"]} pressed={r1["pressed"]}')
    check("  #30 是反向的一组：赞有 12 票，但我投的是踩 ⇒ 亮的只有踩",
          r30["on"] == [False, True] and r30["pressed"] == ["false", "true"],
          f'on={r30["on"]} pressed={r30["pressed"]}')
    check("  亮不亮看得出来（不是只差一个 class：颜色确实不同）",
          r1["colors"][0] != r1["colors"][1], r1["colors"])
    check("★计数照常显示，与高亮无关（3 / 7）", r1["nums"] == ["3", "7"], r1["nums"])
    check("★计数为 0 不显示数字：#2 两颗钮都只剩图标，`👍0` 那种噪声不许有",
          r2["nums"] == [None, None] and pg.locator("#c-2 .commentVoteNum").count() == 0,
          r2["nums"])
    vg = pg.evaluate("""() => {
      const r = [...document.querySelectorAll('#c-30 .commentVote')]
          .map((x) => x.getBoundingClientRect());
      return { upRight: r[0].right, downLeft: r[1].left,
               y0: r[0].y, h0: r[0].height, y1: r[1].y, h1: r[1].height };
    }""")
    check("踩排在赞的右边（DOM 顺序之外再量一次几何）",
          vg["downLeft"] >= vg["upRight"] - 0.5,
          f'赞右缘 {round(vg["upRight"], 1)} 踩左缘 {round(vg["downLeft"], 1)}')
    check("  两颗钮在同一水平带上（没被挤到另一行去）",
          min(vg["y0"] + vg["h0"], vg["y1"] + vg["h1"]) - max(vg["y0"], vg["y1"]) > 0,
          f'y {round(vg["y0"], 1)}+{round(vg["h0"], 1)} / {round(vg["y1"], 1)}+{round(vg["h1"], 1)}')

    print("\n⑪b 点一次发什么：改投发 ±1、再点同一边发 0（撤回）、显示的数来自服务端回执")
    # 这里量的是**发出去的 value**：界面在乐观更新之后就已经变了，"改投"与"撤回"
    # 两种实现长得一模一样 —— 只有把请求记下来才分得清（桩里那个 `__votes`）。
    pg.evaluate("window.__votes = []")
    pg.locator("#c-30 .commentVote").first.click()
    pg.wait_for_timeout(300)
    check("★点「赞」发的是 value=1（#30 原本 myVote=-1 ⇒ 这是**改投**，不是撤回）",
          pg.evaluate("window.__votes") == [[30, 1]], pg.evaluate("window.__votes"))
    a30 = pg.evaluate(VOTE_ROW, 30)
    check("★显示的数字来自**服务端回执**：夹具里 #30 的赞是 12，回执给的是 7"
          "（本地自增会显示 13 ⇒ 这条分辨得出『自己算账』那种写法）",
          a30["nums"] == ["7", "2"], a30["nums"])
    check("  回执里的 myVote 覆盖了乐观值 ⇒ 赞亮、踩灭",
          a30["on"] == [True, False], a30["on"])
    check("  投完就解锁（in-flight 那把锁不会漏）",
          a30["disabled"] == [False, False], a30["disabled"])

    pg.evaluate("window.__votes = []")
    pg.locator("#c-30 .commentVote").first.click()
    pg.wait_for_timeout(300)
    check("★再点一次已经点亮的那一侧 = 撤回（value=0，不是再投一遍）",
          pg.evaluate("window.__votes") == [[30, 0]], pg.evaluate("window.__votes"))
    z30 = pg.evaluate(VOTE_ROW, 30)
    check("★撤回后回执里两个数都是 0 ⇒ 数字整颗收掉（不留 `👍0 👎0`）",
          z30["nums"] == [None, None], z30["nums"])
    check("  且没有一颗还亮着", z30["on"] == [False, False], z30["on"])

    print("\n⑪c 乐观更新：点下去当场就变（不等一个来回），但那只是占位、回执一到就整组覆盖")
    # 桩按住不回（`__voteHold`）才看得见中间那一瞬——否则"乐观更新"与"等回来再改"
    # 在界面上没有任何区别（这是这一组最容易写成永真的地方）。
    pg.evaluate("window.__voteHold = true")
    pg.locator("#c-2 .commentVote").first.click()
    pg.wait_for_timeout(250)
    mid = pg.evaluate(VOTE_ROW, 2)
    check("★请求还挂着（桩没回）时按钮已经亮、数字已经 +1 —— 乐观值就是这一瞬",
          mid["on"] == [True, False] and mid["nums"][0] == "1",
          f'on={mid["on"]} nums={mid["nums"]}')
    check("  同时它被锁住（连点两下不该发出两个相反方向的请求）",
          mid["disabled"] == [True, True], mid["disabled"])
    pg.evaluate("window.__voteRelease()")
    pg.wait_for_timeout(300)
    pg.evaluate("window.__voteHold = false")
    done = pg.evaluate(VOTE_ROW, 2)
    check("★回执一到就覆盖那笔本地账（乐观值是 1，回执给的是 7 —— 覆盖了才对得上）",
          done["nums"][0] == "7" and done["on"] == [True, False], f'nums={done["nums"]}')
    check("  锁也解开了", done["disabled"] == [False, False], done["disabled"])

    print("\n⑪d 失败回滚：code≠200 时退回原样，并把服务端那句话显示出来")
    pg.evaluate("window.__voteFail = true")
    pg.evaluate("window.__votes = []")
    pg.locator("#c-42 .commentVote").first.click()
    pg.wait_for_timeout(400)
    pg.evaluate("window.__voteFail = false")
    check("前提：失败那一下确实发出去了（否则下面的「没留下痕迹」是空话）",
          pg.evaluate("window.__votes") == [[42, 1]], pg.evaluate("window.__votes"))
    f42 = pg.evaluate(VOTE_ROW, 42)
    check("★失败后没留下假的乐观值（数字与高亮都退回原样）",
          f42["nums"] == [None, None] and f42["on"] == [False, False],
          f'nums={f42["nums"]} on={f42["on"]}')
    check("  按钮解锁（不然后面这颗钮永远点不动）",
          f42["disabled"] == [False, False], f42["disabled"])
    msg = pg.evaluate("() => { const m = document.querySelector('.ant-message-error');"
                      " return m ? m.textContent.trim() : null }")
    check("★提示语用的是服务端那一句（errMsg，不是本地编的通用话）", msg == "投票没成功", msg)
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

    # ══ 五、红基线 D：把「回复」退回只能开在页面顶部那个输入框 ═══════════════════════
    print("\n⑩d 红基线 D（reply-top 变体）：点「回复」时框还在页面顶部，靠下的那条够不着")
    pg5 = br.new_page(viewport={"width": 1280, "height": 900})
    errs5 = []
    pg5.on("pageerror", lambda e: errs5.append(str(e)))
    pg5.add_init_script("window.__BOOT = { path: '/article/1', token: 't' };")
    pg5.goto(REPLY_TOP.as_uri() + "/index.html")
    pg5.wait_for_selector(".commentComposer", timeout=8000)
    pg5.wait_for_timeout(300)
    check("对照组页面本身是好的（没有 JS 错误、列表在）",
          not errs5 and pg5.locator(".commentThread").count() == 30, "; ".join(errs5[:1]))
    pg5.evaluate("document.querySelector('#c-30').scrollIntoView({block:'center',behavior:'auto'})")
    pg5.wait_for_timeout(250)
    pg5.locator("#c-30 .commentActions button").first.click()
    pg5.wait_for_timeout(350)
    check("★对照组里**没有**行内框—— ⇒ ⑩ 那几条「住在这一行的 .commentMain 里」有牙",
          pg5.locator(".commentComposer.isInline").count() == 0,
          pg5.locator(".commentComposer.isInline").count())
    check("★对照组里回复栏出现在**顶层**那个输入框上—— ⇒ ⑩「顶层没有那条」有牙",
          pg5.locator(".commentComposer:not(.isInline) .commentReplyBar").count() == 1,
          pg5.locator(".commentComposer:not(.isInline) .commentReplyBar").count())
    # 这就是用户那句话的**几何翻译**：框在页面顶部，而要看的那条评论在两千多像素以外。
    bar = box(pg5, ".commentComposer:not(.isInline) .commentReplyBar")
    check("★对照组里那个框离被回复的评论 2000px 以上（「每次都要滚到顶部」就是这件事）",
          bool(bar) and abs(bar["y"] - pg5.evaluate(
              "() => document.querySelector('#c-30').getBoundingClientRect().y")) > 2000,
          f'bar.y={bar and round(bar["y"], 1)}')
    check("★对照组里焦点**没有**落在任何输入框里（点完还得自己去找框）",
          pg5.evaluate("() => document.activeElement.tagName") != "TEXTAREA",
          pg5.evaluate("() => document.activeElement.tagName"))
    pg5.close()

    # ══ 六、红基线 E：高亮从「我投的那一票」换成「票多的那一侧」══════════════════════
    print("\n⑪e 红基线 E（vote-by-count 变体）：高亮跟着票数走")
    pg6 = br.new_page(viewport={"width": 1280, "height": 900})
    errs6 = []
    pg6.on("pageerror", lambda e: errs6.append(str(e)))
    pg6.add_init_script("window.__BOOT = { path: '/article/1', token: 't' };")
    pg6.goto(VOTE_BY_COUNT.as_uri() + "/index.html")
    pg6.wait_for_selector(".commentThread", timeout=8000)
    pg6.wait_for_timeout(300)
    check("对照组页面本身是好的（没有 JS 错误、两颗钮都在）",
          not errs6 and pg6.locator("#c-1 .commentVote").count() == 2, "; ".join(errs6[:1]))
    b1 = pg6.evaluate(VOTE_ROW, 1)
    check("★对照组里亮的是**票多的那一侧**（踩 7 票 > 赞 3 票）"
          "—— ⇒ ⑪ 那条「高亮跟 myVote 走」有牙",
          b1["on"] == [False, True], b1["on"])
    b30 = pg6.evaluate(VOTE_ROW, 30)
    check("★反向那组也翻过来（#30 票多的是赞）—— 两条一起才排得掉『恰好蒙对』",
          b30["on"] == [True, False], b30["on"])
    # 对照组只差那一句 ⇒ 同页的**计数**判据该照旧是绿的：红的必须只落在高亮那两条上。
    check("  对照组的计数显示没变（3 / 7）—— ⇒ 上面那两条红只可能是高亮那一处",
          b1["nums"] == ["3", "7"], b1["nums"])
    pg6.close()

    # ══ 七、赞 / 踩图标的墨迹在同一水平线（20261005 用户第 3 条）══════════════════════
    # 用户原话：「讨论区赞和踩图标视觉上不在同一水平线，好像踩高了一点。」
    # 根因**不在** `.commentVote`（两颗钮一样高、都是 `align-items:center`，svg 盒子逐项
    # 相等），在**字形自己**：初稿那条拇指几何在 24 字框里偏下（墨迹 y ∈ [2.5, 22.3]、
    # 中心 12.4），而踩是它关于 y=12 的镜像 ⇒ 踩的中心跑到 11.6。两颗并排就差 **0.8 个
    # 用户单位**（14px 下 0.47px；手机 DPR3 上是 1～2 个物理像素——眼睛比的正是"拳头上沿 /
    # 下沿"那条横边，所以看得见）。修法 = 把这条几何整体上移 0.4 个单位让墨迹居中。
    # ⚠️ 判据只能量**墨迹**：旧稿里两个 svg 盒子的几何完全一致，量盒子（或量 viewBox、
    # 量 `d` 里的数字）永远全绿。这里把真 svg 用 XMLSerializer 序列化、栅格化到 canvas、
    # 扫非透明行——这就是"用户看见的那条边"。
    print("\n⑫ 赞 / 踩图标：两条墨迹落在同一水平线上（量真渲染色块的行范围，不量盒子）")
    pg7 = br.new_page(viewport={"width": 1280, "height": 900})
    errs7 = []
    pg7.on("pageerror", lambda e: errs7.append(str(e)))
    pg7.add_init_script("window.__BOOT = { path: '/article/1', token: 't' };")
    pg7.goto(FIXED.as_uri() + "/index.html")
    pg7.wait_for_selector(".commentThread", timeout=8000)
    pg7.wait_for_timeout(300)
    pg7.evaluate(INK_HELPER)
    up = pg7.evaluate(INK_OF, '#c-1 .commentVote[aria-label="赞"] svg')
    dn = pg7.evaluate(INK_OF, '#c-1 .commentVote[aria-label="踩"] svg')
    check("★前提：两张图都真栅格化出了墨迹（空图会让下面「中心相同」变成永真）",
          bool(up) and bool(dn) and 15 < up["h"] < 24 and 15 < dn["h"] < 24, f"{up} / {dn}")
    check("★两颗墨迹中心都落在字框中线 12.0 上（±0.4 单位）—— 对齐靠的是**两条都居中**",
          abs(up["cy"] - 12) <= 0.4 and abs(dn["cy"] - 12) <= 0.4,
          f'赞 {up["cy"]} / 踩 {dn["cy"]}')
    check("★两颗墨迹中心互差 ≤ 0.25 单位（= 同一水平线；改动前是 0.8）",
          abs(dn["cy"] - up["cy"]) <= 0.25,
          f'{dn["cy"] - up["cy"]:+.2f} 单位 = {(dn["cy"] - up["cy"]) / 24 * 14:+.3f}px @14px')
    boxes = pg7.evaluate("""() => ['赞', '踩'].map((l) => {
      const r = document.querySelector('#c-1 .commentVote[aria-label="' + l + '"] svg')
        .getBoundingClientRect();
      return { top: +r.top.toFixed(2), h: +r.height.toFixed(2) };
    })""")
    check("★上下文：那一行里两个 svg 盒子同高同顶（±0.5px）—— 缺了这条，"
          "「字框里居中」推不出「屏幕上同线」",
          abs(boxes[0]["top"] - boxes[1]["top"]) <= 0.5 and abs(boxes[0]["h"] - boxes[1]["h"]) <= 0.5,
          str(boxes))
    check("  两颗仍是彼此的镜像（赞上沿+踩下沿 ≈ 24、反之亦然）——不是「各挪半格凑齐」",
          abs(up["top"] + dn["bottom"] - 24) <= 0.6 and abs(up["bottom"] + dn["top"] - 24) <= 0.6,
          f'{up["top"]}+{dn["bottom"]} / {up["bottom"]}+{dn["top"]}')
    ou = pg7.evaluate(OLD_INK, OLD_ICON["ThumbUpIcon"])
    od = pg7.evaluate(OLD_INK, OLD_ICON["ThumbDownIcon"])
    check("★红基线：改动前那版两颗墨迹中心差 0.8 单位（14px 下 0.47px）—— ⇒ 上面那条有牙",
          bool(ou) and bool(od) and abs(od["cy"] - ou["cy"]) >= 0.6,
          f'赞 {ou and ou["cy"]} / 踩 {od and od["cy"]}')
    check("  红基线的墨迹高与现版一致（这次是**纯平移**，字形的形状没动）",
          bool(ou) and abs(ou["h"] - up["h"]) <= 0.2, f'{ou and ou["h"]} vs {up["h"]}')
    check("无 JS 运行时报错（第 ⑦ 节这一页）", not errs7, "; ".join(errs7[:2]))
    pg7.close()
    br.close()

print(f"\ncomment-layout: {'全绿' if not FAILS else str(len(FAILS)) + ' 条红'}\n")
sys.exit(1 if FAILS else 0)
