# -*- coding: utf-8 -*-
"""编辑器那颗图片按钮：改成「图库优先，也能电脑本地上传」的无头验收（20261006，用户要求）。

用户原话：「编辑文章时，编辑栏顶部图片那个按钮改为优先展示服务器上的图库，也可以电脑本地上传。」

那颗按钮是 bytemd 的**内置 action**（左组第 6 颗，`leftActions[5]`），点下去直接弹系统文件
选择框；bytemd 没有任何口子能换掉它（插件 action 只能追加到末尾；不传 `uploadImages` 会连
拖拽/粘贴上传一起关掉 —— 这三条前提由 `editor-image-button.test.mjs` 读源码钉住）。所以做法
是：按钮原样留着，`src/components/Editor/index.tsx` 在**捕获阶段**拦下它的 click，改开我们
自己的图库弹窗。

"拦住了"这件事**只有真跑一遍才看得见** —— 静态读源码只能证明 `stopPropagation` 写在那个
位置上，证明不了它真把 svelte 那个冒泡 handler 拦下了。本文件锁的就是它：

  · 第一节：点那颗按钮**不许再弹系统文件框**。真负控 = 另打一份把 `e.stopPropagation()`
    抹掉的包，同一次点击**必须**触发 `filechooser`。少了这条负控，"没有 filechooser"可能
    只是因为沙箱里压根点不着那颗按钮（假绿）。
  · 第二节：弹窗优先是图库（默认页签「图库」、网格条数 = 桩数据条数、卡下面是展示名）。
    缩略图 src 必须是 **CDN 化后**的地址（本沙箱把 `VITE_CDN_BASEURL` 设成
    `https://cdn.example.com`；真站现在是空的 —— 空的时候这条重写规则等于不存在，断言会
    退化成"跟原始串一样"，所以这里必须非空）。
  · 第三节：选中一张 ⇒ 写进正文的是**库里那个原始串**（`/api/protect/download/…`，不是 CDN
    化后的），形态与 bytemd 自己插图逐字节一样（空文档 ⇒ `"\\n![](url)"`），光标落回那一行。
    ⚠️ 用原生串是有后果的：写进正文的是 CDN 化地址的话，换公开域名之后
    `src/routes/upload.rs` 的删除判据就再也认不出这张图属于哪个桶了。
  · 第四节：本地上传那条路还在（点选 ⇒ 同一个上传函数 ⇒ 同样插进正文），且**上传被拒时
    正文一个字符都不变**。这一节的负控 = 另打一份把判据还原成修前那句
    `response.status !== 200` 的包（本仓失败是 HTTP 200 + code:500 ⇒ 那句恒真），它**必须**
    把 `![]()` 插进正文。
  · 第五节：图库为空 / 读不到时给的是人话，且「本地上传」仍然可用（不能把人卡死）。

见 CLAUDE.md §2：本机不能 vite build。esbuild 把**真组件**打成 bundle、只桩一个边界
（`src/apis/axios.tsx`）。三个必踩的坑：① 桩必须是**可调用对象**（`ImageMethods` 调的是
`http({...})`，别的模块调 `http.get(...)`）；② 假响应一律深拷贝（同一个数组引用会被 React
的 Object.is 判等拦下 ⇒ 界面纹丝不动）；③ 样式用 `--loader:.css=text` 吞成字符串、再由沙箱
**手工注入** `bytemd/dist/index.css` 与组件的 `index.css` —— 绕开 `katex/dist/katex.css` 里
那些 `url(fonts/*.woff2)`（不绕就得给 esbuild 补字体 loader）。本机无中文字体（汉字渲染成
豆腐块），断言全走数值、条数、class 与文档内容。

用法：python3 frontend/tests/editor-image-picker.test.py
依赖：frontend/node_modules（esbuild/react/react-dom/antd/bytemd/sass）、playwright(python)。
"""
import functools
import http.server
import pathlib
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


CDN = "https://cdn.example.com"
DEFINE = ('import.meta.env={"VITE_HTTP_BASEURL":"","VITE_CDN_BASEURL":"%s",'
          '"MODE":"production","DEV":false,"PROD":true,"BASE_URL":"/"}' % CDN)

