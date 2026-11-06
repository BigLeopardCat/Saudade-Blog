# -*- coding: utf-8 -*-
"""看板娘渲染层的**真浏览器行为锁**。"""
import functools
import http.server
import io
import json
import pathlib
import socketserver
import statistics
import threading

from playwright.sync_api import sync_playwright
from PIL import Image

ROOT = pathlib.Path(__file__).resolve().parents[2]
PUBLIC = ROOT / "frontend" / "public"
WIDGET = PUBLIC / "live2d-widgets"

TITLE = "回归台标题A1"          # 欢迎语要把它填进「」里，用个不会自然出现的串
PAGE_PATH = "/article/16"        # 文章页才会出现"欢迎阅读"（首页走的是时段问候）

EVIL_TITLE = '回归台标题B9<img src=x onerror="window.__xss=1"><b>B</b>'
EVIL_PATH = "/article/17"

# 口型的三个状态（④ 用）。direct 是 chat-stream.js:1187 的原样写法与取值。
MOUTH = {
    "close": "() => window.__setMouthClose()",
    "open": "() => window.__setMouthOpen(1)",
    "direct": "() => { window.__mouthOverride = 0.8; }",
}

FAILS = []


def check(desc, cond, detail=""):
    print(("  ✅ " if cond else "  ❌ ") + desc + (f"  [{detail}]" if detail else ""))
    if not cond:
        FAILS.append(desc)


# 前置：三份运行时产物必须在场（不在场时给的是"去跑哪条命令"，不是一片红）
def preflight():
    missing = [p for p in (
        WIDGET / "vendor" / "pixi.min.js",
        WIDGET / "vendor" / "cubism4.min.js",
        PUBLIC / "cubism5" / "live2dcubismcore.min.js",
    ) if not p.exists()]
    if missing:
        print("❌ 看板娘运行时产物未就位，先跑：  npm run vendor:live2d")
        for p in missing:
            print("    缺 " + str(p.relative_to(ROOT)))
        raise SystemExit(2)


HARNESS = """<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<title>%TITLE%</title>
<link rel="stylesheet" href="/live2d-widgets/widget.css">
<style>html,body{margin:0;height:100%%;background:#ffffff}</style>
</head><body>
<script>
  // /api/* 一律给个空壳：看板娘初始化会顺带拉起聊天面板（拉历史、建会话），
  // 真发出去全是 404 —— 那会让 boot.js 的前端上报把每条都记一遍，噪声盖住真问题。
  // 返回体按各调用方的形状给（history 要 items、conversations 要 id）。
  (function () {
    const orig = window.fetch;
    window.fetch = function (url) {
      const u = String(url);
      if (u.indexOf('/api/') !== 0) return orig.apply(this, arguments);
      let body = {};
      if (u.includes('/api/chat/history')) body = { items: [] };
      if (u.includes('/api/chat/conversations')) body = { id: 1, items: [] };
      if (u.includes('/api/chat/search')) body = { items: [] };
      return Promise.resolve({ ok: true, status: 200, json: async () => body });
    };
  })();
</script>
<script src="/live2d-widgets/boot.js?v=__VER__" defer></script>
</body></html>
"""


class Handler(http.server.SimpleHTTPRequestHandler):
    def do_GET(self):
        path = self.path.split("?")[0]
        if path in ("/", PAGE_PATH, EVIL_PATH):
            # Match the production loader's lock-derived cache key.
            ver = json.loads((ROOT / "frontend/widget.lock.json").read_text())["sha"]
            # 标题按路径给：⑩ 那条路径喂的是带标签的载荷（同一份 harness，只换 title）
            title = EVIL_TITLE if path == EVIL_PATH else TITLE
            body = HARNESS.replace("%TITLE%", title).replace("__VER__", ver).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        return super().do_GET()

    def log_message(self, *a):
        pass


def start_server():
    handler = functools.partial(Handler, directory=str(PUBLIC))
    httpd = socketserver.TCPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd, httpd.server_address[1]


# 像素工具：数"不是背景色"的像素
def shot(page, box):
    return Image.open(io.BytesIO(page.screenshot(clip=box))).convert("RGB")


def ink(img, bg=(255, 255, 255), tol=12):
    """非背景像素数（背景是白 body；tol 吃掉抗锯齿与压缩噪声）"""
    px = img.getdata()
    return sum(1 for p in px if abs(p[0] - bg[0]) > tol or abs(p[1] - bg[1]) > tol or abs(p[2] - bg[2]) > tol)


