# -*- coding: utf-8 -*-
"""后台首页右栏（日历 + 待办）的无头验收。

后台首页是**唯一一个没有沙箱的常驻页面**，而它恰好是最难用眼睛看出问题的那类：
右栏三段（原「每日箴言」卡 / 日历 / 待办卡）靠百分比高度 + `space-between` 撑着，
撤掉任何一段都不会报错，只是剩下的两段悄悄散开或压扁；日历往上挪还是往下挪，
也只有在几何断言里才说得清。

沿用既定装配手段（见 talk-time.test.py 头注）：sass 用 programmatic API 编译
（CLI 在 Node 18 上会因 chokidar 的 ERR_REQUIRE_ESM 崩）、esbuild 打真组件、
只桩边界（react-redux / 两个重量级兄弟组件 / 主题变量）。

两个兄弟组件（左栏统计卡、中栏文章记录）用空 div 顶替：它们各自要拉接口、开图，
而本沙箱只关心**右栏**——被断言的就是右栏自己。

待办自 20260924 起**落库**（GET/PUT /api/protected/todos，整份列表覆盖），所以这里桩掉
`src/apis/DashboardMethods.tsx` 这一层（内存里那份"服务端"），Home 里的读写路径
——600ms 防抖、加载闸、失败提示——都还是真的。桩同时记下每次 PUT 的载荷，
用来验"改动真的发出去了"，以及最要命的那条：**列表没读出来时绝不出网**。
注意视口必须 > 1530px：`.right` 在 1530px 以下整块 `display:none`（媒体查询）。

**样本日期全部相对"今天"生成**：逾期/今天/未来三档要验"按日期分组 + 逾期高亮"，
写死日期的话这份用例过一天就会自己变红。

用法：python3 frontend/tests/dashboard-home.test.py
"""
import datetime
import json
import pathlib
import shutil
import subprocess
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[2]
FE = ROOT / "frontend"
HOME_SASS = "src/pages/Dashboard/Home/index.sass"

# 20260924 四轮：**必须连博客头那份 sass 一起编译**。原因是实测出来的一个真事故——
# `frontHome/Head/index.sass` 里留着一整块**过期的** `.home {...}`（日历 + 右栏 + 待办卡
# 的老版本，140 行），它选择器与 Home/index.sass 逐字相同、特异性也相同，而在生产
# bundle 里**排在后面**（证据：线上 CSS 里 `.home .cardInfo` 出现在字节 100983 与 203888
# 两处，后者的 padding/height/overflow 把新的那份盖掉了）。只编译 Home 一份 =
# 复现不了这条级联，于是"待办卡右移 30px、内边距 10px"这种线上真缺陷在沙箱里全绿。
# 顺序按生产实证：Home 在前、Head 在后。
SASS_FILES = [HOME_SASS, "src/frontHome/Head/index.sass"]

DEFINE = ('import.meta.env={"VITE_HTTP_BASEURL":"","VITE_CDN_BASEURL":"",'
          '"MODE":"production","DEV":false,"PROD":true,"BASE_URL":"/"}')

FAILS = []


def check(desc, cond, detail=""):
    print(("  ✅ " if cond else "  ❌ ") + desc + (f"  [{detail}]" if detail else ""))
    if not cond:
        FAILS.append(desc)


# ── 样本：日期全部相对"今天" ────────────────────────────────────────────────
TODAY = datetime.date.today()
CN_WEEK = "一二三四五六日"


def day(offset: int) -> str:
    return (TODAY + datetime.timedelta(days=offset)).isoformat()


def cn_label(offset: int) -> str:
    """和组件里 dayjs(d).locale('zh-cn').format('M月D日 dddd') 对齐"""
    d = TODAY + datetime.timedelta(days=offset)
    return f"{d.month}月{d.day}日 星期{CN_WEEK[d.isoweekday() - 1]}"


OVERDUE, TOMORROW, LATER = day(-4), day(1), day(2)
SEED = [
    {"id": 1, "text": "逾期的一条", "done": False, "date": OVERDUE},
    {"id": 2, "text": "今天要做的", "done": False, "date": day(0)},
    {"id": 3, "text": "今天这条已经做完了", "done": True, "date": day(0)},
    {"id": 4, "text": "明天开会记得带电脑和充电器", "done": False, "date": TOMORROW},
    {"id": 5, "text": "没排期的一条", "done": False},
    {"id": 6, "text": "后天一堆事1", "done": False, "date": LATER},
    {"id": 7, "text": "后天一堆事2", "done": False, "date": LATER},
    {"id": 8, "text": "后天一堆事3", "done": False, "date": LATER},
]
EMPTY_DAY = day(-1)          # 没有任何待办的一天（验"空格子不画列表"）


