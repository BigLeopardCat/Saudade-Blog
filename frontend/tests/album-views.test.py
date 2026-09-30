# -*- coding: utf-8 -*-
"""后台「图库」页的两种展示方式（20261001，用户第 2 条）无头验收。

用户原话：「后台图库提供两种展示方式，一种当前的直接展开，另一种以列表的方式展开，
头部是略缩图后面跟着图片名。」

判据只有"真跑一遍"才看得见，所以本文件锁四组事：

  · **两种方式真的互斥**（第一节）—— 切到列表时网格那批图必须**整个不在 DOM 里**。
    只断言"列表出来了"会被"两套叠着渲染"蒙过（真叠着时页面看着也对，只是白渲染一遍）。
  · **行 = 缩略图 + 图片名**（第二节）—— 缩略图 56×56、名字是**盘上名的展示名**
    （剥掉上传时压的 14 位时间戳前缀，规则与 Rust `strip_timestamp_prefix` 同形，
    由 `asset-name.test.mjs` 在纯函数层钉死；这里钉的是"列表真的用了它"）。这一节的
    两个几何断言是**反的**：缩略图**不许被挤小**（`flex: 0 0 auto`），名字那一格才是
    被截断的那个（超长名必须 `scrollWidth > clientWidth`）——只断言其中一个，
    "两个都让一让"的实现也能过。
  · **勾选与计数**（第三、四节）—— 行点击与勾选框点击都要能翻，且各只翻**一次**。
    第四节是**真负控**：另打一份把 `e.stopPropagation()` 抹掉的包，在同一个沙箱里跑
    同一次点击 —— 它必须复现"点了没反应"（勾选框的 change 与冒泡到行的 click 各翻一次，
    净效果归零）。没有这条负控，"点了勾上了"这个断言证明不了 `stopPropagation` 在起作用。
  · **展示方式记在本地**（第五节）—— 刷新后还是列表（`localStorage.albumViewMode`）。
  · **列表方式不打乱页面上原有的那条写路径**（第六节）—— 选中后走原样的删除弹窗，
    `DELETE /api/protect/delImg` 的 body 是被选中那张图的 URL。

见 CLAUDE.md §2：本机不能 vite build。esbuild 把**真组件**打成 bundle，只桩一个边界
（`src/apis/axios.tsx`）；页面 sass 用 programmatic API 单独编译后注入（顺带过一遍编译，
本机唯一拦得下构建级缺陷的环节）。两个必踩的坑：① `src/apis/ImageMethods.tsx` 调的是
`http({...})`（默认导出**当函数用**），所以桩必须是"可调用对象"，只给 `.get/.post`
会 TypeError 并被组件里那个 `.catch` 静静吃掉（症状 = 列表永远是空的）；
② 假响应一律深拷贝。本机无中文字体（汉字渲染成豆腐块），断言全走数值、条数与请求体。

用法：python3 frontend/tests/album-views.test.py
依赖：frontend/node_modules（esbuild/react/react-dom/antd/sass）、playwright(python)。
"""
import functools
import http.server
import pathlib
import re
import shutil
import subprocess
import sys
import tempfile
import threading

ROOT = pathlib.Path(__file__).resolve().parents[2]
FE = ROOT / "frontend"

FAILS = []


def check(desc, cond, detail=""):
    print(("  ✅ " if cond else "  ❌ ") + desc + (f"  [{detail}]" if detail else ""))
    if not cond:
        FAILS.append(desc)


DEFINE = ('import.meta.env={"VITE_HTTP_BASEURL":"","VITE_CDN_BASEURL":"",'
          '"MODE":"production","DEV":false,"PROD":true,"BASE_URL":"/"}')