def ink_bbox(img, bg=(255, 255, 255), tol=12):
    """非背景像素的外接框 (l, t, r, b) 与像素数。空白页上只有看板娘在画 ⇒
    整屏的外接框就是**角色本体**的外接框（⑨ 手机档要量的正是它，而不是 300px 的盒）。
    没有非背景像素时返回 ((0, 0, -1, -1), 0)。"""
    w, h = img.size
    px = img.load()
    l, t, r, b, n = w, h, -1, -1, 0
    for y in range(h):
        for x in range(w):
            p = px[x, y]
            if abs(p[0] - bg[0]) > tol or abs(p[1] - bg[1]) > tol or abs(p[2] - bg[2]) > tol:
                n += 1
                if x < l: l = x
                if y < t: t = y
                if x > r: r = x
                if y > b: b = y
    return (l, t, r, b), n


# ⑦ 用的探针：把一段行内代码塞进真气泡，量它的底与字
# 底色是**半透明**的（`rgba(...)`）⇒ getComputedStyle 给的是字面量，直接拿它算对比度
# 得到的是个假数。这里沿着祖先链把每一层的 background-color 从底往上复合，直到遇到
# 不透明的一层为止——复合完的才是屏幕上那个像素。
HL_PROBE = """() => {
  const panel = document.getElementById('waifu-chat');
  if (!panel) return null;
  const box = panel.querySelector('.chat-messages');
  if (!box) return null;
  let d = document.getElementById('hl-probe');
  if (!d) {
    d = document.createElement('div');
    d.id = 'hl-probe';
    d.className = 'chat-msg agent';
    d.innerHTML = '<div class="msg-text"><p>行内代码：<code>get_blog_info</code> 与 <code>widget.lock.json</code></p></div>';
    box.appendChild(d);
  }
  const code = d.querySelector('code');
  const rgba = (s) => {
    const m = String(s).match(/rgba?\\(([^)]+)\\)/);
    if (!m) return [0, 0, 0, 0];
    const p = m[1].split(',').map((x) => parseFloat(x));
    return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1];
  };
  const over = (fg, bg) => [fg[0] * fg[3] + bg[0] * (1 - fg[3]),
                            fg[1] * fg[3] + bg[1] * (1 - fg[3]),
                            fg[2] * fg[3] + bg[2] * (1 - fg[3]), 1];
  const flatten = (el) => {
    const stack = [];
    for (let n = el; n; n = n.parentElement) {
      const c = rgba(getComputedStyle(n).backgroundColor);
      stack.push(c);
      if (c[3] >= 1) break;
    }
    let out = [255, 255, 255, 1];
    for (let i = stack.length - 1; i >= 0; i--) out = over(stack[i], out);
    return out.slice(0, 3).map((v) => Math.round(v));
  };
  return { chip: flatten(code), text: rgba(getComputedStyle(code).color).slice(0, 3).map((v) => Math.round(v)),
           panel: flatten(panel) };
}"""


# ⑧ 用：面板里每颗"带 svg 图标的按钮"，量它的**图标色 vs 背后的合成底色**。
# 为什么得逐个量、不能查一遍配色表：图标色走 `currentColor`，它取什么值取决于**宿主控件
# 自己有没有声明 `color`** —— 表单控件（button/input/select/textarea）的 UA 样式表给的是
# `color: buttontext`，那是**元素上的具名值、不是继承值**，外层的 `#waifu-chat { color: … }`
# 根本传不进去。漏了一颗，源码里看不出任何异常（`fill="#203042"` 还明明白白写着深蓝）。
ICON_PROBE = """() => {
  const rgba = (s) => {
    const m = String(s).match(/rgba?\\(([^)]+)\\)/);
    if (!m) return [0, 0, 0, 0];
    const p = m[1].split(',').map((x) => parseFloat(x));
    return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1];
  };
  const over = (fg, bg) => [fg[0] * fg[3] + bg[0] * (1 - fg[3]),
                            fg[1] * fg[3] + bg[1] * (1 - fg[3]),
                            fg[2] * fg[3] + bg[2] * (1 - fg[3]), 1];
  const flatten = (el) => {
    const stack = [];
    for (let n = el; n; n = n.parentElement) {
      const c = rgba(getComputedStyle(n).backgroundColor);
      stack.push(c);
      if (c[3] >= 1) break;
    }
    let out = [255, 255, 255, 1];
    for (let i = stack.length - 1; i >= 0; i--) out = over(stack[i], out);
    return out.slice(0, 3).map((v) => Math.round(v));
  };
  const out = [];
  document.querySelectorAll('#waifu-chat button').forEach((b) => {
    if (!b.querySelector('svg path')) return;
    const p = b.querySelector('svg path');
    out.push({ name: b.id || String(b.className),
               fill: rgba(getComputedStyle(p).fill).slice(0, 3).map((v) => Math.round(v)),
               bg: flatten(b) });
  });
  return out;
}"""


def _lum(c):
    def f(v):
        v /= 255
        return v / 12.92 if v <= 0.03928 else ((v + 0.055) / 1.055) ** 2.4
    return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2])


