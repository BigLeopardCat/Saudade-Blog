# -*- coding: utf-8 -*-
"""登录页无头验收（20260921 改版）：结构 / 几何 / 聚焦样式 / 弹窗交互 / 提交契约。

跳转契约（20260922）也在这里锁：管理员 token → /dashboard，普通用户/无 token → /。
两岔都要在，只锁一岔就会漏掉"普通用户被送进后台吃一次无权限再弹回来"那类问题。

**昼夜两档（20261006 用户第 3 条）**：这一页从前恒深色，现在跟随全站
（白天 = 主页那套和纸配色，夜间 = 原来的墨蓝 + 河灯金，见 src/pages/Login/index.sass
的头注）。判据因此分两套夹具跑：主页面**不带 isDarkMode**（= 全站默认的白天档），
另开一个 `pg_d` 在挂载前写 `localStorage.isDarkMode = 'true'` 当夜间夹具。
③ 那一节里量色值的那几条因此住到 `pg_d` 上 —— 它们量的正是"夜间档还是原来那副样子"。

本机不能 vite build（3.7GB 内存会 OOM，见 CLAUDE.md §2），沿用既定替代手段：
  · sass 用 programmatic API 编译（`node_modules/.bin/sass` 在 Node 18 上会因
    chokidar 的 ERR_REQUIRE_ESM 直接崩，别用 CLI）；
  · esbuild 把**真组件**打成一个 bundle，配桩掉 antd / react-router-dom /
    react-redux / 取 token 与 fetchToken 的模块（只桩边界，不桩被测逻辑）；
  · 真 react-dom 渲染 → Playwright 断言。

用法（仓库任意位置）：python3 frontend/tests/login-page.test.py
依赖：frontend/node_modules（esbuild + react + react-dom）、playwright（python）。
"""
import base64
import json
import pathlib
import re
import shutil
import subprocess
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[2]          # 仓库根
FE = ROOT / "frontend"
LOGIN_SASS = "src/pages/Login/index.sass"

# `import.meta.env` 的替身（与 dark-mode-contrast / dashboard-sidebar / notes-list-ui 同一个串）。
# 必须显式给：esbuild 的 iife 输出里 `import.meta` 是空对象，`import.meta.env.X` 会当场
# **抛 TypeError**——20260924 品牌区接上 useViewerAvatar（它经 utils/runtimeApi.ts 读 env）
# 那一刻起，这一页整页白屏、所有断言连"元素在不在"都问不出来。
DEFINE = ('import.meta.env={"VITE_HTTP_BASEURL":"","VITE_CDN_BASEURL":"",'
          '"MODE":"production","DEV":false,"PROD":true,"BASE_URL":"/"}')

FAILS = []


def check(desc, cond, detail=""):
    print(("  ✅ " if cond else "  ❌ ") + desc + (f"  [{detail}]" if detail else ""))
    if not cond:
        FAILS.append(desc)


def _lum(rgb):
    """WCAG 2.x 相对亮度（传 0-255 三元组）。"""
    def f(c):
        c = c / 255
        return c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4
    r, g, b = (f(v) for v in rgb)
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def contrast_ratio(fg, bg):
    a, b = _lum(fg), _lum(bg)
    hi, lo = max(a, b), min(a, b)
    return (hi + 0.05) / (lo + 0.05)


def jwt_with_role(role: str) -> str:
    """造一个 payload 段合法的 JWT。前端 `isAdminToken`（src/utils/auth.ts）只解码 payload
    的 role 来做界面分流、**不验签**（真正的授权在 Rust），所以签名段可以是假的。
    用途：登录页自 20260922 起跳转分两岔——管理员 token → /dashboard，其余 → /，两条都要锁。"""
    payload = base64.urlsafe_b64encode(
        json.dumps({"sub": 721, "role": role}).encode()).decode().rstrip("=")
    return "x." + payload + ".y"


