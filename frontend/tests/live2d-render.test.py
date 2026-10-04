# -*- coding: utf-8 -*-
"""看板娘渲染层的**真浏览器行为锁**（20261001 开源前准备，渲染层替换前先落）。

为什么必须在上层真跑一遍：
  渲染层换了实现以后，**坏了不会报错**。模型没画出来时聊天面板照常工作、工具条照常
  在那儿、日志一行不红——用户看到的是"看板娘不见了"，而所有静态断言、所有 `*.test.mjs`
  都是绿的（它们只读源码文本，看不见一块空画布）。20260923 那次"三跳全绿、UI 上什么
  都没有"是同一族教训。所以这条锁跑的是**真页面 + 真模型 + 真 WebGL**，断言落在像素与
  计算样式上。

它锁的是"渲染层对外的契约"，不是"渲染层怎么实现的"——所以上游实现（waifu-tips +
chunk）与自研实现（pixi-live2d-display）都必须全绿，替换前后各跑一次，前后都绿才算
换对了。契约为五组：

  ① DOM 骨架与外接框：#waifu/#waifu-tips/#waifu-canvas/canvas#live2d 的存在、顺序、
     尺寸。**#live2d 必须是 300×300、#waifu 必须恒 300px 高**——后者是 20260828 那次
     "收起→展开中间态 canvas 塌陷、面板掉到按钮位置"的回归锁。
  ② 工具条：前五个按钮的顺序与形态（switch-model / switch-texture / photo / info / quit），
     第六个 `hitokoto` 是 chat-stream.js **追加**的对话开关（渲染层只负责前五个）。
  ③ **角色真的画在画布上**：截图数非背景像素。这一条是整条锁的核心——其余都可能在
     "画布全白"的同时全绿。
  ④ 口型接口：`__setMouthOpen` / `__setMouthClose` / `window.__mouthOverride` 三个名字
     是 chat-stream.js 直接写的（流式输出时控制口型），签名与净效果一字不能改；
     断言落在"嘴巴真的动了"（画面差异）而不是"变量被赋值了"。
     **只在动画不动的像素上比**（静止掩膜，做法与实测数字见 ④ 段注释）。
  ⑤ 入场/拖拽/收起唤回：dataset.slideInOnce、dataset.waifuBottom、waifu-active /
     waifu-hidden / waifu-toggle-active 四个类、`waifu-display` 这个 24h 标记。
     这些是 boot.js 与 widget.css 两边共同依赖的对外状态。

用法：python3 frontend/tests/live2d-render.test.py
依赖：playwright(python) + Pillow（见 tests/requirements.txt），以及
      `npm run vendor:live2d` 就位过的三份运行时产物（缺了会明确报出来，不是猜）。
"""
import functools
import http.server
import io
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


# ── 前置：三份运行时产物必须在场（不在场时给的是"去跑哪条命令"，不是一片红）──
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
        if path in ("/", PAGE_PATH):
            # 版本号照抄 boot.js 的 VER：入口改版后这里跟着换，测试永远加载"本代"入口
            ver = ""
            try:
                src = (WIDGET / "boot.js").read_text(encoding="utf-8")
                ver = src.split("const VER = '")[1].split("'")[0]
            except Exception:
                pass
            body = HARNESS.replace("%TITLE%", TITLE).replace("__VER__", ver).encode("utf-8")
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


# ── 像素工具：数"不是背景色"的像素 ────────────────────────────────────────────
def shot(page, box):
    return Image.open(io.BytesIO(page.screenshot(clip=box))).convert("RGB")


def ink(img, bg=(255, 255, 255), tol=12):
    """非背景像素数（背景是白 body；tol 吃掉抗锯齿与压缩噪声）"""
    px = img.getdata()
    return sum(1 for p in px if abs(p[0] - bg[0]) > tol or abs(p[1] - bg[1]) > tol or abs(p[2] - bg[2]) > tol)