def contrast(a, b):
    la, lb = _lum(a), _lum(b)
    hi, lo = max(la, lb), min(la, lb)
    return (hi + 0.05) / (lo + 0.05)


def fmt(c):
    return "#" + "".join(f"{max(0, min(255, int(round(v)))):02x}" for v in c)




DOM_STATE = """() => {
  const w = document.getElementById('waifu');
  const cv = document.getElementById('live2d');
  const tip = document.getElementById('waifu-tips');
  const tool = document.getElementById('waifu-tool');
  const cs = w ? getComputedStyle(w) : null;
  const ccs = cv ? getComputedStyle(cv) : null;
  return {
    hasWaifu: !!w,
    active: !!(w && w.classList.contains('waifu-active')),
    hidden: !!(w && w.classList.contains('waifu-hidden')),
    waifuH: w ? Math.round(w.getBoundingClientRect().height) : -1,
    waifuBottom: cs ? cs.bottom : null,
    waifuLeft: w ? w.style.left : null,
    slideInOnce: !!(w && w.dataset.slideInOnce),
    waifuBottomData: w ? (w.dataset.waifuBottom || null) : null,
    childOrder: w ? [...w.children].map(c => c.id) : [],
    canvasCount: w ? w.querySelectorAll('#waifu-canvas canvas').length : -1,
    canvasId: cv ? cv.id : null,
    canvasW: cv ? Math.round(cv.getBoundingClientRect().width) : -1,
    canvasH: cv ? Math.round(cv.getBoundingClientRect().height) : -1,
    canvasStyleW: ccs ? ccs.width : null,
    tipsText: tip ? tip.textContent : null,
    toolOrder: tool ? [...tool.children].map(c => c.id) : [],
    toolSvgs: tool ? [...tool.children].filter(c => c.querySelector('svg')).length : -1,
    toggle: !!document.getElementById('waifu-toggle'),
    toggleActive: (() => { const t = document.getElementById('waifu-toggle');
                           return !!(t && t.classList.contains('waifu-toggle-active')); })(),
    chatPanel: !!document.getElementById('waifu-chat'),
    chatActive: (() => { const c = document.getElementById('waifu-chat');
                         return !!(c && c.classList.contains('active')); })(),
    display: localStorage.getItem('waifu-display'),
    mouth: window.__mouthOverride,
    hasMouthApi: typeof window.__setMouthOpen === 'function'
                 && typeof window.__setMouthClose === 'function',
  };
}"""


# ⑨ 用：命中测试（这一点击到底落在谁头上）。
# ⚠️ `elementFromPoint` **会跳过 `pointer-events:none` 的元素** —— 正因为它会跳，
# 这个探针必须配一条**正控**：点在角色墨迹上要落回 `#waifu`。只有正控绿了，
# "空白处落到了正文"才说明盒子那部分真的透过去了，而不是探针本身恒返回"不是 #waifu"
# （这一族假绿：`pointer-events:none` 让命中测试与红基线**一起**哑掉）。
# 传入的 bb 是 ⑨ 量出来的"盒"与"墨迹"两组坐标，点由它们派生 —— 写死坐标会在
# 模型/尺寸一动时变成"点在哪儿都不知道"的断言。
MOBILE_HIT = """(bb) => {
  const inW = (el) => { for (let n = el; n; n = n.parentElement) if (n.id === 'waifu') return true; return false; };
  const probe = (x, y) => {
    const e = document.elementFromPoint(x, y);
    return e ? (inW(e) ? 'waifu' : 'out') : 'null';
  };
  const cx = Math.round((bb.inkL + bb.inkR) / 2);
  const cy = Math.round((bb.inkT + bb.inkB) / 2);
  return {
    blank: [[bb.boxR - 5, bb.boxT + 20], [bb.boxL + 5, bb.boxT + 20],
            [bb.boxR - 5, bb.boxB - 5]].map(([x, y]) => probe(x, y)),
    body: [[cx, cy], [bb.inkL + 8, bb.inkB - 20]].map(([x, y]) => probe(x, y)),
  };
}"""


# ⑩ 用：`#waifu-tips` 里那段欢迎语的实况（innerHTML / 文本 / 里面真有几个元素）
# 读 innerHTML 而不是只看 textContent：这段文本最后是 `el.innerHTML = …` 写进去的，
# 判"标题里的标签有没有被当成标签"必须看在 **DOM 里造出了什么元素**。
TIPS_PROBE = """() => {
  const tip = document.getElementById('waifu-tips');
  return {
    html: tip ? tip.innerHTML : null,
    text: tip ? tip.textContent : null,
    imgs: tip ? tip.querySelectorAll('img').length : -1,
    bolds: tip ? tip.querySelectorAll('b').length : -1,
    spans: tip ? tip.querySelectorAll('span').length : -1,
    xss: (typeof window.__xss === 'undefined') ? null : window.__xss,
  };
}"""