# ── 夹具（Python 侧是期望值，JS 侧 ENTRY 里按同一份造数据；超长名那份由 Python 注入，
#    保证两侧逐字相同）────────────────────────────────────────────────────────
# 超长名**刻意用 ASCII**：本机无中文字体（`fc-list :lang=zh` 为空），汉字在沙箱里渲染成
# 窄窄的缺字框——实测 124 个汉字只占 1039px，**比那一格还窄**。拿它量"溢出"等于在量字体、
# 不是在量布局。ASCII 有真实字宽：316 字符 ≈ 2200px，一定超出那一格（1440 视口下约 1255px）。
LONG_TAIL = "very_long_screenshot_name_" * 12   # 312 字符 + ".png"
# (盘上的名字, 给人看的名字)
NAMED = [
    ("20260912013218_EMQX.png", "EMQX.png"),
    ("20200405101112_封面-夏日特别版.png", "封面-夏日特别版.png"),
    ("old_pic.png", "old_pic.png"),                       # 不是那个形状 ⇒ 原样显示
    ("20260930120000_笔记.png", "笔记.png"),
    ("20251231235959_末班车.png", "末班车.png"),
]
LONG_URL = "/api/protect/download/20261001000000_" + LONG_TAIL + ".png"
ALL_URLS = ["/api/protect/download/" + n for n, _ in NAMED] + [LONG_URL]
N = len(ALL_URLS)                                          # 6 张


def nz(s):
    """抹空白再比：antd 会在两个汉字之间插空格，不抹的话判的是 antd 的排版。"""
    return re.sub(r"\s+", "", s or "")


FAKE_AXIOS = r"""
const calls: any[] = (window as any).__calls = [];
(window as any).__axiosStub = true;

const env = (data: any) => ({ status: 200, data: { code: 200, message: 'ok', data } });
// ⚠️ 每次都必须回**深拷贝**：真 HTTP 每次都反序列化出一个新对象，而这里面的数组是同一个
// 引用 ⇒ `setStaticDate(同一个引用)` 会被 React 的 Object.is 判等拦下、**不触发重渲染**，
// 症状是"请求成功了但界面纹丝不动"。
const wire = (d: any) => (d == null ? d : JSON.parse(JSON.stringify(d)));
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

const req = async (cfg: any) => {
  const url = cfg.url as string;
  const method = (cfg.method || 'GET').toUpperCase();
  calls.push({ url, method, data: wire(cfg.data) });
  await delay(20);
  if (url === '/api/protect/images') return env(wire((window as any).__images));
  if (url === '/api/protect/delImg') return env('Deleted');
  return env(null);
};

// ⚠️ 必须是**可调用对象**：`src/apis/ImageMethods.tsx` 写的是 `http({ url, method })`
// （默认导出当函数用），而别的页面写 `http.get(...)`。只做其中一种，另一种就是
// `undefined is not a function`，且组件里那句 `.catch((error) => { throw error })`
// 之后没有任何提示 ⇒ 页面白屏或空列表，看日志也只有一条 Promise 报错。
const http: any = (cfg: any) => req(cfg);
http.get = (url: string, cfg?: any) => req({ ...(cfg || {}), url, method: 'GET' });
http.post = (url: string, data?: any, cfg?: any) => req({ ...(cfg || {}), url, data, method: 'POST' });
http.put = (url: string, data?: any, cfg?: any) => req({ ...(cfg || {}), url, data, method: 'PUT' });
http.delete = (url: string, cfg?: any) => req({ ...(cfg || {}), url, method: 'DELETE' });
export default http;
"""

ENTRY = """\
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import Albums from './src/pages/Dashboard/Albums/index.tsx';

// 夹具与 Python 侧同名同序（超长名那一条由 Python 注入 __LONGTAIL__）。
const NAMED: [string, string][] = [
  ['20260912013218_EMQX.png', 'EMQX.png'],
  ['20200405101112_封面-夏日特别版.png', '封面-夏日特别版.png'],
  ['old_pic.png', 'old_pic.png'],
  ['20260930120000_笔记.png', '笔记.png'],
  ['20251231235959_末班车.png', '末班车.png'],
];
const LONG = '20261001000000___LONGTAIL__.png';
const LIST = [
  ...NAMED.map(([f]) => f),
  LONG,
].map((f, i) => ({ imageKey: 900 + i, imageUrl: '/api/protect/download/' + f }));
(window as any).__images = LIST;
(window as any).__mount = () => createRoot(document.getElementById('root')!).render(<Albums />);
"""


