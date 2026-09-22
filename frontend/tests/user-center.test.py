# -*- coding: utf-8 -*-
"""个人中心一期（20260922）无头验收：真 antd + 假后端，走**真组件**的接线与交互。

为什么值得单起一个脚本：
  个人中心是这轮新增的最大一块前端（五个页签 + 头像裁剪 + 红点），而它的风险几乎全在
  **接线**上而不是观感上——「点确定到底发没发那个 multipart」「点了全部已读红点掉不掉」
  「后端那句中文有没有弹出来」都是只有真跑一遍才知道的事。本机不能 vite build（3.7GB 内存
  会 OOM，见 CLAUDE.md §2），沿用既定替代手段（frontend/tests/* 的既有做法）：
    · sass 用 programmatic API 编译（`node_modules/.bin/sass` 在 Node 18 上崩）；
    · esbuild 把真组件打成一个 bundle，**只桩边界**（axios 假后端 / 路由），antd 与
      react-dom 都用真的（antd v5 是 CSS-in-JS，无外部样式表要引）；
    · Playwright 真渲染后按"发了什么请求 + 界面变成什么样"断言。

假后端（替换 src/apis/axios.tsx）**刻意照抄后端的两个口径**，否则测了也白测：
  1. 失败是 HTTP 200 + code=500 + 中文 message（不是 4xx）；
  2. 未登录是同一形状（message=未登录）。
它同时把 `localStorage.tokenKey` 写成一张真形状的 JWT——`getToken()` 读的就是这个键，
个人中心与红点轮询都靠它判登录态。

用法：python3 frontend/tests/user-center.test.py
依赖：frontend/node_modules（esbuild/react/react-dom/antd）、playwright(python)、Pillow。
注意：本机无中文字体（fc-list CJK = 0）⇒ 截图里汉字是豆腐块，结构与请求判据不受影响。
"""
import pathlib
import shutil
import subprocess
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[2]
FE = ROOT / "frontend"

FAILS = []


def check(desc, cond, detail=""):
    print(("  ✅ " if cond else "  ❌ ") + desc + (f"  [{detail}]" if detail else ""))
    if not cond:
        FAILS.append(desc)


DEFINE = ('import.meta.env={"VITE_HTTP_BASEURL":"","VITE_CDN_BASEURL":"",'
          '"MODE":"production","DEV":false,"PROD":true,"BASE_URL":"/"}')

# ── 假后端：只桩 axios 这一个边界 ─────────────────────────────────────────────
FAKE_AXIOS = r"""
// 假后端。`window.__calls` 记录每一次请求，测试按它断言"该发的发了、没发的没发"。
type Call = { url: string; method: string; data: any };
const calls: Call[] = (window as any).__calls = [];

// 一张真形状的 JWT（payload 段是 base64url，role 可读）。前端只读 claims 判角色、不验签。
const b64u = (o: any) => btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const TOKEN = 'x.' + b64u({ sub: 7, role: (window as any).__role || 'user', exp: 9999999999 }) + '.y';
localStorage.setItem('tokenKey', TOKEN);

const state: any = (window as any).__state = {
  profile: { username: 'sora', nickname: '泠月喵', avatar: null },
  favorites: [
    { noteId: 12, title: '架构文档', status: 'published', createdAt: '2026-09-20 10:00:00' },
    { noteId: 22, title: 'ESP32 固件', status: 'published', createdAt: '2026-09-19 09:30:00' },
  ],
  notifications: [
    { id: 101, type: 'announcement', title: '服务器维护', content: '今晚 23:00 维护', link: null, isRead: false, createdAt: '2026-09-22 08:00:00' },
    { id: 100, type: 'announcement', title: '新功能上线', content: '个人中心来啦', link: null, isRead: true, createdAt: '2026-09-21 08:00:00' },
  ],
  messages: [
    // 这封**刻意不带 title**：title 是 20260922 之后加的列，历史行全是 NULL
    // ⇒ 界面必须如实显示「（无标题）」，不许拿正文首行冒充标题。
    { id: 5, fromUserId: 3, toUserId: 7, peerName: '小猫咪', peerAvatar: null, content: '你好呀', isRead: false, createdAt: '2026-09-22 09:00:00' },
  ],
  /** 上传头像后返回的 URL（用来断言"回传的地址真被写进了界面"） */
  uploadedAvatar: '/api/protect/download/avatars/7_abc.jpg',
};

const env = (data: any) => ({ status: 200, data: { code: 200, message: 'ok', data } });
// 失败照抄后端口径：HTTP 200 + code 500 + 中文原因
const fail = (msg: string) => ({ status: 200, data: { code: 500, message: msg, data: null } });
const summary = () => {
  const n = state.notifications.filter((x: any) => !x.isRead).length;
  const m = state.messages.filter((x: any) => x.toUserId === 7 && !x.isRead).length;
  return { notifications: n, messages: m, total: n + m };
};
const json = (d: any) => (typeof d === 'string' ? JSON.parse(d) : d);
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

const http = async (cfg: any) => {
  const url = cfg.url as string;
  const method = (cfg.method || 'GET').toUpperCase();
  calls.push({ url, method, data: cfg.data });
  await delay(20);   // 让 loading 态真的出现过

  if (url === '/api/protected/profile') {
    if (method === 'GET') return env(state.profile);
    const body = json(cfg.data);
    if (!body.nickname) return fail('昵称不能为空');
    // 故意留一个"只有后端拦得住"的取值：证明弹出来的是**后端那句中文**，
    // 不是前端自己编的兜底话（前端拦不到它——非空且在 maxLength 之内）
    if (body.nickname === '重名') return fail('这个昵称已经有人在用了');
    state.profile = { ...state.profile, nickname: body.nickname };
    return env(state.profile);
  }
  if (url === '/api/protected/profile/password') {
    const body = json(cfg.data);
    if ((window as any).__pwdFail) return fail('原密码不正确');
    if (!body.newPassword || body.newPassword.length < 8) return fail('新密码至少 8 位');
    return env('密码已修改');
  }
  if (url === '/api/protected/profile/avatar') {
    // multipart：真发出去的 FormData 里应有 avatar 字段，且是画布烘焙的 JPEG
    const fd = cfg.data as FormData;
    const f = fd.get('avatar') as File;
    if (!f) return fail('没有收到头像文件');
    if (f.type !== 'image/jpeg' && f.type !== 'image/png') return fail('只收 jpg/png/webp/gif');
    if (f.size > 2 * 1024 * 1024) return fail('图片太大（最多 2MB）');
    (window as any).__uploaded = { name: f.name, type: f.type, size: f.size };
    state.profile = { ...state.profile, avatar: state.uploadedAvatar };
    return env({ avatar: state.uploadedAvatar });
  }
  if (url === '/api/protected/favorites') {
    if (method === 'GET') return env(state.favorites);
    return env('已收藏');
  }
  if (url.startsWith('/api/protected/favorites/')) {
    const id = Number(url.split('/').pop());
    state.favorites = state.favorites.filter((f: any) => f.noteId !== id);
    return env('已取消收藏');
  }
  if (url === '/api/protected/notifications/summary') return env(summary());
  if (url === '/api/protected/notifications') {
    return env({ unread: summary().notifications, items: state.notifications });
  }
  if (url === '/api/protected/notifications/read') {
    const body = json(cfg.data);
    state.notifications = state.notifications.map((n: any) =>
      (body.all || (body.ids || []).includes(n.id)) ? { ...n, isRead: true } : n);
    return env(summary());
  }
  if (url === '/api/protected/messages') {
    if (method === 'GET') {
      return env({
        inbox: state.messages.filter((m: any) => m.toUserId === 7),
        outbox: state.messages.filter((m: any) => m.fromUserId === 7),
        unread: summary().messages,
      });
    }
    const body = json(cfg.data);
    if (!body.toUsername) return fail('请填写收件人');
    if (body.toUsername === 'nobody') return fail('找不到这个用户（请填对方账号）');
    // 标题选填：trim 后空串一律折成 NULL（与后端同一口径，见 src/routes/profile.rs）
    const title = (body.title || '').trim() || null;
    if (title && title.length > 60) return fail('标题过长（最多 60 字）');
    const msg = { id: 99, fromUserId: 7, toUserId: 42, peerName: body.toUsername, peerAvatar: null,
                  title, content: body.content, isRead: false, createdAt: '2026-09-22 12:00:00' };
    state.messages.push(msg);
    return env(msg);
  }
  if (url === '/api/protected/messages/read') {
    state.messages = state.messages.map((m: any) => ({ ...m, isRead: true }));
    return env({ inbox: state.messages, outbox: [], unread: 0 });
  }
  if (url === '/api/protected/my/talks') {
    // **故意两类都回**：真实后端 20260922 起已加 src='board' 过滤，但这条缺陷的形态
    // 正是"后端把两类一起回、前端照单全收"，所以要验的是"说说混进来也不显示"。
    // cat 用**库里的真值**（愿/寄/忆/诉）——此前这里编了 '留言'/'说说' 两个不存在的取值，
    // 于是断言在"印章里放的是类型还是来源标"这件事上结构性看不出差别。
    return env([
      { id: 9, src: 'board', title: '', content: '河灯一盏', cat: '诉', v: 0, author: 'sora',
        approved: 1, createdAt: '2026-09-21 20:00:00' },
      { id: 8, src: 'talk', title: '随笔', content: '今天写了点东西', cat: '愿', v: 0, author: 'sora',
        approved: 0, createdAt: '2026-09-20 20:00:00' },
    ]);
  }
  return fail('未知端点 ' + url);
};

export default http;
"""

