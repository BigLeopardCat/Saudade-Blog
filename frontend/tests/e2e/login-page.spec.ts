import { test, expect, type Browser, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  FE_DIR,
  compileSass,
  withSandbox,
  esbuildInSandbox,
  collectPageErrors,
} from "./sandbox";

/**
 * 登录页无头验收（20260921 改版）：结构 / 几何 / 聚焦样式 / 弹窗交互 / 提交契约。
 * （原 tests/login-page.test.py，20261019 迁移）
 *
 * 跳转契约（20260922）也在这里锁：管理员 token → /dashboard，普通用户/无 token → /。
 * 两岔都要在，只锁一岔就会漏掉"普通用户被送进后台吃一次无权限再弹回来"那类问题。
 *
 * **昼夜两档（20261006 用户第 3 条）**：这一页从前恒深色，现在跟随全站
 * （白天 = 主页那套和纸配色，夜间 = 原来的墨蓝 + 河灯金，见 src/pages/Login/index.sass
 * 的头注）。判据因此分两套夹具跑：主页面**不带 isDarkMode**（= 全站默认的白天档），
 * 另开一个 `pg_d` 在挂载前写 `localStorage.isDarkMode = 'true'` 当夜间夹具。
 * ③ 那一节里量色值的那几条因此住到 `pg_d` 上 —— 它们量的正是"夜间档还是原来那副样子"。
 *
 * 本机不能 vite build（3.7GB 内存会 OOM，见 CLAUDE.md §2），沿用既定替代手段：
 *   · sass 用 programmatic API 编译（`node_modules/.bin/sass` 在 Node 18 上会因
 *     chokidar 的 ERR_REQUIRE_ESM 直接崩，别用 CLI）；
 *   · esbuild 把**真组件**打成一个 bundle，配桩掉 antd / react-router-dom /
 *     react-redux / 取 token 与 fetchToken 的模块（只桩边界，不桩被测逻辑）；
 *   · 真 react-dom 渲染 → Playwright 断言。
 *
 * （TS 迁移注：原版是一条流程串到底（⑥ 把账号填成 sora、⑩ 依赖它），
 * 这里同样单个 test 串行，辅助页面 browser.newPage 各自独立 context。）
 */

const LOGIN_SASS = path.join(FE_DIR, "src/pages/Login/index.sass");
const TOKENS_CSS = readFileSync(path.join(FE_DIR, "src/index.css"), "utf-8");

// ── ① 桩：antd / router / redux（真渲染 DOM，便于无头断言） ──────────────────
const STUB_ANTD = `
// 极简 antd stub（只覆盖 Login 用到的 Modal / message / ConfigProvider）：真渲染 DOM，
// 便于无头断言。ConfigProvider 只记录 props——真 antd 的深色是 CSS-in-JS 注入的，
// 沙箱里没有它的样式表，所以能验的是**接线**（主题有没有传下去），不是最终观感。
import * as React from 'react';
export const __msgLog: string[] = [];
(window as any).__msgLog = __msgLog;
// push 必须现取 window.__msgLog（而非闭包引用）：测试段清空用的是整组替换
// （__msgLog = []），闭包引用会把记录推进已被替换掉的旧数组，读数会永远空。
export const message = {
    useMessage: () => [
        {
            success: (t: string) => (window as any).__msgLog.push('success:' + t),
            error: (t: string) => (window as any).__msgLog.push('error:' + t),
            warning: (t: string) => (window as any).__msgLog.push('warning:' + t),
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
`;

const STUB_ROUTER = `
// navigate 必须是**稳定引用**——真 react-router 的 useNavigate 就是稳定的（内部 useCallback）。
// Login 里 useEffect(..., [navigate]) 依赖它：桩若每次渲染返回新函数，那个 effect 会跟着
// 每次 re-render 重跑（每跳一次都多记一笔），"跳了几次/跳去哪"就再也量不准。
const nav = (to: string) => {
    (window as any).__nav = ((window as any).__nav || []).concat(to);
};
export const useNavigate = () => nav;
`;

const STUB_REDUX = `
export const useDispatch = () => (action: any) => {
    (window as any).__actions = ((window as any).__actions || []).concat(action);
    return Promise.resolve({ status: (window as any).__loginStatus ?? 200, message: 'ok' });
};
`;

const ENTRY = `
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import Login from './src/pages/Login/index.tsx';
(window as any).__mount = () => createRoot(document.getElementById('root')!).render(<Login />);
`;

