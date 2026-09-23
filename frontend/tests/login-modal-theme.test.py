# -*- coding: utf-8 -*-
"""登录页弹窗**真 antd** 渲染验收（20260922）：底色 / 文字对比度 / 关闭图标 / 遮罩。

为什么另起一个脚本（而不是并进 login-page.test.py）：
  那个脚本把 antd 整个换成桩（只为断言结构与交互，快）；而本轮修的正是"弹窗看起来
  不对"，桩里没有 antd 的样式，量不出观感——**结构对了不等于接线对了**。
  这里不 alias antd，让它真渲染（antd v5 是 CSS-in-JS，无外部样式表要引），
  Playwright 里按 WCAG 相对亮度算对比度：底色够不够暗、字够不够亮，是数值判据不是眼感。

用法：python3 frontend/tests/login-modal-theme.test.py
注意：本机无中文字体（fc-list CJK = 0）⇒ 截图里的汉字是豆腐块，属环境限制；
      对比度与几何不受影响（量的都是颜色与盒模型）。
"""
import pathlib
import shutil
import subprocess
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[2]
FE = ROOT / "frontend"
LOGIN_SASS = "src/pages/Login/index.sass"

# `import.meta.env` 的替身（与 login-page / dark-mode-contrast / dashboard-sidebar 同一个串）
DEFINE = ('import.meta.env={"VITE_HTTP_BASEURL":"","VITE_CDN_BASEURL":"",'
          '"MODE":"production","DEV":false,"PROD":true,"BASE_URL":"/"}')

FAILS = []


def check(desc, cond, detail=""):
    print(("  ✅ " if cond else "  ❌ ") + desc + (f"  [{detail}]" if detail else ""))
    if not cond:
        FAILS.append(desc)


def build_sandbox() -> pathlib.Path:
    sb = pathlib.Path(tempfile.mkdtemp(prefix="login-modal-verify-"))
    shutil.copytree(FE / "src", sb / "src")
    (sb / "node_modules").symlink_to(FE / "node_modules")

    # 只桩边界（路由 / redux / 取 token / SEO），antd 与图标都用真的
    (sb / "src/apis/getToken.tsx").write_text(
        "const getToken = () => (window as any).__token ?? null;\nexport default getToken;\n", encoding="utf-8")
    (sb / "src/store/components/user.tsx").write_text(
        "export const fetchToken = (d: any) => ({ type: 'user/fetchToken', payload: d });\n", encoding="utf-8")
    (sb / "src/components/SeoHelmet.tsx").write_text(
        "const SeoHelmet = (_p: any) => null;\nexport default SeoHelmet;\n", encoding="utf-8")
    (sb / "src/pages/Login/deep-routes.tsx").write_text(
        "export const useNavigate = () => (to: string) => {"
        "(window as any).__nav = ((window as any).__nav || []).concat(to); };\n", encoding="utf-8")
    (sb / "entry.tsx").write_text('''\
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import Login from './src/pages/Login/index.tsx';
(window as any).__mount = () => createRoot(document.getElementById('root')!).render(<Login />);
''', encoding="utf-8")

    subprocess.run(["node", "-e",
                    "const s=require('sass');const r=s.compile(process.argv[1],{style:'expanded'});"
                    "require('fs').writeFileSync(process.argv[2],r.css);",
                    str(FE / LOGIN_SASS), str(sb / "login.css")],
                   cwd=str(FE), check=True)

    # react-router-dom / react-redux 用真包会拖进一堆运行时，仍走桩（与被测外观无关）
    (sb / "stub-router.tsx").write_text(
        "export const useNavigate = () => (to: string) => {"
        "(window as any).__nav = ((window as any).__nav || []).concat(to); };\n", encoding="utf-8")
    (sb / "stub-redux.tsx").write_text(
        "export const useDispatch = () => (a: any) => Promise.resolve({ status: 200, message: 'ok' });\n",
        encoding="utf-8")

    subprocess.run([str(FE / "node_modules/.bin/esbuild"), "entry.tsx",
                    "--bundle", "--format=iife", "--outfile=bundle.js",
                    "--loader:.sass=text", "--jsx=automatic",
                    # 20260924 起品牌区挂了 useViewerAvatar（经 utils/runtimeApi.ts 读
                    # import.meta.env）；iife 输出里 import.meta 是空对象 ⇒ 不给这个替身
                    # 就 `undefined.VITE_HTTP_BASEURL` 当场抛错、整页白屏。串与
                    # login-page / dark-mode-contrast 那几个沙箱保持一致。
                    f"--define:{DEFINE}",
                    f"--alias:react-router-dom={sb}/stub-router.tsx",
                    f"--alias:react-redux={sb}/stub-redux.tsx"],
                   cwd=str(sb), check=True, capture_output=True)

    (sb / "index.html").write_text(
        '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">'
        '<link rel="stylesheet" href="login.css"></head><body><div id="root"></div>'
        '<script src="bundle.js"></script><script>window.__mount && window.__mount();</script>'
        '</body></html>', encoding="utf-8")
    return sb