def build_sandbox() -> pathlib.Path:
    sb = pathlib.Path(tempfile.mkdtemp(prefix="dashboard-home-"))
    shutil.copytree(FE / "src", sb / "src")
    (sb / "node_modules").symlink_to(FE / "node_modules")
    stubs = sb / "stubs"
    stubs.mkdir()

    # 边界①：react-redux。状态对象保持同一实例（每次返回新对象会让 useSelector
    # 判定"变了"而无限重渲染）。
    (stubs / "redux.tsx").write_text('''\
const state: any = {
  user: { avatar: '', name: 'Sora' },
  notes: { noteCount: 0, noteList: [], loading: false },
  tags: { tagCount: 0, tagList: [] },
  categories: { categoryList: [] },
};
export const useSelector = (fn: any) => { try { return fn(state); } catch { return undefined; } };
export const useDispatch = () => (_a: any) => undefined;
export const Provider = ({ children }: any) => children;
''', encoding="utf-8")

    # 边界②：redux thunk 工厂（首页挂载时会 dispatch 三个拉取动作）
    for name in ("note", "categories", "tags"):
        (sb / f"src/store/components/{name}.tsx").write_text(
            "export const fetch%s = () => ({ type: 'noop' });\n"
            "export default {};\n" % {"note": "NoteList", "categories": "Categories",
                                      "tags": "Tags"}[name], encoding="utf-8")

    # 边界③：两个重量级兄弟组件（左栏/中栏）——本沙箱只验右栏
    (sb / "src/components/articleAnalytics/index.tsx").write_text(
        "const ArticleAnalytics = () => <div className='stub-analytics'/>;\n"
        "export default ArticleAnalytics;\n", encoding="utf-8")
    (sb / "src/components/articleRecord/index.tsx").write_text(
        "const ArticleRecord = (_p: {isDark?: boolean}) => <div className='stub-record'/>;\n"
        "export default ArticleRecord;\n", encoding="utf-8")

    # 边界③b：react-router-dom 的 import 兜底。本沙箱只渲染 Home，用不到路由，
    # 但 Home 现在要 useNavigate（待审评论那行的跳转），缺了 esbuild 直接打包失败。
    (stubs / "router.tsx").write_text('''\
export const useNavigate = () => (to: string, opts?: any) => {
  const w = window as any;
  w.__nav = (w.__nav || []).concat([{to, opts}]);
};
export const Link = ({children}: any) => children;
export const NavLink = ({children}: any) => children;
export const Outlet = () => null;
export const Navigate = () => null;
export const useSearchParams = () => [new URLSearchParams(location.search), () => {}] as any;
export const useLocation = () => ({pathname: location.pathname, search: location.search});
export const useParams = () => ({});
''', encoding="utf-8")

    # 边界④：待办接口层。桩的是"服务端那份列表"+ 每次 PUT 的载荷记录；
    # 判成功/取失败文案那两行**照抄真实现**（改口径时这里要跟着改，别让它俩分叉）。
    (sb / "src/apis/DashboardMethods.tsx").write_text('''\
const KEY_PUTS = '__puts', KEY_FAIL = '__failGet';
let server: any[] = %s;
// 每次页面加载都从种子起（= 库里的初始那份）；同一页面会话内 PUT 会改它。
// **刻意**不跨 reload 保留：沙箱要的是可复现的起点（reload 后回到初始 8 条）。
const env = (data: any) => ({status: 200, data: {code: 200, message: 'ok', data}});
export const ok = (res: any) => res.status === 200 && !!res.data && res.data.code === 200;
export const errMsg = (res: any, fallback = '操作失败，请稍后再试') =>
  String(res?.data?.message || '').trim() || fallback;
export function getTodos() {
  if (localStorage.getItem(KEY_FAIL) === '1') {
    localStorage.removeItem(KEY_FAIL);
    return Promise.resolve({status: 200, data: {code: 500, message: '假装读失败', data: null}});
  }
  return Promise.resolve(env(server));
}
export function saveTodos(todos: any) {
  (window as any).__lastPut = todos;
  localStorage.setItem(KEY_PUTS, String(Number(localStorage.getItem(KEY_PUTS) || 0) + 1));
  server = todos;
  return Promise.resolve(env(server));
}
// 待审评论：桩一份留言列表，几条 approved=0（等人工裁决）由页面上现改
export function listBoardRows() {
  (window as any).__boardCalls = ((window as any).__boardCalls || 0) + 1;
  if (localStorage.getItem('__failBoard') === '1') {
    localStorage.removeItem('__failBoard');
    return Promise.resolve({status: 200, data: {code: 500, message: '假装读失败', data: null}});
  }
  const n = Number(localStorage.getItem('__pending') || 0);
  const rows = [];
  for (let i = 0; i < 4; i++) {
    rows.push({talkKey: i + 1, content: '留言' + (i + 1), author: 'a',
               approved: i < n ? 0 : 1});
  }
  return Promise.resolve(env(rows));
}
''' % json.dumps(SEED, ensure_ascii=False), encoding="utf-8")

    (sb / "entry.tsx").write_text('''\
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import Home from './src/pages/Dashboard/Home/index.tsx';
(window as any).__mount = () => createRoot(document.getElementById('root')!).render(<Home />);
''', encoding="utf-8")

    subprocess.run(["node", "-e",
                    "const s=require('sass'),fs=require('fs');"
                    "const out=process.argv.slice(1,-1).map(p => s.compile(p,{style:'expanded'}).css).join('\\n');"
                    "fs.writeFileSync(process.argv[process.argv.length-1], out);",
                    *[str(FE / f) for f in SASS_FILES], str(sb / "home.css")],
                   cwd=str(FE), check=True)

    subprocess.run([str(FE / "node_modules/.bin/esbuild"), "entry.tsx",
                    "--bundle", "--format=iife", "--outfile=bundle.js",
                    "--loader:.sass=text", "--jsx=automatic", f"--define:{DEFINE}",
                    "--loader:.png=dataurl", "--loader:.svg=dataurl",
                    "--loader:.css=text",
                    f"--alias:react-redux={stubs}/redux.tsx",
                    f"--alias:react-router-dom={stubs}/router.tsx"],
                   cwd=str(sb), check=True, capture_output=True)

    # 主题变量 + 高度链：#root 必须有确定高度，`.right` 的 100% 才有参照物
    # （真站里这个高度由后台 Layout 给）。
    (sb / "theme.css").write_text(
        "html,body,#root{height:100%;margin:0}"
        ":root{--container-background-color:#fff;--font-p-color:#333;"
        "--font-title-color:#111;--pic-background-cover:#f7f7f7;--phoneBar-bg:#333;"
        "--phoneBar-font-color:#eee;}\n", encoding="utf-8")

    (sb / "index.html").write_text(
        '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">'
        '<link rel="stylesheet" href="theme.css">'
        '<link rel="stylesheet" href="home.css"></head><body><div id="root"></div>'
        '<script src="bundle.js"></script><script>window.__mount && window.__mount();</script>'
        '</body></html>', encoding="utf-8")
    return sb


SANDBOX = build_sandbox()
URL = SANDBOX.as_uri() + "/index.html"

from playwright.sync_api import sync_playwright  # noqa: E402


def row_texts(pg):
    """按渲染顺序取出所有待办行里的文字"""
    return pg.eval_on_selector_all(".todo-row .todo-text", "els => els.map(e => e.value)")