def esbuild(sb: pathlib.Path, entry: str, outfile: str):
    r = subprocess.run([str(FE / "node_modules/.bin/esbuild"), entry,
                        "--bundle", "--format=iife", "--outfile=" + outfile,
                        "--loader:.sass=text", "--jsx=automatic",
                        # 上传按钮里有一张 `assets/uploadImg.png`（Vite 会把它变成 URL）：
                        # 不配 loader 时 esbuild 直接报错退出——这是**打包期**的失败，
                        # 比渲染期的失败好定位得多，所以这里只补 loader、不绕过这个组件。
                        "--loader:.png=dataurl", "--loader:.svg=dataurl",
                        f"--define:{DEFINE}"],
                       cwd=str(sb), capture_output=True)
    if r.returncode != 0:
        raise SystemExit("esbuild 打包失败：\n%s" % r.stderr.decode("utf-8", "replace"))


def write_html(sb: pathlib.Path, bundle: str, css: str):
    (sb / "index.html").write_text(
        '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">'
        '<style>html,body,#root{height:100%;margin:0}'
        # 真站在 frontend/src/frontHome/main.css 里有全局 `*{box-sizing:border-box}`，
        # 后台页面同样吃它；不照搬的话几何断言会在沙箱里失真。
        '*{box-sizing:border-box;margin:0;padding:0}</style>'
        '<style>' + css + '</style></head><body><div id="root"></div>'
        '<script src="' + bundle + '"></script></body></html>', encoding="utf-8")


def build_sandbox() -> pathlib.Path:
    sb = pathlib.Path(tempfile.mkdtemp(prefix="album-views-"))
    shutil.copytree(FE / "src", sb / "src")
    (sb / "node_modules").symlink_to(FE / "node_modules")

    (sb / "src/apis/axios.tsx").write_text(FAKE_AXIOS, encoding="utf-8")
    (sb / "entry.tsx").write_text(ENTRY.replace("__LONGTAIL__", LONG_TAIL), encoding="utf-8")

    # 页面自己的 sass：单独编译（`--loader:.sass=text` 只是把样式吞成一个字符串，不进页面）
    css_out = sb / "page.css"
    subprocess.run(["node", "-e",
                    "const s=require('sass');const r=s.compile(process.argv[1],{style:'expanded'});"
                    "require('fs').writeFileSync(process.argv[2],r.css);",
                    str(FE / "src/pages/Dashboard/Albums/index.sass"), str(css_out)],
                   cwd=str(FE), check=True)
    # 组件级的 .css（CheckButton 的 `.Check_container{font-size:1.5rem}` 等）由 esbuild
    # 从 JS 里抽到 bundle.css —— 那份必须一起进页面，否则"勾选框在行内被调小"这件事
    # 根本没有可比对的基线。
    esbuild(sb, "entry.tsx", "bundle.js")
    if not (sb / "bundle.css").exists():
        raise SystemExit("esbuild 没产出 bundle.css：.css 的导入链断了（勾选框样式将无从比对）")
    write_html(sb, "bundle.js", css_out.read_text() + "\n" + (sb / "bundle.css").read_text())

    # ── 负控（第四节）：另打一份**把 `e.stopPropagation()` 抹掉**的包 ────────────────
    bad = sb / "bad"
    shutil.copytree(sb / "src", bad / "src")
    (bad / "node_modules").symlink_to(FE / "node_modules")
    (bad / "entry.tsx").write_text((sb / "entry.tsx").read_text(), encoding="utf-8")
    tsx = bad / "src/pages/Dashboard/Albums/index.tsx"
    src = tsx.read_text(encoding="utf-8")
    n = src.count("onClick={(e) => e.stopPropagation()}")
    if n != 1:
        raise SystemExit(f"负控锚点失配：`onClick={{(e) => e.stopPropagation()}}` 命中 {n} 处"
                         "（应为 1）——组件里的写法变了，本节的负控要先跟着改，"
                         "否则它证明不了任何事")
    tsx.write_text(src.replace("(e) => e.stopPropagation()", "() => {}"), encoding="utf-8")
    esbuild(bad, "entry.tsx", "bundle.js")
    write_html(bad, "bundle.js", css_out.read_text() + "\n" + (sb / "bundle.css").read_text())
    return sb


SANDBOX = build_sandbox()