/** WCAG 2.x 相对亮度（传 0-255 三元组）。 */
function lum(rgb: number[]): number {
  const f = (c: number) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * f(rgb[0]) + 0.7152 * f(rgb[1]) + 0.0722 * f(rgb[2]);
}
function contrastRatio(fg: number[], bg: number[]): number {
  const a = lum(fg);
  const b = lum(bg);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/**
 * 造一个 payload 段合法的 JWT。前端 `isAdminToken`（src/utils/auth.ts）只解码 payload
 * 的 role 来做界面分流、**不验签**（真正的授权在 Rust），所以签名段可以是假的。
 * 用途：登录页自 20260922 起跳转分两岔——管理员 token → /dashboard，其余 → /，两条都要锁。
 */
function jwtWithRole(role: string): string {
  const payload = Buffer.from(
    JSON.stringify({ sub: 721, role }),
    "utf-8",
  )
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return "x." + payload + ".y";
}

// ── 时钟夹具（20261013）──────────────────────────────────────────────────
// 这一页现在**自己会跟着钟面切档**（挂 `useAutoThemeSwitch()`，判据见 ③d），于是
// "没写 isDarkMode ⇒ 白天档"这类夹具必须**把时间钉住**：不钉的话，套件在 23:00-06:00
// 之间跑时页面的分钟 ticker 会把冷启动的浅色页切成夜间，③a 那一整段（白天档）当场
// 全红 —— 20261013 23:42 实测，连带红 10 项，而那是**夹具随时辰变**，不是样式坏了。
// 钉在本地 14:00：正是 ticker 的设计无动作时段（06:00-23:00 只认访客），夹具回到
// "测的是样式、不是钟表"。
// ⚠️ install 的 time 传 **Date** 最稳（数字按秒解释，传毫秒会落到公元 58753 年）。
// ⚠️ `install` 只设起始时刻、时钟照常自己走；要冻住得再 pauseAt()。③d 靠 fastForward 跳。
// ⚠️ 本机无时区对齐：测试进程时区是东八区而浏览器侧是 UTC，`new Date(…14,0,0)` 落到
//    浏览器钟面是 06:00 —— 「钟面停在 14:00」「22:58 钉子」及 ③d 的落盘/闩判据在本机
//    红 X，**Python 原版同机同红**（dt.datetime 构造同样带东八区偏移），属环境差异非
//    回归；判据保留原值（CI 的 runner 时区若为 UTC 则应转绿）。
const DAYTIME = new Date(2026, 9, 13, 14, 0, 0); // 2026-10-13 14:00（月份 0 起）

async function newPage(
  browser: Browser,
  opts: { time?: Date; viewport?: { width: number; height: number } } = {},
): Promise<Page> {
  // browser.newPage() 每个页面自带一个匿名 context（localStorage 不串页），保持原语义。
  const page = await browser.newPage({
    viewport: opts.viewport ?? { width: 1280, height: 900 },
  });
  await page.clock.install({ time: opts.time ?? DAYTIME });
  return page;
}

async function styles(
  page: Page,
  sel: string,
  pseudo: string | null = null,
  props: string[] = ["borderTopColor"],
): Promise<Record<string, string>> {
  return page.evaluate(
    ([s, pse, pr]) => {
      const el = document.querySelector(s)!;
      const cs = getComputedStyle(el, pse ?? undefined);
      const o: Record<string, string> = {};
      pr.forEach((p) => {
        o[p] = (cs as unknown as Record<string, string>)[p];
      });
      return o;
    },
    [sel, pseudo, props] as [string, string | null, string[]],
  );
}

test.describe("登录页改版验收", () => {
  test.setTimeout(240_000);

  test("结构/几何/昼夜两档/弹窗/提交契约/密码显隐/重定向/移动端（111 条）", async ({
    browser,
  }) => {
    // ② sass 编译（programmatic API）；②b 全站令牌（`src/index.css` 的 `:root` 与夜间档）。
    // **必须一起引**：登录页自 20261006 起用 `--washi-*` 分昼夜两档，不引这份的话
    // `getComputedStyle` 拿到的是 `var()` 的**回退值**（写在各处的字面量）——白天那几条
    // 断言会变成"量回退值"，改令牌也照样绿，是一条假绿的判据。
    const loginCss = compileSass(LOGIN_SASS);

    await withSandbox(
      {
        "index.html":
          '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">' +
          '<link rel="stylesheet" href="tokens.css">' +
          '<link rel="stylesheet" href="login.css"></head><body><div id="root"></div>' +
          '<script src="bundle.js"></script><script>window.__mount && window.__mount();</script>' +
          "</body></html>",
        "tokens.css": TOKENS_CSS,
        "login.css": loginCss,
      },
      async (sb) => {
        // ① 搭沙箱：拷贝 src、就地替换边界模块、alias 桩三件套
        await esbuildInSandbox(sb, {
          entry: "entry.tsx",
          copySrc: true,
          define: {
            "import.meta.env": JSON.stringify({
              VITE_HTTP_BASEURL: "",
              VITE_CDN_BASEURL: "",
              MODE: "production",
              DEV: false,
              PROD: true,
              BASE_URL: "/",
            }),
          },
          alias: {
            antd: path.join(sb.dir, "stubs/antd.tsx"),
            "react-router-dom": path.join(sb.dir, "stubs/router.tsx"),
            "react-redux": path.join(sb.dir, "stubs/redux.tsx"),
          },
          loaders: { ".sass": "text" },
          files: {
            "stubs/antd.tsx": STUB_ANTD,
            "stubs/router.tsx": STUB_ROUTER,
            "stubs/redux.tsx": STUB_REDUX,
            "src/apis/getToken.tsx":
              "const getToken = () => (window as any).__token ?? null;\nexport default getToken;\n",
            "src/store/components/user.tsx":
              "export const fetchToken = (data: any) => ({ type: 'user/fetchToken', payload: data });\n",
            "src/components/SeoHelmet.tsx":
              "const SeoHelmet = (_p: any) => null;\nexport default SeoHelmet;\n",
            // 桩掉错误上报（真源码见 src/utils/report.ts）：它的 error 监听（capture）会把
            // 沙箱里必然发生的资源 404（头像指向真后端才存在的 /api/protect/download/…）
            // 当错误 POST 到 /api/monitor/log。Python 原版用 file:// 起页，fetch(file://)
            // 被浏览器直接拒绝——上报请求根本没发出，"零 XHR"判据才碰巧成立；TS 沙箱是
            // http 静态服务，这条 fetch 会真的发出去。桩掉对齐原判据语义（测的是页面
            // 行为，不是上报通道），axios.tsx 只用 reportError 一个符号。
            "src/utils/report.ts":
              "export const reportError = (_p: any) => {};\n",
            "entry.tsx": ENTRY,
          },
        });

        const pg = await newPage(browser);
        const errs = collectPageErrors(pg);
        await pg.goto(sb.url);
        await pg.waitForTimeout(400);

        // ── ⓪ 时钟夹具生效（夹具的前提：钟面卡在 14:00，不是「跑的那一刻」） ──
        // 这一条是**判据的前提守卫**：时钟没钉上时，白天档那 10 条会随跑的时刻忽绿忽红，
        // 而"绿"和"红"都读不出是样式坏了还是钟面飘了。先量钟面，再量样式。
        expect.soft(
          (await pg.evaluate(() => new Date().getHours())) === 14,
          `浏览器钟面停在本地 14:00（ticker 的设计无动作时段） → ${await pg.evaluate(() => new Date().toString())}`,
        ).toBe(true);

        // ── ① 结构（旧页面的霓虹锚点应已不存在） ──
        expect.soft(
          errs().length === 0,
          `无 JS 运行时报错 → ${errs().slice(0, 2).join("; ")}`,
        ).toBe(true);
        expect.soft(
          (await pg.locator(".login-box").count()) === 1,
          `.login-box 存在`,
        ).toBe(true);
        expect.soft(
          (await pg.locator(".login-brand h2").innerText()).includes("Saudade Blog"),
          `标题 Saudade Blog → ${await pg.locator(".login-brand h2").innerText()}`,
        ).toBe(true);
        // 20260924：品牌区那行小字「登录后体验完整服务」换成访客自己的三态头像（同一个
        // useViewerAvatar）。旧断言锁的是已被删掉的那行字 ⇒ 当轮改判据，不是删断言：
        // 这一页从没登录过（无 token、localStorage 空）⇒ 三态里的第③态 = 默认头像。
        expect.soft(
          (await pg.locator(".login-sub").count()) === 0,
          `品牌区小字已撤（不再有 .login-sub）`,
        ).toBe(true);
        expect.soft(
          (await pg.locator(".login-avatar").count()) === 1,
          `品牌区是头像（.login-avatar 一个）`,
        ).toBe(true);
        expect.soft(
          (await pg.getAttribute(".login-avatar img", "src")) === "/default-avatar.png",
          `新访客 → 默认头像 /default-avatar.png → ${await pg.getAttribute(".login-avatar img", "src")}`,
        ).toBe(true);
        expect.soft(
          JSON.stringify(
            (await pg.locator(".field label").allInnerTexts()).map((t) => t.trim()),
          ) === JSON.stringify(["账号", "密码"]),
          `可见 label：账号 / 密码`,
        ).toBe(true);
        expect.soft(
          (await pg.locator("input#account").count()) === 1 &&
            (await pg.locator("input#password").count()) === 1,
          `两个输入框 id 正确`,
        ).toBe(true);
        expect.soft(
          (await pg.getAttribute("input#password", "type")) === "password",
          `密码框 type=password`,
        ).toBe(true);
        expect.soft(
          (await pg.locator(".login-box form a").count()) === 0,
          `旧版霓虹锚点已移除（form 内无 <a>）`,
        ).toBe(true);
        expect.soft(
          (await pg.locator("button.login-submit").innerText()).trim() === "登 录",
          `提交按钮存在且文案=登 录`,
        ).toBe(true);
        expect.soft(
          JSON.stringify(
            (await pg.locator(".login-links button").allInnerTexts()).map((t) =>
              t.trim(),
            ),
          ) === JSON.stringify(["忘记密码？", "注册账号"]),
          `两个入口按钮：忘记密码？/ 注册账号`,
        ).toBe(true);
        expect.soft(
          (await pg.locator(".login-foot a").innerText()).trim() === "返回首页",
          `返回首页入口存在且不带箭头 → ${await pg.locator(".login-foot a").innerText()}`,
        ).toBe(true);

        // ── ①b 头像第②态：退出登录但本机挂过账号 → 仍是那个账号的头像 ──
        // 登录页正是"退出后落回"的地方——令牌是自包含的，过期和退出在浏览器侧长得一样，
        // 展示身份不该跟着失忆（三态判据与缓存见 components/UserCenter/identity.ts）。
        // 新开一个 page 而不是改上面那个：这份缓存必须在挂载前就位（useViewerAvatar 的初始
        // state 在挂载时读一次 localStorage），已跑起来的 page 改了也不会重读。
        // 顺带锁"未登录不为一张头像打后端"——见 identity.ts 的 pull()。
        const AVATAR_2 = "/api/protect/download/avatar-sora-20260922.png";
        const pgB = await newPage(browser);
        const reqsB: string[] = [];
        pgB.on("request", (r) => reqsB.push(`${r.resourceType()} ${r.url()}`));
        await pgB.addInitScript(
          `localStorage.setItem('saudade.lastUser', JSON.stringify({` +
            `username:'sora', nickname:'', ` +
            `avatar:${JSON.stringify(AVATAR_2)}, at:'2026-09-24 00:00:00'}));`,
        );
        await pgB.goto(sb.url);
        await pgB.waitForTimeout(400);
        const avatarSrc = (page: Page) =>
          page.getAttribute(".login-avatar img", "src");
        expect.soft(
          (await avatarSrc(pgB)) === AVATAR_2,
          `上次那个账号的头像（不是默认头像） → ${await avatarSrc(pgB)}`,
        ).toBe(true);
        expect.soft(
          !reqsB.some((u) => u.includes("protected/profile")),
          `未登录不发资料请求 → ${JSON.stringify(reqsB.slice(0, 4))}`,
        ).toBe(true);

        // ①c 头像跟着输入框走（20260924 拍板：**只认本机登录过的账号**）。用户报的是"换账号输入时，
        // 头像还是显示上次账号的头像"。治本不能是"按输入的名字去后端查头像"——那等于给所有人一个
        // 账号枚举 oracle（输 sora 出猫头像、输 soraa 出默认 ⇒ 一次请求就知道账号存不存在）。
        // 所以判据全是**本地**的：命中本机那份清单才显示它的头像，一偏离就回默认。
        // 这一节同时还锁**旧数据兼容**：上面只写了 `saudade.lastUser`、没有清单（= 20260924 之前的
        // 老访客的浏览器），读侧要能用它合成清单——不然升级那一刻所有人都认不出来。
        await pgB.fill("input#account", "sora");
        await pgB.waitForTimeout(200);
        expect.soft(
          (await avatarSrc(pgB)) === AVATAR_2,
          `输入的就是本机记住的账号 → 仍是那张头像 → ${await avatarSrc(pgB)}`,
        ).toBe(true);
        await pgB.fill("input#account", "  SORA ");
        await pgB.waitForTimeout(200);
        expect.soft(
          (await avatarSrc(pgB)) === AVATAR_2,
          `两侧空白 + 大小写在展示层宽容匹配（真正的账号语义在后端） → ${await avatarSrc(pgB)}`,
        ).toBe(true);
        await pgB.fill("input#account", "other-user");
        await pgB.waitForTimeout(200);
        expect.soft(
          (await avatarSrc(pgB)) === "/default-avatar.png",
          `输入的是**别的**账号 → 立刻退回默认头像 → ${await avatarSrc(pgB)}`,
        ).toBe(true);
        // 判据只看 xhr/fetch：**"查名字"这条路上只可能是 XHR**，而页面自己加载头像图片
        // （`<img>` → image 请求）不算查询——那正是"头像只来自本地缓存"的表现。
        expect.soft(
          !reqsB.some((u) => u.startsWith("xhr") || u.startsWith("fetch")),
          `整段打字过程零 XHR（不存在「按输入的名字去查」这种请求） → ${JSON.stringify(reqsB.slice(0, 4))}`,
        ).toBe(true);
        await pgB.fill("input#account", "");
        await pgB.waitForTimeout(200);
        expect.soft(
          (await avatarSrc(pgB)) === AVATAR_2,
          `清空输入 → 回到「本机挂着的那个账号」（与头部第②态同语义） → ${await avatarSrc(pgB)}`,
        ).toBe(true);
        await pgB.close();

        // ①d 清单（20260924 用户实测报回来的洞）：这台机器上登录过**不止一个**账号时，输上一个用过的
        // 账号也该认出它自己那张头像——先前只记了最近一个（`saudade.lastUser`），于是"换账号输入"
        // 永远只能得到默认头像。这里预置**两条**（较新的 kohaku、较旧的 sora），三条断言分别锁：
        // 认得较旧的那个 / 认得较新的那个 / 认不得的仍回默认。
        const AVATAR_3 = "/api/protect/download/avatar-kohaku-20260924.png";
        const pgC = await newPage(browser);
        const reqsC: string[] = [];
        pgC.on("request", (r) => reqsC.push(`${r.resourceType()} ${r.url()}`));
        await pgC.addInitScript(
          `localStorage.setItem('saudade.knownUsers', JSON.stringify([` +
            `{username:'kohaku', nickname:'', avatar:${JSON.stringify(AVATAR_3)}, at:'2026-09-24 01:00:00'},` +
            `{username:'sora', nickname:'', avatar:${JSON.stringify(AVATAR_2)}, at:'2026-09-20 01:00:00'}` +
            `]));` +
            `localStorage.setItem('saudade.lastUser', JSON.stringify({` +
            `username:'kohaku', nickname:'', avatar:${JSON.stringify(AVATAR_3)},` +
            ` at:'2026-09-24 01:00:00'}));`,
        );
        await pgC.goto(sb.url);
        await pgC.waitForTimeout(400);
        expect.soft(
          (await avatarSrc(pgC)) === AVATAR_3,
          `空输入 → 清单里最近那个（kohaku） → ${await avatarSrc(pgC)}`,
        ).toBe(true);
        await pgC.fill("input#account", "sora");
        await pgC.waitForTimeout(200);
        expect.soft(
          (await avatarSrc(pgC)) === AVATAR_2,
          `输较**旧**的那个账号 → 认出来的是它自己那张头像（别再拿最近那个顶上） → ${await avatarSrc(pgC)}`,
        ).toBe(true);
        await pgC.fill("input#account", "kohaku");
        await pgC.waitForTimeout(200);
        expect.soft(
          (await avatarSrc(pgC)) === AVATAR_3,
          `输较新的那个账号 → 它自己的头像 → ${await avatarSrc(pgC)}`,
        ).toBe(true);
        await pgC.fill("input#account", "nobody-here");
        await pgC.waitForTimeout(200);
        expect.soft(
          (await avatarSrc(pgC)) === "/default-avatar.png",
          `清单里没有的账号 → 默认头像（绝不按名字去后端查） → ${await avatarSrc(pgC)}`,
        ).toBe(true);
        expect.soft(
          !reqsC.some((u) => u.startsWith("xhr") || u.startsWith("fetch")),
          `清单比对全程零 XHR → ${JSON.stringify(reqsC.slice(0, 4))}`,
        ).toBe(true);
        await pgC.close();

        // ── ② 几何（居中 + 不溢出） ──
        const box = (await pg.locator(".login-box").boundingBox())!;
        expect.soft(
          Math.abs(box.width - 400) <= 1,
          `卡片宽 = 400 → ${box.width.toFixed(1)}`,
        ).toBe(true);
        expect.soft(
          Math.abs(box.x + box.width / 2 - 640) <= 2,
          `水平居中（中心偏差 ≤2px） → 中心 ${(box.x + box.width / 2).toFixed(1)}`,
        ).toBe(true);
        expect.soft(
          Math.abs(box.y + box.height / 2 - 450) <= 4,
          `垂直居中（偏差 ≤4px） → 中心 ${(box.y + box.height / 2).toFixed(1)}`,
        ).toBe(true);
        expect.soft(
          box.y >= 0 && box.y + box.height <= 900,
          `不超出视口 → 底 ${(box.y + box.height).toFixed(1)}`,
        ).toBe(true);
        expect.soft(
          await pg.evaluate(() => {
            const b = document.querySelector(".login-box")!.getBoundingClientRect();
            const i = document
              .querySelector("input#account")!
              .getBoundingClientRect();
            return i.left >= b.left && i.right <= b.right;
          }),
          `输入框不溢出卡片`,
        ).toBe(true);

        // ── ③ 样式生效 · 白天档（这一页没写 isDarkMode ⇒ 走全站默认的白天） ──
        // 账号框有 autoFocus ⇒ 量"未聚焦"必须先 blur（否则两次都读到聚焦态，这条会假绿）
        await pg.evaluate(
          () =>
            document.activeElement &&
            (document.activeElement as HTMLElement).blur(),
        );
        await pg.waitForTimeout(350);

        const pageBg = await pg.evaluate(() =>
          getComputedStyle(document.querySelector(".login-page")!).backgroundImage,
        );
        // 判据是"这条渐变就是主页首屏 `.collageBg` 那条"：两端色值都在。只断言"有渐变"是不够的
        // —— 换成墨蓝那条也是渐变（20261006 之前的样子）。
        expect.soft(
          pageBg.includes("255, 246, 250") && pageBg.includes("233, 244, 255"),
          `页面底是主页那套拼贴渐变（#fff6fa → #e9f4ff 两端都在） → ${pageBg.slice(0, 120)}`,
        ).toBe(true);
        const tex = await styles(
          pg,
          ".login-page",
          "::after",
          ["backgroundImage", "backgroundSize"],
        );
        // 两层（横线 + 竖线）都必须是 28px；`background-size` 会原样拼成 "28px 28px, 28px 28px"，
        // 所以按逗号拆开比集合，别拿整串去 == 一个单层的写法（那样量的是字符串拼接习惯）。
        const texSizes = new Set(
          tex.backgroundSize.split(",").map((v) => v.trim()),
        );
        expect.soft(
          texSizes.size === 1 &&
            texSizes.has("28px 28px") &&
            tex.backgroundImage.includes("160, 120, 190"),
          `白天有纹路：两层 28px 方格纸（照抄主页首屏那一层） → ${tex.backgroundSize} / ${tex.backgroundImage.slice(0, 80)}`,
        ).toBe(true);
        expect.soft(
          (await pg.evaluate(
            () =>
              getComputedStyle(
                document.querySelector(".login-page")!,
                "::before",
              ).content,
          )) === "none",
          `白天没有那团月晕（\`::before\` 只在夜间档）`,
        ).toBe(true);
        expect.soft(
          (await pg.evaluate(
            () =>
              document.body.classList.contains("login-route") &&
              !document.body.classList.contains("login-dark"),
          )),
          `body 挂了 login-route（页面底），白天不挂 login-dark`,
        ).toBe(true);
        expect.soft(
          (await pg.evaluate(
            () => document.querySelector(".login-page")!.className,
          )) === "login-page",
          `根节点白天不带 frontDark（\`--washi-*\` 因此停在浅色档） → ${await pg.evaluate(() => document.querySelector(".login-page")!.className)}`,
        ).toBe(true);
        const boxday = await styles(pg, ".login-box", null, [
          "backgroundColor",
          "backdropFilter",
          "borderRadius",
        ]);
        expect.soft(
          boxday.backgroundColor === "rgb(255, 253, 250)",
          `卡片是纸白实底（#fffdfa） → ${boxday.backgroundColor}`,
        ).toBe(true);
        expect.soft(
          boxday.backdropFilter === "none",
          `白天不做 backdrop-filter（底是不透明的，模糊看不出效果还白付一层合成） → ${boxday.backdropFilter}`,
        ).toBe(true);
        expect.soft(
          boxday.borderRadius === "18px",
          `卡片圆角 18px → ${boxday.borderRadius}`,
        ).toBe(true);

        const rest = (await styles(pg, "input#account")).borderTopColor;
        await pg.click("input#account");
        await pg.waitForTimeout(350);
        const foc = await styles(pg, "input#account", null, [
          "borderTopColor",
          "boxShadow",
          "backgroundColor",
        ]);
        expect.soft(
          rest.includes("198, 152, 192"),
          `未聚焦边框是和纸粉线（--washi-line 白天档） → ${rest}`,
        ).toBe(true);
        expect.soft(
          foc.borderTopColor === "rgb(217, 79, 154)",
          `聚焦边框变深粉 #d94f9a（白天的强调色，不是夜间的河灯金） → ${foc.borderTopColor}`,
        ).toBe(true);
        expect.soft(
          foc.boxShadow.includes("217, 79, 154"),
          `聚焦有粉色外发光环 → ${foc.boxShadow.slice(0, 60)}`,
        ).toBe(true);

        // 主按钮的对比度：**从渲染结果里读**两个渐变色标与字色（不写死在测试里），逐个算 WCAG。
        // 这条是"浅粉渐变 + 墨字"这个选择的守门人 —— 计划里原本写的白字压在 #d94f9a 上只有
        // 3.8:1、压 #8e63e0 上 4.2:1，都过不了 4.5:1（15px/600 够不到大字号）。哪天有人把
        // 渐变换回深粉或把字色改白，这里当场红。
        const subDay = await styles(pg, ".login-submit", null, [
          "backgroundImage",
          "color",
        ]);
        const stops = [...subDay.backgroundImage.matchAll(/rgb\((\d+),\s*(\d+),\s*(\d+)/g)].map(
          (m) => [Number(m[1]), Number(m[2]), Number(m[3])],
        );
        expect.soft(
          stops.length >= 2,
          `白天主按钮是浅粉渐变（#ffd7ea → #f0b9dd） → ${subDay.backgroundImage.slice(0, 80)}`,
        ).toBe(true);
        const ink = (subDay.color.match(/\d+/g) ?? []).slice(0, 3).map(Number);
        const worst = Math.min(
          ...stops.map((s) => contrastRatio(ink, s)),
        );
        expect.soft(
          worst >= 4.5,
          `按钮字色对**每一个**渐变色标都 ≥ 4.5:1 → 最差 ${worst.toFixed(2)}:1  字${JSON.stringify(ink)} 色标${JSON.stringify(stops)}`,
        ).toBe(true);
        expect.soft(
          !(await pg.evaluate(
            () =>
              [
                document.querySelector(".login-submit")!,
                document.body,
              ]
                .map((e) => getComputedStyle(e).backgroundImage)
                .join(),
          )).includes("3, 233, 244"),
          `旧霓虹青已撤（页面无 #03e9f4）`,
        ).toBe(true);

        // ── ③b 夜间档（挂载前写 isDarkMode='true'）：还是 20260921 那副墨蓝样子 ──
        const pgD = await newPage(browser);
        await pgD.addInitScript("localStorage.setItem('isDarkMode', 'true');");
        await pgD.goto(sb.url);
        await pgD.waitForTimeout(400);
        expect.soft(
          (await pgD.evaluate(
            () => document.querySelector(".login-page")!.className,
          )).includes("frontDark"),
          `根节点挂上 frontDark（\`--washi-*\` 切夜间档） → ${await pgD.evaluate(() => document.querySelector(".login-page")!.className)}`,
        ).toBe(true);
        expect.soft(
          await pgD.evaluate(
            () =>
              document.body.classList.contains("login-route") &&
              document.body.classList.contains("login-dark"),
          ),
          `body 同时挂 login-route + login-dark`,
        ).toBe(true);
        const darkBg = await pgD.evaluate(() =>
          getComputedStyle(document.querySelector(".login-page")!).backgroundImage,
        );
        expect.soft(
          darkBg.includes("13, 19, 25") && darkBg.includes("29, 38, 52"),
          `页面底回到墨蓝渐变（#0d1319 → #1d2634） → ${darkBg.slice(0, 120)}`,
        ).toBe(true);
        expect.soft(
          (await pgD.evaluate(
            () =>
              getComputedStyle(
                document.querySelector(".login-page")!,
                "::before",
              ).content,
          )) !== "none",
          `夜间才有那团月晕（\`::before\` 有内容）`,
        ).toBe(true);
        expect.soft(
          (await pgD.evaluate(
            () =>
              getComputedStyle(
                document.querySelector(".login-page")!,
                "::after",
              ).backgroundImage,
          )).includes("none"),
          `夜间不铺方格纸（\`::after\` 的图被关掉，只剩月晕）`,
        ).toBe(true);
        const boxn = await styles(pgD, ".login-box", null, [
          "backgroundColor",
          "backdropFilter",
        ]);
        expect.soft(
          boxn.backdropFilter.includes("blur(14px)"),
          `夜间卡片是玻璃（backdrop-filter 还在） → ${boxn.backdropFilter}`,
        ).toBe(true);
        await pgD.evaluate(
          () =>
            document.activeElement &&
            (document.activeElement as HTMLElement).blur(),
        );
        await pgD.waitForTimeout(350);
        const restN = (await styles(pgD, "input#account")).borderTopColor;
        await pgD.click("input#account");
        await pgD.waitForTimeout(350);
        const focN = await styles(pgD, "input#account", null, [
          "borderTopColor",
          "boxShadow",
        ]);
        expect.soft(
          restN === "rgba(255, 255, 255, 0.14)",
          `未聚焦边框是淡白 → ${restN}`,
        ).toBe(true);
        expect.soft(
          focN.borderTopColor === "rgb(240, 201, 135)",
          `聚焦边框变河灯金 #f0c987 → ${focN.borderTopColor}`,
        ).toBe(true);
        expect.soft(
          focN.boxShadow.includes("240, 196, 110"),
          `聚焦有金色外发光环 → ${focN.boxShadow.slice(0, 60)}`,
        ).toBe(true);
        const subNight = await styles(pgD, ".login-submit", null, [
          "backgroundImage",
          "color",
        ]);
        expect.soft(
          subNight.backgroundImage.includes("232, 184, 102"),
          `主按钮是河灯金渐变 → ${subNight.backgroundImage.slice(0, 80)}`,
        ).toBe(true);
        const stopsN = [...subNight.backgroundImage.matchAll(/rgb\((\d+),\s*(\d+),\s*(\d+)/g)].map(
          (m) => [Number(m[1]), Number(m[2]), Number(m[3])],
        );
        const inkN = (subNight.color.match(/\d+/g) ?? []).slice(0, 3).map(Number);
        const worstN = Math.min(
          ...stopsN.map((s) => contrastRatio(inkN, s)),
        );
        expect.soft(
          worstN >= 4.5,
          `夜间按钮字色同样逐档 ≥ 4.5:1 → 最差 ${worstN.toFixed(2)}:1`,
        ).toBe(true);
        expect.soft(
          await pgD.evaluate(
              () =>
                ((
                  window as unknown as Record<string, Array<{ algorithm?: string; token?: { colorBgElevated?: string } }>>
                ).__cpThemes ?? []
              ).some(
              (t) =>
                t &&
                t.algorithm === "__DARK_ALGORITHM__" &&
                t.token &&
                t.token.colorBgElevated,
            ),
          ),
          `弹窗主题跟着切到深色算法（墨蓝底 + 河灯金主色）`,
        ).toBe(true);
        await pgD.close();

        // ── ③d 跨 23:00：这一页在 App 壳之外，自己也得做边界动作（20261013 修） ──
        // 从前只有 App.tsx 调 `autoThemeDecision`，而 `login` 是顶层路由（`router/index.tsx`
        // 里与 `/` 平级，不在那层 `.frontDark` 底下）⇒ 夜里直达这一页**整晚浅色**、停在页上
        // 跨 23:00 也不切（20261013 线上实测：留白亮度 234/228/243，同刻首页 26/26/12）。
        // 判据只能是"把钟推到边界上真跑一遍"——③a/③b 那两套夹具都**先预置 isDarkMode 再
        // goto**，无论这一页有没有 ticker 都会绿，测不到这条。修法是挂 `useAutoThemeSwitch()`。
        // ⚠️ 传 Date 而不是毫秒：theme 的 isNightHour/currentThemeDay 走**浏览器本地钟面**。
        //    这一页故意**不**钉 14:00。
        const pgE = await newPage(browser, {
          time: new Date(2026, 9, 13, 22, 58, 0),
        });
        await pgE.goto(sb.url);
        await pgE.waitForTimeout(400);
        expect.soft(
          (await pgE.evaluate(() => {
            const d = new Date();
            return (
              d.getFullYear() +
              "-" +
              (d.getMonth() + 1) +
              "-" +
              d.getDate() +
              " " +
              d.getHours() +
              ":" +
              String(d.getMinutes()).padStart(2, "0")
            );
          })) === "2026-10-13 22:58",
          `起始时刻真的是 2026-10-13 22:58（钉子先钉牢，下面那几条才有意义） → ${await pgE.evaluate(() => new Date().toString())}`,
        ).toBe(true);
        expect.soft(
          !(await pgE.evaluate(
            () => document.querySelector(".login-page")!.className,
          )).includes("frontDark"),
          `22:58 冷启动（存储为空）：白天档，不挂 frontDark → ${await pgE.evaluate(() => document.querySelector(".login-page")!.className)}`,
        ).toBe(true);
        // Playwright 的时钟串："08"=8 秒、"03:00"=3 分、"07:00:00"=7 小时
        await pgE.clock.fastForward("03:00");
        await pgE.waitForTimeout(200);
        const clsE = await pgE.evaluate(
          () => document.querySelector(".login-page")!.className,
        );
        expect.soft(
          clsE.includes("frontDark"),
          `跨 23:00 后自己挂上 frontDark → ${clsE}`,
        ).toBe(true);
        // 落盘格式 = `JSON.stringify(布尔)` ⇒ 裸 `true`（全仓 5 个写入点全都是这个写法：theme /
        // Head / PhoneSwitch / Dashboard / chat-stream.js）。`readDarkMode` 另兼容带引号的旧式
        // `'"true"'`，但**别拿它当期望值**——那是兼容读取的，不是现在写出来的。
        expect.soft(
          (await pgE.evaluate(() => localStorage.getItem("isDarkMode"))) === "true",
          `结果也落了盘（此前这一页从不写 isDarkMode） → ${await pgE.evaluate(() => localStorage.getItem("isDarkMode"))}`,
        ).toBe(true);
        expect.soft(
          await pgE.evaluate(() => !!localStorage.getItem("darkModeInWindow")),
          `夜窗闩已置位（证明边界真的跑过，而不是碰巧本来就暗）`,
        ).toBe(true);
        await pgE.clock.fastForward("07:00:00");
        await pgE.waitForTimeout(200);
        const clsE2 = await pgE.evaluate(
          () => document.querySelector(".login-page")!.className,
        );
        expect.soft(
          !clsE2.includes("frontDark"),
          `推到 06:00 之后切回白天档（出窗那一半也在） → ${clsE2}`,
        ).toBe(true);
        expect.soft(
          await pgE.evaluate(() => !localStorage.getItem("darkModeInWindow")),
          `出窗后闩与意愿一起清（新的一天重新开始）`,
        ).toBe(true);
        await pgE.close();

        // ── ③c 即时跟随：头部/看板娘切换时不刷新页面就换档 ──
        // `useIsDarkMode()` 听的就是这个事件（全仓唯一在 React 里响应主题变化的写法）。
        // 判据取"类真的挂上了"——只断言 state 变了是量不到 DOM 的。
        await pg.evaluate(
          () =>
            window.dispatchEvent(
              new CustomEvent("darkmode-change", { detail: true }),
            ),
        );
        await pg.waitForTimeout(250);
        expect.soft(
          (await pg.evaluate(
            () => document.querySelector(".login-page")!.className,
          )).includes("frontDark") &&
            (await pg.evaluate(() =>
              document.body.classList.contains("login-dark"),
            )),
          `派发 darkmode-change(true) → 不刷新就切成夜间档`,
        ).toBe(true);
        await pg.evaluate(
          () =>
            window.dispatchEvent(
              new CustomEvent("darkmode-change", { detail: false }),
            ),
        );
        await pg.waitForTimeout(250);
        expect.soft(
          (await pg.evaluate(
            () => document.querySelector(".login-page")!.className,
          )) === "login-page" &&
            !(await pg.evaluate(() =>
              document.body.classList.contains("login-dark"),
            )),
          `再派发 false → 切回白天档`,
        ).toBe(true);

        // ── ④ 注册入口 → 不开放注册的声明（只有一个出口，且居中） ──
        await pg.click(".login-links button:nth-child(3)");
        await pg.waitForTimeout(250);
        const dlg = pg.locator('.ant-modal-mock[data-title="注册账号"]');
        expect.soft(
          (await dlg.count()) === 1,
          `弹窗打开且标题=注册账号`,
        ).toBe(true);
        const body = (await dlg.count()) ? await dlg.innerText() : "";
        expect.soft(body.includes("不开放自助注册"), `写明不开放自助注册`).toBe(
          true,
        );
        expect.soft(body.includes("无需登录"), `阅读无需登录`).toBe(true);
        expect.soft(
          body.includes("发布功能需要登录"),
          `发布功能需要登录（这句原先写错成「无需登录」）`,
        ).toBe(true);
        expect.soft(
          !body.includes("留言、说说、河灯等访客功能"),
          `不再说「留言无需登录」`,
        ).toBe(true);
        expect.soft(body.includes("账号安全维护"), `含「账号安全维护」`).toBe(
          true,
        );
        expect.soft(body.includes("博主"), `交代账号从哪来（博主开设）`).toBe(
          true,
        );
        expect.soft(
          !body.includes("河灯集"),
          `不再引导去留言板（那条路需要登录，走不通）`,
        ).toBe(true);
        const footBtns = (await pg.locator(".login-modal-foot button").allInnerTexts())
          .map((t) => t.trim());
        expect.soft(
          JSON.stringify(footBtns) === JSON.stringify(["知道了"]),
          `页脚只有一个出口：知道了 → ${JSON.stringify(footBtns)}`,
        ).toBe(true);
        expect.soft(
          await pg.evaluate(() => {
            const b = document
              .querySelector(".login-modal-foot button")!
              .getBoundingClientRect();
            const f = document
              .querySelector(".login-modal-foot")!
              .getBoundingClientRect();
            return Math.abs((b.left + b.right) / 2 - (f.left + f.right) / 2) <= 1;
          }),
          `「知道了」水平居中`,
        ).toBe(true);
        await pg.click(".login-modal-primary");
        await pg.waitForTimeout(200);
        expect.soft(
          (await pg.locator(".ant-modal-mock").count()) === 0,
          `点「知道了」关闭弹窗`,
        ).toBe(true);
        expect.soft(
          (await pg.evaluate(
            () => (window as unknown as Record<string, string[]>).__nav ?? [],
          )).length === 0,
          `关闭弹窗不产生跳转`,
        ).toBe(true);

        // ── ⑤ 忘记密码入口 → 恢复码表单（无页脚，关窗靠 X/遮罩/Esc） ──
        await pg.click(".login-links button:nth-child(1)");
        await pg.waitForTimeout(250);
        const dlg2 = pg.locator('.ant-modal-mock[data-title="重置密码"]');
        expect.soft(
          (await dlg2.count()) === 1,
          `弹窗打开且标题=重置密码`,
        ).toBe(true);
        const b2 = (await dlg2.count()) ? await dlg2.innerText() : "";
        expect.soft(b2.includes("一次性恢复码"), `说明需要一次性恢复码`).toBe(
          true,
        );
        expect.soft(
          (await dlg2.locator("input").count()) === 4 &&
            (await dlg2.locator("input[placeholder='用户名']").count()) === 1 &&
            (await dlg2.locator("input[placeholder='一次性恢复码']").count()) ===
              1 &&
            (await dlg2.locator("input[placeholder='新密码（至少 8 位）']").count()) ===
              1,
          `找回密码表单字段齐全`,
        ).toBe(true);
        expect.soft(
          (await pg.locator(".login-modal-foot").count()) === 0,
          `没有页脚（「取消」是多余的）`,
        ).toBe(true);
        expect.soft(
          (await pg.locator(".login-modal-hint").count()) === 0 &&
            !b2.includes("河灯集"),
          `没有「拿不到恢复码」那行（走不通的引导）`,
        ).toBe(true);
        expect.soft(
          (await pg.locator(".ant-modal-close").count()) === 1,
          `有右上角关闭 X`,
        ).toBe(true);
        // 布局：这几个 input 是弹窗内 flex 列的直接子项，content-box 时 padding 会把它撑出容器
        expect.soft(
          await pg.evaluate(() => {
            const b = document
              .querySelector(".ant-modal-body input")!
              .getBoundingClientRect();
            const p = document
              .querySelector(".ant-modal-body")!
              .getBoundingClientRect();
            return b.left >= p.left - 0.5 && b.right <= p.right + 0.5;
          }),
          `表单输入框不溢出弹窗正文`,
        ).toBe(true);
        expect.soft(
          await pg.evaluate(() => {
            const r = [...document.querySelectorAll(".login-reset-form input")].map(
              (i) => i.getBoundingClientRect(),
            );
            return (
              new Set(r.map((x) => Math.round(x.width))).size === 1 &&
              new Set(r.map((x) => Math.round(x.left))).size === 1
            );
          }),
          `四个输入框等宽且左对齐`,
        ).toBe(true);
        // 关闭 → 重开：恢复码是一次性的，残留上次的值会让用户拿废码干试
        await pg.fill(".login-reset-form input:nth-of-type(1)", "sora");
        await pg.fill(".login-reset-form input:nth-of-type(2)", "STALECODE0000000000");
        await pg.click(".ant-modal-close");
        await pg.waitForTimeout(200);
        expect.soft(
          (await pg.locator(".ant-modal-mock").count()) === 0 &&
            (await pg.evaluate(
              () => (window as unknown as Record<string, string[]>).__nav ?? [],
            )).length === 0,
          `点右上角 X 关闭弹窗且不跳转`,
        ).toBe(true);
        await pg.click(".login-links button:nth-child(1)");
        await pg.waitForTimeout(250);
        expect.soft(
          await pg.evaluate(() =>
            [...document.querySelectorAll(".login-reset-form input")].every(
              (i) => (i as HTMLInputElement).value === "",
            ),
          ),
          `重开后表单是空的（不留上一次的恢复码）`,
        ).toBe(true);
        // 弹窗主题：白天档 = antd 默认浅色算法 + 和纸主色（**不能带 darkAlgorithm**，
        // 否则白天的弹窗还是墨蓝底）。字面量 `#d94f9a` 与 `--washi-pink-deep` 白天那一档同值。
        expect.soft(
          await pg.evaluate(() =>
            ((
              window as unknown as Record<
                string,
                Array<{ algorithm?: string; token?: { colorPrimary?: string } }>
              >
            ).__cpThemes ?? []
            ).some(
              (t) =>
                t && !t.algorithm && t.token && t.token.colorPrimary === "#d94f9a",
            ),
          ),
          `白天弹窗走浅色算法 + 和纸主色（不带 darkAlgorithm）`,
        ).toBe(true);

        // ── ⑥ 提交契约（空值 → 原生校验；成功 → 派发 fetchToken + 按 token 分流跳转） ──
        await pg.evaluate(() => {
          (window as unknown as Record<string, unknown[]>).__msgLog = [];
          (window as unknown as Record<string, unknown[]>).__nav = [];
        });
        await pg.click("button.login-submit");
        await pg.waitForTimeout(300);
        expect.soft(
          (await pg.evaluate(
            () =>
              (window as unknown as Record<string, string[]>).__msgLog ?? [],
          )).some((m) => m.includes("请填写用户名")),
          `空值提交被拦住（提示请填写用户名） → ${JSON.stringify(await pg.evaluate(() => (window as unknown as Record<string, string[]>).__msgLog ?? []))}`,
        ).toBe(true);
        expect.soft(
          (await pg.evaluate(
            () =>
              (window as unknown as Record<string, unknown[]>).__actions ?? [],
          )).length === 0,
          `空值提交不发请求`,
        ).toBe(true);

        await pg.fill("input#account", "sora");
        await pg.fill("input#password", "hunter2");
        await pg.click("button.login-submit");
        await pg.waitForTimeout(400);
        interface Action {
          type: string;
          payload: { username: string; password: string };
        }
        const acts = await pg.evaluate(
          () =>
            (window as unknown as Record<string, Action[]>).__actions ?? [],
        );
        expect.soft(
          acts.length === 1 &&
            acts[0].type === "user/fetchToken" &&
            JSON.stringify(acts[0].payload) ===
              JSON.stringify({ username: "sora", password: "hunter2" }),
          `派发 fetchToken（账号密码原样） → ${JSON.stringify(acts).slice(0, 160)}`,
        ).toBe(true);
        expect.soft(
          ["登 录", "登录中…"].includes(
            (await pg.locator("button.login-submit").innerText()).trim(),
          ),
          `登录中按钮文案/状态合法`,
        ).toBe(true);
        await pg.waitForTimeout(600);
        expect.soft(
          (await pg.evaluate(
            () => (window as unknown as Record<string, string[]>).__msgLog ?? [],
          )).some((m) => m.includes("success:登录成功")),
          `成功后提示「登录成功」`,
        ).toBe(true);
        // 20260922 起跳转分两岔（此前一律送 /dashboard，普通用户到了只会吃一次"无权限访问后台"
        // 再被弹回首页）：管理员 token → /dashboard，其余（含拿不到 token）→ /。
        // 本段登录前没设 token ⇒ getToken() 得 null ⇒ 走首页那一岔。
        expect.soft(
          (await pg.evaluate(
            () =>
              (
                (window as unknown as Record<string, string[]>).__nav ?? []
              ).join(","),
          )) === "/",
          `成功后无 token/普通用户 → 首页 / → ${JSON.stringify(await pg.evaluate(() => (window as unknown as Record<string, string[]>).__nav ?? []))}`,
        ).toBe(true);

        // ── ⑥b 管理员登录后直达后台（20260922 分流契约的另一岔） ──
        await pg.evaluate(
          (token: string) => {
            const w = window as unknown as Record<string, unknown>;
            w.__nav = [];
            w.__token = token;
            w.__msgLog = [];
          },
          jwtWithRole("admin"),
        );
        await pg.click("button.login-submit");
        await pg.waitForTimeout(1200); // 成功分支的跳转带 500ms setTimeout
        expect.soft(
          (await pg.evaluate(
            () =>
              (
                (window as unknown as Record<string, string[]>).__nav ?? []
              ).join(","),
          )) === "/dashboard",
          `管理员 token → /dashboard → ${JSON.stringify(await pg.evaluate(() => (window as unknown as Record<string, string[]>).__nav ?? []))}`,
        ).toBe(true);
        await pg.evaluate(() => {
          (window as unknown as Record<string, undefined>).__token = undefined;
        });

        // ── ⑦ 失败分支（服务端 500 → 报错且不跳转） ──
        await pg.evaluate(() => {
          (window as unknown as Record<string, unknown[]>).__nav = [];
          (window as unknown as Record<string, unknown[]>).__msgLog = [];
          (window as unknown as Record<string, number>).__loginStatus = 500;
        });
        await pg.click("button.login-submit");
        await pg.waitForTimeout(1200);
        expect.soft(
          (await pg.evaluate(
            () => (window as unknown as Record<string, string[]>).__msgLog ?? [],
          )).some((m) => m.startsWith("error:")),
          `失败提示走 error 通道 → ${JSON.stringify(await pg.evaluate(() => (window as unknown as Record<string, string[]>).__msgLog ?? []))}`,
        ).toBe(true);
        // 判据从"不含 /dashboard"改成"一次都没跳"：20260922 起成功分支普通用户也不去 /dashboard，
        // 旧写法在新契约下恒真（纯空转），锁不住任何东西。
        expect.soft(
          (await pg.evaluate(
            () => (window as unknown as Record<string, string[]>).__nav ?? [],
          )).length === 0,
          `失败不跳转（一次都没跳） → ${JSON.stringify(await pg.evaluate(() => (window as unknown as Record<string, string[]>).__nav ?? []))}`,
        ).toBe(true);

        // ── ⑧ 密码显隐 + 会话重定向 ──
        await pg.evaluate(() => {
          (window as unknown as Record<string, number>).__loginStatus = 200;
        });
        expect.soft(
          (await pg.getAttribute("input#password", "type")) === "password",
          `默认 type=password`,
        ).toBe(true);
        expect.soft(
          (await pg.locator(".pwd-toggle svg").count()) === 1 &&
            (await pg.locator(".pwd-toggle").innerText()).trim() === "",
          `显隐按钮是图标不是文字（svg，无文本） → ${JSON.stringify(await pg.locator(".pwd-toggle").innerText())}`,
        ).toBe(true);
        expect.soft(
          (await pg.getAttribute(".pwd-toggle", "aria-label")) === "显示密码",
          `默认 aria-label=显示密码`,
        ).toBe(true);
        await pg.click(".pwd-toggle");
        await pg.waitForTimeout(150);
        expect.soft(
          (await pg.getAttribute("input#password", "type")) === "text",
          `点显示 → type=text`,
        ).toBe(true);
        expect.soft(
          (await pg.locator(".pwd-toggle svg").count()) === 1 &&
            (await pg.getAttribute(".pwd-toggle", "aria-label")) === "隐藏密码",
          `图标与 aria-label 同步为「隐藏密码」`,
        ).toBe(true);
        expect.soft(
          await pg.evaluate(
            () =>
              parseFloat(
                getComputedStyle(document.querySelector("input#password")!)
                  .paddingRight,
              ) >= 40,
          ),
          `图标按钮横向不吃掉输入框（右内边距 ≥ 40）`,
        ).toBe(true);

        // 20260927 用户报「填写密码时会**多出来**一个眼睛的图标」：本框已经有一只自绘的
        // `.pwd-toggle`，多出来的那只来自 **Edge** 对 type=password 渲染的原生显隐按钮
        // （`::-ms-reveal`，IE/Edge 的遗留伪元素，Edge Chromium 至今仍支持；access log 的
        // UA 实测是 `Edg/152`）。修法 = 用 CSS 藏掉原生那只，只留自绘的。
        //
        // **这条判据只能是源码锁**：本机没有 msedge channel（`playwright install msedge`
        // 未装），Chromium 根本不渲染 `::-ms-reveal` ⇒ 无从渲染验证。取编译产物而不是
        // 源文件，至少要保证那条规则真的穿过了 sass 编译（`::-ms-*` 是历史上有过解析
        // 事故的写法）。作用域也必须一起锁：只藏主登录框那一个——重置密码弹窗的两个密码
        // 框没有自绘眼睛，原生那只对它们是有用的。
        const flat = loginCss.replace(/\s+/g, "");
        const sels = [...flat.matchAll(/([^{}]+?)::-ms-reveal\{([^}]*)\}/g)].map(
          (m) => [m[1], m[2]] as const,
        );
        expect.soft(
          sels.length === 1 && sels[0][1] === "display:none;",
          `藏掉 Edge 原生的密码显隐按钮（::-ms-reveal；Chrome 渲染不出来，只能锁编译产物） → ${JSON.stringify(sels)}`,
        ).toBe(true);
        expect.soft(
          sels.length > 0 && sels[0][0] === ".field-pwdinput[type=password]",
          `作用域只在主登录框（重置密码弹窗那两个密码框不在 .field-pwd 下，原生眼睛留着） → ${sels.length ? sels[0][0] : "没有这条规则"}`,
        ).toBe(true);

        const pg2 = await newPage(browser);
        await pg2.addInitScript("window.__token = 'fake-token';");
        await pg2.goto(sb.url);
        await pg2.waitForTimeout(400);
        expect.soft(
          (await pg2.evaluate(
            () =>
              (
                (window as unknown as Record<string, string[]>).__nav ?? []
              ).join(","),
          )) === "/",
          `已有普通用户 token 时自动回首页 / → ${JSON.stringify(await pg2.evaluate(() => (window as unknown as Record<string, string[]>).__nav ?? []))}`,
        ).toBe(true);

        // 另一岔：管理员 token 才是"一进来就直达后台"。分开两个 page 是因为 token 得在
        // 挂载前就位（add_init_script），改一个 page 的 localStorage 影响不到已跑的 effect。
        const pg4 = await newPage(browser);
        await pg4.addInitScript(
          `window.__token = ${JSON.stringify(jwtWithRole("admin"))};`,
        );
        await pg4.goto(sb.url);
        await pg4.waitForTimeout(400);
        expect.soft(
          (await pg4.evaluate(
            () =>
              (
                (window as unknown as Record<string, string[]>).__nav ?? []
              ).join(","),
          )) === "/dashboard",
          `已有管理员 token 时自动直达 /dashboard → ${JSON.stringify(await pg4.evaluate(() => (window as unknown as Record<string, string[]>).__nav ?? []))}`,
        ).toBe(true);

        // ── ⑨ 移动端（380px 宽） ──
        const pg3 = await newPage(browser, {
          viewport: { width: 380, height: 780 },
        });
        await pg3.goto(sb.url);
        await pg3.waitForTimeout(400);
        const b3 = (await pg3.locator(".login-box").boundingBox())!;
        expect.soft(
          b3.x >= 8 && b3.x + b3.width <= 372,
          `小屏卡片不溢出视口（左右各留 ≥8px） → x=${b3.x.toFixed(1)} 右=${(b3.x + b3.width).toFixed(1)}`,
        ).toBe(true);

        // ── ⑩ 忘记密码自动带入登录账号 ──
        // 必须排在所有"往 input#account 写字"的段之后：⑥ 已把账号填成 sora，此时重开应带过来。
        // （⑤ 里那条"重开表单是空的"之所以成立，是因为那会儿登录框还是空的——两段各锁一种情形。）
        await pg.click(".login-links button:nth-child(1)");
        await pg.waitForTimeout(250);
        expect.soft(
          (await pg.inputValue(".login-reset-form input:nth-of-type(1)")) ===
            "sora",
          `打开时把登录框里的账号带进「用户名」 → ${await pg.inputValue(".login-reset-form input:nth-of-type(1)")}`,
        ).toBe(true);
        expect.soft(
          await pg.evaluate(() =>
            [...document.querySelectorAll(".login-reset-form input")]
              .slice(1)
              .every((i) => (i as HTMLInputElement).value === ""),
          ),
          `只带账号：恢复码与两个密码框仍为空`,
        ).toBe(true);
        await pg.close();
        await pg2.close();
        await pg3.close();
        await pg4.close();
      },
    );
  });
});