# ── ① 搭沙箱：拷贝 src、就地替换四个边界模块、软链 node_modules ──────────
def build_sandbox() -> pathlib.Path:
    sb = pathlib.Path(tempfile.mkdtemp(prefix="login-verify-"))
    shutil.copytree(FE / "src", sb / "src")
    (sb / "node_modules").symlink_to(FE / "node_modules")
    stubs = sb / "stubs"
    stubs.mkdir()

    (stubs / "antd.tsx").write_text('''\
// 极简 antd stub（只覆盖 Login 用到的 Modal / message / ConfigProvider）：真渲染 DOM，
// 便于无头断言。ConfigProvider 只记录 props——真 antd 的深色是 CSS-in-JS 注入的，
// 沙箱里没有它的样式表，所以能验的是**接线**（主题有没有传下去），不是最终观感。
import * as React from 'react';
export const __msgLog: string[] = [];
(window as any).__msgLog = __msgLog;
export const message = {
    useMessage: () => [
        {
            success: (t: string) => __msgLog.push('success:' + t),
            error: (t: string) => __msgLog.push('error:' + t),
            warning: (t: string) => __msgLog.push('warning:' + t),
        },
        null,
    ],
};
export const theme = { darkAlgorithm: '__DARK_ALGORITHM__' };
// 品牌区那个头像（20260924 起占位）用。桩按**真 antd v5 的形状**渲染：有 src 时是
// <span class="ant-avatar ...className"><img src alt></span>——className 落在 span、src 落在
// 内层 img。桩若图省事把 src 直接放 span 上，断言就会锁在一个真页面不存在的形状上。
export const Avatar = (props: any) =>
    React.createElement(
        'span',
        { className: ['ant-avatar', 'ant-avatar-circle', props.className].filter(Boolean).join(' ') },
        props.src ? React.createElement('img', { src: props.src, alt: props.alt }) : null,
    );
export const __cpThemes: any[] = [];
(window as any).__cpThemes = __cpThemes;
export const ConfigProvider = (props: any) => {
    __cpThemes.push(props.theme);
    return React.createElement(React.Fragment, null, props.children);
};
export const __modalCalls: any[] = [];
export const Modal = (props: any) => {
    __modalCalls.push({ open: !!props.open, title: props.title });
    if (!props.open) return null;
    return React.createElement(
        'div', { className: 'ant-modal-mock', 'data-title': props.title, role: 'dialog' },
        React.createElement('div', { className: 'ant-modal-title' }, props.title),
        // 真 antd 的关闭 X：重置密码弹窗现在没有页脚，关窗只能靠它/遮罩/Esc ⇒ 桩里必须有
        React.createElement('button', { className: 'ant-modal-close', onClick: props.onCancel }, '×'),
        React.createElement('div', { className: 'ant-modal-body' }, props.children),
        props.footer ? React.createElement('div', { className: 'ant-modal-footer' }, props.footer) : null,
    );
};
''', encoding="utf-8")

    (stubs / "router.tsx").write_text('''\
// navigate 必须是**稳定引用**——真 react-router 的 useNavigate 就是稳定的（内部 useCallback）。
// Login 里 useEffect(..., [navigate]) 依赖它：桩若每次渲染返回新函数，那个 effect 会跟着
// 每次 re-render 重跑（每跳一次都多记一笔），"跳了几次/跳去哪"就再也量不准。
const nav = (to: string) => {
    (window as any).__nav = ((window as any).__nav || []).concat(to);
};
export const useNavigate = () => nav;
''', encoding="utf-8")

    (stubs / "redux.tsx").write_text('''\
export const useDispatch = () => (action: any) => {
    (window as any).__actions = ((window as any).__actions || []).concat(action);
    return Promise.resolve({ status: (window as any).__loginStatus ?? 200, message: 'ok' });
};
''', encoding="utf-8")

    (sb / "src/apis/getToken.tsx").write_text(
        "const getToken = () => (window as any).__token ?? null;\nexport default getToken;\n", encoding="utf-8")
    (sb / "src/store/components/user.tsx").write_text(
        "export const fetchToken = (data: any) => ({ type: 'user/fetchToken', payload: data });\n", encoding="utf-8")
    (sb / "src/components/SeoHelmet.tsx").write_text(
        "const SeoHelmet = (_p: any) => null;\nexport default SeoHelmet;\n", encoding="utf-8")
    (sb / "entry.tsx").write_text('''\
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import Login from './src/pages/Login/index.tsx';
(window as any).__mount = () => createRoot(document.getElementById('root')!).render(<Login />);
''', encoding="utf-8")

    # ② sass 编译（programmatic API；CLI 在 Node 18 上崩）
    subprocess.run(["node", "-e",
                    "const s=require('sass');const r=s.compile(process.argv[1],{style:'expanded'});"
                    "require('fs').writeFileSync(process.argv[2],r.css);",
                    str(FE / LOGIN_SASS), str(sb / "login.css")],
                   cwd=str(FE), check=True)
    # ②b 全站令牌（`src/index.css` 的 `:root` 与夜间档）。
    # **必须一起引**：登录页自 20261006 起用 `--washi-*` 分昼夜两档，不引这份的话
    # `getComputedStyle` 拿到的是 `var()` 的**回退值**（写在各处的字面量）——白天那几条
    # 断言会变成"量回退值"，改令牌也照样绿，是一条假绿的判据。
    shutil.copyfile(FE / "src/index.css", sb / "tokens.css")

    # ③ esbuild 打包（.sass 的裸 import 会被 text loader 吞掉，CSS 由页面单独引入）
    subprocess.run([str(FE / "node_modules/.bin/esbuild"), "entry.tsx",
                    "--bundle", "--format=iife", "--outfile=bundle.js",
                    "--loader:.sass=text", "--jsx=automatic", f"--define:{DEFINE}",
                    f"--alias:antd={stubs}/antd.tsx",
                    f"--alias:react-router-dom={stubs}/router.tsx",
                    f"--alias:react-redux={stubs}/redux.tsx"],
                   cwd=str(sb), check=True, capture_output=True)

    (sb / "index.html").write_text(
        '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">'
        '<link rel="stylesheet" href="tokens.css">'
        '<link rel="stylesheet" href="login.css"></head><body><div id="root"></div>'
        '<script src="bundle.js"></script><script>window.__mount && window.__mount();</script>'
        '</body></html>', encoding="utf-8")
    return sb


SANDBOX = build_sandbox()
URL = SANDBOX.as_uri() + "/index.html"

from playwright.sync_api import sync_playwright  # noqa: E402