class _Quiet(http.server.SimpleHTTPRequestHandler):
    """静音：访问日志会落进 ~/sandbox_regression.log（那是给人看断言的地方）。
    必须子类覆写——`partial` 的实例属性不影响它转发的那个类。"""

    def log_message(self, *a, **k):
        return None


_handler = functools.partial(_Quiet, directory=str(SANDBOX))
_server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _handler)
threading.Thread(target=_server.serve_forever, daemon=True).start()

from playwright.sync_api import sync_playwright  # noqa: E402

BASE = f"http://127.0.0.1:{_server.server_address[1]}/"
URL = BASE + "index.html"
BAD_URL = BASE + "bad/index.html"


def mount(br, url=URL, view=None, size=(1440, 900)):
    """挂载图库页。`view` 预置 localStorage 里的展示方式（None = 一次都没选过）。"""
    page = br.new_page(viewport={"width": size[0], "height": size[1]})
    errs = []
    page.on("pageerror", lambda e: errs.append(str(e)))
    if view:
        page.goto(BASE + "index.html")          # 先落一个同源页面，才能写 localStorage
        page.evaluate("(v) => localStorage.setItem('albumViewMode', v)", view)
    page.goto(url)
    page.evaluate("() => window.__mount()")
    try:
        page.wait_for_selector(".imgShade, .albumRow", timeout=10000)
    except Exception:
        # 等不到就别只说"超时"：把关键节点、请求记录与页面异常一起打出来。
        print("  ⚠ 等不到图片节点，现场：")
        print("    " + page.evaluate("""() => JSON.stringify({
            root: document.getElementById('root').children.length,
            grid: document.querySelectorAll('.imgShade').length,
            rows: document.querySelectorAll('.albumRow').length,
            axiosStub: window.__axiosStub === true,
            calls: (window.__calls || []).map((c) => c.method + ' ' + c.url),
        })"""))
        print("    页面异常：" + ("; ".join(errs[:3]) or "（无）"))
        raise
    page.wait_for_timeout(600)
    page.errs = errs
    return page


GEO = """() => {
    const nz = (s) => String(s == null ? '' : s).replace(/\\s+/g, '');
    const R = (el) => {
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { l: Math.round(r.left), t: Math.round(r.top), w: Math.round(r.width),
                 h: Math.round(r.height), rt: Math.round(r.right), b: Math.round(r.bottom) };
    };
    const rows = [...document.querySelectorAll('.albumRow')];
    const sel = document.querySelector('.albumSelCount');
    const seg = document.querySelector('.ant-segmented');
    const del = document.querySelector('.albumActions .noselect');
    return {
        rows: rows.length,
        gridImgs: document.querySelectorAll('.imgShade').length,
        listWrap: !!document.querySelector('.albumList'),
        thumb: R(document.querySelector('.albumThumb')),
        selCount: nz(sel && sel.textContent),
        selRect: R(sel),
        selOpacity: sel ? getComputedStyle(sel).opacity : null,
        selPosition: sel ? getComputedStyle(sel).position : null,
        segRect: R(seg),
        delRect: R(del),
        rowInfo: rows.map((r) => {
            const nm = r.querySelector('.albumName');
            const th = r.querySelector('.albumThumb');
            return {
                name: nm ? nm.textContent : null,
                alt: th ? th.getAttribute('alt') : null,
                thumb: R(th),
                nameRect: R(nm),
                // > 0 = 这个名字真的被截断了（在被压的那一格上）
                nameOverflow: nm ? nm.scrollWidth - nm.clientWidth : null,
                checked: r.classList.contains('is-checked'),
                box: !!r.querySelector('input:checked'),
                mark: R(r.querySelector('.checkmark')),
            };
        }),
    };
}"""


def geo(pg):
    return pg.evaluate(GEO)


def write_calls(pg):
    """本页发出的**写请求**（非 GET）。"禁用/空选时一个请求都不发"这类断言用它。"""
    return pg.evaluate("""() => window.__calls.filter((c) => c.method !== 'GET')
        .map((c) => ({ url: c.url, method: c.method, body: c.data }))""")


def to_list(pg):
    """切到「列表」那一档（Segmented 的第 2 个选项）。"""
    pg.locator(".ant-segmented-item").nth(1).click()
    pg.wait_for_timeout(400)