STUB_ROUTER = (
    "export const useNavigate = () => (to: string) => {"
    "(window as any).__nav = ((window as any).__nav || []).concat(to); };\n"
)

# 头部（Head）要挂 redux 与路由，两个都只桩"读"，动作创建函数用真的（它们只是造 thunk，
# 真正的请求在 stub 掉的 axios 里）。状态对象每次都返回**同一个数组实例**——返回新数组
# 会让 useSelector 判定"变了"而无限重渲染。
STUB_REDUX = """\
const state: any = {
  categories: { categories: [] },
  tags: { tags: [] },
  note: { noteList: [] },
  user: { avatar: '/owner.png', blogTitle: 'Saudade' },
};
export const useSelector = (fn: any) => fn(state);
export const useDispatch = () => (_action: any) => Promise.resolve({ status: 200, data: { code: 200, data: null } });
export const Provider = ({ children }: any) => children;
export const connect = () => (C: any) => C;
"""

HEAD_ENTRY = """\
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import Head from './src/frontHome/Head/index.tsx';
(window as any).__mountHead = () => createRoot(document.getElementById('root')!).render(
  <Head setDark={() => {}} isDark={false} scrollHeight={0} />
);
"""

ENTRY = """\
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import UserCenter from './src/components/UserCenter/index.tsx';
// 只挂个人中心本身：头部（点「个人中心」开窗、红点位置）由 Head 那套负责，这里测的是
// 窗口里的五个页签与它们的请求契约。
(window as any).__mount = (open: boolean) => createRoot(document.getElementById('root')!).render(
  <UserCenter open={open} onClose={() => { (window as any).__closed = true; }} fallbackAvatar="/owner.png" />
);
"""