def cell(pg, iso):
    """一格日历：盒子的几何、日期数字的位置、小圆点、以及「今天」那圈环的真实落点。"""
    return pg.evaluate("""(title) => {
      const c = document.querySelector(`.ant-picker-cell[title="${title}"]`);
      if (!c) return null;
      const bx = (el) => { if (!el) return null; const r = el.getBoundingClientRect();
        return {t: r.top, l: r.left, r: r.right, b: r.bottom, w: r.width, h: r.height,
                cx: r.left + r.width / 2, cy: r.top + r.height / 2}; };
      const inner = c.querySelector('.ant-picker-cell-inner');
      const val = c.querySelector('.ant-picker-calendar-date-value');
      const dots = [...c.querySelectorAll('.calDot')];
      const dotsWrap = c.querySelector('.calDots');
      const ring = inner ? getComputedStyle(inner, '::before') : null;
      const si = inner ? getComputedStyle(inner) : null;
      const sv = val ? getComputedStyle(val) : null;
      return {
        selected: c.className.includes('ant-picker-cell-selected'),
        dots: dots.map(d => d.className),
        dotColors: dots.map(d => getComputedStyle(d).backgroundColor),
        dotTitle: dotsWrap ? dotsWrap.getAttribute('title') : null,
        hasText: !!c.querySelector('.events'),
        text: c.textContent.trim(),
        cell: bx(c), inner: bx(inner), val: bx(val),
        dotsBox: dots.length ? bx(dots[0]) : null,
        innerRadius: inner ? getComputedStyle(inner).borderRadius : null,
        innerBg: si ? si.backgroundColor : null,
        valColor: sv ? sv.color : null,
        valWeight: sv ? sv.fontWeight : null,
        ring: ring ? {border: ring.border, radius: ring.borderRadius, pos: ring.position,
                      top: ring.top, left: ring.insetInlineStart,
                      right: ring.insetInlineEnd, bottom: ring.bottom} : null,
      };
    }""", iso)