# ⑩ 的红基线：把**同一个载荷**不经转义塞进文档（= 修前那段代码的产物就是这形状），
# 断言探针那边真的会多出一个 <img>、`onerror` 真的会跑。没有这一步，"没造出 <img>"
# 与"探针本来就数不着 img / 载荷本来就是死的"分辨不开。
XSS_CTL = """(payload) => {
  const d = document.createElement('div');
  d.id = 'xss-control';
  d.innerHTML = payload;
  document.body.appendChild(d);
  return { imgs: d.querySelectorAll('img').length,
           bolds: d.querySelectorAll('b').length };
}"""


def wait(page, fn, ms=45000, step=120):
    """轮询等待：固定 sleep 在慢机器/冷缓存下是偶发红的来源（模型贴图 1.5MB）"""
    waited = 0
    while waited < ms:
        if page.evaluate(fn):
            return True
        page.wait_for_timeout(step)
        waited += step
    return False


def main():
    preflight()
    httpd, port = start_server()
    url = f"http://127.0.0.1:{port}{PAGE_PATH}"
    print(f"看板娘渲染回归台  {url}\n")

    with sync_playwright() as p:
        browser = p.chromium.launch(args=[
            "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader",
        ])
        page = browser.new_page(viewport={"width": 900, "height": 720})
        page.goto(url, wait_until="load")

        ok = wait(page, "() => !!document.getElementById('live2d')")
        check("① 看板娘 DOM 已注入（#live2d 存在）", ok)
        if not ok:
            browser.close()
            httpd.shutdown()
            return finish()
        ok = wait(page, "() => { const w = document.getElementById('waifu');"
                        " const t = document.getElementById('waifu-tool');"
                        " return !!(w && w.classList.contains('waifu-active') && t && t.children.length >= 5); }")
        check("① 初始化完成（waifu-active + 五个工具按钮就位）", ok)
        if not ok:
            browser.close()
            httpd.shutdown()
            return finish()

        # ① DOM 骨架与外接框
        st = page.evaluate(DOM_STATE)
        check("① #waifu 带 waifu-active（可见态）", st["active"])
        # 只断言前三个：后面还有 chat-stream/chat-render 追加的 #waifu-chat 与
        # #waifu-tool-star-box（别的模块的东西，不属于渲染层契约）
        check("① 前三个子节点顺序 = tips / canvas / tool",
              st["childOrder"][:3] == ["waifu-tips", "waifu-canvas", "waifu-tool"], st["childOrder"])
        check("① #waifu-canvas 里有且只有一个 canvas", st["canvasCount"] == 1, st["canvasCount"])
        check("① canvas 的 id 是 live2d（chat-engine 按 id 取画布）", st["canvasId"] == "live2d")
        check("① #live2d 外接框 300×300（css 决定；被内联样式改掉就是被撑变形了）",
              st["canvasW"] == 300 and st["canvasH"] == 300,
              f"{st['canvasW']}×{st['canvasH']} style={st['canvasStyleW']}")
        check("① #waifu 高度恒 300px（中间态塌陷的回归锁）", st["waifuH"] == 300, st["waifuH"])

        # ② 工具条
        # 只锁**渲染层那五个的相对顺序**，不锁 hitokoto 的位次：chat-stream 的
        # repurposeHitokoto 与 registerTools 之间有真实竞态（前者只要 #waifu-tool 在
        # DOM 里就 append，而它在模型加载完成前就已存在）⇒ 线上 hitokoto 有时在最前、
        # 有时在最后。锁绝对位次就是在锁一个线上本来就不稳定的东西。
        FIVE = ["waifu-tool-switch-model", "waifu-tool-switch-texture",
                "waifu-tool-photo", "waifu-tool-info", "waifu-tool-quit"]
        check("② 渲染层五个按钮都在，且相对顺序固定",
              [i for i in st["toolOrder"] if i in FIVE] == FIVE, st["toolOrder"])
        check("② 对话开关 hitokoto 由 chat-stream 追加（六个按钮齐）",
              "waifu-tool-hitokoto" in st["toolOrder"] and len(st["toolOrder"]) == 6, st["toolOrder"])
        check("② 每个按钮都带 svg 图标", st["toolSvgs"] == len(st["toolOrder"]),
              f"{st['toolSvgs']}/{len(st['toolOrder'])}")

        # ③ 角色真的画出来了
        check("③ 模型加载完成（滑入闸门已放行）",
              wait(page, "() => { const w = document.getElementById('waifu');"
                         " return !!(w && w.dataset.slideInOnce); }"))
        page.wait_for_timeout(1400)          # 等滑入动画（800ms）走完
        # 外接框必须**滑到位之后**再取：滑入前 #waifu 停在 bottom:-500px，
        # 画布的 rect 落在视口之外，clip 截图会直接报"区域在图像外"
        box = page.locator("#live2d").bounding_box()
        img = shot(page, box)
        n_ink = ink(img)
        print(f"      · 画布非背景像素 {n_ink} / {img.width * img.height}")
        check("③ 画布上有角色（非背景像素 > 5000）", n_ink > 5000, n_ink)

        # ④ 口型接口（chat-stream.js 直接写这三个名字）
        check("④ __setMouthOpen / __setMouthClose 都在", st["hasMouthApi"])
        check("④ __mouthOverride 初值 = -1（交还空闲动画）", st["mouth"] == -1, st["mouth"])

        def gray(pg):
            return list(Image.open(io.BytesIO(pg.screenshot(clip=box))).convert("L").getdata())

        def snap(state):
            page.evaluate(MOUTH[state])
            page.wait_for_timeout(70)        # 口型下一帧生效（写变量 → 渲染循环读）
            return gray(page)

        mx = [0] * (img.width * img.height)
        for _ in range(14):
            a, b = snap("close"), snap("close")
            for i in range(len(mx)):
                d = abs(a[i] - b[i])
                if d > mx[i]:
                    mx[i] = d
        mask = [v <= 6 for v in mx]          # 阈值 6：同状态两张逐像素相同，留点余量
        print(f"      · 静止掩膜 {sum(mask)}/{len(mask)} 像素（{sum(mask) * 100 // len(mask)}% 不动）")

        def moved(g, c):
            return sum(1 for i, v in enumerate(g) if mask[i] and abs(v - c[i]) > 24)

        def probe(state, n=16):
            """配对测：每对都是「先 close 再目标态」，两张只隔 ~180ms ⇒ 相位差被配对消掉"""
            out = []
            for _ in range(n):
                c = snap("close")
                out.append(moved(snap(state), c))
            return out

        d_noise, d_open, d_direct = probe("close"), probe("open"), probe("direct")
        nz, op, di = (statistics.median(v) for v in (d_noise, d_open, d_direct))
        gate = max(25, 5 * nz)               # 噪声底自校准（噪声中位恒 ≤4）
        print(f"      · 掩膜内变化像素（配对中位）  同状态 {nz:.0f}"
              f"（均值 {statistics.mean(d_noise):.0f}）  张嘴 {op:.0f}  直接写 {di:.0f}"
              f"  闸门 {gate:.0f}")
        check("④ 张嘴让画面真的变了（口型生效，不是变量被赋值）", op > gate,
              f"中位 {op:.0f} vs 噪声中位 {nz:.0f}")
        # chat-stream.js:1187 那一行是**直接赋值**（不经过 __setMouthOpen），这里照抄
        # 它的原样写法与取值（mouthOpen ? 0.8 : 0）
        check("④ 直接写 __mouthOverride（chat-stream 的原样写法）也真的动", di > gate,
              f"中位 {di:.0f} vs 噪声中位 {nz:.0f}")
        # __setMouthClose 的净效果是"钉死在闭合"（它把 override 设成 0 而不是 -1 ——
        # 上游沿用下来的怪异写法，chat-stream 依赖它的净效果而不是这个名字的语义）
        page.evaluate("() => window.__setMouthClose()")
        check("④ 闭嘴后 override 停在 ≥0（钉住闭合，不是交还动画）",
              page.evaluate("() => window.__mouthOverride") >= 0,
              page.evaluate("() => window.__mouthOverride"))
        page.evaluate("() => { window.__mouthOverride = -1; }")   # 交还空闲动画，免得影响 ⑤

        # ⑤ 入场 / 拖拽 / 收起唤回
        st_now = page.evaluate(DOM_STATE)
        check("⑤ 滑入后 bottom 归零（角色停在最终位置，不是停在半路）",
              st_now["waifuBottom"] == "0px", st_now["waifuBottom"])
        # 欢迎语用**初始化那一刻**的采样（st），不能用这里的 st_now：上游的 tips 是
        # 每 20 秒随机换一条的轮播（`愿你有一天能与重要的人重逢。` 之类），晚采样会
        # 读到轮播后的那一条 —— 那是"采晚了"，不是"欢迎语没写"。新实现只写这一句，
        # 早晚都一样；两种实现都绿才是这条锁要的。
        check("⑤ 欢迎语写进了 #waifu-tips（boot.js 的 observeTips 靠它转进对话框）",
              bool(st["tipsText"]) and "欢迎阅读" in st["tipsText"] and TITLE in st["tipsText"],
              repr(st["tipsText"])[:90])

        cx, cy = box["x"] + box["width"] / 2, box["y"] + box["height"] / 2
        wf = lambda: page.locator("#waifu").bounding_box()

        # ① 原地"点一下"。真点击在按下/抬起之间几乎总带 1px 抖动——Playwright 的
        #    down/up 自己不会造抖动，**必须显式补这一下**，否则这条判据对旧代码也是绿的。
        r0 = wf()
        page.mouse.move(cx, cy)
        page.mouse.down()
        page.mouse.move(cx + 1, cy + 1)
        page.mouse.move(cx, cy)
        page.mouse.up()
        page.wait_for_timeout(60)
        r1 = wf()
        check("⑤ 原地点击不移动看板娘（1px 抖动不算拖）",
              abs(r1["x"] - r0["x"]) <= 1 and abs(r1["y"] - r0["y"]) <= 1,
              f"Δx={r1['x'] - r0['x']:.0f} Δy={r1['y'] - r0['y']:.0f}")

        # ② 往上拖 60px、往右拖 40px：位移必须**跟着鼠标同向**（旧代码整条反着走）。
        #    往上拖而不是往下拖，是因为 #waifu 静止时 bottom:0 已经贴着视口底——
        #    往下拖会被钳在 0，"没动"会被误读成"方向反了"。
        page.mouse.move(cx, cy)
        page.mouse.down()
        page.mouse.move(cx + 40, cy - 60, steps=6)
        page.mouse.up()
        page.wait_for_timeout(60)
        r2 = wf()
        check("⑤ 往右拖 40px ⇒ 元素也往右 40px（方向不反）",
              abs((r2["x"] - r1["x"]) - 40) <= 3, f"Δx={r2['x'] - r1['x']:.0f}")
        check("⑤ 往上拖 60px ⇒ 元素也往上 60px（bottom 变大、不是变小）",
              abs((r1["y"] - r2["y"]) - 60) <= 3, f"Δy={r2['y'] - r1['y']:.0f}")

        st2 = page.evaluate(DOM_STATE)
        check("⑤ 拖拽改了 #waifu 的 left", st2["waifuLeft"] is not None and "px" in (st2["waifuLeft"] or ""),
              st2["waifuLeft"])
        check("⑤ 拖拽记下 dataset.waifuBottom（收起/唤回要按它还原）",
              st2["waifuBottomData"] is not None, st2["waifuBottomData"])

        # ③ 原路拖回来：往下 60、往左 40 —— 这一半量的是"另一个方向"，顺带把位置
        #    还原（后面收起/唤回那几步按 dataset.waifuBottom 走，停在半空会多一层变量）。
        page.mouse.move(cx + 40, cy - 60)
        page.mouse.down()
        page.mouse.move(cx, cy, steps=6)
        page.mouse.up()
        page.wait_for_timeout(60)
        r3 = wf()
        check("⑤ 原路拖回来（往下/往左同向）",
              abs(r3["x"] - r1["x"]) <= 3 and abs(r3["y"] - r1["y"]) <= 3,
              f"Δx={r3['x'] - r1['x']:.0f} Δy={r3['y'] - r1['y']:.0f}")

        # 收起（quit 工具是前五个里的最后一个）
        page.evaluate("() => document.getElementById('waifu-tool-quit').click()")
        page.wait_for_timeout(300)
        st3 = page.evaluate(DOM_STATE)
        check("⑤ 收起：waifu-active 摘掉、waifu-display 24h 标记写上",
              (not st3["active"]) and bool(st3["display"]), f"display={st3['display']}")
        page.wait_for_timeout(900)
        st4 = page.evaluate(DOM_STATE)
        check("⑤ 收起后加了 waifu-hidden 且唤回按钮亮起",
              st4["hidden"] and st4["toggle"] and st4["toggleActive"], st4)

        # 唤回
        page.evaluate("() => document.getElementById('waifu-toggle').click()")
        page.wait_for_timeout(400)
        st5 = page.evaluate(DOM_STATE)
        check("⑤ 唤回：waifu-active 回来、waifu-hidden 摘掉",
              st5["active"] and not st5["hidden"], st5)

        # ⑥ 聊天面板还在（渲染层替换不许连坐）
        check("⑥ 聊天面板仍被建出来（#waifu-chat）", st5["chatPanel"])
        page.evaluate("() => document.getElementById('waifu-tool-hitokoto').click()")
        page.wait_for_timeout(300)
        check("⑥ 点对话按钮能切到 active（跨模块的那条线没断）",
              page.evaluate("() => document.getElementById('waifu-chat').classList.contains('active')"))

        page.add_style_tag(path=str(ROOT / "frontend" / "src" / "index.css"))
        for mode in ("light", "dark"):
            page.evaluate("(d) => document.getElementById('waifu-chat')"
                          ".classList.toggle('washiDark', d)", mode == "dark")
            page.wait_for_timeout(120)
            m = page.evaluate(HL_PROBE)
            tint = contrast(m["chip"], m["panel"])
            legible = contrast(m["text"], m["chip"])
            check(f"⑦ [{mode}] 代码芯片与纸面看得出差别（旧实现这里是 1.07:1）",
                  tint >= 1.15, f"{tint:.2f}:1  chip={fmt(m['chip'])} panel={fmt(m['panel'])}")
            check(f"⑦ [{mode}] 芯片上的字读得清（WCAG 正文 4.5:1；旧实现夜里 1.09:1）",
                  legible >= 4.5, f"{legible:.2f}:1  text={fmt(m['text'])} chip={fmt(m['chip'])}")
        page.evaluate("() => document.getElementById('waifu-chat').classList.remove('washiDark')")

        for mode in ("light", "dark"):
            page.evaluate("(d) => document.getElementById('waifu-chat')"
                          ".classList.toggle('washiDark', d)", mode == "dark")
            page.wait_for_timeout(120)
            icons = page.evaluate(ICON_PROBE)
            worst = min(icons, key=lambda i: contrast(i["fill"], i["bg"])) if icons else None
            check(f"⑧ [{mode}] 面板里带图标的按钮都读得清（{len(icons)} 颗，≥3:1）",
                  worst is not None and contrast(worst["fill"], worst["bg"]) >= 3.0,
                  "" if worst is None else
                  f"最差 {worst['name']} {contrast(worst['fill'], worst['bg']):.2f}:1 "
                  f"icon={fmt(worst['fill'])} bg={fmt(worst['bg'])}")
        page.evaluate("() => document.getElementById('waifu-chat').classList.remove('washiDark')")

        mp = browser.new_page(viewport={"width": 390, "height": 844})
        mp.goto(url, wait_until="load")
        ok9 = wait(mp, "() => { const w = document.getElementById('waifu');"
                       " const t = document.getElementById('waifu-tool');"
                       " return !!(w && w.classList.contains('waifu-active') && t && t.children.length >= 5); }")
        check("⑨ 手机档 390×844 下初始化完成（角色 + 六个工具钮）", ok9)
        if ok9:
            wait(mp, "() => { const w = document.getElementById('waifu');"
                     " return !!(w && w.dataset.slideInOnce); }")
            mp.wait_for_timeout(2000)            # 等滑入动画走完（外框没到位时截图会落空）
            mimg = Image.open(io.BytesIO(mp.screenshot())).convert("RGB")
            (il, it, ir, ib), n9 = ink_bbox(mimg)
            print(f"      · 手机档角色墨迹 {n9} px，外接框 x{il}..{ir} y{it}..{ib}"
                  f"（{ir - il + 1}×{ib - it + 1}）")
            check("⑨ 手机档角色仍画得出来（非背景像素 > 3000；半尺寸下修前是 20791）",
                  n9 > 3000, n9)
            # 界都留了余量，因为模型**每隔一会儿有一次大动作**（抬手/跳跃，④ 段量过）。
            # 静态帧 x≤100 / y≥695；界给 140 / 640 —— 大动作那一帧也进不来。
            # 修前的 249 / 558（A 臂 248 / 546）离这两条界都还差得远。
            check("⑨ 角色墨迹右缘收到左半屏（≤140px；修前 248）", ir <= 140, f"右缘 {ir}")
            check("⑨ 角色整体下移到屏底（墨迹顶 ≥640px；修前 546）", it >= 640, f"顶 {it}")
            check("⑨ 墨迹没顶出视口", ir < 390 and ib <= 844, f"x{il}..{ir} y{it}..{ib}")

            # 布局盒必须**一个字都没动**：300×300 贴在 left:15 —— 这条是
            # "#waifu-chat 的定位基准没变"的代理判据（面板是 #waifu 的子节点，
            # 祖先一旦有 transform 就会改它的包含块；缩放只加在 #waifu-canvas 上）。
            mst = mp.evaluate(DOM_STATE)
            mbox = mp.evaluate("() => { const b = document.getElementById('waifu').getBoundingClientRect();"
                               " return [Math.round(b.left), Math.round(b.top),"
                               " Math.round(b.width), Math.round(b.height)]; }")
            check("⑨ #waifu 布局盒仍是 300×300 贴 left:15（对话面板的包含块没变）",
                  mbox[0] == 15 and mbox[2] == 300 and mbox[3] == 300, str(mbox))
            check("⑨ 画布**渲染**尺寸缩到 150×150（缩放真的落在 #waifu-canvas 上）",
                  mst["canvasW"] == 150 and mst["canvasH"] == 150,
                  f"{mst['canvasW']}×{mst['canvasH']}")
            check("⑨ #live2d 的 CSS 尺寸仍是 300×300（缩放是 transform，不是改盒模型）",
                  mst["canvasStyleW"] == "300px", str(mst["canvasStyleW"]))
            # 工具条要跟着缩小的角色走：锚在 300px 盒的右缘（A 臂视口 x294），
            # 缩小后必须挪到角色那一带，否则六个钮会飘在没有角色的空处。
            # 判据只写"挪到左边来了"（x≤140），**不写"在角色右缘之外"** ——
            # 后者会与大动作帧的墨迹右缘耦合（模型一抬手就红），而它想抓的只是"没重锚"。
            mtool = mp.evaluate("() => { const b = document.getElementById('waifu-tool')"
                                ".getBoundingClientRect();"
                                " return [Math.round(b.left), Math.round(b.top),"
                                " Math.round(b.right), Math.round(b.bottom)]; }")
            check("⑨ 工具条跟着角色重锚（左缘挪到角色那一带、仍在视口内；修前 294）",
                  0 < mtool[0] <= 140 and mtool[3] <= 844, str(mtool))

            box = {"boxL": mbox[0], "boxT": mbox[1], "boxR": mbox[0] + mbox[2],
                   "boxB": mbox[1] + mbox[3], "inkL": il, "inkT": it, "inkR": ir, "inkB": ib}
            hit = mp.evaluate(MOBILE_HIT, box)
            check("⑨ 角色身上的点是**点得中**的（正控：五点里这三点必须落回 #waifu）",
                  hit["body"] == ["waifu", "waifu"], str(hit["body"]))
            check("⑨ 盒子里没内容的地方点得到底下的正文（空白点都出 #waifu）",
                  hit["blank"] == ["out", "out", "out"], str(hit["blank"]))

            # 红基线：把放行撤掉（= 修前的行为），同样三个空白点必须**全被盒子吞掉**。
            # 没有这一步，"空白点全是 out"没法与"探针坏了/点根本没落在盒子里"区分开。
            mp.add_style_tag(content="#waifu { pointer-events: auto !important; }")
            hit_red = mp.evaluate(MOBILE_HIT, box)
            check("⑨ 红基线：撤掉放行后同样三个空白点全被 #waifu 吞掉（探针不是哑的）",
                  hit_red["blank"] == ["waifu", "waifu", "waifu"], str(hit_red["blank"]))
            mp.close()

        evil_url = url.replace(PAGE_PATH, EVIL_PATH)
        ep = browser.new_page(viewport={"width": 900, "height": 720})
        ep.goto(evil_url, wait_until="load")
        got_tips = wait(ep, "() => { const t = document.getElementById('waifu-tips');"
                            " return !!(t && t.textContent.includes('回归台标题B9')); }")
        check("⑩ 带标签的标题走到了欢迎语里（⑦ 的那条链路在，下面三条才有对象）", got_tips)
        if got_tips:
            t10 = ep.evaluate(TIPS_PROBE)
            # ① **值被转义**：DOM 里没有多出来的元素，原文以 `&lt;img` 的形态留在 innerHTML 里
            check("⑩ 标题里的 `<img …>` 没被解析成元素（#waifu-tips 里 0 个 img）",
                  t10["imgs"] == 0 and t10["bolds"] == 0,
                  f"imgs={t10['imgs']} b={t10['bolds']} html={repr(t10['html'])[:90]}")
            check("⑩ 原文还在，只是被转义（innerHTML 里是 &lt;img）",
                  bool(t10["html"]) and "&lt;img" in t10["html"], repr(t10["html"])[:90])
            # ② **模板自己那个 <span> 必须还在**——"把整段文案一起转义"也能让上面两条绿，
            #    但那样标题的强调色就没了（⑩ 判的是"转义值"，不是"转义一切"）
            check("⑩ 模板自带的 <span>（标题强调色）没被一起转义",
                  t10["spans"] == 1, f"spans={t10['spans']}")
            # ③ **onerror 没跑**：载荷里那个 handler 一次都没被触发
            check("⑩ 载荷里的 onerror 没有执行（window.__xss 未置位）",
                  t10["xss"] is None, repr(t10["xss"]))
            # 红基线：同一载荷、同一个探针，只把转义去掉 ⇒ 必须造出 <img> 且 onerror 真的跑。
            # 这一条同时证明载荷是活的、探针不是哑的、`window.__xss` 这个标记机制有效。
            ctl = ep.evaluate(XSS_CTL, EVIL_TITLE)
            ep.wait_for_timeout(400)      # onerror 要等 img 的加载失败事件
            xss_after = ep.evaluate("() => (typeof window.__xss === 'undefined') ? null : window.__xss")
            check("⑩ 红基线：同一载荷不转义时确实造出 <img> 且 onerror 跑起来",
                  ctl["imgs"] == 1 and ctl["bolds"] == 1 and xss_after == 1,
                  f"{ctl} xss={xss_after}")
        ep.close()

        browser.close()
    httpd.shutdown()
    return finish()


def finish():
    print()
    if FAILS:
        print(f"❌ 失败 {len(FAILS)} 项：")
        for f in FAILS:
            print("   - " + f)
        return 1
    print("✅ 全部通过")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