# ── 夹具：三条覆盖三种形态（本地盘路径 / R2 绝对地址 / 不带时间戳前缀的旧名）────────────
# (imageKey, 盘上的 url, 给人看的展示名)。Python 侧与 JS 侧（ENTRY 里）同名同序同值。
FIX = [
    (901, "/api/protect/download/20260912013218_EMQX.png", "EMQX.png"),
    (902, "https://img.example.com/gallery/20261006000000_sunset.png", "20261006000000_sunset.png"),
    (903, "/api/protect/download/old_pic.png", "old_pic.png"),
]
PICK = FIX[0][1]                                                # 图库里点的那一张
LOCAL_URL = "/api/protect/download/20261006000000_local.png"    # 本地上传接口回的 url

FAKE_AXIOS = r"""
const calls: any[] = (window as any).__calls = [];
(window as any).__axiosStub = true;

const env = (data: any) => ({ status: 200, data: { code: 200, message: 'ok', data } });
const raw = (body: any) => ({ status: 200, data: body });
// ⚠️ 深拷贝：真 HTTP 每次都反序列化出一个新对象，这里面的数组是同一个引用 ⇒ 直接回引用会被
// React 的 Object.is 判等拦下、**不触发重渲染**，症状是"请求成功了但列表是空的"。
const wire = (d: any) => (d == null ? d : JSON.parse(JSON.stringify(d)));
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

const req = async (cfg: any) => {
  const url = cfg.url as string;
  const method = (cfg.method || 'GET').toUpperCase();
  const isForm = typeof FormData !== 'undefined' && cfg.data instanceof FormData;
  calls.push({
    url, method,
    // FormData 序列化出来是 {}，所以单记一份文件名 —— 上传断言靠它
    form: isForm ? { field: 'file', name: (cfg.data.get('file') as File)?.name || '' } : null,
  });
  await delay(20);
  if (url === '/api/protect/images') {
    if ((window as any).__imgFail) return raw({ code: 500, message: '图库读取失败', data: '' });
    return env(wire((window as any).__images));
  }
  if (url === '/api/protect/upload') {
    if ((window as any).__upFail) return raw({ code: 500, message: 'R2 配额已满，暂时不能上传', data: '' });
    return env((window as any).__uploadUrl);
  }
  return env(null);
};

// ⚠️ 必须是**可调用对象**：`src/apis/ImageMethods.tsx` 写的是 `http({ url, method })`
// （默认导出当函数用），而别的模块写 `http.get(...)`。只做一种，另一种就是
// `undefined is not a function`，且组件里的 `.catch` 之后没有任何提示 ⇒ 空列表/白屏。
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
import Editor_ from './src/components/Editor/index.tsx';

// 夹具（与 Python 侧同序同值）
const FIX = [
  { imageKey: 901, imageUrl: '/api/protect/download/20260912013218_EMQX.png' },
  { imageKey: 902, imageUrl: 'https://img.example.com/gallery/20261006000000_sunset.png' },
  { imageKey: 903, imageUrl: '/api/protect/download/old_pic.png' },
];
(window as any).__images = FIX;
(window as any).__uploadUrl = '__LOCALURL__';
(window as any).__imgFail = false;
(window as any).__upFail = false;

// 探针：直接问 CodeMirror 要正文与光标（与 React 状态无关，组件换写法也读得到）
const CM = () => (document.querySelector('.CodeMirror') as any).CodeMirror;
(window as any).__doc = () => CM().getValue();
// ⚠️ `getSelection()` 在 CodeMirror 5 里回的是**字符串**；要光标位置得用 listSelections()
//    拿 {anchor, head}（这条踩过：读到字符串 → 断言里 .get() 直接抛 AttributeError）。
(window as any).__sel = () => CM().listSelections()[0];

// 受控组件：模拟 NewNotes 的 setNoteContent（自动保存挂的就是它）。onChange 有没有被调到，
// 决定正文能不能存下来 —— 所以顺带记一笔。
const App = () => {
  const [v, setV] = React.useState('');
  return (
    // 容器要 >800px：bytemd 的 split 判据是 `containerWidth >= 800`，不到 800 时左组渲染的是
    // 「书写/预览」两个页签，**我们的拦截器在那个形态下不会命中**（见 mjs 第 ② 组）。
    <div style={{ width: 1200 }}>
      <Editor_
        noteContent={v}
        setNoteContent={(next: string) => {
          (window as any).__onChangeCount = ((window as any).__onChangeCount || 0) + 1;
          (window as any).__lastValue = next;
          setV(next);
        }}
      />
    </div>
  );
};

(window as any).__mount = () =>
  createRoot(document.getElementById('root')!).render(<App />);
"""