def build_sandbox() -> pathlib.Path:
    sb = pathlib.Path(tempfile.mkdtemp(prefix="uc-verify-"))
    shutil.copytree(FE / "src", sb / "src")
    (sb / "node_modules").symlink_to(FE / "node_modules")

    (sb / "src/apis/axios.tsx").write_text(FAKE_AXIOS, encoding="utf-8")
    (sb / "stub-router.tsx").write_text(STUB_ROUTER, encoding="utf-8")
    (sb / "stub-redux.tsx").write_text(STUB_REDUX, encoding="utf-8")
    (sb / "entry.tsx").write_text(ENTRY, encoding="utf-8")
    (sb / "head-entry.tsx").write_text(HEAD_ENTRY, encoding="utf-8")

    # sass 单独编译（组件里的 import './index.sass' 由 esbuild 的 --loader:.sass=text 收下）
    css = []
    for rel in ("src/components/UserCenter/index.sass", "src/components/AvatarCropModal/index.sass",
                "src/frontHome/Head/index.sass"):
        out = sb / (pathlib.Path(rel).stem + ".css")
        subprocess.run(["node", "-e",
                        "const s=require('sass');const r=s.compile(process.argv[1],{style:'expanded'});"
                        "require('fs').writeFileSync(process.argv[2],r.css);",
                        str(FE / rel), str(out)], cwd=str(FE), check=True)
        css.append(out.read_text())

    def bundle(entry: str, outfile: str):
        # capture_output + check=True 会把 esbuild 的报错吞掉（只留一句 exit status 1，
        # 排查时等于没有信息）⇒ 失败时把 stderr 原样打出来再抛。
        r = subprocess.run([str(FE / "node_modules/.bin/esbuild"), entry,
                            "--bundle", "--format=iife", f"--outfile={outfile}",
                            "--loader:.sass=text", "--jsx=automatic",
                            f"--define:{DEFINE}",
                            f"--alias:react-router-dom={sb}/stub-router.tsx"],
                           cwd=str(sb), capture_output=True)
        if r.returncode != 0:
            # 按字节收、宽容解码：esbuild 会在中文那行按字节截断，严格 utf-8 解会先炸在
            # 解码上、把真正的报错盖掉（20260922 实测）。
            raise SystemExit("esbuild 打包 %s 失败：\n%s"
                             % (entry, r.stderr.decode("utf-8", "replace")))

    bundle("entry.tsx", "bundle.js")
    # 头部那一包多桩一个 react-redux（它是全站 store 的连接点）
    subprocess.run([str(FE / "node_modules/.bin/esbuild"), "head-entry.tsx",
                    "--bundle", "--format=iife", "--outfile=head-bundle.js",
                    "--loader:.sass=text", "--jsx=automatic",
                    f"--define:{DEFINE}",
                    f"--alias:react-router-dom={sb}/stub-router.tsx",
                    f"--alias:react-redux={sb}/stub-redux.tsx"],
                   cwd=str(sb), check=True, capture_output=True)

    head_css = (sb / "head-bundle.css")
    head_link = f'<link rel="stylesheet" href="head-bundle.css">' if head_css.exists() else ""

    (sb / "index.html").write_text(
        '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">'
        f"<style>{''.join(css)}</style></head><body><div id=\"root\"></div>"
        '<script src="bundle.js"></script>'
        '<script>window.__mount(true);</script>'
        '</body></html>', encoding="utf-8")
    (sb / "head.html").write_text(
        '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">'
        f"{head_link}<style>{''.join(css)}</style></head><body><div id=\"root\"></div>"
        '<script src="head-bundle.js"></script>'
        '<script>window.__mountHead();</script>'
        '</body></html>', encoding="utf-8")
    return sb


def make_png(path: pathlib.Path, w: int, h: int, color=(200, 60, 60)):
    """造一张真 PNG（走 Pillow）：裁剪要读 naturalWidth/Height 并 drawImage 到画布"""
    from PIL import Image
    path.parent.mkdir(parents=True, exist_ok=True)
    Image.new("RGB", (w, h), color).save(path)


SANDBOX = build_sandbox()
PNG = SANDBOX / "src-photo.png"
make_png(PNG, 600, 400)

# 两张"线上真会存在"的图：站点主人头像（组件的回退值）与头像上传接口的回包地址。
# 必须让它们**真能加载**——antd 的 Avatar 在图片 onError 时会把 <img> 整个摘掉、
# 退回文字兜底，于是"头像显示的是哪个地址"这条断言会变成"根本没有 <img>"。
make_png(SANDBOX / "owner.png", 120, 120, (110, 150, 210))
make_png(SANDBOX / "api/protect/download/avatars/7_abc.jpg", 512, 512, (120, 200, 160))

# 必须走 HTTP 而不是 file://：应用里图片是**根相对路径**（/owner.png、
# /api/protect/download/…），file:// 下会解析成 file:///owner.png 而必然 404。
import functools  # noqa: E402
import http.server  # noqa: E402
import threading  # noqa: E402

_handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(SANDBOX))
_handler.log_message = lambda *a, **k: None
_server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _handler)
threading.Thread(target=_server.serve_forever, daemon=True).start()

from playwright.sync_api import sync_playwright  # noqa: E402

URL = f"http://127.0.0.1:{_server.server_address[1]}/index.html"


# 当前页签的面板：antd 只把**激活过的**页签挂进 DOM（未激活的不挂），而「用户设置」
# 是常挂的 ⇒ 裸 `.ucPane` 会同时命中两个。排除 ucSettings 就唯一了。
PANE = ".ucPane:not(.ucSettings)"


def calls(page):
    return page.evaluate("() => window.__calls")


def find_call(page, url, method=None):
    return [c for c in calls(page) if c["url"] == url and (method is None or c["method"] == method)]