def to_grid(pg):
    pg.locator(".ant-segmented-item").nth(0).click()
    pg.wait_for_timeout(400)


# ⚠️ 「已选中 N 张」那格挂着 `transition: 0.3s`（切透明/切回）——写完立刻量到的还是
# **动画中间档**（实测点了之后 250ms 量到 0.98）。量透明度必须等过这个时长。
WAIT_ANIM = 500


def click_row(pg, idx):
    """点行的**名字那一格**（不是勾选框）：走的是行的 onClick。"""
    pg.locator(".albumRow").nth(idx).locator(".albumName").click()
    pg.wait_for_timeout(WAIT_ANIM)


def click_box(pg, idx):
    """点行内的勾选框本体（label 中心 = 那个圆点）。"""
    pg.locator(".albumRow").nth(idx).locator(".Check_container").click()
    pg.wait_for_timeout(WAIT_ANIM)


with sync_playwright() as p:
    br = p.chromium.launch()

    # ── 一、默认是「平铺」，两种方式互斥 ──────────────────────────────────────
    print("\n【一】默认平铺：网格在、列表不在（两种方式是互斥的，不是叠着渲染）")
    pg = mount(br)
    g = geo(pg)
    check(f"默认档渲染出 {N} 张图（假后端那一份）", g["gridImgs"] == N, str(g["gridImgs"]))
    check("默认档列表容器不存在（`.albumList` 没进 DOM）",
          g["listWrap"] is False and g["rows"] == 0, f'wrap={g["listWrap"]} rows={g["rows"]}')

    to_list(pg)
    g = geo(pg)
    check(f"切到列表后是 {N} 行", g["rows"] == N, str(g["rows"]))
    check("  且网格那批图**整个不在 DOM 里**（不是叠在下面/漏了卸载）",
          g["gridImgs"] == 0, str(g["gridImgs"]))

    to_grid(pg)
    g = geo(pg)
    check("  切回平铺：网格回来、列表整个撤掉（双向都要验，否则只证明了单向不变量）",
          g["gridImgs"] == N and g["listWrap"] is False and g["rows"] == 0,
          f'grid={g["gridImgs"]} rows={g["rows"]}')
    check("第一节无页面异常", not pg.errs, "; ".join(pg.errs[:3]))
    pg.close()

    # ── 二、行 = 缩略图 + 图片名 ─────────────────────────────────────────────
    print("\n【二】行内容：56×56 缩略图 + 剥掉时间戳前缀的图片名")
    pg = mount(br, view="list")
    g = geo(pg)
    names = [r["name"] for r in g["rowInfo"]]
    expect = [v for _, v in NAMED] + [LONG_TAIL + ".png"]
    check("列表里每一行的名字就是假后端那一份的展示名（剥前缀 / 原样两种都在）",
          names == expect, str(names[:3]) + " …")
    check("  `20260912013218_EMQX.png` 显示成 `EMQX.png`", names[0] == "EMQX.png", names[0])
    check("  不是那个形状的（`old_pic.png`）原样显示", names[2] == "old_pic.png", names[2])
    check("缩略图的 alt 也是同一个展示名（读屏与图裂时看到的是名字，不是盘上那串）",
          [r["alt"] for r in g["rowInfo"]] == expect, str([r["alt"] for r in g["rowInfo"]][:2]))

    thumbs = g["rowInfo"]
    check("每一行的缩略图都是 56×56（含超长名那一行）",
          all(r["thumb"] and r["thumb"]["w"] == 56 and r["thumb"]["h"] == 56 for r in thumbs),
          str([(r["thumb"] or {}).get("w") for r in thumbs]))
    check("  缩略图**没有被名字挤小**（`flex: 0 0 auto`：最坏的那一行也一样宽）",
          thumbs[-1]["thumb"]["w"] == 56, str(thumbs[-1]["thumb"]))
    check("被压的是名字那一格：超长名真的溢出了（`scrollWidth > clientWidth`）",
          thumbs[-1]["nameOverflow"] > 0, str(thumbs[-1]["nameOverflow"]))
    check("  反过来，短名那几行**没有**溢出（证明上一条不是「这一格永远溢出」）",
          all(r["nameOverflow"] <= 0 for r in g["rowInfo"][:N - 1]),
          str([r["nameOverflow"] for r in g["rowInfo"]]))
    check("行内勾选框比默认那档小（`.Check_container` 自带 1.5rem ⇒ 行内 1.1rem 要写在它自己那层）",
          g["rowInfo"][0]["mark"] and 20 <= g["rowInfo"][0]["mark"]["h"] <= 25,
          str(g["rowInfo"][0]["mark"]))
    check("第二节无页面异常", not pg.errs, "; ".join(pg.errs[:3]))
    pg.close()

    # ── 三、行点击 ⇒ 勾选 + 计数；「已选中」那格只变淡、不消失 ──────────────────
    print("\n【三】行点击：勾选 + 计数；「已选中 N 张」在位不可见（不占位消失、不绝对定位）")
    pg = mount(br, view="list")
    g = geo(pg)
    check("前置：未选中时计数是 0 且那格是**透明的**", g["selCount"] == "已选中0张图片"
          and g["selOpacity"] == "0", f'{g["selCount"]} opacity={g["selOpacity"]}')
    check("  但那格照旧**占着位置**（宽度 > 50px）——透明不等于被摘掉",
          g["selRect"] and g["selRect"]["w"] > 50, str(g["selRect"]))
    check("  且它是**流内**元素（`position: static`），不是绝对定位",
          g["selPosition"] == "static", str(g["selPosition"]))
    check("  切换器与删除钮都在计数右边（一行三件，次序对）",
          g["selRect"] and g["segRect"] and g["delRect"]
          and g["selRect"]["rt"] <= g["segRect"]["l"] and g["segRect"]["rt"] <= g["delRect"]["l"],
          f'{g["selRect"]} {g["segRect"]} {g["delRect"]}')

    click_row(pg, 0)
    g = geo(pg)
    check("点第 1 行的名字 ⇒ 那一行被勾上（行高亮 + 勾选框真选中）",
          g["rowInfo"][0]["checked"] and g["rowInfo"][0]["box"], str(g["rowInfo"][0]))
    check("  计数变成「已选中1张图片」", g["selCount"] == "已选中1张图片", g["selCount"])
    check("  那格同时变可见（opacity 1）", g["selOpacity"] == "1", str(g["selOpacity"]))
    check("  只有这一行被勾上", sum(1 for r in g["rowInfo"] if r["checked"]) == 1,
          str([r["checked"] for r in g["rowInfo"]]))

    click_row(pg, 0)
    g = geo(pg)
    check("再点同一行 ⇒ 取消勾选、计数归 0（是开关，不是单向置位）",
          (not g["rowInfo"][0]["checked"]) and g["selCount"] == "已选中0张图片",
          f'{g["rowInfo"][0]["checked"]} {g["selCount"]}')
    check("第三节无页面异常", not pg.errs, "; ".join(pg.errs[:3]))
    pg.close()

    # ── 四、勾选框自己点：只翻一次（含真负控）──────────────────────────────────
    print("\n【四】点勾选框本体只翻一次（负控：抹掉 stopPropagation 的那份包必须复现「点了没反应」）")
    pg = mount(br, view="list")
    click_box(pg, 1)
    g = geo(pg)
    check("点第 2 行的勾选框 ⇒ 勾上，且计数是 **1**（不是 2——两处回调各翻一次会变成 2）",
          g["rowInfo"][1]["checked"] and g["selCount"] == "已选中1张图片",
          f'{g["rowInfo"][1]["checked"]} {g["selCount"]}')
    check("  别的行没被带上", sum(1 for r in g["rowInfo"] if r["checked"]) == 1,
          str([r["checked"] for r in g["rowInfo"]]))
    click_box(pg, 1)
    g = geo(pg)
    check("再点一次 ⇒ 取消，计数归 0", (not g["rowInfo"][1]["checked"])
          and g["selCount"] == "已选中0张图片", f'{g["rowInfo"][1]["checked"]} {g["selCount"]}')
    check("第四节（正档）无页面异常", not pg.errs, "; ".join(pg.errs[:3]))
    pg.close()

    # 负控：同一份代码、只把 `e.stopPropagation()` 换成空函数 —— 必须复现缺陷
    pg = mount(br, url=BAD_URL, view="list")
    g0 = geo(pg)
    check("负控前置：坏档也是 6 行、默认都没勾",
          g0["rows"] == N and sum(1 for r in g0["rowInfo"] if r["checked"]) == 0,
          str(g0["rows"]))
    click_box(pg, 0)
    gb = geo(pg)
    check("负控：抹掉 `stopPropagation` 后**同一次点击不再生效**（行没勾上）",
          gb["rowInfo"][0]["checked"] is False,
          f'checked={gb["rowInfo"][0]["checked"]} count={gb["selCount"]}')
    check("  （计数同步失真：{} ⇒ 正档断言确实在钉这一处）".format(gb["selCount"]),
          gb["selCount"] != "已选中1张图片", gb["selCount"])
    pg.close()

    # ── 五、展示方式记在本地，刷新后还在 ──────────────────────────────────────
    print("\n【五】切一次就记住：刷新后仍是列表；再切回平铺，刷新后也记住")
    pg = mount(br)
    check("前置：一次都没选过时是平铺", geo(pg)["listWrap"] is False)
    to_list(pg)
    pg.goto(URL)
    pg.evaluate("() => window.__mount()")
    pg.wait_for_selector(".albumRow", timeout=10000)
    pg.wait_for_timeout(500)
    g = geo(pg)
    check("切到列表后刷新 ⇒ 仍是列表（localStorage `albumViewMode`）",
          g["rows"] == N and g["gridImgs"] == 0, f'rows={g["rows"]} grid={g["gridImgs"]}')
    to_grid(pg)
    pg.goto(URL)
    pg.evaluate("() => window.__mount()")
    pg.wait_for_selector(".imgShade", timeout=10000)
    pg.wait_for_timeout(500)
    g = geo(pg)
    check("再切回平铺后刷新 ⇒ 也记住（不是只有 list 那一档被写进本地）",
          g["gridImgs"] == N and g["rows"] == 0, f'rows={g["rows"]} grid={g["gridImgs"]}')
    pg.close()

    # ── 六、列表方式不打乱原有的删除路径 ─────────────────────────────────────
    print("\n【六】选中后走原样的删除弹窗：body = 被选中那张图的 URL")
    pg = mount(br, view="list")
    # ① 未选中就点删除：一个写请求都不许发
    pg.locator(".albumActions .noselect").click()
    pg.wait_for_timeout(400)
    check("未选中时点删除 ⇒ 零写请求（弹窗都不该出现）", write_calls(pg) == [], str(write_calls(pg)))
    # ② 选中第 3 行再删
    click_row(pg, 2)
    pg.locator(".albumActions .noselect").click()
    pg.wait_for_timeout(400)
    check("选中一张再点删除 ⇒ 弹窗出现、还没发请求",
          pg.locator(".ant-modal-wrap:visible").count() >= 1 and write_calls(pg) == [],
          str(write_calls(pg)))
    pg.locator(".ant-modal-wrap:visible .ant-modal-footer .ant-btn-primary").click()
    pg.wait_for_timeout(600)
    w = write_calls(pg)
    check("确定 ⇒ 恰好一条 DELETE /api/protect/delImg",
          len(w) == 1 and w[0]["method"] == "DELETE" and w[0]["url"] == "/api/protect/delImg",
          str(w))
    check("  body 就是被选中那张图的 URL（列表方式的勾选接回了同一条路径）",
          w and w[0]["body"] == [ALL_URLS[2]], str(w[0]["body"] if w else None))
    g = geo(pg)
    check("  删完勾选清空、计数归 0（留着勾选会让人以为「点了没生效」）",
          g["selCount"] == "已选中0张图片"
          and sum(1 for r in g["rowInfo"] if r["checked"]) == 0, g["selCount"])
    check("第六节无页面异常", not pg.errs, "; ".join(pg.errs[:3]))
    pg.close()

    br.close()

print()
if FAILS:
    print(f"❌ {len(FAILS)} 项未通过：")
    for f in FAILS:
        print("   - " + f)
    sys.exit(1)
print("✅ 图库两种展示方式（20261001，用户第 2 条）：全部通过")