def esbuild(sb: pathlib.Path, entry: str, outfile: str):
    r = subprocess.run([str(FE / "node_modules/.bin/esbuild"), entry,
                        "--bundle", "--format=iife", "--outfile=" + outfile,
                        # 样式一律吞成字符串（再由 write_html 手工注入）——这样
                        # katex / github-markdown-css 里的 url(fonts/…) 不会被 esbuild 解析
                        "--loader:.sass=text", "--loader:.css=text",
                        "--jsx=automatic",
                        "--loader:.png=dataurl", "--loader:.svg=dataurl",
                        f"--define:{DEFINE}"],
                       cwd=str(sb), capture_output=True)
    if r.returncode != 0:
        raise SystemExit("esbuild 打包失败：\n%s" % r.stderr.decode("utf-8", "replace"))


def write_html(sb: pathlib.Path, bundle: str, css: str):
    (sb / "index.html").write_text(
        '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">'
        '<style>html,body,#root{height:100%;margin:0}*{box-sizing:border-box}</style>'
        '<style>' + css + '</style>'
        '</head><body><div id="root"></div>'
        '<script src="' + bundle + '"></script></body></html>', encoding="utf-8")


def page_css() -> str:
    """真站那两份样式：bytemd 自己那份（工具栏/弹层）+ 组件的 index.css（弹窗网格与名字截断）。
    少了 bytemd 那份，`.bytemd-toolbar-left` 之类的几何都不成立；少了组件那份，图库网格的
    滚动与名字那一行就无从比对。"""
    return "\n".join([
        (FE / "node_modules/bytemd/dist/index.css").read_text(encoding="utf-8"),
        (FE / "src/components/Editor/index.css").read_text(encoding="utf-8"),
    ])


def mutate(src_dir: pathlib.Path, rel: str, anchor: str, repl: str, why: str) -> None:
    """负控包的字符串手术：**锚点必须唯一命中**，否则当场报错退出。

    锚点失配 = 组件写法变了 ⇒ 这一节的负控证明不了任何事（会静默退化成"再打一份一样的包"）。
    红基线一律写成**内嵌字面量**，不读 `git show HEAD`（那会把测试钉死在某次提交上）。
    """
    p = src_dir / rel
    s = p.read_text(encoding="utf-8")
    n = s.count(anchor)
    if n != 1:
        raise SystemExit(f"负控锚点失配（{why}）：`{anchor}` 在 {rel} 里命中 {n} 处（应为 1）"
                         "—— 写法变了，本节的负控要先跟着改")
    p.write_text(s.replace(anchor, repl), encoding="utf-8")


def fork(sb: pathlib.Path, name: str) -> pathlib.Path:
    d = sb / name
    shutil.copytree(sb / "src", d / "src")
    (d / "node_modules").symlink_to(FE / "node_modules")
    (d / "entry.tsx").write_text((sb / "entry.tsx").read_text(encoding="utf-8"), encoding="utf-8")
    return d