with sync_playwright() as p:
    br = p.chromium.launch()

    def fresh_page(role="user", dark=False):
        page = br.new_page(viewport={"width": 1280, "height": 900})
        errs = []
        page.on("pageerror", lambda e: errs.append(str(e)))
        # 主题源就是 localStorage.isDarkMode（theme.ts readDarkMode：裸 'true' 与
        # JSON 的 '"true"' 两种历史格式都认），挂载时 useIsDarkMode 会补读一次。
        page.add_init_script(f"window.__role = '{role}';"
                             + ("localStorage.setItem('isDarkMode','true');" if dark else ""))
        page.goto(URL)
        page.wait_for_selector(".ant-modal-content", timeout=10000)
        page.wait_for_timeout(600)
        page.errs = errs
        return page

    print("① 打开窗口：五个页签 + 用户设置（头像/昵称/账号）")
    pg = fresh_page()
    pg.wait_for_selector(".ucAvatarName", timeout=10000)
    tabs = pg.locator(".ant-tabs-tab").all_inner_texts()
    check("五个页签齐全（用户设置/收藏的文章/留言记录/公告和通知/站内信箱）",
          len(tabs) == 5 and "用户设置" in tabs[0] and "收藏的文章" in tabs[1]
          and "留言记录" in tabs[2] and "公告和通知" in tabs[3] and "站内信箱" in tabs[4],
          " | ".join(tabs))
    check("昵称来自 /api/protected/profile 的回包",
          pg.locator(".ucAvatarName").inner_text() == "泠月喵",
          pg.locator(".ucAvatarName").inner_text())
    check("账号只读展示（没有任何可改账号的输入框）",
          "sora" in pg.locator(".ucAvatarAccount").inner_text()
          and pg.locator(".ucAvatarAccount input").count() == 0)
    check("没设头像时回退到站点主人头像",
          pg.get_attribute(".ucAvatar img", "src") == "/owner.png",
          str(pg.get_attribute(".ucAvatar img", "src")))
    check("打开窗口只拉用户信息 + 未读汇总（其余页签懒加载，不白发请求）",
          sorted(c["url"] for c in calls(pg) if c["method"] == "GET")
          == ["/api/protected/notifications/summary", "/api/protected/profile"],
          " | ".join(f'{c["method"]} {c["url"]}' for c in calls(pg)))

    print("② 头像：选图 → 裁剪弹窗（拖动/缩放）→ 确定 → 发 multipart、界面换新地址")
    pg.set_input_files(".ucUploadBtn input[type=file]", str(PNG))
    pg.wait_for_selector(".acStage", timeout=10000)
    pg.wait_for_timeout(600)
    check("裁剪弹窗弹出来了（1:1 舞台 + 缩放滑块）",
          pg.locator(".acStage").count() == 1 and pg.locator(".acZoom .ant-slider").count() == 1)
    box = pg.evaluate("() => {const r=document.querySelector('.acStage').getBoundingClientRect();"
                      "return {x:r.left, y:r.top, w:r.width, h:r.height};}")
    check("舞台是正方形（1:1 裁剪窗）", abs(box["w"] - box["h"]) <= 1,
          f'{box["w"]:.0f}×{box["h"]:.0f}')
    # ★ 20260922 用户反馈「方形框裁出来圆形算什么」⇒ 改成 GitHub 那套：方舞台不动，
    #   叠一个内切圆遮罩、圆外压暗。几何一个字节没改（内切圆 = 方框的边 = 头像展示形状）。
    check("裁剪窗改成圆形遮罩（方舞台 + 内切圆 + 圆外压暗）",
          pg.locator(".acCircle").count() == 1 and pg.locator(".acCorner").count() == 0,
          f'acCircle={pg.locator(".acCircle").count()} acCorner={pg.locator(".acCorner").count()}')
    mask = pg.evaluate("""() => {
        const c = document.querySelector('.acCircle');
        const s = document.querySelector('.acStage').getBoundingClientRect();
        const r = c.getBoundingClientRect();
        const cs = getComputedStyle(c);
        return {sameAsStage: Math.abs(r.width - s.width) <= 1 && Math.abs(r.height - s.height) <= 1,
                radius: cs.borderRadius, shadow: cs.boxShadow};
    }""")
    check("遮罩与舞台同尺寸（内切圆 = 方框的边，所见即所得）", mask["sameAsStage"], str(mask))
    check("遮罩是正圆（border-radius 50%）", mask["radius"].startswith("50%"), mask["radius"])
    check("圆外用超大外扩 box-shadow 压暗（舞台 overflow:hidden 会把外扩部分裁掉）",
          "9999px" in mask["shadow"], mask["shadow"])
    check("图片已按 cover 摆进舞台（尺寸不为 0）", pg.evaluate(
        "() => {const i=document.querySelector('.acImg');const r=i.getBoundingClientRect();"
        "return r.width > 100 && r.height > 100;}"))
    # 拖动一次：焦点应真的移动（objectPosition 就是 coverCropStyle 给的焦点样式）
    before = pg.evaluate("() => document.querySelector('.acImg').style.objectPosition")
    cx, cy = box["x"] + box["w"] / 2, box["y"] + box["h"] / 2
    pg.mouse.move(cx + 40, cy)
    pg.mouse.down()
    pg.mouse.move(cx - 40, cy)
    pg.mouse.up()
    pg.wait_for_timeout(200)
    after = pg.evaluate("() => document.querySelector('.acImg').style.objectPosition")
    check("拖动改变了裁剪焦点（objectPosition 变化）", before != after, f"{before!r} → {after!r}")
    # 滚轮缩放：缩放值应变化（aria-valuenow 在 handle 上，不在 slider 根上）
    z_before = pg.get_attribute(".acZoom .ant-slider-handle", "aria-valuenow")
    pg.mouse.move(cx, cy)
    pg.mouse.wheel(0, -120)
    pg.wait_for_timeout(200)
    z_after = pg.get_attribute(".acZoom .ant-slider-handle", "aria-valuenow")
    check("滚轮缩放生效（缩放值变化）", z_before != z_after, f"{z_before} → {z_after}")
    pg.click(".acActions button.ant-btn-primary")
    pg.wait_for_timeout(1200)
    uploaded = pg.evaluate("() => window.__uploaded || null")
    check("确认后发了 multipart 上传，字段 avatar 且类型 image/jpeg",
          bool(uploaded) and uploaded["type"] == "image/jpeg", str(uploaded))
    check("上传的是画布烘焙的成品（远小于 2MB 上限）",
          bool(uploaded) and 0 < uploaded["size"] < 2 * 1024 * 1024,
          str(uploaded and uploaded["size"]))
    check("上传成功后界面换成回传的新地址",
          pg.get_attribute(".ucAvatar img", "src") == "/api/protect/download/avatars/7_abc.jpg",
          str(pg.get_attribute(".ucAvatar img", "src")))
    check("裁剪弹窗已关闭", pg.locator(".acStage").count() == 0)

    print("③ 用户设置：改昵称（成功 / 后端拒绝弹它那句中文 / 空值不发请求）")
    nick_input = ".ucSettings .ucField:not(.ucFieldStack) input.ant-input"
    nick_btn = ".ucSettings .ucField:not(.ucFieldStack) button.ant-btn-primary"
    pg.fill(nick_input, "新的昵称")
    pg.click(nick_btn)
    pg.wait_for_timeout(600)
    body = find_call(pg, "/api/protected/profile", "PUT")
    check("PUT /api/protected/profile 发了且带新昵称",
          bool(body) and body[-1]["data"] == {"nickname": "新的昵称"},
          str(body and body[-1]["data"]))
    check("保存后界面上的昵称跟着变", pg.locator(".ucAvatarName").inner_text() == "新的昵称",
          pg.locator(".ucAvatarName").inner_text())
    # 只有后端拦得住的取值 → 必须原样弹出后端那句中文
    pg.fill(nick_input, "重名")
    pg.click(nick_btn)
    pg.wait_for_timeout(700)
    check("后端拒绝时弹出的是后端那句中文，不是前端编的兜底话",
          "这个昵称已经有人在用了" in pg.locator(".ant-message").inner_text(),
          pg.locator(".ant-message").inner_text().replace("\n", " "))
    check("被拒后界面上的昵称没有被改掉（没有乐观更新）",
          pg.locator(".ucAvatarName").inner_text() == "新的昵称",
          pg.locator(".ucAvatarName").inner_text())
    n_before = len(find_call(pg, "/api/protected/profile", "PUT"))
    pg.fill(nick_input, "   ")
    pg.click(nick_btn)
    pg.wait_for_timeout(400)
    check("空昵称前端拦住，不发请求",
          len(find_call(pg, "/api/protected/profile", "PUT")) == n_before
          and "昵称不能为空" in pg.locator(".ant-message").inner_text(),
          pg.locator(".ant-message").inner_text().replace("\n", " "))

    print("④ 用户设置：改密码（两次不一致前端拦、键名后端认、原密码错弹中文、成功后清空）")
    pwd_in = ".ucSettings .ucFieldStack input.ant-input"
    pwd_btn = ".ucSettings .ucFieldStack button.ant-btn-primary"
    n_before = len(find_call(pg, "/api/protected/profile/password", "PUT"))
    pg.fill(f"{pwd_in} >> nth=0", "old-pass-123")
    pg.fill(f"{pwd_in} >> nth=1", "new-pass-123")
    pg.fill(f"{pwd_in} >> nth=2", "new-pass-999")
    pg.click(pwd_btn)
    pg.wait_for_timeout(400)
    check("两次新密码不一致：前端拦住，不发请求",
          len(find_call(pg, "/api/protected/profile/password", "PUT")) == n_before
          and "不一致" in pg.locator(".ant-message").inner_text(),
          pg.locator(".ant-message").inner_text().replace("\n", " "))
    pg.evaluate("() => { window.__pwdFail = true; }")
    pg.fill(f"{pwd_in} >> nth=2", "new-pass-123")
    pg.click(pwd_btn)
    pg.wait_for_timeout(700)
    pw = find_call(pg, "/api/protected/profile/password", "PUT")
    check("键名是后端认的 oldPassword/newPassword（不是 Rust 字段名）",
          bool(pw) and set(pw[-1]["data"].keys()) == {"oldPassword", "newPassword"},
          str(pw and pw[-1]["data"]))
    check("原密码错：弹出后端那句中文", "原密码不正确" in pg.locator(".ant-message").inner_text(),
          pg.locator(".ant-message").inner_text().replace("\n", " "))
    pg.evaluate("() => { window.__pwdFail = false; }")
    pg.fill(f"{pwd_in} >> nth=0", "old-pass-123")
    pg.click(pwd_btn)
    pg.wait_for_timeout(700)
    check("改成功后输入框清空（密码不留在表单里）",
          pg.input_value(f"{pwd_in} >> nth=0") == "" and pg.input_value(f"{pwd_in} >> nth=1") == "")
    pg.close()

    print("⑤ 收藏的文章：懒加载、阅读先关窗再跳、取消收藏发 DELETE 且行当场消失")
    pg = fresh_page()
    pg.click(".ant-tabs-tab >> nth=1")
    pg.wait_for_selector(PANE + " .ant-list-item", timeout=10000)
    titles = pg.locator(".ucItemTitle").all_inner_texts()
    check("收藏列表来自后端且两行都在", len(titles) == 2 and "架构文档" in titles[0],
          " | ".join(titles))
    pg.locator(PANE + " .ant-list-item").nth(0).locator("button", has_text="阅读").click()
    pg.wait_for_timeout(400)
    nav = pg.evaluate("() => window.__nav || []")
    check("点「阅读」先关窗再跳 /article/12",
          nav and nav[-1] == "/article/12" and pg.evaluate("() => window.__closed === true"), str(nav))
    pg.click(".ant-tabs-tab >> nth=1")
    pg.wait_for_timeout(300)
    pg.locator(PANE + " .ant-list-item").nth(1).locator("button", has_text="取消收藏").click()
    pg.wait_for_timeout(700)
    dels = [c for c in calls(pg) if c["method"] == "DELETE"]
    check("DELETE /api/protected/favorites/22 发了",
          bool(dels) and dels[-1]["url"].endswith("/22"), str(dels))
    check("取消后那一行当场消失", pg.locator(PANE + " .ant-list-item").count() == 1,
          str(pg.locator(PANE + " .ant-list-item").count()))
    pg.close()

    print("⑥ 公告和通知：页签未读角标 = 后端汇总；全部已读后当场归零")
    pg = fresh_page()
    notice_badge = ".ant-tabs-tab >> nth=3 >> .ant-badge-count"
    mail_badge = ".ant-tabs-tab >> nth=4 >> .ant-badge-count"
    check("公告页签挂着未读角标（1 条）",
          pg.locator(notice_badge).count() == 1 and pg.locator(notice_badge).inner_text() == "1",
          pg.locator(".ant-tabs-tab >> nth=3").inner_text().replace("\n", " "))
    check("信箱页签挂着未读角标（1 封）",
          pg.locator(mail_badge).count() == 1 and pg.locator(mail_badge).inner_text() == "1",
          pg.locator(".ant-tabs-tab >> nth=4").inner_text().replace("\n", " "))
    check("未读数来自 /notifications/summary（不是前端自己数列表）",
          bool(find_call(pg, "/api/protected/notifications/summary", "GET")))
    pg.click(".ant-tabs-tab >> nth=3")
    pg.wait_for_selector(PANE + " .ant-list-item", timeout=10000)
    pane_txt = pg.locator(PANE).inner_text()
    check("列表按 type 显示「公告」标签，且未读那条带标记",
          "公告" in pane_txt and pg.locator(PANE + " .ant-badge-status-processing").count() == 1,
          pane_txt.replace("\n", " ")[:120])
    pg.click(PANE + " .ucPaneBar button.ant-btn")
    pg.wait_for_timeout(800)
    rd = find_call(pg, "/api/protected/notifications/read", "POST")
    check("全部已读发的是 {ids: [], all: true}",
          bool(rd) and rd[-1]["data"] == {"ids": [], "all": True}, str(rd and rd[-1]["data"]))
    check("红点当场归零（不等下一次轮询）", pg.locator(notice_badge).count() == 0,
          pg.locator(".ant-tabs-tab >> nth=3").inner_text().replace("\n", " "))
    pg.close()

    print("⑦ 站内信箱：收件箱/发件箱、发信成功进发件箱、收件人不存在弹后端中文")
    pg = fresh_page()
    pg.click(".ant-tabs-tab >> nth=4")
    pg.wait_for_selector(".ucCompose", timeout=10000)
    pg.wait_for_selector(PANE + " .ant-list-item", timeout=10000)
    check("收件箱里有一封「来自 小猫咪」", "来自 小猫咪" in pg.locator(PANE).inner_text(),
          pg.locator(PANE).inner_text().replace("\n", " ")[:100])
    # 写信区现在有三个输入（收件人 / 信件标题 / 正文）⇒ 收件人必须用 nth 定位，
    # 裸 `.ucCompose input.ant-input` 会命中两个（Playwright 严格模式下直接报错）。
    to_in = ".ucCompose input.ant-input >> nth=0"
    title_in = ".ucCompose input.ant-input >> nth=1"
    body_in = ".ucCompose textarea"
    send_btn = ".ucCompose button.ant-btn-primary"
    check("历史信件没有标题列 ⇒ 如实显示「（无标题）」，不拿正文首行冒充",
          "（无标题）" in pg.locator(PANE).inner_text(),
          pg.locator(PANE).inner_text().replace("\n", " ")[:120])
    check("写信区有「信件标题」这一项（选填，上限 60 字）",
          pg.get_attribute(title_in, "maxlength") == "60"
          and "选填" in pg.get_attribute(title_in, "placeholder"),
          str(pg.get_attribute(title_in, "placeholder")))
    pg.fill(to_in, "nobody")
    pg.fill(title_in, "关于那篇架构文档")
    pg.fill(body_in, "在吗")
    pg.click(send_btn)
    pg.wait_for_timeout(700)
    check("收件人不存在：弹出后端那句中文（不假装发成功）",
          "找不到这个用户" in pg.locator(".ant-message").inner_text(),
          pg.locator(".ant-message").inner_text().replace("\n", " "))
    pg.fill(to_in, "xiaoji")
    pg.click(send_btn)
    pg.wait_for_timeout(700)
    sm = find_call(pg, "/api/protected/messages", "POST")
    check("发信体是 {toUsername, title, content}（后端认的键名）",
          bool(sm) and set(sm[-1]["data"].keys()) == {"toUsername", "title", "content"},
          str(sm and sm[-1]["data"]))
    check("标题按填写的原样发出", bool(sm) and sm[-1]["data"]["title"] == "关于那篇架构文档",
          str(sm and sm[-1]["data"]))
    check("发完清空正文输入框（防手抖重发）", pg.input_value(body_in) == "")
    # 不填标题也必须发得出去（选填），且发出去的是空串——后端把它折成 NULL
    pg.fill(to_in, "xiaoji")
    pg.fill(body_in, "没有标题的一封")
    pg.click(send_btn)
    pg.wait_for_timeout(700)
    sm2 = find_call(pg, "/api/protected/messages", "POST")
    check("标题留空照样能发（选填，发空串由后端折成 NULL）",
          len(sm2) == len(sm) + 1 and sm2[-1]["data"]["title"] == "",
          str(sm2 and sm2[-1]["data"]))
    check("发完清空标题输入框", pg.input_value(title_in) == "")
    pg.locator(PANE + " .ant-tabs-tab").nth(1).click()
    pg.wait_for_timeout(400)
    check("发件箱里出现刚发的那封", "发给 xiaoji" in pg.locator(PANE).inner_text(),
          pg.locator(PANE).inner_text().replace("\n", " ")[:160])
    pg.close()

    print("⑧ 留言记录：只列河灯留言 / 印章放的是留言类型 / 审核状态如实显示")
    pg = fresh_page()
    pg.click(".ant-tabs-tab >> nth=2")
    pg.wait_for_selector(PANE + " .ant-list-item", timeout=10000)
    txt = pg.locator(PANE).inner_text()
    # 用户 20260922 原话「说说不是留言，为什么还出现在这里并且有审核状态」⇒ 本页只列 board。
    # 后端已加 src='board' 过滤，前端显示层再兜一道（假后端故意两类都回，验的就是这一条）。
    check("说说不出现在留言记录里（后端过滤 + 前端显示层兜底）",
          pg.locator(PANE + " .ant-list-item").count() == 1
          and "今天写了点东西" not in txt and "随笔" not in txt,
          "行数=%d 文本=%s" % (pg.locator(PANE + " .ant-list-item").count(),
                              txt.replace("\n", " ")[:140]))
    check("河灯留言照常在，审核状态如实显示",
          "河灯一盏" in txt and "已通过" in txt, txt.replace("\n", " ")[:140])
    # 印章必须是**留言板那个红**（.rz-seal = #a33f30 底 / #ffe8c8 暖金字 + 衬线 + 0.22em 字距）。
    # 此前这里是 antd 的蓝色 Tag，用户原话「留言的印章颜色不是留言板的红色」。
    # 两处色值是跨组件的视觉契约，改一处必须改另一处（留言板那份在 riverboard 样式里）。
    # 且印章里放的必须是**留言类型**（cat：诉/寄/愿/忆）——用户第二轮纠正的就是这一点。
    seal = pg.evaluate("""() => {
        const s = document.querySelectorAll('.ucSeal');
        if (!s.length) return null;
        const cs = getComputedStyle(s[0]);
        return {n: s.length, text: s[0].textContent, bg: cs.backgroundColor, color: cs.color,
                ls: cs.letterSpacing, ff: cs.fontFamily};
    }""")
    check("印章里是留言类型（诉），不是「留言板/说说」这种来源标",
          bool(seal) and seal["n"] == 1 and seal["text"] == "诉", str(seal))
    check("印章用的是留言板那个红（#a33f30 底 / #ffe8c8 字），不是 antd 蓝 Tag",
          bool(seal) and seal["bg"] == "rgb(163, 63, 48)" and seal["color"] == "rgb(255, 232, 200)",
          str(seal))
    check("印章保留了 .rz-seal 的字形特征（衬线 + 0.22em 字距）",
          bool(seal) and seal["ls"] == "2.42px" and "serif" in seal["ff"].lower(), str(seal))
    pg.close()

    print("⑨ 管理员多一个「后台管理」入口（普通用户没有）")
    pg = fresh_page(role="admin")
    pg.wait_for_selector(".ucAvatarName", timeout=10000)
    check("管理员窗口里能看到「后台管理」", pg.locator(".ucTitle button.ant-btn-link").count() == 1)
    pg.click(".ucTitle button.ant-btn-link")
    pg.wait_for_timeout(400)
    check("点它先关窗再跳 /dashboard",
          pg.evaluate("() => (window.__nav || []).slice(-1)[0]") == "/dashboard"
          and pg.evaluate("() => window.__closed === true"),
          str(pg.evaluate("() => window.__nav || []")))
    admin_errs = list(pg.errs)
    pg.close()
    pg_user = fresh_page()
    pg_user.wait_for_selector(".ucAvatarName", timeout=10000)
    check("普通用户没有这个入口", pg_user.locator(".ucTitle button.ant-btn-link").count() == 0)
    body_errs = list(pg_user.errs)
    pg_user.close()

    print("⑩ 窗口观感：五页签尺寸一致 / 标题栏分割线 / 关闭钮贴右上 / 字数计数不被遮挡")
    pg = fresh_page()
    geo = []
    for i in range(5):
        pg.click(f".ant-tabs-tab >> nth={i}")
        pg.wait_for_timeout(450)
        geo.append(pg.evaluate("""() => {
            const c = document.querySelector('.ant-modal-content').getBoundingClientRect();
            const p = document.querySelector('.ant-tabs-tabpane-active .ucPane').getBoundingClientRect();
            return {w: Math.round(c.width), h: Math.round(c.height), ph: Math.round(p.height)};
        }"""))
    check("五个页签下窗口尺寸一模一样（不再换个页就变形）",
          len({(g["w"], g["h"]) for g in geo}) == 1, str(geo))
    check("五个页签的内容格高度也一致（固定高度 + 内容多的自己滚）",
          len({g["ph"] for g in geo}) == 1, str(geo))
    hdr = pg.evaluate("""() => {
        const h = document.querySelector('.ant-modal-header');
        const cs = getComputedStyle(h);
        const r = h.getBoundingClientRect();
        const t = document.querySelector('.ant-tabs-nav').getBoundingClientRect();
        return {bw: cs.borderBottomWidth, bs: cs.borderBottomStyle, mb: cs.marginBottom,
                hBottom: r.bottom, tabsTop: t.top};
    }""")
    # antd v5 的 Modal header **默认没有下边框**（v4 才有），这条是自己补的 ⇒ 断言要量
    # computed style，不能只看"有没有写过这句 CSS"。
    check("标题栏底下有分割线（antd v5 默认无，是补的）",
          hdr["bs"] == "solid" and float(hdr["bw"].replace("px", "")) >= 1, str(hdr))
    check("分割线正好夹在标题栏与五页签之间",
          hdr["mb"] == "0px" and hdr["hBottom"] <= hdr["tabsTop"] + 1, str(hdr))
    close = pg.evaluate("""() => {
        const b = document.querySelector('.ant-modal-close').getBoundingClientRect();
        const c = document.querySelector('.ant-modal-content').getBoundingClientRect();
        return {gapTop: Math.round(b.top - c.top), gapRight: Math.round(c.right - b.right),
                w: Math.round(b.width)};
    }""")
    check("关闭钮往右上角挪了（离内容框上/右各约 9px，antd 默认各约 17px）",
          4 <= close["gapTop"] <= 14 and 4 <= close["gapRight"] <= 14 and close["w"] > 0, str(close))
    # ★「字数限制文本被遮挡」（20260922 用户反馈）：antd 的 showCount 把计数绝对定位在
    #   输入框下方约 22px 处，而 .ucField 的行距只有 12px ⇒ 计数整条被下一行压住。
    #   修法是给 TextArea 套一层 .ucMsgBody 吃 margin-bottom（见 index.tsx 同名注释）。
    #   这里量**几何重叠**，因为"CSS 写对了"和"真的没被压住"是两件事。
    pg.click(".ant-tabs-tab >> nth=4")
    pg.wait_for_selector(".ucCompose", timeout=10000)
    pg.wait_for_timeout(400)
    pg.fill(".ucCompose textarea", "遮挡检查")
    pg.wait_for_timeout(300)
    cnt = pg.evaluate("""() => {
        const c = document.querySelector('.ucCompose .ant-input-data-count');
        if (!c) return null;
        const r = c.getBoundingClientRect();
        const f = document.querySelector('.ucCompose .ucFieldFoot').getBoundingClientRect();
        const ta = document.querySelector('.ucCompose textarea').getBoundingClientRect();
        const cs = getComputedStyle(c);
        return {text: c.textContent, countTop: Math.round(r.top), countBottom: Math.round(r.bottom),
                taBottom: Math.round(ta.bottom), footTop: Math.round(f.top),
                visible: r.width > 0 && r.height > 0 && cs.visibility !== 'hidden'};
    }""")
    check("字数计数（N / 500）真的渲染出来了", bool(cnt) and cnt["visible"], str(cnt))
    check("计数在正文输入框下方", bool(cnt) and cnt["countTop"] >= cnt["taBottom"] - 1, str(cnt))
    check("计数不再被下面那行（.ucFieldFoot）压住",
          bool(cnt) and cnt["countBottom"] <= cnt["footTop"], str(cnt))
    check("计数内容如实反映输入长度", bool(cnt) and cnt["text"].startswith("4 / 500"),
          str(cnt and cnt["text"]))
    pg.close()

    print("⑪ 夜间：窗口金色漏光描边 + 发送按钮换成登录页那套配色")
    dk = fresh_page(dark=True)
    # state="attached"：`.ucRoot` 落在外层 .ant-modal-root 上，那个 div 自身没有尺寸
    # （子元素都是 fixed/absolute），Playwright 默认的 visible 判据会一直等不到。
    dk.wait_for_selector(".ucRoot.ucDark", state="attached", timeout=10000)
    dk.wait_for_selector(".ant-modal-content", timeout=10000)
    dk.wait_for_timeout(600)
    glow = dk.evaluate("""() => {
        const c = document.querySelector('.ant-modal-content');
        const cs = getComputedStyle(c);
        return {shadow: cs.boxShadow, border: cs.borderTopWidth};
    }""")
    check("夜间窗口有金色漏光描边（河灯金 1px 环 + 外发光，取登录页月晕同族色）",
          "240, 196, 110" in glow["shadow"], glow["shadow"])
    check("描边走 box-shadow（不动 border，不挤动窗内布局）",
          glow["border"] in ("0px", "0"), glow["border"])
    dk.click(".ant-tabs-tab >> nth=4")
    dk.wait_for_selector(".ucSendBtn", timeout=10000)
    dk.wait_for_timeout(400)
    btn = dk.evaluate("""() => {
        const b = document.querySelector('.ucSendBtn');
        const cs = getComputedStyle(b);
        return {bgImage: cs.backgroundImage, color: cs.color, border: cs.borderTopWidth};
    }""")
    check("夜间发送按钮是登录页那套河灯金渐变（不是 darkAlgorithm 的灰绿主色）",
          "247, 220, 174" in btn["bgImage"] and "232, 184, 102" in btn["bgImage"], str(btn))
    check("按钮文字是墨色、无边框（金底上可读，与 .login-submit 同配方）",
          btn["color"] == "rgb(42, 33, 19)" and btn["border"] == "0px", str(btn))
    dk.close()

    print("⑫ 头部：头像右上角红点 + 点「个人中心」打开个人中心（挂真 Head 组件跑）")
    hp = br.new_page(viewport={"width": 1280, "height": 900})
    head_errs = []
    hp.on("pageerror", lambda e: head_errs.append(str(e)))
    hp.goto(URL.replace("index.html", "head.html"))
    hp.wait_for_selector(".homeRight .avatarDotWrap", timeout=15000)
    hp.wait_for_timeout(800)
    check("桌面头部头像上挂了红点（未读通知 1 + 未读私信 1）",
          hp.locator(".homeRight .avatarDot").count() == 1
          and hp.get_attribute(".homeRight .avatarDot", "aria-label") == "有 2 条未读",
          str(hp.get_attribute(".homeRight .avatarDot", "aria-label")))
    check("移动抽屉里的那个头像也有红点（窄屏下 .homeRight 是 display:none）",
          hp.locator(".phoneSide .avatarDot").count() == 1)
    check("红点不抢走头像的 hover（pointer-events: none）",
          hp.evaluate("() => getComputedStyle(document.querySelector('.homeRight .avatarDot'))"
                      ".pointerEvents") == "none")
    # 「个人中心」按钮在 hover 出来的登录卡里（showStatus 有 300ms 防抖）。
    # ⚠️ 几何断言必须放在 hover **之后**：登录卡平时是 display:none，getBoundingClientRect
    # 全 0，量出来只会是"没歪也判失败"（20260922 实测踩过）。
    hp.hover(".homeRight .homeLogo")
    hp.wait_for_timeout(900)
    # ★ 回归锁（20260922 事故）：`.loginCard` 丢掉 position:absolute 就掉回文档流，
    #   把头像与登录/退出按钮整片挤歪。根因是 sass 的**缩进嵌套**——有人在 .loginCard
    #   上面插了个顶格规则块，编译器就把 .loginCard 挂到那个选择器下面去了（DOM 里两者
    #   是兄弟，选择器一旦变成 `.X .loginCard` 就一条都不命中）。这条断言直接量几何，
    #   比"看着没歪"可靠：登录卡必须贴着头部右缘浮在上面。
    pg_geo = hp.evaluate("""() => {
        const c = document.querySelector('.homeRight .loginCard');
        const r = c.getBoundingClientRect();
        const h = document.querySelector('.homeRight').getBoundingClientRect();
        return {pos: getComputedStyle(c).position, top: Math.round(r.top),
                right: Math.round(r.right), hRight: Math.round(h.right),
                hTop: Math.round(h.top), w: Math.round(r.width)};
    }""")
    check("登录卡是浮层（position:absolute）——sass 嵌套错位会让它掉回文档流",
          pg_geo["pos"] == "absolute" and pg_geo["w"] > 0, str(pg_geo))
    check("登录卡贴在头部右缘（没有被挤走的位移）",
          abs(pg_geo["right"] - pg_geo["hRight"]) <= 40 and pg_geo["top"] >= pg_geo["hTop"] - 40,
          str(pg_geo))
    uc_btn = hp.locator(".homeRight .loginCard .theme-btn", has_text="个人中心")
    check("普通用户的按钮文案已从「心境」改成「个人中心」",
          uc_btn.count() == 1
          and hp.locator(".homeRight .loginCard .theme-btn", has_text="心境").count() == 0,
          " | ".join(hp.locator(".homeRight .loginCard .theme-btn").all_inner_texts()))
    uc_btn.click()
    hp.wait_for_selector(".ant-modal-content", timeout=10000)
    check("点「个人中心」打开的是个人中心（不再是跳 /dashboard）",
          "个人中心" in hp.locator(".ant-modal-content").inner_text()
          and hp.evaluate("() => (window.__nav || []).length") == 0,
          str(hp.evaluate("() => window.__nav || []")))
    # 退出：头部是常驻组件，只靠挂载时读一次 localStorage 会留下过期的登录态
    hp.evaluate("""() => { localStorage.removeItem('tokenKey');
                           window.dispatchEvent(new CustomEvent('auth-change')); }""")
    hp.wait_for_timeout(800)
    check("退出登录（auth-change）：红点消失",
          hp.locator(".homeRight .avatarDot").count() == 0,
          str(hp.locator(".homeRight .avatarDot").count()))
    # antd 关窗后 .ant-modal-content 仍留在 DOM 里（外层挂了 display:none）⇒ 判**可见性**
    check("退出登录（auth-change）：个人中心自动关掉",
          not hp.locator(".ant-modal-content").is_visible(),
          str(hp.locator(".ant-modal-content").count()))
    hp.screenshot(path="/tmp/head-user-center.png")
    hp.close()

    print("⑬ 全程无 JS 报错")
    all_errs = body_errs + admin_errs + head_errs
    check("无 pageerror", not all_errs, "; ".join(all_errs[:3]))
    br.close()

_server.shutdown()
shutil.rmtree(SANDBOX, ignore_errors=True)
print("\n截图：/tmp/user-center.png（本机无中文字体，汉字为豆腐块）")
print("\n" + ("全部通过" if not FAILS else f"失败 {len(FAILS)} 项：" + "; ".join(FAILS)))
sys.exit(1 if FAILS else 0)
