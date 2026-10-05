# -*- coding: utf-8 -*-
"""站点设置「图库存储」页签（20261006，用户第 3 条）无头验收。

20261006 用户拍板「配置挪到站点设置，单一入口」：图库那边只留用量与灰态，R2 的桶名/
前缀/公开域名/配额/开关**只有这一处入口**。于是这一页要是坏了（读不出值、存不进去、
或者存的时候顺手把别的设置覆盖了），R2 图床就彻底用不了，而**页面上不会有任何报错**——
正是必须真跑一遍才看得见的那类。所以本文件锁四件事：

  · **它真的落在这一页**（第一节）—— 图库那颗按钮带 `{tab:'4'}` 跳过来，`initialTab`
    要认得出这个 state；认不出就落在「站点信息」上，用户以为按钮没生效。
  · **表单回填的是服务端存的值**（第二节）—— 桶名/前缀/域名/配额/开关五项逐一对上，
    且**哪一格是哪个**（三个 `addonBefore` 的字）也要对上：回填串了格等于改错字段。
  · **条子走的是 `utils/r2Quota`**（第三、四节）—— 可信读数显示"已用 X / 上限 Y（Z%）"；
    读数不可信（`listError`）时**只显示原因**，一个用量数字一个百分比都不许出现
    （「0.00 GB」会被读成「用量是 0」）。第四节是**真负控**：同一份 bundle，只让桩返回
    `listError`，第三节那几条必须红。
  · **保存只提交这五个键**（第五节）—— 这个接口的语义是"只写请求里带了的那些"，
    多带一个键就会**连带改写别的页签的设置**（留言/评论那几个开关就在同一张表里）。
    所以判据是**键集合相等**，不是"包含这五个"。负控同上（同一份 bundle 换个桩）。

见 CLAUDE.md §2：本机不能 vite build。esbuild 把**真组件**打成 bundle，只桩一个边界
（`src/apis/axios.tsx`）；页面 sass 用 programmatic API 单独编译后注入（顺带过一遍编译）。
本机无中文字体（汉字渲染成豆腐块），断言一律走数值、键名与 ASCII 数字。

用法：python3 frontend/tests/r2-settings-tab.test.py
依赖：frontend/node_modules（esbuild/react/react-dom/antd/@mui/sass）、playwright(python)。
"""
import functools
import http.server
import json
import pathlib
import re
import subprocess
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

# ── 夹具：桩里存的值 / 读数 ────────────────────────────────────────────────────
# 配额与用量都用整 0.5 档，好让"50%"这种断言不依赖浮点比较。
GIB = 1024 ** 3
QUOTA_GB = 9.5
USED_BYTES = int(4.75 * GIB)
LIMIT_BYTES = int(QUOTA_GB * GIB)