with sync_playwright() as p:
    br = p.chromium.launch()
    # 必须 > 1530px：`.right` 在更窄的视口下整块 display:none
    pg = br.new_page(viewport={"width": 1600, "height": 1000})
    errs = []
    pg.on("pageerror", lambda e: errs.append(str(e)))
    # 待办由上面的接口桩给（不再走 localStorage）；这里只清掉卡片标题，
    # 好验它的默认值。日期样本全部相对"今天"生成，见文件头。
    # 顺手把 setInterval 登记一下：这一页有一条 60 秒的轮询，脚本里等不起 60 秒，
    # 但"那条轮询到底接上了没有"必须能断言（能力有测试 ≠ 接线有测试）
    pg.add_init_script("""
      localStorage.removeItem('dashboard_list_title');
      (() => { const orig = window.setInterval;
        window.__intervals = [];
        window.setInterval = (fn, ms, ...rest) => {
          window.__intervals.push(ms); return orig(fn, ms, ...rest); };
      })();
    """)
    pg.goto(URL)
    pg.wait_for_timeout(800)   # Typed.js 打字机 + antd 日历挂载

    print("① 页面活着")
    check("无 JS 运行时报错", not errs, "; ".join(errs[:2]))
    check("右栏存在（视口宽度够）", pg.locator(".home .right").count() == 1)

    print("② 每日箴言卡已撤（20260924）")
    check("页面上不再有「每日箴言」", "每日箴言" not in pg.locator("body").inner_text())
    check("不再有箴言卡的 .oneSay / .custom-card-header",
          pg.locator(".oneSay, .custom-card-header").count() == 0)

    print("③ 日历与待办都在右栏里，且左右同边")
    check("右栏里有一个日历", pg.locator(".right .ant-picker-calendar").count() == 1)
    check("右栏里有待办卡", pg.locator(".right .cardInfo").count() == 1)
    check("待办卡标题仍是本地存的那份（默认「开发进度」）",
          pg.input_value(".right .cardInfo input") == "开发进度")

    # 20260924 三轮：两块内容共用同一条左右边。原先「卡片 10px + 卡体 14px」让待办
    # 从比日历窄 25px 的地方起笔（实测 1168.3 vs 1193.3），右栏看着像两个人各写各的。
    # 留 2px 容差：卡片自己有 1px 边框，那 1px 不值得为对齐去动卡片本身的观感。
    align = pg.evaluate("""() => {
      const b = (sel) => { const el = document.querySelector(sel);
        if (!el) return null; const r = el.getBoundingClientRect();
        return {l: r.left, r: r.right, h: r.height}; };
      const card = document.querySelector('.right .cardInfo');
      const cs = getComputedStyle(card);
      return { grid: b('.calWrap .ant-picker-content'), row: b('.todo-row'),
               scroll: b('.todoBody'), card: b('.right .cardInfo'),
               cal: b('.right .ant-picker-calendar'),
               margin: cs.margin, padding: cs.padding, overflowY: cs.overflowY };
    }""")
    check("待办行与日历网格左边对齐",
          abs(align["row"]["l"] - align["grid"]["l"]) <= 2,
          f"待办 {align['row']['l']:.1f} / 日历 {align['grid']['l']:.1f}")
    # 20260924 四轮：上面那条断言曾经**假绿**过。真事故是 .cardInfo 被 Head 那份过期
    # 拷贝盖住：`margin:30px` 把卡片整体右移 30px（左边比日历多 30、右边还探出右栏），
    # `padding:10px` 再让内容多缩 10px。只量"行 vs 网格"在有 1px 边框的那一版恰好够用，
    # 量不到"卡片盒本身跑了"。这两条直接钉卡片自己的盒：左右都要与日历严格同边。
    check("待办卡与日历同左边（卡片自己没有把盒推开的外边距）",
          abs(align["card"]["l"] - align["cal"]["l"]) <= 1,
          f"卡片 {align['card']['l']:.1f} / 日历 {align['cal']['l']:.1f}")
    check("待办卡与日历同右边（没有探出右栏）",
          abs(align["card"]["r"] - align["cal"]["r"]) <= 1,
          f"卡片 {align['card']['r']:.1f} / 日历 {align['cal']['r']:.1f}")
    check("待办卡左右内边距为 0、外边距为 0（对齐靠盒子本身，不靠负边距找补）",
          align["margin"] == "0px" and align["padding"].startswith("10px 0px"),
          f"margin={align['margin']} padding={align['padding']}")
    check("待办滚动区右边与日历网格同边（滚动条 6px 留在这条边的内侧）",
          abs(align["scroll"]["r"] - align["grid"]["r"]) <= 2,
          f"滚动区 {align['scroll']['r']:.1f} / 日历 {align['grid']['r']:.1f}")
    check("待办行加高了（原来 22px，现在 ≥28px）", align["row"]["h"] >= 28,
          f"{align['row']['h']:.1f}px")

    print("④ 日历上移、待办吃掉余量（不再是 space-between 撑开）")
    geo = pg.evaluate("""() => {
      const b = (sel) => { const el = document.querySelector(sel);
        if (!el) return null; const r = el.getBoundingClientRect();
        return {t: r.top, b: r.bottom, l: r.left, r: r.right, w: r.width, h: r.height}; };
      return { cal: b('.right .ant-picker-calendar'), todo: b('.right .cardInfo'),
               right: b('.right') };
    }""")
    gap = geo["todo"]["t"] - geo["cal"]["b"]
    check("日历在待办卡上方", gap >= 0,
          f"日历底 {geo['cal']['b']:.0f} / 待办顶 {geo['todo']['t']:.0f}")
    # 旧布局（space-between）下这个缝实测近 300px：日历被顶到最上、待办被压到最下。
    check("两段之间只隔一个 gap（≤ 40px），不再是撑出来的空档", gap <= 40, f"{gap:.0f}px")
    # 年度进度条已删（20260924）：它一直量出 0 高度、在生产里根本不可见
    # （height:15% 挂在由内容决定高度的父块上 ⇒ 解析成 auto，孩子又全是绝对定位），
    # 主人拍板撤掉。这里锁"日历紧贴右栏顶部"，别再让它上面凭空多出一段。
    check("日历紧贴右栏顶部（上面没有多余的一段）",
          geo["cal"]["t"] - geo["right"]["t"] <= 40,
          f"日历顶 {geo['cal']['t']:.0f} / 右栏顶 {geo['right']['t']:.0f}")
    check("日历落在右栏上半段（撤掉箴言后确实上移了）",
          geo["cal"]["t"] < geo["right"]["t"] + geo["right"]["h"] / 2,
          f"日历顶 {geo['cal']['t']:.0f} / 右栏半高 "
          f"{geo['right']['t'] + geo['right']['h'] / 2:.0f}")
    check("待办卡吃掉余量（底边贴近右栏底）",
          geo["right"]["b"] - geo["todo"]["b"] <= 60,
          f"余 {geo['right']['b'] - geo['todo']['b']:.0f}px")
    check("两者都在右栏内（左右不越界）",
          geo["cal"]["l"] >= geo["right"]["l"] - 1
          and geo["todo"]["r"] <= geo["right"]["r"] + 1)
    check("日历有实际高度（不是被压成 0）", geo["cal"]["h"] > 200,
          f"{geo['cal']['h']:.0f}px")
    # 20260924 二轮：格子从 46px 收到 26px、表体高度也不再被 antd 的 256px 定死，
    # 整块日历 383px → 261px。省下来的高度归待办卡（它是 flex:1，自动吃掉）。
    check("日历收小了（< 300px，上一轮 383px）", geo["cal"]["h"] < 300,
          f"{geo['cal']['h']:.0f}px")
    check("待办卡明显比日历高（省下来的空间确实给了待办）",
          geo["todo"]["h"] > geo["cal"]["h"] * 2,
          f"日历 {geo['cal']['h']:.0f} / 待办 {geo['todo']['h']:.0f}")

    print("⑤ 日历格子：编号居中在小圆里、待办画成小圆点（20260924 二轮）")
    today_cell = cell(pg, day(0))
    late_cell = cell(pg, OVERDUE)
    later_cell = cell(pg, LATER)
    empty_cell = cell(pg, EMPTY_DAY)

    # 上一轮是"把待办文字塞进格子"（.events 里一行一条）。那条路的代价是格子得撑到
    # 46px 以上，而 antd 的「今天」环是挂在格子上的 —— 格子一大环就跟着放大成方框。
    check("格子里不再有待办文字（.events 那条路已撤）",
          not any(c["hasText"] for c in (today_cell, late_cell, later_cell)),
          str([c["text"] for c in (today_cell, late_cell, later_cell)]))

    check("今天两个待办 → 两个点，其中一个是已完成（is-done）",
          today_cell["dots"] == ["calDot", "calDot is-done"], str(today_cell["dots"]))
    check("逾期那格是红点",
          late_cell["dots"] == ["calDot is-overdue"]
          and late_cell["dotColors"] == ["rgb(212, 56, 13)"],
          f"{late_cell['dots']} {late_cell['dotColors']}")
    check("一天三条 → 正好三个点（上限就是 3）",
          len(later_cell["dots"]) == 3, str(later_cell["dots"]))
    check("没有待办的那格不画点", empty_cell["dots"] == [], str(empty_cell["dots"]))
    check("点的 title 列出那一天的全部待办（点了上限也看得全）",
          later_cell["dotTitle"] == "后天一堆事1、后天一堆事2、后天一堆事3",
          str(later_cell["dotTitle"]))

    # 编号居中：格子 → 小圆 → 数字，三层中心必须对得上（"圆形在数字上偏移"就是这么来的）
    off = {k: round(abs(c["inner"]["cx"] - c["cell"]["cx"]), 1)
           for k, c in (("今天", today_cell), ("逾期", late_cell), ("后天", later_cell))}
    check("日期数字在格子里横向居中（偏差 < 1px）",
          all(v < 1 for v in off.values()), str(off))
    check("数字被画在一枚 26px 的小圆里（不是整格方块）",
          round(today_cell["inner"]["w"]) == 26 and round(today_cell["inner"]["h"]) == 26
          and today_cell["innerRadius"] == "50%",
          f"{today_cell['inner']['w']:.0f}×{today_cell['inner']['h']:.0f} {today_cell['innerRadius']}")
    check("点画在格子的下沿（在数字下方，不与数字重叠）",
          later_cell["dotsBox"]["t"] >= later_cell["inner"]["b"] - 1,
          f"点顶 {later_cell['dotsBox']['t']:.1f} / 数字底 {later_cell['inner']['b']:.1f}")

    # 「今天」默认是**选中态**（rc-picker 的面板值默认就是今天，实测今天那格同时带
    # -selected 与 -today）⇒ 它是一枚实心紫圆 + 白字，不是 antd 默认那圈蓝框。
    # 这不是"环丢了"：环（`.ant-picker-cell-inner::before`）本来就只在今天**不是**
    # 选中项时才露出来，那一段放到 ⑥ 点了别的日期之后再验。
    check("今天那格是实心紫圆 + 白字（默认选中，一眼看得出是几号）",
          today_cell["selected"] and today_cell["innerBg"] == "rgb(197, 135, 188)"
          and today_cell["valColor"] == "rgb(255, 255, 255)",
          f"selected={today_cell['selected']} {today_cell['innerBg']} {today_cell['valColor']}")
    check("格子高度回到紧凑档（≤ 36px，上一轮是 58px）",
          later_cell["cell"]["h"] <= 36, f"{later_cell['cell']['h']:.0f}px")

    print("⑥ 点日期 = 中文行内快添（不再是英文弹窗）")
    pg.locator(f'.ant-picker-cell[title="{LATER}"]').click()
    pg.wait_for_timeout(300)

    # 选了别的一天之后，「今天」失去选中态 —— 这时才轮到 antd 那圈环出场。
    # 环挂在 `.ant-picker-cell-inner::before`、inset:0：锚点就是那枚 26px 小圆，
    # 锚错了（格子这层没有定位上下文）它会去贴外层 td 画，那就成了"环跑偏"。
    unsel = cell(pg, day(0))
    ring = unsel["ring"]
    check("今天不再是选中项后，环是紫色圆形、正好贴住数字那枚小圆",
          (not unsel["selected"]) and ring["border"] == "1px solid rgb(197, 135, 188)"
          and ring["radius"] == "50%" and ring["pos"] == "absolute"
          and ring["top"] == "0px" and ring["left"] == "0px"
          and ring["right"] == "0px" and ring["bottom"] == "0px",
          str(ring))
    check("今天那格的数字仍然是加粗的紫色（环之外另给一层强调）",
          unsel["valColor"] == "rgb(176, 112, 168)" and unsel["valWeight"] == "600",
          f"{unsel['valColor']} / {unsel['valWeight']}")

    check("出现快添栏", pg.locator(".calQuick").count() == 1)
    check("文案是中文的「M月D日 · 加一条」",
          pg.locator(".calQuick-label").inner_text().strip().endswith("加一条")
          and f"{int(LATER[5:7])}月{int(LATER[8:10])}日" in pg.locator(".calQuick-label").inner_text(),
          pg.locator(".calQuick-label").inner_text())
    check("输入框自动聚焦", pg.evaluate(
        "() => document.activeElement && document.activeElement.closest('.calQuick') !== null"))
    check("不再弹英文的 Select Date 确认框",
          pg.locator(".ant-modal-confirm-title").count() == 0)
    pg.fill(".calQuick input", "快添的一条")
    pg.keyboard.press("Enter")
    pg.wait_for_timeout(300)
    check("回车即添加（落进这一天）", "快添的一条" in row_texts(pg))
    check("添加后快添栏留着、输入框已清空（方便连着加）",
          pg.locator(".calQuick").count() == 1
          and pg.input_value(".calQuick input") == "")
    check("那天的点仍封顶 3 个，但 title 里已经多了新加这条",
          len(cell(pg, LATER)["dots"]) == 3
          and "快添的一条" in (cell(pg, LATER)["dotTitle"] or ""),
          str(cell(pg, LATER)["dotTitle"]))
    pg.click(".calQuick button:has-text('取消')")
    pg.wait_for_timeout(200)
    check("取消后快添栏收起", pg.locator(".calQuick").count() == 0)

    print("⑦ 日历头部：翻月 / 回「今天」/ 点日期把那天带进待办卡")
    # 自定义 headerRender 会把 antd 自带的 ‹ › 顶掉（所以自己长了一套）。三样按契约钉住。
    check("头部有「‹ › + 年/月下拉 + 今天」",
          pg.locator(".calHead .calNav").count() == 2
          and pg.locator(".calHead .ant-select").count() == 2
          and pg.locator(".calHead .calToday").count() == 1)

    def head_ym(pgx):
        """头部两个下拉当前显示的年、月（zh-cn 的月份短名就是「9月」这种）"""
        return pgx.eval_on_selector_all(".calHead .ant-select-selection-item",
                                        "els => els.map(e => e.textContent.trim())")

    ym = head_ym(pg)
    check("两栏显示的就是今天的年月", ym == [str(TODAY.year), f"{TODAY.month}月"], str(ym))

    # 上个月：按真实日历算（1 月退一步是去年 12 月），别拿月份数字硬减
    prev_d = TODAY.replace(day=1) - datetime.timedelta(days=1)
    pg.click('.calHead .calNav[aria-label="上个月"]')
    pg.wait_for_timeout(200)
    check("点 ‹ 退回上个月（跨年也对）",
          head_ym(pg) == [str(prev_d.year), f"{prev_d.month}月"], str(head_ym(pg)))
    pg.click('.calHead .calNav[aria-label="下个月"]')
    pg.wait_for_timeout(200)
    check("点 › 又回到本月", head_ym(pg) == ym, str(head_ym(pg)))

    # 走远一点，再验「今天」是一步回到今天（而不是"回一格"）
    pg.click('.calHead .calNav[aria-label="上个月"]')
    pg.click('.calHead .calNav[aria-label="上个月"]')
    pg.wait_for_timeout(250)
    check("连翻两下确实走远了", head_ym(pg) != ym, str(head_ym(pg)))
    pg.click(".calHead .calToday")
    pg.wait_for_timeout(250)
    check("点「今天」一步回到本月", head_ym(pg) == ym, str(head_ym(pg)))
    check("回来之后今天那格仍是「今天」态（环在）",
          (cell(pg, day(0))["ring"] or {}).get("radius") == "50%")

    # 下拉换月也得接线（onChange 里是 value.clone().month()，写错就静默不动）
    pg.locator(".calHead .ant-select").nth(1).click()
    pg.wait_for_timeout(250)
    pg.locator('.ant-select-dropdown .ant-select-item-option[title="1月"]').click()
    pg.wait_for_timeout(250)
    check("从下拉里挑 1 月能换过去",
          head_ym(pg) == [str(TODAY.year), "1月"], str(head_ym(pg)))
    pg.click(".calHead .calToday")
    pg.wait_for_timeout(250)

    # 点日期 ↔ 待办卡的锚点契约。分组行的 data-date 就是那一组的 key：逾期那几天
    # 在卡里并成了一组（key='overdue'），所以**过去的日期要落到 'overdue' 上**。
    keys = pg.eval_on_selector_all(".cardInfo .todo-group",
                                   "els => els.map(e => e.dataset.date)")
    check("每个待办分组都带 data-date（就是它在卡里的 key）",
          keys == ["overdue", day(0), TOMORROW, LATER, "none"], str(keys))

    # 联动＝"只滚不改数据"，所以要**滚得动**才看得见。矮窗口下 `.todoBody` 会真的溢出
    # （flex:1 + overflow-y:auto）——窗口矮是真实场景，不是为用例造的特例。
    pg2 = br.new_page(viewport={"width": 1600, "height": 620})
    pg2.goto(URL)
    pg2.wait_for_timeout(800)
    ov = pg2.evaluate("() => { const b = document.querySelector('.cardInfo .todoBody');"
                      " return b.scrollHeight - b.clientHeight; }")
    check("矮窗口下待办区确实能滚（否则下面那条是空转）", ov > 20, f"{ov}px")
    pg2.evaluate("() => { document.querySelector('.cardInfo .todoBody').scrollTop = 1e5; }")
    pg2.locator(f'.ant-picker-cell[title="{OVERDUE}"]').click()
    pg2.wait_for_timeout(300)
    res = pg2.evaluate("""() => {
      const b = document.querySelector('.cardInfo .todoBody');
      const g = document.querySelector('.cardInfo .todo-group[data-date="overdue"]');
      if (!g) return null;
      const rb = b.getBoundingClientRect(), rg = g.getBoundingClientRect();
      return {inView: rg.top >= rb.top - 1 && rg.bottom <= rb.bottom + 1,
              top: b.scrollTop,
              // 行文字在 <input value> 里，textContent 取不到 —— 按 value 找
              todo: [...g.querySelectorAll('.todo-row .todo-text')]
                      .some(i => i.value === '逾期的一条')};
    }""")
    check("点一个已逾期的日期 → 滚回卡片顶上的「已逾期」那一组",
          bool(res) and res["inView"] and res["todo"] and res["top"] < ov, str(res))
    pg2.close()
    print("⑧ 落库：每次改动把整份列表发上去（600ms 防抖之后）")
    # 防抖 600ms：上一次改动（回车添加）到现在要等够
    pg.wait_for_timeout(900)
    sent = pg.evaluate("() => window.__lastPut")
    check("快添那条已经发给服务端（整份列表，9 条）",
          len(sent) == 9 and sent[-1]["text"] == "快添的一条",
          f"{len(sent)} 条，末条 {sent[-1]['text'] if sent else '—'}")
    check("发出的字段就是线上口径 text/done/date（跨语言契约）",
          set(sent[-1].keys()) == {"text", "done", "date"}, str(sorted(sent[-1].keys())))
    check("新加那条带着它那天的排期", sent[-1]["date"] == LATER and sent[-1]["done"] is False,
          str(sent[-1]))
    check("未排期那条发的是 null 而不是空串",
          [r for r in sent if r["text"] == "没排期的一条"][0]["date"] is None)
    check("发出的那份不含空行", all(r["text"].strip() for r in sent))

    print("⑨ 待办按日期分组、逾期组标红")
    pg.reload()
    pg.wait_for_timeout(700)
    heads = pg.eval_on_selector_all(".todo-group-head", "els => els.map(e => e.textContent)")
    check("分组顺序 = 已逾期 / 今天 / 明天 / 后天 / 未排期",
          heads == ["已逾期1", "今天2", cn_label(1) + "1", cn_label(2) + "3", "未排期1"],
          str(heads))
    check("逾期组头带 is-overdue 且是红字",
          pg.eval_on_selector(".todo-group-head.is-overdue",
                              "el => getComputedStyle(el).color") == "rgb(212, 56, 13)",
          pg.eval_on_selector(".todo-group-head.is-overdue", "el => getComputedStyle(el).color"))
    # 20260924 三轮：那个只读的红字 .todo-date 换成了每行自己的排期按钮，
    # 日期从此写在按钮里（值读 input.value，不是 textContent）
    check("逾期组里每条都标了自己是哪天（M/D，写在它自己的排期按钮上）",
          pg.eval_on_selector_all(".todo-group-head.is-overdue ~ .todo-row .todo-due input",
                                  "els => els.map(e => e.value)") ==
          [f"{int(OVERDUE[5:7])}/{int(OVERDUE[8:10])}"])

    print("⑩ 新增一行 / 空行自动回收")
    before = len(row_texts(pg))
    # 按钮上只有字（20260924 二轮：撤掉那个 + 号图标）
    check("「新增一行」按钮上没有图标",
          pg.locator(".todo-add .anticon").count() == 0
          and pg.locator(".todo-add").inner_text().strip() == "新增一行",
          pg.locator(".todo-add").inner_text().strip())
    pg.click(".todo-add")
    pg.wait_for_timeout(300)
    check("点「新增一行」多出一行", len(row_texts(pg)) == before + 1,
          f"{before} → {len(row_texts(pg))}")
    check("新行自动聚焦", pg.evaluate(
        "() => document.activeElement && document.activeElement.closest('.todo-row') !== null"))
    # 空行是前端的临时态。注意：**只多一个空行本身不产生任何出网请求**（它被
    # 过滤掉后与库里那份一致）——所以这里顺手打勾另一条，制造一次真改动，
    # 再看发出去的那份里有没有这个空行。
    pg.locator(".todo-row").first.locator("input[type='checkbox']").click()
    pg.wait_for_timeout(900)
    sent2 = pg.evaluate("() => window.__lastPut")
    check("打勾也会把整份发上去", bool(sent2) and len(sent2) == before,
          f"{len(sent2) if sent2 else 0} 条 / 期望 {before}")
    check("空行不落库（发出的那份里没有空文字）",
          bool(sent2) and all(r["text"].strip() for r in sent2))
    check("打勾这个改动本身在发出的那份里（不是发了份旧的）",
          bool(sent2) and [r for r in sent2 if r["text"] == "逾期的一条"][0]["done"] is True)
    # 焦点已经被那次点击带走 ⇒ 空行在这一刻就已回收
    pg.wait_for_timeout(200)
    check("空行失焦后自动收掉，不留空壳", len(row_texts(pg)) == before,
          f"{len(row_texts(pg))}")

    print("⑪ 删除要二次确认")
    target = row_texts(pg)[0]
    pg.locator(".todo-row").first.locator(".todo-del").click()
    pg.wait_for_timeout(300)
    check("弹出确认框（中文）", "删掉这条待办？" in pg.locator("body").inner_text())
    check("还没点确定时那行还在（删除不是点一下就没）",
          target in row_texts(pg), str(row_texts(pg)))
    # antd 会在两个汉字之间插一个空格（"删 除"），按 :has-text 匹配不上，按类名点
    pg.click(".ant-modal-confirm-btns .ant-btn-primary")
    pg.wait_for_timeout(400)
    check("确定后才真的删掉", target not in row_texts(pg), str(row_texts(pg)))
    pg.wait_for_timeout(900)
    sent3 = pg.evaluate("() => window.__lastPut")
    check("删除也发给了服务端（整份重发，那份里没有它）",
          sent3 is not None and target not in [r["text"] for r in sent3],
          f"{len(sent3) if sent3 else 0} 条")

    print("⑫ 拖拽排序（同组内换位、跨组不动）")
    # 拖拽要**分步、跨帧**发：dragstart 里 setDragId 是 React 状态更新，
    # 四个事件挤在同一个同步任务里时（连续事件优先级不进同步 flush），
    # drop 处理器闭包里读到的 dragId 还是 null，整段拖拽会静默失效——
    # 那是我第一版用例的假失败（组件本身没问题）。步与步之间留一帧。
    def drag_start(src_text):
        pg.evaluate("""(srcText) => {
          const src = [...document.querySelectorAll('.todo-row')]
            .find(r => r.querySelector('.todo-text')?.value === srcText);
          window.__src = src;
          window.__dt = window.__dt || new DataTransfer();
          src.querySelector('.todo-grip').dispatchEvent(
            new DragEvent('dragstart', {bubbles: true, cancelable: true, dataTransfer: window.__dt}));
        }""", src_text)
        pg.wait_for_timeout(150)

    def drag_over(dst_text):
        """返回 dispatchEvent 的结果：preventDefault 被调用过才是 false（=这一格接这一拖）"""
        accepted = pg.evaluate("""(dstText) => {
          const dst = [...document.querySelectorAll('.todo-row')]
            .find(r => r.querySelector('.todo-text')?.value === dstText);
          return dst.dispatchEvent(
            new DragEvent('dragover', {bubbles: true, cancelable: true, dataTransfer: window.__dt}));
        }""", dst_text)
        pg.wait_for_timeout(60)
        return accepted

    def drop_on(dst_text):
        pg.evaluate("""(dstText) => {
          const dst = [...document.querySelectorAll('.todo-row')]
            .find(r => r.querySelector('.todo-text')?.value === dstText);
          dst.dispatchEvent(
            new DragEvent('drop', {bubbles: true, cancelable: true, dataTransfer: window.__dt}));
        }""", dst_text)
        pg.wait_for_timeout(300)

    def drag_end():
        pg.evaluate("""() => window.__src.querySelector('.todo-grip').dispatchEvent(
          new DragEvent('dragend', {bubbles: true, cancelable: true, dataTransfer: window.__dt}))""")
        pg.wait_for_timeout(150)

    order0 = row_texts(pg)
    drag_start("后天一堆事3")
    check("拖起来的那行标了 dragging（看得出在拖谁）",
          pg.locator(".todo-row.dragging").count() == 1)
    same_ok = drag_over("后天一堆事1")
    drop_on("后天一堆事1")
    drag_end()
    order1 = row_texts(pg)
    check("同一组内拖到前面 = 换位",
          order1.index("后天一堆事3") < order1.index("后天一堆事1"),
          f"{order0} → {order1}")
    check("同组的那格接住了这一拖（dragover 里 preventDefault）", same_ok is False)
    check("其余各条的相对顺序没被打乱",
          [t for t in order1 if "后天一堆事" not in t]
          == [t for t in order0 if "后天一堆事" not in t])

    drag_start("后天一堆事3")
    cross_ok = drag_over("今天要做的")
    drop_on("今天要做的")
    drag_end()
    check("跨组拖不生效（拖等于顺带改日期，那是另一个动作）",
          row_texts(pg) == order1, str(row_texts(pg)))
    check("跨组的那格不接（dragover 里不 preventDefault）", cross_ok is True)
    check("拖完不留 dragging 残影", pg.locator(".todo-row.dragging").count() == 0)

    print("⑬ 读失败时不出网（否则空列表会把库里的待办抹掉）")
    # 让下一次 getTodos 失败一次，然后整页重来：这是"库读不到"的真实现场
    pg.evaluate("""() => {
      localStorage.setItem('__failGet', '1');
      localStorage.setItem('__puts', '0');   // 计数清零，专看这一轮有没有写回去
    }""")
    pg.reload()
    pg.wait_for_timeout(900)
    check("如实说读失败，而不是说「还没有待办」（两者不能混为一谈）",
          pg.locator(".todo-loaderr").count() == 1
          and "假装读失败" in pg.locator(".todo-loaderr").inner_text(),
          pg.locator(".todo-loaderr").inner_text().strip()
          if pg.locator(".todo-loaderr").count() else "（没有失败提示）")
    check("数据没到手时一行都不画", row_texts(pg) == [], str(row_texts(pg)))
    check("**没有**把空列表写回库里（这条错了就是静默清空）",
          pg.evaluate("() => Number(localStorage.getItem('__puts') || 0)") == 0)
    pg.click(".todo-loaderr button")     # 重试
    pg.wait_for_timeout(900)
    check("重试后把列表读回来（8 条）", len(row_texts(pg)) == 8, str(len(row_texts(pg))))
    check("读回来那一刻不写回去（本地与库里那份一致时不出网）",
          pg.evaluate("() => Number(localStorage.getItem('__puts') || 0)") == 0)

    print("⑭ 每行一个排期按钮（新建的与已有的都能绑期限）")
    # 上一节的 reload 把接口桩重置回种子那份（8 条），这一节从那里起

    def group_of(name):
        """这条待办此刻落在哪个分组里（分组头的文字，含条数）"""
        return pg.evaluate("""(name) => {
          for (const g of document.querySelectorAll('.todo-group')) {
            const hit = [...g.querySelectorAll('.todo-text')].some(i => i.value === name);
            if (hit) { const h = g.querySelector('.todo-group-head'); return h ? h.textContent : null; }
          }
          return null;
        }""", name)

    def due_index(name):
        return pg.evaluate("""(name) => [...document.querySelectorAll('.todo-row')]
            .findIndex(r => r.querySelector('.todo-text').value === name)""", name)

    def md(iso):
        return f"{int(iso[5:7])}/{int(iso[8:10])}"

    n_rows = pg.locator(".todo-row").count()
    check("每一行都有自己的排期按钮",
          pg.locator(".todo-due").count() == n_rows == 8,
          f"按钮 {pg.locator('.todo-due').count()} / 行 {n_rows}")
    dues = pg.eval_on_selector_all(".todo-row", """els => els.map(r => {
      const w = r.querySelector('.todo-due');
      const i = w ? w.querySelector('input') : null;
      return {text: r.querySelector('.todo-text').value, due: i ? i.value : null,
              overdue: w ? w.className.includes('is-overdue') : false,
              icon: !!r.querySelector('.todo-due-add')};
    })""")
    check("有日期的那几行，按钮上写的就是那个日期（M/D）",
          [d["due"] for d in dues if d["text"] == "今天要做的"] == [md(day(0))]
          and [d["due"] for d in dues if d["text"] == "明天开会记得带电脑和充电器"] == [md(TOMORROW)],
          str([(d["text"], d["due"]) for d in dues if d["due"]]))
    check("没排期那条只露一枚淡淡的日历图标（不是空着让人猜）",
          [d["due"] for d in dues if d["text"] == "没排期的一条"] == [""]
          and [d["icon"] for d in dues if d["text"] == "没排期的一条"] == [True])
    check("已经有日期的那几行不再露日历图标", all(not d["icon"] for d in dues if d["due"]))
    check("逾期行的日期是红字（那一组混了好几天，看组名不知道欠的是哪天）",
          pg.eval_on_selector(".todo-due.is-overdue input", "el => getComputedStyle(el).color")
          == "rgb(212, 56, 13)",
          pg.eval_on_selector(".todo-due.is-overdue input", "el => getComputedStyle(el).color"))

    # 主人原话是"新增的任务并不能绑定期限"——那就按那条路走一遍
    check("（前置）点之前主日历下面没有快添栏", pg.locator(".calQuick").count() == 0)
    pg.click(".todo-add")
    pg.wait_for_timeout(250)
    pg.keyboard.type("新增的一条")
    pg.wait_for_timeout(150)
    pg.locator(".todo-due").nth(due_index("新增的一条")).click()
    pg.wait_for_timeout(400)
    check("点开的是它自己的小月历，没惊动上面那枚主日历（不弹快添栏）",
          pg.locator(".ant-picker-dropdown .ant-picker-panel").count() >= 1
          and pg.locator(".calQuick").count() == 0)
    check("这枚小月历是中文的（年/月，不是 Sep 那种缩写）",
          "年" in pg.locator(".ant-picker-dropdown .ant-picker-header").inner_text(),
          pg.locator(".ant-picker-dropdown .ant-picker-header").inner_text().strip())
    pg.locator(f'.ant-picker-dropdown .ant-picker-cell[title="{TOMORROW}"]').click()
    pg.wait_for_timeout(900)
    check("新增的那条当场排上了明天（这是原来做不到的那件事）",
          (group_of("新增的一条") or "").startswith(cn_label(1)),
          str(group_of("新增的一条")))
    sent4 = pg.evaluate("() => window.__lastPut")
    check("这个期限也发给了服务端",
          bool(sent4) and [r for r in sent4 if r["text"] == "新增的一条"][0]["date"] == TOMORROW)

    # 再撤掉它：悬停那一行的排期按钮，点冒出来的清除叉
    pg.locator(".todo-due").nth(due_index("新增的一条")).hover()
    pg.wait_for_timeout(200)
    pg.locator(".todo-due").nth(due_index("新增的一条")).locator(".ant-picker-clear").click()
    pg.wait_for_timeout(900)
    check("撤掉日期后回到「未排期」组", group_of("新增的一条") == "未排期2",
          str(group_of("新增的一条")))
    sent5 = pg.evaluate("() => window.__lastPut")
    check("撤掉也发给了服务端（date 收回 null，不是留个空串）",
          bool(sent5) and [r for r in sent5 if r["text"] == "新增的一条"][0]["date"] is None,
          str([r for r in sent5 if r["text"] == "新增的一条"]))

    print("⑮ 待审评论：顶上提示一行、点得进去、审完自己消失")
    # 桩里 3 条 approved=0（= 等人工裁决的那一档）
    pg.evaluate("""() => {
      localStorage.setItem('__pending', '3');
      localStorage.setItem('__puts', '0');
      delete window.__nav;
    }""")
    pg.reload()
    pg.wait_for_timeout(900)
    # inner_text 在 flex 容器的子项之间会插换行（"3\n条评论待人工审核"），抹平了再看
    def review_text():
        return "".join(pg.locator(".todo-review").inner_text().split()) \
            if pg.locator(".todo-review").count() else ""

    check("挂着待审评论时，列表顶上多一行提示",
          review_text() == "3条评论待人工审核", review_text() or "（没有这一行）")
    check("它排在全部待办分组**之前**",
          pg.evaluate("""() => {
            const r = document.querySelector('.todo-review');
            const g = document.querySelector('.todo-group');
            return !!r && !!g && r.getBoundingClientRect().top < g.getBoundingClientRect().top;
          }"""))
    check("它**不是**一条待办（不能拖、不能删、不进那份 8 条里）",
          pg.locator(".todo-review .todo-text, .todo-review .todo-del, .todo-review .todo-grip")
            .count() == 0
          and len(row_texts(pg)) == 8, str(row_texts(pg)))
    # 它也不该混进发往服务端的那份（那是待办表，服务端不认这种行）
    pg.locator(".todo-row").first.locator("input[type='checkbox']").click()
    pg.wait_for_timeout(900)
    sent6 = pg.evaluate("() => window.__lastPut")
    check("它不会被写进待办（那份还是 8 条、字段还是 text/done/date）",
          bool(sent6) and len(sent6) == 8
          and all(sorted(r.keys()) == ["date", "done", "text"] for r in sent6),
          str(len(sent6) if sent6 else 0) + " 条")
    pg.click(".todo-review")
    pg.wait_for_timeout(200)
    check("点它就跳到评论管理那一页（落到评论管理 Tab 上）",
          (pg.evaluate("() => (window.__nav || []).slice(-1)[0]") or {}).get("to")
          == "/dashboard/users?tab=review",
          str(pg.evaluate("() => (window.__nav || []).slice(-1)[0]")))
    check("60 秒轮询接上了（切回标签页另有一条立即刷的通道）",
          60000 in (pg.evaluate("() => window.__intervals") or []),
          str(pg.evaluate("() => window.__intervals")))

    # 读失败保持上一次的数：一个提示不该因为一次网络抖动就自己消失
    pg.evaluate("""() => {
      localStorage.setItem('__failBoard', '1');
      document.dispatchEvent(new Event('visibilitychange'));
    }""")
    pg.wait_for_timeout(400)
    check("这一下读失败时，那行还在（不把「读不到」演成「审完了」）",
          pg.locator(".todo-review").count() == 1
          and "3" in pg.locator(".todo-review").inner_text(),
          pg.locator(".todo-review").inner_text().strip()
          if pg.locator(".todo-review").count() else "（没了）")

    # 主人去评论管理把三条审完 → 切回来这一下就该自己消失
    pg.evaluate("""() => {
      localStorage.setItem('__pending', '0');
      document.dispatchEvent(new Event('visibilitychange'));
    }""")
    pg.wait_for_timeout(500)
    check("审完之后切回来，这一行自己就没了（不用手动关）",
          pg.locator(".todo-review").count() == 0)
    check("待办本身一条没少", len(row_texts(pg)) == 8, str(len(row_texts(pg))))

    br.close()

print()
if FAILS:
    print(f"❌ {len(FAILS)} 条未通过：" + "；".join(FAILS))
    raise SystemExit(1)
print("全部通过")