def build_sandbox() -> pathlib.Path:
    sb = pathlib.Path(tempfile.mkdtemp(prefix="editor-image-picker-"))
    shutil.copytree(FE / "src", sb / "src")
    (sb / "node_modules").symlink_to(FE / "node_modules")
    (sb / "src/apis/axios.tsx").write_text(FAKE_AXIOS, encoding="utf-8")
    (sb / "entry.tsx").write_text(ENTRY.replace("__LOCALURL__", LOCAL_URL), encoding="utf-8")
    css = page_css()
    esbuild(sb, "entry.tsx", "bundle.js")
    write_html(sb, "bundle.js", css)

    # 负控甲（第一节）：抹掉 `e.stopPropagation()` ⇒ 同一次点击必须弹出系统文件框
    nostop = fork(sb, "nostop")
    mutate(nostop, "src/components/Editor/index.tsx", "e.stopPropagation()",
           "/* 负控：拦下的那一下没了 */", "stopPropagation")
    esbuild(nostop, "entry.tsx", "bundle.js")
    write_html(nostop, "bundle.js", css)

    # 负控乙（第四节）：把成功判据还原成**修前那句**（`response.status !== 200`）。本仓的失败
    # 信封是 HTTP 200 + `code:500` + `data:''` ⇒ 那句恒真 ⇒ 失败会被当成功、`![]()` 插进正文。
    # 这条负控要求正文那句"一个字符都不变"的断言**能红**。
    #
    # ⚠️ 它必须**同时**拆掉两道闸才有反应（这道题考试的重点）：① `handleImageUpload` 判
    # `code !== 200` 就不返回（失败时它 `throw`）② 图库弹窗还要 `imgs[0].url` 为真才插。
    # 只拆其中一个，正文照样一动不动 —— 也就是说第四节那条断言是**两层防线共同**守住的，
    # 单拆一层还红不了。负控要证明的是"这条断言不是假绿"，所以两层都得跟着还原。
    oldcheck = fork(sb, "oldcheck")
    mutate(oldcheck, "src/components/Editor/index.tsx",
           "if (response.data?.code !== 200) {", "if (response.status !== 200) {", "上传成功判据")
    mutate(oldcheck, "src/components/Editor/ImagePicker.tsx",
           "if (!url) {", "if (false) {", "弹窗侧的空 url 闸")
    esbuild(oldcheck, "entry.tsx", "bundle.js")
    write_html(oldcheck, "bundle.js", css)
    return sb


SANDBOX = build_sandbox()


class _Quiet(http.server.SimpleHTTPRequestHandler):
    """静音：访问日志会落进夜间回归日志（那是给人看断言的地方）。"""

    def log_message(self, *a, **k):
        return None


_handler = functools.partial(_Quiet, directory=str(SANDBOX))
_server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _handler)
threading.Thread(target=_server.serve_forever, daemon=True).start()

from playwright.sync_api import sync_playwright  # noqa: E402

BASE = f"http://127.0.0.1:{_server.server_address[1]}/"
URL = BASE + "index.html"
NOSTOP_URL = BASE + "nostop/index.html"
OLDCHECK_URL = BASE + "oldcheck/index.html"

# 内置图片按钮（左组下标 5）。**必须带左组前缀**：右组下标 5 是「源码」那颗按钮。
IMG = '.bytemd-toolbar-left > .bytemd-toolbar-icon[bytemd-tippy-path="5"]'
FILE_INPUT = ".editor-image-picker-upload input[type=file]"
PNG = b"\x89PNG\r\n\x1a\n" + b"0" * 64


def mount(br, url=URL, size=(1440, 900), images=None):
    page = br.new_page(viewport={"width": size[0], "height": size[1]})
    errs = []
    page.choosers = []
    page.on("pageerror", lambda e: errs.append(str(e)))
    # filechooser 记账挂在 mount 上（不是每次点击现挂，免得监听器越叠越多）；
    # 收到就必须 set_files 收尾，否则那个 `<input type=file>` 一直等着人点。
    page.on("filechooser", lambda c: (page.choosers.append(1), c.set_files([])))
    page.set_default_timeout(15000)          # 失败要快 —— 默认 30s 会把一次失误拖成半分钟
    page.goto(url)
    page.evaluate("(imgs) => { if (imgs) window.__images = imgs; window.__mount(); }", images)
    try:
        # 等左组图标出来（split 生效才渲染）。等不到，后面每一条都会超时 —— 先打现场。
        page.wait_for_selector(IMG, timeout=10000)
    except Exception:
        print("  ⚠ 等不到左组图标，现场：")
        print("    " + page.evaluate("""() => JSON.stringify({
            root: document.getElementById('root').children.length,
            toolbar: !!document.querySelector('.bytemd-toolbar'),
            leftIcons: document.querySelectorAll('.bytemd-toolbar-left > .bytemd-toolbar-icon').length,
            paths: [...document.querySelectorAll('.bytemd-toolbar-icon')].map((e) => e.getAttribute('bytemd-tippy-path')),
            cm: !!document.querySelector('.CodeMirror'),
            axiosStub: window.__axiosStub === true,
        })"""))
        print("    页面异常：" + ("; ".join(errs[:3]) or "（无）"))
        raise
    page.wait_for_timeout(300)
    page.errs = errs
    return page