FAKE_AXIOS = r"""
const calls: any[] = (window as any).__calls = [];
(window as any).__axiosStub = true;
// 负控开关：地址上带 `?bad=1` 时，用量接口改回**读不出来**（`listError`），
// 用量接口的存值也换一份（两个负控共用同一个页面、同一份 bundle）。
const bad = location.search.includes('bad');

const env = (data: any) => ({ status: 200, data: { code: 200, message: 'ok', data } });
// 每次回**深拷贝**：真 HTTP 每次反序列化一个新对象，这里的对象是同一份引用 ——
// 直接塞进 state 会被 React 的 Object.is 判等拦下、不触发重渲染（症状＝界面纹丝不动）。
const wire = (d: any) => (d == null ? d : JSON.parse(JSON.stringify(d)));
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

const SETTINGS = {
  blogTitle: 'Saudade', blogAuthor: 'Sora', blogIcp: '', blogPublicIcp: '',
  blogCopyright: '', userTalk: '', socialGithub: '', socialEmail: '',
  socialBilibili: '', socialQQ: '',
  r2ImageBucket: 'saudade-blog-image',
  r2ImagePrefix: 'gallery',
  r2ImagePublicBase: 'https://img.cat0.qzz.io',
  r2ImageQuotaGB: __QUOTA__,
  r2ImageEnabled: true,
};
const USAGE = {
  enabled: true, configured: true, credentials: true,
  bucket: 'saudade-blog-image', prefix: 'gallery', publicBase: 'https://img.cat0.qzz.io',
  quotaGB: __QUOTA__, limitBytes: __LIMIT__, usedBytes: __USED__, listError: null,
};

const req = async (cfg: any) => {
  const url = cfg.url as string;
  const method = (cfg.method || 'GET').toUpperCase();
  calls.push({ url, method, data: wire(cfg.data) });
  await delay(20);
  if (url === '/api/protected/websetting' && method === 'GET') return env(wire(SETTINGS));
  if (url === '/api/protected/websetting') return env('Settings updated');
  if (url === '/api/protect/images/r2') {
    const u = wire(USAGE);
    // 负控这份**刻意连 `limitBytes` 一起置 0**（＝"配额没配出个正数"那一种）：它是唯一
    // 能让"少一次 null 判断"暴露出来的取值 —— 那时 `usagePercent(0, 0)` 会返回 **100**，
    // 条子会变成一条满的假条子。只把 usedBytes 置 0 的话，朴素实现算出来也是 0%，
    // 第四节的断言就分不出对错了。
    if (bad) { u.listError = '列桶失败：HTTP 403'; u.usedBytes = 0; u.limitBytes = 0; }
    return env(u);
  }
  return env(null);
};

// ⚠️ 必须是**可调用对象**：这个页面里 MUI 那半边走 `http({url,method})`、
// 新页签走 `http.get(...)` —— 只做其中一种，另一种就是 `undefined is not a function`。
const http: any = (cfg: any) => req(cfg);
http.get = (url: string, cfg?: any) => req({ ...(cfg || {}), url, method: 'GET' });
http.post = (url: string, data?: any, cfg?: any) => req({ ...(cfg || {}), url, data, method: 'POST' });
http.put = (url: string, data?: any, cfg?: any) => req({ ...(cfg || {}), url, data, method: 'PUT' });
http.delete = (url: string, cfg?: any) => req({ ...(cfg || {}), url, method: 'DELETE' });
export default http;
""".replace("__QUOTA__", str(QUOTA_GB)).replace("__LIMIT__", str(LIMIT_BYTES)).replace("__USED__", str(USED_BYTES))

ENTRY = """\
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import UserControl from './src/pages/Dashboard/UserControl/index.tsx';

// 挂载点与真站一致的那一点：图库那颗「R2 存储」按钮是**带 state 跳过来**的
// （`navigate('/dashboard/usercontrol', { state: { tab: '4' } })`）。这里照抄那个 state ——
// 少写它，测的就不是用户真正走的那条路（第五节另有一条断言直接钉这个 state）。
(window as any).__mount = () => createRoot(document.getElementById('root')!).render(
  <MemoryRouter initialEntries={[{ pathname: '/dashboard/usercontrol', state: { tab: '4' } }]}>
    <UserControl />
  </MemoryRouter>
);
"""


def esbuild(sb: pathlib.Path, outfile: str):
    r = subprocess.run([str(FE / "node_modules/.bin/esbuild"), "entry.tsx",
                        "--bundle", "--format=iife", "--outfile=" + outfile,
                        "--loader:.sass=text", "--loader:.png=dataurl", "--loader:.svg=dataurl",
                        "--jsx=automatic", f"--define:{DEFINE}"],
                       cwd=str(sb), capture_output=True)
    if r.returncode != 0:
        raise SystemExit("esbuild 打包失败：\n%s" % r.stderr.decode("utf-8", "replace"))


def build_sandbox() -> pathlib.Path:
    import shutil
    import tempfile
    sb = pathlib.Path(tempfile.mkdtemp(prefix="r2tab-"))
    # ⚠️ `src` 必须**拷**进来，不能软链：下面要把它里面的 `apis/axios.tsx` 换成桩，
    # 走软链的话那一刀砍在仓库里的真文件上（本仓其余沙箱同此口径）。
    shutil.copytree(FE / "src", sb / "src")
    (sb / "node_modules").symlink_to(FE / "node_modules")
    # 只桩这一个边界（同 album-views 的口径）
    (sb / "src/apis/axios.tsx").write_text(FAKE_AXIOS, encoding="utf-8")
    (sb / "entry.tsx").write_text(ENTRY, encoding="utf-8")

    # 页面自己的 sass：单独编译后注入（顺带过一遍编译 —— 本机唯一拦得下构建级缺陷的环节）
    css_out = sb / "page.css"
    subprocess.run(["node", "-e",
                    "const s=require('sass');const r=s.compile(process.argv[1],{style:'expanded'});"
                    "require('fs').writeFileSync(process.argv[2],r.css);",
                    str(FE / "src/pages/Dashboard/UserControl/index.sass"), str(css_out)],
                   cwd=str(FE), check=True)
    esbuild(sb, "bundle.js")
    (sb / "index.html").write_text(
        '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">'
        '<style>' + css_out.read_text(encoding="utf-8") + '</style>'
        '</head><body><div id="root"></div><script src="bundle.js"></script></body></html>',
        encoding="utf-8")
    return sb