with sync_playwright() as p:
    br = p.chromium.launch()
    pg = br.new_page(viewport={"width": 1280, "height": 900})
    errs = []
    pg.on("pageerror", lambda e: errs.append(str(e)))
    pg.goto(URL)
    pg.wait_for_timeout(400)

    print("① 结构（旧页面的霓虹锚点应已不存在）")
    check("无 JS 运行时报错", not errs, "; ".join(errs[:2]))
    check(".login-box 存在", pg.locator(".login-box").count() == 1)
    check("标题 Saudade Blog", "Saudade Blog" in pg.locator(".login-brand h2").inner_text())
    # 20260924：品牌区那行小字「登录后体验完整服务」换成访客自己的三态头像（同一个
    # useViewerAvatar）。旧断言锁的是已被删掉的那行字 ⇒ 当轮改判据，不是删断言：
    # 这一页从没登录过（无 token、localStorage 空）⇒ 三态里的第③态 = 默认头像。
    check("品牌区小字已撤（不再有 .login-sub）", pg.locator(".login-sub").count() == 0)
    check("品牌区是头像（.login-avatar 一个）", pg.locator(".login-avatar").count() == 1)
    check("新访客 → 默认头像 /default-avatar.png",
          pg.get_attribute(".login-avatar img", "src") == "/default-avatar.png",
          str(pg.get_attribute(".login-avatar img", "src")))
    check("可见 label：账号 / 密码",
          [t.strip() for t in pg.locator(".field label").all_inner_texts()] == ["账号", "密码"])
    check("两个输入框 id 正确", pg.locator("input#account").count() == 1 and pg.locator("input#password").count() == 1)
    check("密码框 type=password", pg.get_attribute("input#password", "type") == "password")
    check("旧版霓虹锚点已移除（form 内无 <a>）", pg.locator(".login-box form a").count() == 0)
    check("提交按钮存在且文案=登 录", pg.locator("button.login-submit").inner_text().strip() == "登 录")
    check("两个入口按钮：忘记密码？/ 注册账号",
          [t.strip() for t in pg.locator(".login-links button").all_inner_texts()] == ["忘记密码？", "注册账号"])
    check("返回首页入口存在且不带箭头",
          pg.locator(".login-foot a").inner_text().strip() == "返回首页",
          pg.locator(".login-foot a").inner_text().strip())

    print("①b 头像第②态：退出登录但本机挂过账号 → 仍是那个账号的头像")
    # 登录页正是"退出后落回"的地方——令牌是自包含的，过期和退出在浏览器侧长得一样，
    # 展示身份不该跟着失忆（三态判据与缓存见 components/UserCenter/identity.ts）。
    # 新开一个 page 而不是改上面那个：这份缓存必须在挂载前就位（useViewerAvatar 的初始
    # state 在挂载时读一次 localStorage），已跑起来的 page 改了也不会重读。
    # 顺带锁"未登录不为一张头像打后端"——见 identity.ts 的 pull()。
    AVATAR_2 = "/api/protect/download/avatar-sora-20260922.png"
    pg_b = br.new_page(viewport={"width": 1280, "height": 900})
    reqs_b = []
    pg_b.on("request", lambda r: reqs_b.append(f"{r.resource_type} {r.url}"))
    pg_b.add_init_script(
        "localStorage.setItem('saudade.lastUser', JSON.stringify({"
        "username:'sora', nickname:'', "
        f"avatar:{json.dumps(AVATAR_2)}, at:'2026-09-24 00:00:00'}}));")
    pg_b.goto(URL)
    pg_b.wait_for_timeout(400)
    check("上次那个账号的头像（不是默认头像）",
          pg_b.get_attribute(".login-avatar img", "src") == AVATAR_2,
          str(pg_b.get_attribute(".login-avatar img", "src")))
    check("未登录不发资料请求",
          not [u for u in reqs_b if "protected/profile" in u],
          json.dumps(reqs_b, ensure_ascii=False)[:200])

    # ①c 头像跟着输入框走（20260924 拍板：**只认本机登录过的账号**）。用户报的是"换账号输入时，
    # 头像还是显示上次账号的头像"。治本不能是"按输入的名字去后端查头像"——那等于给所有人一个
    # 账号枚举 oracle（输 sora 出猫头像、输 soraa 出默认 ⇒ 一次请求就知道账号存不存在）。
    # 所以判据全是**本地**的：命中本机那份清单才显示它的头像，一偏离就回默认。
    # 这一节同时还锁**旧数据兼容**：上面只写了 `saudade.lastUser`、没有清单（= 20260924 之前的
    # 老访客的浏览器），读侧要能用它合成清单——不然升级那一刻所有人都认不出来。
    def avatar_src(page):
        return page.get_attribute(".login-avatar img", "src")

    pg_b.fill("input#account", "sora")
    pg_b.wait_for_timeout(200)
    check("输入的就是本机记住的账号 → 仍是那张头像", avatar_src(pg_b) == AVATAR_2, str(avatar_src(pg_b)))
    pg_b.fill("input#account", "  SORA ")
    pg_b.wait_for_timeout(200)
    check("两侧空白 + 大小写在展示层宽容匹配（真正的账号语义在后端）",
          avatar_src(pg_b) == AVATAR_2, str(avatar_src(pg_b)))
    pg_b.fill("input#account", "other-user")
    pg_b.wait_for_timeout(200)
    check("输入的是**别的**账号 → 立刻退回默认头像",
          avatar_src(pg_b) == "/default-avatar.png", str(avatar_src(pg_b)))
    # 判据只看 xhr/fetch：**"查名字"这条路上只可能是 XHR**，而页面自己加载头像图片
    # （`<img>` → image 请求）不算查询——那正是"头像只来自本地缓存"的表现。
    check("整段打字过程零 XHR（不存在「按输入的名字去查」这种请求）",
          not [u for u in reqs_b if u.startswith(("xhr", "fetch"))],
          json.dumps(reqs_b, ensure_ascii=False)[:300])
    pg_b.fill("input#account", "")
    pg_b.wait_for_timeout(200)
    check("清空输入 → 回到「本机挂着的那个账号」（与头部第②态同语义）",
          avatar_src(pg_b) == AVATAR_2, str(avatar_src(pg_b)))
    pg_b.close()

    # ①d 清单（20260924 用户实测报回来的洞）：这台机器上登录过**不止一个**账号时，输上一个用过的
    # 账号也该认出它自己那张头像——先前只记了最近一个（`saudade.lastUser`），于是"换账号输入"
    # 永远只能得到默认头像。这里预置**两条**（较新的 kohaku、较旧的 sora），三条断言分别锁：
    # 认得较旧的那个 / 认得较新的那个 / 认不得的仍回默认。
    print("①d 本机登录过的多个账号：输哪个认哪个（清单，不是只记最近一个）")
    AVATAR_3 = "/api/protect/download/avatar-kohaku-20260924.png"
    pg_c = br.new_page(viewport={"width": 1280, "height": 900})
    reqs_c = []
    pg_c.on("request", lambda r: reqs_c.append(f"{r.resource_type} {r.url}"))
    pg_c.add_init_script(
        "localStorage.setItem('saudade.knownUsers', JSON.stringify(["
        f"{{username:'kohaku', nickname:'', avatar:{json.dumps(AVATAR_3)}, at:'2026-09-24 01:00:00'}},"
        f"{{username:'sora', nickname:'', avatar:{json.dumps(AVATAR_2)}, at:'2026-09-20 01:00:00'}}"
        "]));"
        "localStorage.setItem('saudade.lastUser', JSON.stringify({"
        f"username:'kohaku', nickname:'', avatar:{json.dumps(AVATAR_3)},"
        " at:'2026-09-24 01:00:00'}));")
    pg_c.goto(URL)
    pg_c.wait_for_timeout(400)
    check("空输入 → 清单里最近那个（kohaku）", avatar_src(pg_c) == AVATAR_3, str(avatar_src(pg_c)))
    pg_c.fill("input#account", "sora")
    pg_c.wait_for_timeout(200)
    check("输较**旧**的那个账号 → 认出来的是它自己那张头像（别再拿最近那个顶上）",
          avatar_src(pg_c) == AVATAR_2, str(avatar_src(pg_c)))
    pg_c.fill("input#account", "kohaku")
    pg_c.wait_for_timeout(200)
    check("输较新的那个账号 → 它自己的头像", avatar_src(pg_c) == AVATAR_3, str(avatar_src(pg_c)))
    pg_c.fill("input#account", "nobody-here")
    pg_c.wait_for_timeout(200)
    check("清单里没有的账号 → 默认头像（绝不按名字去后端查）",
          avatar_src(pg_c) == "/default-avatar.png", str(avatar_src(pg_c)))
    check("清单比对全程零 XHR",
          not [u for u in reqs_c if u.startswith(("xhr", "fetch"))],
          json.dumps(reqs_c, ensure_ascii=False)[:300])
    pg_c.close()

    print("② 几何（居中 + 不溢出）")
    box = pg.locator(".login-box").bounding_box()
    check("卡片宽 = 400", abs(box["width"] - 400) <= 1, f'{box["width"]:.1f}')
    check("水平居中（中心偏差 ≤2px）", abs((box["x"] + box["width"] / 2) - 640) <= 2,
          f'中心 {box["x"] + box["width"] / 2:.1f}')
    check("垂直居中（偏差 ≤4px）", abs((box["y"] + box["height"] / 2) - 450) <= 4,
          f'中心 {box["y"] + box["height"] / 2:.1f}')
    check("不超出视口", box["y"] >= 0 and box["y"] + box["height"] <= 900, f'底 {box["y"] + box["height"]:.1f}')
    check("输入框不溢出卡片", pg.evaluate(
        "() => {const b=document.querySelector('.login-box').getBoundingClientRect();"
        "const i=document.querySelector('input#account').getBoundingClientRect();"
        "return i.left>=b.left && i.right<=b.right;}"))

    print("③ 样式生效 · 白天档（这一页没写 isDarkMode ⇒ 走全站默认的白天）")
    # 账号框有 autoFocus ⇒ 量"未聚焦"必须先 blur（否则两次都读到聚焦态，这条会假绿）
    pg.evaluate("() => document.activeElement && document.activeElement.blur()")
    pg.wait_for_timeout(350)

    def styles(page, sel, pseudo=None, props=("borderTopColor",)):
        return page.evaluate(
            """([sel, pseudo, props]) => {
                 const el = document.querySelector(sel);
                 const cs = getComputedStyle(el, pseudo);
                 const o = {}; props.forEach(p => o[p] = cs[p]); return o;
               }""", [sel, pseudo, list(props)])

    page_bg = pg.evaluate("() => getComputedStyle(document.querySelector('.login-page')).backgroundImage")
    # 判据是"这条渐变就是主页首屏 `.collageBg` 那条"：两端色值都在。只断言"有渐变"是不够的
    # —— 换成墨蓝那条也是渐变（20261006 之前的样子）。
    check("页面底是主页那套拼贴渐变（#fff6fa → #e9f4ff 两端都在）",
          "255, 246, 250" in page_bg and "233, 244, 255" in page_bg, page_bg[:120])
    tex = styles(pg, ".login-page", "::after", ("backgroundImage", "backgroundSize"))
    # 两层（横线 + 竖线）都必须是 28px；`background-size` 会原样拼成 "28px 28px, 28px 28px"，
    # 所以按逗号拆开比集合，别拿整串去 == 一个单层的写法（那样量的是字符串拼接习惯）。
    tex_sizes = {v.strip() for v in tex["backgroundSize"].split(",")}
    check("白天有纹路：两层 28px 方格纸（照抄主页首屏那一层）",
          tex_sizes == {"28px 28px"} and "160, 120, 190" in tex["backgroundImage"],
          f'{tex["backgroundSize"]} / {tex["backgroundImage"][:80]}')
    check("白天没有那团月晕（`::before` 只在夜间档）",
          pg.evaluate("() => getComputedStyle(document.querySelector('.login-page'), '::before').content") == "none")
    check("body 挂了 login-route（页面底），白天不挂 login-dark",
          pg.evaluate("() => document.body.classList.contains('login-route')"
                      " && !document.body.classList.contains('login-dark')"))
    check("根节点白天不带 frontDark（`--washi-*` 因此停在浅色档）",
          pg.evaluate("() => document.querySelector('.login-page').className") == "login-page",
          pg.evaluate("() => document.querySelector('.login-page').className"))
    boxday = styles(pg, ".login-box", None, ("backgroundColor", "backdropFilter", "borderRadius"))
    check("卡片是纸白实底（#fffdfa）", boxday["backgroundColor"] == "rgb(255, 253, 250)", boxday["backgroundColor"])
    check("白天不做 backdrop-filter（底是不透明的，模糊看不出效果还白付一层合成）",
          boxday["backdropFilter"] == "none", boxday["backdropFilter"])
    check("卡片圆角 18px", boxday["borderRadius"] == "18px", boxday["borderRadius"])

    rest = styles(pg, "input#account")["borderTopColor"]
    pg.click("input#account")
    pg.wait_for_timeout(350)
    foc = styles(pg, "input#account", None, ("borderTopColor", "boxShadow", "backgroundColor"))
    check("未聚焦边框是和纸粉线（--washi-line 白天档）",
          "198, 152, 192" in rest, rest)
    check("聚焦边框变深粉 #d94f9a（白天的强调色，不是夜间的河灯金）",
          foc["borderTopColor"] == "rgb(217, 79, 154)", foc["borderTopColor"])
    check("聚焦有粉色外发光环", "217, 79, 154" in foc["boxShadow"], foc["boxShadow"][:60])

    # 主按钮的对比度：**从渲染结果里读**两个渐变色标与字色（不写死在测试里），逐个算 WCAG。
    # 这条是"浅粉渐变 + 墨字"这个选择的守门人 —— 计划里原本写的白字压在 #d94f9a 上只有
    # 3.8:1、压 #8e63e0 上 4.2:1，都过不了 4.5:1（15px/600 够不到大字号）。哪天有人把
    # 渐变换回深粉或把字色改白，这里当场红。
    sub_day = styles(pg, ".login-submit", None, ("backgroundImage", "color"))
    stops = [(int(a), int(b), int(c)) for a, b, c in
             re.findall(r"rgb\((\d+),\s*(\d+),\s*(\d+)", sub_day["backgroundImage"])]
    check("白天主按钮是浅粉渐变（#ffd7ea → #f0b9dd）", len(stops) >= 2, sub_day["backgroundImage"][:80])
    ink = [int(v) for v in re.findall(r"\d+", sub_day["color"])[:3]]
    worst = min((contrast_ratio(ink, s) for s in stops), default=0)
    check("按钮字色对**每一个**渐变色标都 ≥ 4.5:1",
          worst >= 4.5, f"最差 {worst:.2f}:1  字{ink} 色标{stops}")
    check("旧霓虹青已撤（页面无 #03e9f4）", "3, 233, 244" not in pg.evaluate(
        "() => [document.querySelector('.login-submit'), document.body].map(e=>getComputedStyle(e).backgroundImage).join()"))

    print("③b 夜间档（挂载前写 isDarkMode='true'）：还是 20260921 那副墨蓝样子")
    pg_d = br.new_page(viewport={"width": 1280, "height": 900})
    pg_d.add_init_script("localStorage.setItem('isDarkMode', 'true');")
    pg_d.goto(URL)
    pg_d.wait_for_timeout(400)
    check("根节点挂上 frontDark（`--washi-*` 切夜间档）",
          "frontDark" in pg_d.evaluate("() => document.querySelector('.login-page').className"),
          pg_d.evaluate("() => document.querySelector('.login-page').className"))
    check("body 同时挂 login-route + login-dark",
          pg_d.evaluate("() => document.body.classList.contains('login-route')"
                        " && document.body.classList.contains('login-dark')"))
    dark_bg = pg_d.evaluate("() => getComputedStyle(document.querySelector('.login-page')).backgroundImage")
    check("页面底回到墨蓝渐变（#0d1319 → #1d2634）",
          "13, 19, 25" in dark_bg and "29, 38, 52" in dark_bg, dark_bg[:120])
    check("夜间才有那团月晕（`::before` 有内容）",
          pg_d.evaluate("() => getComputedStyle(document.querySelector('.login-page'), '::before').content") != "none")
    check("夜间不铺方格纸（`::after` 的图被关掉，只剩月晕）",
          "none" in pg_d.evaluate(
              "() => getComputedStyle(document.querySelector('.login-page'), '::after').backgroundImage"))
    boxn = styles(pg_d, ".login-box", None, ("backgroundColor", "backdropFilter"))
    check("夜间卡片是玻璃（backdrop-filter 还在）",
          "blur(14px)" in boxn["backdropFilter"], boxn["backdropFilter"])
    pg_d.evaluate("() => document.activeElement && document.activeElement.blur()")
    pg_d.wait_for_timeout(350)
    rest_n = styles(pg_d, "input#account")["borderTopColor"]
    pg_d.click("input#account")
    pg_d.wait_for_timeout(350)
    foc_n = styles(pg_d, "input#account", None, ("borderTopColor", "boxShadow"))
    check("未聚焦边框是淡白", rest_n == "rgba(255, 255, 255, 0.14)", rest_n)
    check("聚焦边框变河灯金 #f0c987", foc_n["borderTopColor"] == "rgb(240, 201, 135)", foc_n["borderTopColor"])
    check("聚焦有金色外发光环", "240, 196, 110" in foc_n["boxShadow"], foc_n["boxShadow"][:60])
    sub_night = styles(pg_d, ".login-submit", None, ("backgroundImage", "color"))
    check("主按钮是河灯金渐变", "232, 184, 102" in sub_night["backgroundImage"], sub_night["backgroundImage"][:80])
    stops_n = [(int(a), int(b), int(c)) for a, b, c in
               re.findall(r"rgb\((\d+),\s*(\d+),\s*(\d+)", sub_night["backgroundImage"])]
    ink_n = [int(v) for v in re.findall(r"\d+", sub_night["color"])[:3]]
    worst_n = min((contrast_ratio(ink_n, s) for s in stops_n), default=0)
    check("夜间按钮字色同样逐档 ≥ 4.5:1", worst_n >= 4.5, f"最差 {worst_n:.2f}:1")
    check("弹窗主题跟着切到深色算法（墨蓝底 + 河灯金主色）", pg_d.evaluate(
        "() => (window.__cpThemes || []).some(t => t && t.algorithm === '__DARK_ALGORITHM__'"
        " && t.token && t.token.colorBgElevated)"))
    pg_d.close()

    print("③c 即时跟随：头部/看板娘切换时不刷新页面就换档")
    # `useIsDarkMode()` 听的就是这个事件（全仓唯一在 React 里响应主题变化的写法）。
    # 判据取"类真的挂上了"——只断言 state 变了是量不到 DOM 的。
    pg.evaluate("() => window.dispatchEvent(new CustomEvent('darkmode-change', {detail: true}))")
    pg.wait_for_timeout(250)
    check("派发 darkmode-change(true) → 不刷新就切成夜间档",
          "frontDark" in pg.evaluate("() => document.querySelector('.login-page').className")
          and pg.evaluate("() => document.body.classList.contains('login-dark')"))
    pg.evaluate("() => window.dispatchEvent(new CustomEvent('darkmode-change', {detail: false}))")
    pg.wait_for_timeout(250)
    check("再派发 false → 切回白天档",
          pg.evaluate("() => document.querySelector('.login-page').className") == "login-page"
          and pg.evaluate("() => !document.body.classList.contains('login-dark')"))

    print("④ 注册入口 → 不开放注册的声明（只有一个出口，且居中）")
    pg.click(".login-links button:nth-child(3)")
    pg.wait_for_timeout(250)
    dlg = pg.locator('.ant-modal-mock[data-title="注册账号"]')
    check("弹窗打开且标题=注册账号", dlg.count() == 1)
    body = dlg.inner_text() if dlg.count() else ""
    check("写明不开放自助注册", "不开放自助注册" in body)
    check("阅读无需登录", "无需登录" in body)
    check("发布功能需要登录（这句原先写错成「无需登录」）", "发布功能需要登录" in body)
    check("不再说「留言无需登录」", "留言、说说、河灯等访客功能" not in body)
    check("含「账号安全维护」", "账号安全维护" in body)
    check("交代账号从哪来（博主开设）", "博主" in body)
    check("不再引导去留言板（那条路需要登录，走不通）", "河灯集" not in body)
    check("页脚只有一个出口：知道了",
          [t.strip() for t in pg.locator(".login-modal-foot button").all_inner_texts()] == ["知道了"],
          json.dumps([t.strip() for t in pg.locator(".login-modal-foot button").all_inner_texts()], ensure_ascii=False))
    check("「知道了」水平居中", pg.evaluate(
        "() => {const b=document.querySelector('.login-modal-foot button').getBoundingClientRect();"
        "const f=document.querySelector('.login-modal-foot').getBoundingClientRect();"
        "return Math.abs((b.left+b.right)/2 - (f.left+f.right)/2) <= 1;}"))
    pg.click(".login-modal-primary")
    pg.wait_for_timeout(200)
    check("点「知道了」关闭弹窗", pg.locator(".ant-modal-mock").count() == 0)
    check("关闭弹窗不产生跳转", pg.evaluate("() => (window.__nav || []).length") == 0)

    print("⑤ 忘记密码入口 → 恢复码表单（无页脚，关窗靠 X/遮罩/Esc）")
    pg.click(".login-links button:nth-child(1)")
    pg.wait_for_timeout(250)
    dlg2 = pg.locator('.ant-modal-mock[data-title="重置密码"]')
    check("弹窗打开且标题=重置密码", dlg2.count() == 1)
    b2 = dlg2.inner_text() if dlg2.count() else ""
    check("说明需要一次性恢复码", "一次性恢复码" in b2)
    check("找回密码表单字段齐全",
          dlg2.locator("input").count() == 4
          and dlg2.locator("input[placeholder='用户名']").count() == 1
          and dlg2.locator("input[placeholder='一次性恢复码']").count() == 1
          and dlg2.locator("input[placeholder='新密码（至少 8 位）']").count() == 1)
    check("没有页脚（「取消」是多余的）", pg.locator(".login-modal-foot").count() == 0)
    check("没有「拿不到恢复码」那行（走不通的引导）",
          pg.locator(".login-modal-hint").count() == 0 and "河灯集" not in b2)
    check("有右上角关闭 X", pg.locator(".ant-modal-close").count() == 1)
    # 布局：这几个 input 是弹窗内 flex 列的直接子项，content-box 时 padding 会把它撑出容器
    check("表单输入框不溢出弹窗正文", pg.evaluate(
        "() => {const b=document.querySelector('.ant-modal-body input').getBoundingClientRect();"
        "const p=document.querySelector('.ant-modal-body').getBoundingClientRect();"
        "return b.left>=p.left-0.5 && b.right<=p.right+0.5;}"))
    check("四个输入框等宽且左对齐", pg.evaluate(
        "() => {const r=[...document.querySelectorAll('.login-reset-form input')]"
        ".map(i=>i.getBoundingClientRect());"
        "return new Set(r.map(x=>Math.round(x.width))).size===1"
        "&& new Set(r.map(x=>Math.round(x.left))).size===1;}"))
    # 关闭 → 重开：恢复码是一次性的，残留上次的值会让用户拿废码干试
    pg.fill(".login-reset-form input:nth-of-type(1)", "sora")
    pg.fill(".login-reset-form input:nth-of-type(2)", "STALECODE0000000000")
    pg.click(".ant-modal-close")
    pg.wait_for_timeout(200)
    check("点右上角 X 关闭弹窗且不跳转",
          pg.locator(".ant-modal-mock").count() == 0
          and pg.evaluate("() => (window.__nav || []).length") == 0)
    pg.click(".login-links button:nth-child(1)")
    pg.wait_for_timeout(250)
    check("重开后表单是空的（不留上一次的恢复码）",
          pg.evaluate("() => [...document.querySelectorAll('.login-reset-form input')].every(i => i.value === '')"))
    # 弹窗主题：白天档 = antd 默认浅色算法 + 和纸主色（**不能带 darkAlgorithm**，
    # 否则白天的弹窗还是墨蓝底）。字面量 `#d94f9a` 与 `--washi-pink-deep` 白天那一档同值。
    check("白天弹窗走浅色算法 + 和纸主色（不带 darkAlgorithm）", pg.evaluate(
        "() => (window.__cpThemes || []).some(t => t && !t.algorithm"
        " && t.token && t.token.colorPrimary === '#d94f9a')"))

    print("⑥ 提交契约（空值 → 原生校验；成功 → 派发 fetchToken + 按 token 分流跳转）")
    pg.evaluate("() => { window.__msgLog.length = 0; window.__nav = []; }")
    pg.click("button.login-submit")
    pg.wait_for_timeout(300)
    check("空值提交被拦住（提示请填写用户名）",
          any("请填写用户名" in m for m in pg.evaluate("() => window.__msgLog")),
          json.dumps(pg.evaluate("() => window.__msgLog"), ensure_ascii=False))
    check("空值提交不发请求", pg.evaluate("() => (window.__actions || []).length") == 0)

    pg.fill("input#account", "sora")
    pg.fill("input#password", "hunter2")
    pg.click("button.login-submit")
    pg.wait_for_timeout(400)
    acts = pg.evaluate("() => window.__actions || []")
    check("派发 fetchToken（账号密码原样）",
          len(acts) == 1 and acts[0]["type"] == "user/fetchToken"
          and acts[0]["payload"] == {"username": "sora", "password": "hunter2"},
          json.dumps(acts, ensure_ascii=False)[:160])
    check("登录中按钮文案/状态合法", pg.locator("button.login-submit").inner_text().strip() in ("登 录", "登录中…"))
    pg.wait_for_timeout(600)
    check("成功后提示「登录成功」", any("success:登录成功" in m for m in pg.evaluate("() => window.__msgLog")))
    # 20260922 起跳转分两岔（此前一律送 /dashboard，普通用户到了只会吃一次"无权限访问后台"
    # 再被弹回首页）：管理员 token → /dashboard，其余（含拿不到 token）→ /。
    # 本段登录前没设 token ⇒ getToken() 得 null ⇒ 走首页那一岔。
    check("成功后无 token/普通用户 → 首页 /",
          pg.evaluate("() => (window.__nav || []).join(',')") == '/',
          json.dumps(pg.evaluate("() => window.__nav"), ensure_ascii=False))

    print("⑥b 管理员登录后直达后台（20260922 分流契约的另一岔）")
    pg.evaluate(f"() => {{ window.__nav = []; window.__token = {json.dumps(jwt_with_role('admin'))};"
                " window.__msgLog.length = 0; }")
    pg.click("button.login-submit")
    pg.wait_for_timeout(1200)          # 成功分支的跳转带 500ms setTimeout
    check("管理员 token → /dashboard",
          pg.evaluate("() => (window.__nav || []).join(',')") == '/dashboard',
          json.dumps(pg.evaluate("() => window.__nav"), ensure_ascii=False))
    pg.evaluate("() => { window.__token = undefined; }")

    print("⑦ 失败分支（服务端 500 → 报错且不跳转）")
    pg.evaluate("() => { window.__nav = []; window.__msgLog.length = 0; window.__loginStatus = 500; }")
    pg.click("button.login-submit")
    pg.wait_for_timeout(1200)
    check("失败提示走 error 通道", any(m.startswith("error:") for m in pg.evaluate("() => window.__msgLog")),
          json.dumps(pg.evaluate("() => window.__msgLog"), ensure_ascii=False))
    # 判据从"不含 /dashboard"改成"一次都没跳"：20260922 起成功分支普通用户也不去 /dashboard，
    # 旧写法在新契约下恒真（纯空转），锁不住任何东西。
    check("失败不跳转（一次都没跳）", pg.evaluate("() => (window.__nav || []).length") == 0,
          json.dumps(pg.evaluate("() => window.__nav"), ensure_ascii=False))

    print("⑧ 密码显隐 + 会话重定向")
    pg.evaluate("() => { window.__loginStatus = 200; }")
    check("默认 type=password", pg.get_attribute("input#password", "type") == "password")
    check("显隐按钮是图标不是文字（svg，无文本）",
          pg.locator(".pwd-toggle svg").count() == 1
          and pg.locator(".pwd-toggle").inner_text().strip() == "",
          json.dumps(pg.locator(".pwd-toggle").inner_text(), ensure_ascii=False))
    check("默认 aria-label=显示密码", pg.get_attribute(".pwd-toggle", "aria-label") == "显示密码")
    pg.click(".pwd-toggle")
    pg.wait_for_timeout(150)
    check("点显示 → type=text", pg.get_attribute("input#password", "type") == "text")
    check("图标与 aria-label 同步为「隐藏密码」",
          pg.locator(".pwd-toggle svg").count() == 1
          and pg.get_attribute(".pwd-toggle", "aria-label") == "隐藏密码")
    check("图标按钮横向不吃掉输入框（右内边距 ≥ 40）", pg.evaluate(
        "() => parseFloat(getComputedStyle(document.querySelector('input#password')).paddingRight) >= 40"))

    # 20260927 用户报「填写密码时会**多出来**一个眼睛的图标」：本框已经有一只自绘的
    # `.pwd-toggle`，多出来的那只来自 **Edge** 对 type=password 渲染的原生显隐按钮
    # （`::-ms-reveal`，IE/Edge 的遗留伪元素，Edge Chromium 至今仍支持；access log 的
    # UA 实测是 `Edg/152`）。修法 = 用 CSS 藏掉原生那只，只留自绘的。
    #
    # **这条判据只能是源码锁**：本机没有 msedge channel（`playwright install msedge`
    # 未装），Chromium 根本不渲染 `::-ms-reveal` ⇒ 无从渲染验证。取编译产物而不是
    # 源文件，至少要保证那条规则真的穿过了 sass 编译（`::-ms-*` 是历史上有过解析
    # 事故的写法）。作用域也必须一起锁：只藏主登录框那一个——重置密码弹窗的两个密码
    # 框没有自绘眼睛，原生那只对它们是有用的。
    css = (SANDBOX / "login.css").read_text(encoding="utf-8")
    flat = "".join(css.split())
    sels = re.findall(r"([^{}]+?)::\-ms\-reveal\s*\{([^}]*)\}", flat)
    check("藏掉 Edge 原生的密码显隐按钮（::-ms-reveal；Chrome 渲染不出来，只能锁编译产物）",
          len(sels) == 1 and sels[0][1] == "display:none;", json.dumps(sels))
    check("作用域只在主登录框（重置密码弹窗那两个密码框不在 .field-pwd 下，原生眼睛留着）",
          bool(sels) and sels[0][0] == ".field-pwdinput[type=password]",
          sels[0][0] if sels else "没有这条规则")

    pg2 = br.new_page(viewport={"width": 1280, "height": 900})
    pg2.add_init_script("window.__token = 'fake-token';")
    pg2.goto(URL)
    pg2.wait_for_timeout(400)
    check("已有普通用户 token 时自动回首页 /",
          pg2.evaluate("() => (window.__nav || []).join(',')") == '/',
          json.dumps(pg2.evaluate("() => window.__nav"), ensure_ascii=False))

    # 另一岔：管理员 token 才是"一进来就直达后台"。分开两个 page 是因为 token 得在
    # 挂载前就位（add_init_script），改一个 page 的 localStorage 影响不到已跑的 effect。
    pg4 = br.new_page(viewport={"width": 1280, "height": 900})
    pg4.add_init_script(f"window.__token = {json.dumps(jwt_with_role('admin'))};")
    pg4.goto(URL)
    pg4.wait_for_timeout(400)
    check("已有管理员 token 时自动直达 /dashboard",
          pg4.evaluate("() => (window.__nav || []).join(',')") == '/dashboard',
          json.dumps(pg4.evaluate("() => window.__nav"), ensure_ascii=False))

    print("⑨ 移动端（380px 宽）")
    pg3 = br.new_page(viewport={"width": 380, "height": 780})
    pg3.goto(URL)
    pg3.wait_for_timeout(400)
    b3 = pg3.locator(".login-box").bounding_box()
    check("小屏卡片不溢出视口（左右各留 ≥8px）", b3["x"] >= 8 and b3["x"] + b3["width"] <= 372,
          f'x={b3["x"]:.1f} 右={b3["x"] + b3["width"]:.1f}')

    print("⑩ 忘记密码自动带入登录账号")
    # 必须排在所有"往 input#account 写字"的段之后：⑥ 已把账号填成 sora，此时重开应带过来。
    # （⑤ 里那条"重开表单是空的"之所以成立，是因为那会儿登录框还是空的——两段各锁一种情形。）
    pg.click(".login-links button:nth-child(1)")
    pg.wait_for_timeout(250)
    check("打开时把登录框里的账号带进「用户名」",
          pg.input_value(".login-reset-form input:nth-of-type(1)") == "sora",
          pg.input_value(".login-reset-form input:nth-of-type(1)"))
    check("只带账号：恢复码与两个密码框仍为空",
          pg.evaluate("() => [...document.querySelectorAll('.login-reset-form input')]"
                      ".slice(1).every(i => i.value === '')"))
    br.close()

shutil.rmtree(SANDBOX, ignore_errors=True)
print("\n" + ("全部通过" if not FAILS else f"失败 {len(FAILS)} 项：" + "; ".join(FAILS)))
sys.exit(1 if FAILS else 0)