def modal_open(page) -> bool:
    """antd 关弹窗是给 `.ant-modal-wrap` 加 `display:none`（节点还留在 DOM 里）⇒ 只数节点会把
    "关了"读成"开着"，必须读计算样式。"""
    return page.evaluate("""() => [...document.querySelectorAll('.ant-modal-wrap')]
        .some((el) => getComputedStyle(el).display !== 'none')""")


def cards(page):
    return page.evaluate("""() => [...document.querySelectorAll('.editor-gallery-item')]
        .map((img) => ({ src: img.getAttribute('src'),
                         name: ((img.closest('.ant-card') || {}).querySelector
                                ? img.closest('.ant-card').querySelector('.editor-gallery-name').textContent : '') }))""")


def close_picker(page):
    """关掉图库弹窗（点右上角 X。真站里弹窗开着时遮罩会把整页盖住，工具栏那颗按钮点不到）。"""
    if not modal_open(page):
        return
    page.click(".ant-modal-close")
    page.wait_for_timeout(400)


def click_image_icon(page):
    """点那颗内置图片按钮，返回本次点击的 filechooser 事件数。"""
    if modal_open(page):
        # 顺序错了：弹窗还开着就去点工具栏，遮罩会挡住点击 —— Playwright 会一直重试到超时，
        # 报出来的是"元素不可点击"，看不出真正的原因。这里直接说清楚。
        raise SystemExit("调用顺序错：图库弹窗还开着就点工具栏那颗按钮（遮罩挡着，真站也点不到）")
    before = len(page.choosers)
    page.click(IMG)
    for _ in range(20):                       # 给 bytemd 的 selectFiles 一点时间（真弹的话）
        if len(page.choosers) > before:
            break
        page.wait_for_timeout(100)
    page.wait_for_timeout(300)                # 等图库列表回包 + 渲染
    return len(page.choosers) - before


def pick_tab(page, label):
    page.click(f".ant-tabs-tab:has-text('{label}')")
    page.wait_for_timeout(300)