SANDBOX = build_sandbox()


class _Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a, **k):
        return None


_handler = functools.partial(_Quiet, directory=str(SANDBOX))
_server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _handler)
threading.Thread(target=_server.serve_forever, daemon=True).start()

from playwright.sync_api import sync_playwright  # noqa: E402

BASE = f"http://127.0.0.1:{_server.server_address[1]}/"
URL = BASE + "index.html"
BAD_URL = BASE + "index.html?bad=1"

# 表单的读法：三个文本框按 DOM 次序（= 页面上的次序），配额那个是 InputNumber。
READ_FORM = """() => {
    const box = document.querySelector('.r2_storage');
    if (!box) return null;
    const inps = [...box.querySelectorAll('input.ant-input')];
    return {
        addons: [...box.querySelectorAll('.ant-input-group-addon')].map((e) => e.textContent.trim()),
        values: inps.map((i) => i.value),
        quota: (box.querySelector('input.ant-input-number-input') || {}).value,
        enabled: !!box.querySelector('.ant-switch-checked'),
        // 「已用 / 上限（百分比）」那一行（读数不可信时它只有原因）
        usageLine: (box.querySelector('span') || {}).textContent || '',
        // 条子本体：有没有画出进度（`.ant-progress-bg` 的宽度百分比）与它的颜色
        barWidth: (() => {
            const b = box.querySelector('.ant-progress-bg');
            return b ? b.style.width : null;
        })(),
        barBg: (() => {
            const b = box.querySelector('.ant-progress-bg');
            return b ? getComputedStyle(b).backgroundColor : null;
        })(),
        // 整块可见文本（"不许出现数字"那条断言扫它）
        text: box.innerText,
    };
}"""


def mount(br, url=URL):
    page = br.new_page(viewport={"width": 1440, "height": 900})
    errs = []
    page.on("pageerror", lambda e: errs.append(str(e)))
    page.goto(url)
    page.evaluate("() => window.__mount()")
    try:
        page.wait_for_selector(".r2_storage", timeout=10000)
    except Exception:
        print("  ⚠ 等不到「图库存储」那一块，现场：")
        print("    " + page.evaluate("""() => JSON.stringify({
            root: document.getElementById('root').children.length,
            tabs: [...document.querySelectorAll('.ant-tabs-tab')].map((t) => t.innerText),
            active: (document.querySelector('.ant-tabs-tab-active') || {}).innerText || null,
            calls: (window.__calls || []).map((c) => c.method + ' ' + c.url),
        })"""))
        print("    页面异常：" + ("; ".join(errs[:3]) or "（无）"))
        raise
    page.wait_for_timeout(600)
    page.errs = errs
    return page


def form(pg):
    return pg.evaluate(READ_FORM)


def writes(pg):
    return pg.evaluate("""() => window.__calls.filter((c) => c.method !== 'GET')
        .map((c) => ({ url: c.url, method: c.method, body: c.data }))""")


TAB_LABELS = ["站点信息", "社交媒体", "向量图谱", "图库存储"]