# 页面内注入：WCAG 相对亮度 + 对比度（含 alpha 合成到背景上的处理）
HELPERS = r"""
() => {
  const lum = (c) => {
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
  };
  const parse = (s) => (s.match(/[\d.]+/g) || []).map(Number);
  // 把带 alpha 的前景色合成到背景上（antd 的 mask/字色都带 alpha）
  const over = (fg, bg) => [0,1,2].map(i => fg[i] * (fg[3] ?? 1) + bg[i] * (1 - (fg[3] ?? 1)));
  const ratio = (fgS, bgS) => {
    const bg = parse(bgS);
    const fg = over(parse(fgS), bg);
    const [a, b] = [lum(fg), lum(bg)];
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  };
  const bgOf = (el) => {
    let n = el;
    while (n && n !== document.documentElement) {
      const c = getComputedStyle(n).backgroundColor;
      const p = parse(c);
      if (p.length >= 3 && (p[3] === undefined || p[3] > 0.9)) return c;
      n = n.parentElement;
    }
    return getComputedStyle(document.body).backgroundColor;
  };
  window.__lum = lum;
  window.__ratio = ratio;
  window.__bgOf = bgOf;
  window.__probe = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const cs = getComputedStyle(el);
    const bg = bgOf(el);
    return {
      color: cs.color,
      bg,
      ratio: ratio(cs.color, bg),
      lum: lum(parse(bg)),
      rect: el.getBoundingClientRect().toJSON(),
    };
  };
  // 渐变底的按钮：backgroundColor 是 transparent，走 bgOf 会一路走到弹窗底色
  // ⇒ 量出 1.00:1 这种"深字压深底"的假红。真要量的是"字压在渐变的那几段颜色上"，
  // 所以把 gradient 里每个色标都当一次背景，取**最差**的那一段（保守判据）。
  window.__probeGrad = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const cs = getComputedStyle(el);
    const stops = (cs.backgroundImage.match(/rgba?\([^)]+\)/g) || []);
    if (!stops.length) return window.__probe(sel);
    const rs = stops.map(s => ratio(cs.color, s));
    return { color: cs.color, stops, ratio: Math.min(...rs), perStop: rs };
  };
}
"""

SANDBOX = build_sandbox()
URL = SANDBOX.as_uri() + "/index.html"

from playwright.sync_api import sync_playwright  # noqa: E402