# ── ⑦ 用的探针：把一段行内代码塞进真气泡，量它的底与字 ────────────────────────
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

        # ── 初始化闸门 ────────────────────────────────────────────────────
        # #live2d 只是骨架先到，**五个工具按钮与 waifu-active 在模型加载完之后才出现**
        # （上游 registerTools 跟在 loadModel 后面；自研实现同理）。提前采样会把
        # "还没初始化完"读成"这一条坏了"——这个套件 20261001 首跑就踩了这个坑。
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

        # ── ① DOM 骨架与外接框 ────────────────────────────────────────────
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

        # ── ② 工具条 ──────────────────────────────────────────────────────
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

        # ── ③ 角色真的画出来了 ────────────────────────────────────────────
        check("③ 模型加载完成（滑入闸门已放行）",
              wait(page, "() => { const w = document.getElementById('waifu');"
                         " return !!(w && w.dataset.slideInOnce); }"))
        page.wait_for_timeout(1400)          # 等滑入动画（800ms）走完
        # 外接框必须**滑到位之后**再取：滑入前 #waifu 停在 bottom:-500px，
        # 画布的 rect 落在视口之外，clip 截图会直接报"区域在图像外"（首跑踩过）
        box = page.locator("#live2d").bounding_box()
        img = shot(page, box)
        n_ink = ink(img)
        print(f"      · 画布非背景像素 {n_ink} / {img.width * img.height}")
        check("③ 画布上有角色（非背景像素 > 5000）", n_ink > 5000, n_ink)

        # ── ④ 口型接口（chat-stream.js 直接写这三个名字）────────────────────
        check("④ __setMouthOpen / __setMouthClose 都在", st["hasMouthApi"])
        check("④ __mouthOverride 初值 = -1（交还空闲动画）", st["mouth"] == -1, st["mouth"])

        # 判据为什么要绕这么大一圈——**看板娘身上一直有动画，而且比嘴巴大得多**。
        # 这个模型挂着六个以 performance.now() 为时钟的循环动画参数（ParamTail /
        # Param3 / ParamDaiMao / ParamHairFront / ParamHairSide / ParamEyeL|ROpen，周期
        # 3.0 / 3.8 / 4.5 / 5.0 / 7.5 / 8.8 秒），尾巴和头发一直在摆 ⇒ 整幅画布的墨迹
        # 在两秒里能漂 ±600，而"张嘴"只值 +40 上下。20261001 实测四种估计器
        # （逐帧差分 / 中位图 / 长批次均值 / 相邻张配对）**全被这层噪声淹掉**：
        # "open − close" 在 −739..+665 之间随机翻符号，因为漂移是准周期的、批次落在哪个
        # 相位就偏向哪边。**冻时钟也不行**（cubism 自己的 update 同样读 performance.now，
        # 冻住等于整个渲染停摆，口型跟着不动）。
        #
        # 两条出路都不选"更长的平均"，而是**换统计量 + 只看静止的像素**：
        #   ① 静止掩膜：先拿 14 对"同状态对"（close vs close）求每个像素的最大灰度变化，
        #      ≤6 的算静止。实测掩膜占 95% 的像素（动的只有尾巴/头发那一小块）。掩膜
        #      松一寸噪声涨一大截——8 对时噪声极差 300，14 对只剩 10，所以这个 14 不能省。
        #   ② 判据 = 掩膜内**灰度变化超过 24 级**的像素数，而不是"墨迹增减"。嘴腔那几十个
        #      像素是**整块翻色**，动画漏进来的像素只是边缘抖动。
        #   ③ 取**中位数**而不是均值。这个模型每隔一会儿有一次大动作（实测某一对会整体
        #      跳 300~400 像素，噪声对信号对都中招），均值被单个离群对拉垮：20261001 实测
        #      同一批数据噪声均值 0.2~19.1 乱跳、而中位恒 ≤4；信号中位 49~59、16 对里
        #      15 对一模一样是 49。**中位数让噪声那一列的离群值完全失效**。
        # 实测跨 4 遍：噪声中位 0/4/0/0，张嘴中位 49/59/49/49，直接写 49/52/49/49。
        # 同批数据换成"墨迹增减"或均值，噪声与信号区间直接重叠，判不了。
        # 掩膜是每次跑的时候现算的 ⇒ 锁的是"口型能改动画面"，不是"这个模型的脸在哪"。
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
        mask = [v <= 6 for v in mx]          # 阈值 6：同状态两张实测逐像素相同，留点余量
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
        gate = max(25, 5 * nz)               # 噪声底自校准（实测噪声中位恒 ≤4）
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

        # ── ⑤ 入场 / 拖拽 / 收起唤回 ──────────────────────────────────────
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

        # 拖拽（20261002 整改）。旧判据只问"left 变了没有"，而它对**两种真缺陷都是绿的**：
        #   · 拖反方向 —— 位置照样变，只是往反的走；
        #   · 点一下原地不动却"飞上去" —— 一次按下/抬起之间只要有 1px 抖动就会走到
        #     旧的 `bottom = clientY - offsetY`（把绝对坐标当成了"从视口底量的偏移"），
        #     算出来的值恰好被钳到上限 ⇒ 元素直接顶到视口顶。**位置也变了。**
        # 所以判据必须量**方向**与**原地不动的 Δ**，不能只量"变了没有"。
        # mousedown 必须落在 canvas 上（#waifu 上的监听自己判 target）。
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

        # ── ⑥ 聊天面板还在（渲染层替换不许连坐）────────────────────────────
        check("⑥ 聊天面板仍被建出来（#waifu-chat）", st5["chatPanel"])
        page.evaluate("() => document.getElementById('waifu-tool-hitokoto').click()")
        page.wait_for_timeout(300)
        check("⑥ 点对话按钮能切到 active（跨模块的那条线没断）",
              page.evaluate("() => document.getElementById('waifu-chat').classList.contains('active')"))

        # ── ⑦ 气泡里的行内代码：两档都要读得出来（20261002 主人报的第三条）──────
        # 报的是「白日看不出高亮痕迹、夜间高亮直接糊住文本」。两者是同一个洞的两面：
        # `.chat-msg.agent .msg-text code` 的底是**写死的 #f5f5f5**，没跟 .washiDark 翻
        # ⇒ 白日 #f5f5f5 压在纸面 #fffdfa 上只有 1.07:1（看不出），夜里浅底压浅字
        # #f3e8f6 只有 1.09:1（字没了）。判据因此要**两个对比度都量**，且两档都量。
        # 底色是半透明的 ⇒ 必须把祖先逐层复合成屏幕上真正的那个颜色再算，直接读
        # getComputedStyle 拿到的是 rgba 字面量，算出来的对比度是假的。
        # ⚠️ 深色档的令牌**不住在本文件加载的那张表里**：`--washi-paper` 等定义在
        # `frontend/src/index.css`（真页面由 main.tsx 引入）。不把它引进来，`.washiDark`
        # 就只翻了一半——面板底色仍落回 widget.css 里的浅色兜底，量出来的"深色档"是
        # 一个生产上不存在的状态。那正是本仓记过的那类假绿（"全局规则不在场 ⇒ 把没生效
        # 读成页面缺陷"，反过来也一样能把缺陷读成正常）。所以按真页面把令牌表引进来。
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

        # ── ⑧ 面板里带图标的按钮：两档都得读得清（20261005）────────────────────
        # 报的是「夜间模式侧边栏的选择图片按钮图标看不清」。它不是配色没跟上主题，而是
        # **那颗 `<button>` 自己没写 `color`**：表单控件的 UA 样式表给的是
        # `color: buttontext`（元素上的具名值、不是继承值）⇒ 外层 `#waifu-chat` 的
        # `color: var(--washi-ink)` 传不进去，恒解析成黑。上面那条
        # `#waifu-chat svg path { fill: currentColor }` 本意是"让图标跟着各自按钮的 color
        # 走"，遇上它就跟着黑走了 —— 白日黑压粉纸看不出问题（15:1），夜里黑压深紫纸面
        # 只有 1.69:1。判据因此**只能落在真浏览器算出来的色上**：源码里 `fill="#203042"`
        # 明明写着深蓝，静态断言看不出它已经被 CSS 盖掉。地板取 3:1，与
        # `dark-mode-contrast.test.py` 同一把尺。
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