with sync_playwright() as p:
    br = p.chromium.launch()

    # ── 一、落在这一页 ────────────────────────────────────────────────────────
    print("\n【一】四个页签都在，且默认落在「图库存储」（图库那颗按钮带 state 跳过来）")
    pg = mount(br)
    labels = pg.evaluate("""() => [...document.querySelectorAll('.ant-tabs-tab')]
        .map((t) => t.innerText.replace(/\\s+/g, ''))""")
    check("四个页签按次序排列（新增的「图库存储」在最后）",
          labels == TAB_LABELS, str(labels))
    active = pg.evaluate("""() => (document.querySelector('.ant-tabs-tab-active') || {}).innerText || null""")
    check("**落在「图库存储」上**（`initialTab` 认得 state.tab='4'）",
          active and "图库存储" in active, str(active))
    check("第一节无页面异常", not pg.errs, "; ".join(pg.errs[:3]))

    # ── 二、表单回填 ─────────────────────────────────────────────────────────
    print("\n【二】表单回填的是服务端存的值，且哪一格是哪个")
    f = form(pg)
    check("三格的标签依次是 桶名 / 前缀 / 公开域名", f and f["addons"] == ["桶名", "前缀", "公开域名"],
          json.dumps(f and f["addons"], ensure_ascii=False))
    check("桶名/前缀/域名逐格回填（串格 = 改错字段）",
          f and f["values"] == ["saudade-blog-image", "gallery", "https://img.cat0.qzz.io"],
          json.dumps(f and f["values"], ensure_ascii=False))
    check(f"配额回填 {QUOTA_GB}（面板显示的是**存着的**值，不是生效值）",
          f and f["quota"] == str(QUOTA_GB), str(f and f["quota"]))
    check("开关是打开的（`r2ImageEnabled: true`）", f and f["enabled"] is True, str(f and f["enabled"]))

    # ── 三、条子：可信读数显示三样 ────────────────────────────────────────────
    print("\n【三】读数可信：条子上有「已用 / 上限 / 百分比」三样，且条子画了 50%")
    check("那一行同时出现 4.75 GB / 9.50 GB / 50%",
          f and "4.75 GB" in f["usageLine"] and "9.50 GB" in f["usageLine"]
          and "50%" in f["usageLine"], str(f and f["usageLine"]))
    check("  条子本体画的是 50%（页面走的是 `utils/r2Quota` 的 `usagePercent`，不是自己算的）",
          f and f["barWidth"] == "50%", str(f and f["barWidth"]))
    check("  这一页**没有**开任何弹窗（配置是页签，不是弹窗）",
          pg.locator(".ant-modal-wrap:visible").count() == 0)
    check("第三节无页面异常", not pg.errs, "; ".join(pg.errs[:3]))
    pg.close()

    # ── 四、（负控）读数不可信 ⇒ 只显示原因 ───────────────────────────────────
    print("\n【四】负控：桩改回 `listError` ⇒ 第三节那几条必须红")
    pg = mount(br, url=BAD_URL)
    b = form(pg)
    check("负控前置：确实换成了读不出来的那份读数（原因原文在）",
          b and "列桶失败" in b["text"] and "403" in b["text"], str(b and b["usageLine"]))
    check("负控：三样数字一条都不出现（「0.00 GB」会被读成「用量是 0」）",
          b and not re.search(r"[\d.]+\s*(GB|GiB|MB)|%", b["text"]), str(b and b["usageLine"]))
    check("  条子**宽度必须是 0%**，不是 100% —— 「算不出来」与「用满了」是两回事，"
          "而 `usagePercent` 对 `limit<=0` 返回的正是 100：少一次 null 判断，条子就变成"
          "一条满的假条子（这一档的桩刻意把 `limitBytes` 也置了 0，就是这个原因）",
          b and b["barWidth"] == "0%", str(b and b["barWidth"]))
    check("  且它是**灰**的（`strokeColor` 那条分支也没被绕过）",
          b and b["barBg"] == "rgb(191, 191, 191)", str(b and b["barBg"]))
    check("  第三节的「三样都在」在它身上不成立（证明那条断言不是恒真）",
          b and "50%" not in b["text"])
    pg.close()

    # ── 五、保存：只提交这五个键 ─────────────────────────────────────────────
    print("\n【五】保存提交的键集合**恰好**是那五个（多带一个键＝连带改写别的页签的设置）")
    pg = mount(br)
    pg.locator(".r2_storage button.ant-btn-primary").click()
    pg.wait_for_timeout(600)
    w = writes(pg)
    check("点保存 ⇒ 恰好一条写请求，且是 POST /api/protected/websetting",
          len(w) == 1 and w[0]["method"] == "POST" and w[0]["url"] == "/api/protected/websetting",
          str([(x["method"], x["url"]) for x in w]))
    body = (w[0]["body"] if w else None) or {}
    want = {"r2ImageEnabled", "r2ImageBucket", "r2ImagePrefix", "r2ImagePublicBase", "r2ImageQuotaGB"}
    check("  键集合**恰好相等**（不是「包含」——多带的键会被服务端照写）",
          set(body.keys()) == want, json.dumps(sorted(body.keys())))
    check("  值就是表单里那五个（开关/桶名/前缀/域名/配额）",
          body.get("r2ImageBucket") == "saudade-blog-image"
          and body.get("r2ImagePrefix") == "gallery"
          and body.get("r2ImagePublicBase") == "https://img.cat0.qzz.io"
          and body.get("r2ImageQuotaGB") == QUOTA_GB
          and body.get("r2ImageEnabled") is True,
          json.dumps(body, ensure_ascii=False))
    check("  保存成功后**重拉了**用量（用量条要跟上刚存下的配置）",
          len([c for c in pg.evaluate("() => window.__calls")
               if c["url"] == "/api/protect/images/r2" and c["method"] == "GET"]) >= 2,
          str([c["url"] for c in pg.evaluate("() => window.__calls")]))
    check("第五节无页面异常", not pg.errs, "; ".join(pg.errs[:3]))

    # ── 六、那一格的下限：填 0 ⇒ 出去的配额仍是正数 ───────────────────────────
    # 「这一格是会不会产生账单的那条线」的**下限版本**：配额只要落到 0 或负数，
    # 上传闸门就变得毫无意义（0 会让每一张都被拒、负数更荒谬），所以**出去的配额必须
    # 恒为正**。这条不变量由两处一起给：antd 的 `min={0.1}`（输入期就夹住）与组件里
    # 那道 `> 0`（提交前再拦一次）。这里测的是**合起来的结果**——真点一次、读请求体。
    #
    # ⚠️ 两条路测不到，本套件不假装测过：
    #   · "清空这一格"：antd `InputNumber` 清空只改自己的显示值、**不立刻回吐
    #     `onChange(null)`**（实测：DOM 已经空了，提交上去的仍是旧值 9.5）⇒ 点保存时
    #     走的还是旧配额。组件里那个 null 分支因此是防御性的那一半。
    #   · "让非正数真的发出去"：UI 上做不到（antd 先夹住了），所以"提交 0 被后端整笔拒绝"
    #     那条判据归 Rust 单测（`update_web_info`），不归这里。
    print("\n【六】配额的下限：填 0 ⇒ 出去的配额仍是正数（这条线不许被填成 0）")
    before = len(writes(pg))
    q = pg.locator("input.ant-input-number-input")
    q.click()
    q.press("Control+a")
    q.type("0")
    pg.wait_for_timeout(300)
    pg.locator(".r2_storage button.ant-btn-primary").click()
    pg.wait_for_timeout(500)
    new = writes(pg)[before:]
    check("填 0 之后点保存：本页走过的所有请求体里，配额**没有一个非正数**",
          all(isinstance(x["body"], dict) and isinstance(x["body"].get("r2ImageQuotaGB"), (int, float))
              and x["body"]["r2ImageQuotaGB"] > 0 for x in writes(pg)),
          json.dumps([x["body"].get("r2ImageQuotaGB") for x in writes(pg)]))
    check("  这一次确实又提交了一笔（不是「点了没反应」被当成通过）",
          len(new) == 1 and new[0]["url"] == "/api/protected/websetting",
          json.dumps([x["body"].get("r2ImageQuotaGB") for x in new]))
    check("  且条子/表单**没有**跟着变（拒的是这一次提交，不是把页面搞乱）",
          form(pg) and form(pg)["usageLine"] and "4.75 GB" in form(pg)["usageLine"])
    pg.close()

    br.close()

print()
if FAILS:
    print(f"❌ {len(FAILS)} 项未通过：")
    for f in FAILS:
        print("   - " + f)
    import sys
    sys.exit(1)
print("✅ 站点设置「图库存储」页签（20261006，用户第 3 条）：全部通过")