with sync_playwright() as p:
    br = p.chromium.launch()
    errs = []

    def fresh_page():
        """每个弹窗用**新开的页面**测：弹窗关了再开会有 antd 的退场动画与遮罩残留，
        点下一个入口会被上一个弹窗的输入框拦（实测 60 次重试都不通），不如各测各的。"""
        page = br.new_page(viewport={"width": 1280, "height": 900})
        page.on("pageerror", lambda e: errs.append(str(e)))
        page.goto(URL)
        page.evaluate(HELPERS)
        page.wait_for_timeout(300)
        return page

    print("① 注册弹窗（真 antd + ConfigProvider darkAlgorithm）")
    pg = fresh_page()
    pg.click(".login-links button:nth-child(3)")
    pg.wait_for_selector(".ant-modal-content", timeout=5000)
    pg.wait_for_timeout(500)

    check("真 antd 弹窗已挂载（.ant-modal-content）", pg.locator(".ant-modal-content").count() == 1)
    check("遮罩存在", pg.locator(".ant-modal-mask").count() == 1)
    card = pg.evaluate("() => window.__probe('.ant-modal-content')")
    check("弹窗底色是深色（相对亮度 < 0.15）", card and card["lum"] < 0.15, f'{card["bg"]} lum={card["lum"]:.3f}')
    title = pg.evaluate("() => window.__probe('.ant-modal-title')")
    check("标题对比度 ≥ 4.5:1", title and title["ratio"] >= 4.5, f'{title["ratio"]:.2f}:1')
    body = pg.evaluate("() => window.__probe('.login-modal-body')")
    check("正文对比度 ≥ 4.5:1", body and body["ratio"] >= 4.5, f'{body["ratio"]:.2f}:1')
    listItem = pg.evaluate("() => window.__probe('.login-modal-body li')")
    check("列表项对比度 ≥ 4.5:1", listItem and listItem["ratio"] >= 4.5, f'{listItem["ratio"]:.2f}:1')
    bold = pg.evaluate("() => window.__probe('.login-modal-body b')")
    check("高亮词（河灯金）对比度 ≥ 3:1", bold and bold["ratio"] >= 3, f'{bold["ratio"]:.2f}:1')
    close = pg.evaluate("() => window.__probe('.ant-modal-close')")
    check("关闭图标对比度 ≥ 3:1", close and close["ratio"] >= 3, f'{close["ratio"]:.2f}:1')
    btn = pg.evaluate("() => window.__probeGrad('.login-modal-primary')")
    check("页脚主按钮文字压金渐变可读（最差色标 ≥ 4.5:1）", btn and btn["ratio"] >= 4.5,
          f'{btn["ratio"]:.2f}:1 各色标 ' + ", ".join(f"{r:.1f}" for r in (btn or {}).get("perStop", [])))
    check("页脚只有一个出口（没有留言板按钮）",
          pg.locator(".login-modal-foot button").count() == 1
          and pg.locator(".login-modal-ghost").count() == 0)
    check("「知道了」水平居中（不与正文左边界对齐）", pg.evaluate(
        "() => {const f=document.querySelector('.login-modal-foot').getBoundingClientRect();"
        "const b=document.querySelector('.login-modal-foot button').getBoundingClientRect();"
        "return Math.abs((b.left + b.width/2) - (f.left + f.width/2)) <= 1;}"))
    reg = pg.locator(".login-modal-body").inner_text()
    check("合规声明与后端口径一致（发布需登录）",
          "发布功能需要登录" in reg and "无需登录" in reg and "河灯集" not in reg)
    mrect = pg.evaluate("() => document.querySelector('.ant-modal').getBoundingClientRect().toJSON()")
    check("弹窗不溢出视口", mrect["top"] >= 0 and mrect["bottom"] <= 900,
          f'top={mrect["top"]:.0f} bottom={mrect["bottom"]:.0f}')
    pg.screenshot(path="/tmp/login-modal-register.png")
    pg.close()

    print("② 重置密码弹窗（表单：输入框自身也要看得见）")
    pg = fresh_page()
    # 先在登录框写账号，再开弹窗：验"自动带入账号"这条真渲染路径（桩脚本另有一段锁同一行为）
    pg.fill("input#account", "sora")
    pg.click(".login-links button:nth-child(1)")
    pg.wait_for_selector(".login-reset-form input", timeout=5000)
    pg.wait_for_timeout(500)
    check("打开时带入了登录框里的账号",
          pg.input_value(".login-reset-form input") == "sora",
          pg.input_value(".login-reset-form input"))
    check("恢复码框仍为空（只带账号）", pg.input_value(".login-reset-form input >> nth=1") == "")
    inp = pg.evaluate("() => window.__probe('.login-reset-form input')")
    check("输入框文字对比度 ≥ 4.5:1", inp and inp["ratio"] >= 4.5, f'{inp["ratio"]:.2f}:1')
    check("输入框底色与弹窗底色不同（框看得见）",
          pg.evaluate(
              "() => {const a=getComputedStyle(document.querySelector('.login-reset-form input')).backgroundColor;"
              "const b=getComputedStyle(document.querySelector('.ant-modal-content')).backgroundColor;"
              "return a !== b;}"),
          pg.evaluate("() => getComputedStyle(document.querySelector('.login-reset-form input')).backgroundColor"))
    check("输入框有可见边框（宽度 ≥1px 且非透明）", pg.evaluate(
        "() => {const s=getComputedStyle(document.querySelector('.login-reset-form input'));"
        "return parseFloat(s.borderTopWidth) >= 1 && !s.borderTopColor.endsWith(', 0)');}"))
    sub = pg.evaluate("() => window.__probeGrad('.login-reset-form button')")
    check("提交按钮文字压金渐变可读（最差色标 ≥ 4.5:1）", sub and sub["ratio"] >= 4.5,
          f'{sub["ratio"]:.2f}:1 各色标 ' + ", ".join(f"{r:.1f}" for r in (sub or {}).get("perStop", [])))
    check("没有页脚（「取消」是多余的：X/遮罩/Esc 都能关）",
          pg.locator(".login-modal-foot").count() == 0)
    check("没有「拿不到恢复码」引导行（那条路本身要登录，走不通）",
          pg.locator(".login-modal-hint").count() == 0
          and "河灯集" not in pg.locator(".ant-modal-content").inner_text())
    close2 = pg.evaluate("() => window.__probe('.ant-modal-close')")
    check("关闭 X 是唯一出口且可见（对比度 ≥ 3:1）", close2 and close2["ratio"] >= 3, f'{close2["ratio"]:.2f}:1')
    check("提交按钮与输入框同宽同左边界（不是居中小按钮）", pg.evaluate(
        "() => {const i=document.querySelector('.login-reset-form input').getBoundingClientRect();"
        "const b=document.querySelector('.login-reset-form button').getBoundingClientRect();"
        "return Math.abs(i.left-b.left) <= 1 && Math.abs(i.width-b.width) <= 1;}"),
        pg.evaluate(
            "() => {const i=document.querySelector('.login-reset-form input').getBoundingClientRect();"
            "const b=document.querySelector('.login-reset-form button').getBoundingClientRect();"
            "return `input ${i.left.toFixed(0)}+${i.width.toFixed(0)} / btn ${b.left.toFixed(0)}+${b.width.toFixed(0)}`;}"))
    pg.screenshot(path="/tmp/login-modal-reset.png")
    pg.close()

    print("③ 密码显隐图标（真 antd 图标组件）")
    pg = fresh_page()
    check("无 JS 报错", not errs, "; ".join(errs[:2]))
    check("按钮内是真 EyeOutlined（.anticon-eye）", pg.locator(".pwd-toggle .anticon-eye").count() == 1)
    pg.click(".pwd-toggle")
    pg.wait_for_timeout(200)
    check("切换后变成 .anticon-eye-invisible", pg.locator(".pwd-toggle .anticon-eye-invisible").count() == 1)
    check("图标有尺寸（> 0，不是塌成 0×0）", pg.evaluate(
        "() => {const r=document.querySelector('.pwd-toggle svg').getBoundingClientRect();"
        "return r.width > 8 && r.height > 8;}"))
    pg.screenshot(path="/tmp/login-page-full.png")
    pg.close()

    # ④ 品牌区头像的尺寸与上下间距（20260924 用户反馈"有点小、与上方文本和下方输入框距离不协调"）。
    # 这一节必须在本套件量（**不桩 antd**）：边长来自 antd Avatar 的 size prop，打成 inline
    # width/height 落在 .ant-avatar 上——桩会把它吃掉，量出来永远是 0。
    print("④ 品牌区头像（尺寸 84 + 与标题/输入框的间距）")
    pg = fresh_page()
    # className 是直接传给 antd Avatar 的 ⇒ 根 span 自己就同时带 `.login-avatar` 与 `.ant-avatar`
    # （不是嵌套关系）。size prop 化成的 inline width/height 就在这个根元素上。
    pg.wait_for_selector(".ant-avatar.login-avatar", timeout=10000)
    geo = pg.evaluate(
        "() => {const a=document.querySelector('.login-avatar').getBoundingClientRect();"
        "const h=document.querySelector('.login-brand h2').getBoundingClientRect();"
        "const f=document.querySelector('.field').getBoundingClientRect();"
        "return {aw:a.width, ah:a.height, above:a.top-h.bottom, below:f.top-a.bottom,"
        " cx:a.left+a.width/2, bx:document.querySelector('.login-box').getBoundingClientRect()};}")
    check("头像边长 84（20260924 由 64 调大）",
          abs(geo["aw"] - 84) <= 1 and abs(geo["ah"] - 84) <= 1,
          f'{geo["aw"]:.1f}×{geo["ah"]:.1f}')
    check("与上方标题的间距 = 16",
          abs(geo["above"] - 16) <= 2, f'{geo["above"]:.1f}')
    check("与下方第一个输入框的间距 = 30（比上方大一档，块内不贴）",
          abs(geo["below"] - 30) <= 2, f'{geo["below"]:.1f}')
    check("头像在卡片里水平居中（与卡片中心偏差 ≤2px）",
          abs(geo["cx"] - (geo["bx"]["left"] + geo["bx"]["width"] / 2)) <= 2,
          f'头像中心 {geo["cx"]:.1f} / 卡片中心 {geo["bx"]["left"] + geo["bx"]["width"] / 2:.1f}')
    check("卡片仍是 400 宽、不溢出视口", abs(geo["bx"]["width"] - 400) <= 1
          and geo["bx"]["top"] >= 0 and geo["bx"]["bottom"] <= 900,
          f'{geo["bx"]["width"]:.0f} 高 {geo["bx"]["top"]:.0f}..{geo["bx"]["bottom"]:.0f}')
    pg.close()
    br.close()

shutil.rmtree(SANDBOX, ignore_errors=True)
print("\n截图：/tmp/login-modal-register.png、/tmp/login-modal-reset.png、/tmp/login-page-full.png")
print("（本机无中文字体，截图中汉字是豆腐块；颜色与几何判据不受影响）")
print("\n" + ("全部通过" if not FAILS else f"失败 {len(FAILS)} 项：" + "; ".join(FAILS)))
sys.exit(1 if FAILS else 0)