with sync_playwright() as pw:
    br = pw.chromium.launch()

    # ═════════════════════════════════════════════════════════════════════════════
    print("\n① 点那颗按钮：不再弹系统文件框，改成开图库弹窗（负控：抹掉 stopPropagation ⇒ 必须弹）")
    # ═════════════════════════════════════════════════════════════════════════════
    page = mount(br)
    check("点击前没有弹窗", modal_open(page) is False)
    choosers = click_image_icon(page)
    check("点击**没有**触发系统文件框（filechooser）", choosers == 0, f"choosers={choosers}")
    check("弹窗开出来了", modal_open(page) is True)
    check("那颗按钮本身还在原位（左组下标 5，图标/位置都没动）",
          page.evaluate(f"() => !!document.querySelector('{IMG}')"))

    # 负控：同一次点击，抹掉 stopPropagation 的那份包**必须**弹系统文件框。它同时证明上面
    # 那句 `choosers == 0` 不是假绿（沙箱里确实点得着这颗按钮、bytemd 的 handler 也在）。
    npage = mount(br, url=NOSTOP_URL)
    nchoosers = click_image_icon(npage)
    check("负控：抹掉 stopPropagation ⇒ 同一次点击弹出系统文件框", nchoosers >= 1, f"choosers={nchoosers}")
    # 注意：负控那一档我们**自己那颗弹窗也会开**（捕获监听照样跑，只是不再掐断冒泡）
    # —— 所以这里只能断言"系统文件框确实弹了"，那才是"被拦住的是什么"的证据。

    # ═════════════════════════════════════════════════════════════════════════════
    print("\n② 弹窗优先展示图库（默认页签 + 网格条数 + 展示名 + 缩略图 CDN 化）")
    # ═════════════════════════════════════════════════════════════════════════════
    page.wait_for_timeout(300)
    tabs = page.evaluate("() => [...document.querySelectorAll('.ant-tabs-tab')].map((t) => t.textContent.trim())")
    active = page.evaluate("() => ((document.querySelector('.ant-tabs-tab-active') || {}).textContent || '')")
    check("弹窗里有两个页签", len(tabs) == 2, str(tabs))
    check("默认选中「图库」（用户要求：优先展示服务器上的图库）", "图库" in active, active)
    grid = cards(page)
    check("网格条数 = 图库里的图片数", len(grid) == len(FIX), f"{len(grid)} vs {len(FIX)}")
    check("缩略图 src 是 CDN 化后的地址（本地盘那条）",
          bool(grid) and grid[0]["src"] == CDN + PICK, grid[0]["src"] if grid else "")
    check("R2 那种绝对地址原样用（只重写 /api/protect/download/ 前缀）",
          len(grid) > 1 and grid[1]["src"] == FIX[1][1], grid[1]["src"] if len(grid) > 1 else "")
    check("卡下面那行是展示名（剥掉上传时压的 14 位时间戳前缀）",
          bool(grid) and grid[0]["name"].strip() == "EMQX.png", grid[0]["name"] if grid else "")
    check("不带那个前缀的旧名原样显示（宁可显示全名也不许截错）",
          len(grid) > 2 and grid[2]["name"].strip() == "old_pic.png",
          grid[2]["name"] if len(grid) > 2 else "")
    check("图库列表真的请求了 GET /api/protect/images",
          page.evaluate("() => window.__calls.filter((c) => c.url === '/api/protect/images'"
                        " && c.method === 'GET').length") >= 1)

    # ═════════════════════════════════════════════════════════════════════════════
    print("\n③ 选中一张 ⇒ 写进正文的是**库里那个原始串**，形态与 bytemd 自己插的逐字节一样")
    # ═════════════════════════════════════════════════════════════════════════════
    doc_before = page.evaluate("() => window.__doc()")
    page.click(".editor-gallery-item")
    page.wait_for_timeout(500)
    doc = page.evaluate("() => window.__doc()")
    sel = page.evaluate("() => window.__sel()")
    check("点击前正文是空的（下面那条不是「本来就有」）", doc_before == "", repr(doc_before))
    check("空文档里插一张 = `\\n![](原始串)`（与 bytemd 自己插图同形）",
          doc == "\n![](%s)" % PICK, repr(doc))
    check("写进正文的是**库里那个原始串**，不是 CDN 化后的地址",
          PICK in doc and CDN not in doc, repr(doc))
    check("光标落在刚插入的那一行上",
          sel.get("anchor", {}).get("line") == 1 and sel.get("anchor", {}).get("ch") == 0, str(sel))
    check("插入后弹窗关闭", modal_open(page) is False)
    check("onChange 被调到（NewNotes 的自动保存挂的就是它，正文这才存得住）",
          page.evaluate("() => window.__lastValue || ''") == doc,
          repr(page.evaluate("() => window.__lastValue || ''")))

    # ═════════════════════════════════════════════════════════════════════════════
    print("\n④ 本地上传那条路还在（成功插进正文；被拒时一个字符都不许变 —— 负控：还原修前判据）")
    # ═════════════════════════════════════════════════════════════════════════════
    click_image_icon(page)
    pick_tab(page, "本地上传")
    check("「本地上传」页签里是拖拽/点选的上传区",
          page.evaluate(f"() => document.querySelectorAll('{FILE_INPUT}').length") == 1)
    page.set_input_files(FILE_INPUT, {"name": "screenshot.png", "mimeType": "image/png", "buffer": PNG})
    page.wait_for_timeout(700)
    doc = page.evaluate("() => window.__doc()")
    uploads = page.evaluate("() => window.__calls.filter((c) => c.url === '/api/protect/upload')")
    check("上传走的是同一个 POST /api/protect/upload，字段名 file",
          bool(uploads) and uploads[-1]["form"] and uploads[-1]["form"]["name"] == "screenshot.png",
          str(uploads[-1] if uploads else None))
    check("上传成功后插进正文（用的是接口返回的那个 url）",
          LOCAL_URL in doc and doc.count("![](") == 2, repr(doc))
    check("插进去的不是空 url（失败才可能插出 `![]()`）", "![]()" not in doc, repr(doc))
    check("插入后弹窗关闭", modal_open(page) is False)

    # 失败态：上传被服务端拒绝（本仓失败 = HTTP 200 + code:500）
    click_image_icon(page)
    page.evaluate("() => { window.__upFail = true; }")
    pick_tab(page, "本地上传")
    doc_before = page.evaluate("() => window.__doc()")
    page.set_input_files(FILE_INPUT, {"name": "toobig.png", "mimeType": "image/png", "buffer": PNG})
    page.wait_for_timeout(700)
    check("上传被拒时正文**一个字符都不变**",
          page.evaluate("() => window.__doc()") == doc_before,
          repr(page.evaluate("() => window.__doc()")))
    check("上传被拒时弹窗**不关**（人能接着换一张试）", modal_open(page) is True)
    check("错误提示用的是服务端那句话",
          "R2 配额已满" in page.evaluate("() => document.body.innerText"))

    close_picker(page)          # 上面那条是"故意不关"，进第五节前得自己关掉

    # 负控：判据还原成修前那句（`response.status !== 200`，本仓恒真）⇒ 它必须把 `![]()` 插进去
    opage = mount(br, url=OLDCHECK_URL)
    click_image_icon(opage)
    opage.evaluate("() => { window.__upFail = true; }")
    pick_tab(opage, "本地上传")
    opage.set_input_files(FILE_INPUT, {"name": "toobig.png", "mimeType": "image/png", "buffer": PNG})
    opage.wait_for_timeout(700)
    odoc = opage.evaluate("() => window.__doc()")
    check("负控：两道闸都还原成修前那样 ⇒ 同一个失败回包被当成功、`![]()` 插进正文",
          "![]()" in odoc, repr(odoc))

    # ═════════════════════════════════════════════════════════════════════════════
    print("\n⑤ 图库为空 / 读不到：给人话，且「本地上传」仍然可用（不能把人卡死）")
    # ═════════════════════════════════════════════════════════════════════════════
    page.evaluate("() => { window.__images = []; }")
    click_image_icon(page)
    page.wait_for_timeout(400)
    check("图库为空时说人话（不是一片空白）",
          page.evaluate("() => document.querySelectorAll('.ant-empty').length") == 1)
    pick_tab(page, "本地上传")
    check("空图库时「本地上传」仍然可用",
          page.evaluate(f"() => document.querySelectorAll('{FILE_INPUT}').length") == 1)
    close_picker(page)

    page.evaluate("() => { window.__images = null; window.__imgFail = true; }")
    click_image_icon(page)
    page.wait_for_timeout(400)
    check("图库读不到时显示失败原因（不许拿空网格冒充「图库里没有图」）",
          page.evaluate("() => document.querySelectorAll('.ant-alert-error').length") == 1)
    check("失败原因用的是服务端那句话",
          "图库读取失败" in page.evaluate("() => document.body.innerText"))
    pick_tab(page, "本地上传")
    check("图库读不到时「本地上传」仍然可用",
          page.evaluate(f"() => document.querySelectorAll('{FILE_INPUT}').length") == 1)

    for p, name in ((page, "主档"), (npage, "负控甲（抹 stopPropagation）"), (opage, "负控乙（修前判据）")):
        check(f"{name}没有页面异常", not p.errs, "; ".join(p.errs[:3]))

    br.close()

print()
if FAILS:
    print(f"❌ {len(FAILS)} 项未通过：")
    for f in FAILS:
        print("   - " + f)
    sys.exit(1)
print("✅ 编辑器图片按钮（图库优先，也能本地上传，20261006）：全部通过")
