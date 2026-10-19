import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  FE_DIR,
  compileSass,
  withSandbox,
  esbuildInSandbox,
} from "./sandbox";

/**
 * 登录页弹窗**真 antd** 渲染验收（20260922）：底色 / 文字对比度 / 关闭图标 / 遮罩
 * （原 tests/login-modal-theme.test.py，20261019 迁移）。
 *
 * 为什么另起一个脚本（而不是并进 login-page.test.py）：
 *   那个脚本把 antd 整个换成桩（只为断言结构与交互，快）；而本轮修的正是"弹窗看起来
 *   不对"，桩里没有 antd 的样式，量不出观感——**结构对了不等于接线对了**。
 *   这里不 alias antd，让它真渲染（antd v5 是 CSS-in-JS，无外部样式表要引），
 *   Playwright 里按 WCAG 相对亮度算对比度：底色够不够暗、字够不够亮，是数值判据不是眼感。
 *
 * **昼夜两档（20261006 用户第 3 条）**：登录页从前恒深色、现在跟随全站 ⇒ 弹窗底色也跟着
 * 切（白天 = antd 浅色算法 + 和纸粉主色，夜间 = 原来那套墨蓝 + 河灯金）。
 * `freshPage(dark=true)` 在挂载前写 `localStorage.isDarkMode = 'true'`，两档各量一遍——
 * 这一节的重点正是"浅字落在白底上"这类**只有渲染出来才看得见**的事故，只测一档等于只守一半。
 *
 * 注意：本机无中文字体（fc-list CJK = 0）⇒ 截图里的汉字是豆腐块，属环境限制；
 *       对比度与几何不受影响（量的都是颜色与盒模型）。
 */

const LOGIN_SASS = path.join(FE_DIR, "src/pages/Login/index.sass");

const DEFINE_ENV =
  '{"VITE_HTTP_BASEURL":"","VITE_CDN_BASEURL":"","MODE":"production","DEV":false,"PROD":true,"BASE_URL":"/"}';

// 只桩边界（路由 / redux / 取 token / SEO），antd 与图标都用真的
const STUB_GET_TOKEN =
  "const getToken = () => (window as any).__token ?? null;\nexport default getToken;\n";
const STUB_USER_STORE =
  "export const fetchToken = (d: any) => ({ type: 'user/fetchToken', payload: d });\n";
const STUB_SEO = "const SeoHelmet = (_p: any) => null;\nexport default SeoHelmet;\n";
const STUB_DEEP_ROUTES =
  "export const useNavigate = () => (to: string) => {" +
  "(window as any).__nav = ((window as any).__nav || []).concat(to); };\n";
const STUB_ROUTER = STUB_DEEP_ROUTES;
const STUB_REDUX =
  "export const useDispatch = () => (a: any) => Promise.resolve({ status: 200, message: 'ok' });\n";
const STUB_RUNTIME_API = `export const runtimeBaseURL = '';
export const cdnBaseURL = '';
export const resolveApiAssetUrl = (url?: string) => (url || '');
`;

// 沙箱根 tsconfig：esbuild 的 paths 解析（替代原 CLI --alias）。
const TSCONFIG_PATHS = JSON.stringify({
  compilerOptions: {
    paths: {
      "react-router-dom": ["./stub-router.tsx"],
      "react-redux": ["./stub-redux.tsx"],
    },
  },
});

const ENTRY = `import * as React from 'react';
import { createRoot } from 'react-dom/client';
import Login from './src/pages/Login/index.tsx';
(window as any).__mount = () => createRoot(document.getElementById('root')!).render(<Login />);
`;

// 页面内注入：WCAG 相对亮度 + 对比度（含 alpha 合成到背景上的处理）
const HELPERS = () => {
  const lum = (c: number[]): number => {
    const f = (v: number): number => {
      v /= 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
  };
  const parse = (s: string): number[] => (s.match(/[\d.]+/g) || []).map(Number);
  // 把带 alpha 的前景色合成到背景上（antd 的 mask/字色都带 alpha）
  const over = (fg: number[], bg: number[]): number[] =>
    [0, 1, 2].map((i) => fg[i] * (fg[3] ?? 1) + bg[i] * (1 - (fg[3] ?? 1)));
  const ratio = (fgS: string, bgS: string): number => {
    const bg = parse(bgS);
    const fg = over(parse(fgS), bg);
    const [a, b] = [lum(fg), lum(bg)];
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  };
  const bgOf = (el: Element): string => {
    let n: Element | null = el;
    while (n && n !== document.documentElement) {
      const c = getComputedStyle(n).backgroundColor;
      const p = parse(c);
      if (p.length >= 3 && (p[3] === undefined || p[3] > 0.9)) return c;
      n = n.parentElement;
    }
    return getComputedStyle(document.body).backgroundColor;
  };
  const w = window as unknown as Record<string, unknown>;
  w.__lum = lum;
  w.__ratio = ratio;
  w.__bgOf = bgOf;
  w.__probe = (sel: string) => {
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
  w.__probeGrad = (sel: string) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const cs = getComputedStyle(el);
    const stops = cs.backgroundImage.match(/rgba?\([^)]+\)/g) || [];
    if (!stops.length) return (w.__probe as (s: string) => unknown)(sel);
    const rs = stops.map((s: string) => ratio(cs.color, s));
    return { color: cs.color, stops, ratio: Math.min(...rs), perStop: rs };
  };
};

interface ProbeOut {
  color: string;
  bg: string;
  ratio: number;
  lum: number;
}
interface GradOut {
  color: string;
  stops: string[];
  ratio: number;
  perStop: number[];
}

const probe = (pg: Page, sel: string): Promise<ProbeOut | null> =>
  pg.evaluate(
    (s: string) =>
      (window as unknown as { __probe: (s: string) => ProbeOut | null }).__probe(s),
    sel,
  );
const probeGrad = (pg: Page, sel: string): Promise<GradOut | null> =>
  pg.evaluate(
    (s: string) =>
      (window as unknown as { __probeGrad: (s: string) => GradOut | null }).__probeGrad(s),
    sel,
  );

test.describe("登录页弹窗（真 antd）", () => {
  test.setTimeout(180_000);

  test("注册/重置弹窗昼夜两档对比度、显隐图标、品牌区头像", async ({ browser }) => {
    const errs: string[] = [];

    await withSandbox(
      {
        // index.css 必须在前面：登录页自 20261006 起按昼夜两档用 `--washi-*`，
        // 不引全站令牌的话 `getComputedStyle` 量到的是 `var()` 的**回退值**——
        // 那样"改令牌也照样绿"，白天那几条判据就成了假绿。
        "index.html":
          '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">' +
          '<link rel="stylesheet" href="index.css">' +
          '<link rel="stylesheet" href="login.css"></head><body><div id="root"></div>' +
          '<script src="bundle.js"></script><script>window.__mount && window.__mount();</script>' +
          "</body></html>",
        "index.css": readFileSync(path.join(FE_DIR, "src/index.css"), "utf-8"),
        "login.css": compileSass(LOGIN_SASS),
      },
      async (sb) => {
        await esbuildInSandbox(sb, {
          entry: "entry.tsx",
          files: {
            "entry.tsx": ENTRY,
            "src/apis/getToken.tsx": STUB_GET_TOKEN,
            "src/store/components/user.tsx": STUB_USER_STORE,
            "src/components/SeoHelmet.tsx": STUB_SEO,
            "src/pages/Login/deep-routes.tsx": STUB_DEEP_ROUTES,
            "src/utils/runtimeApi.ts": STUB_RUNTIME_API,
            "stub-router.tsx": STUB_ROUTER,
            "stub-redux.tsx": STUB_REDUX,
            "tsconfig.json": TSCONFIG_PATHS,
          },
          copySrc: true,
          define: { "import.meta.env": DEFINE_ENV },
          loaders: { ".sass": "text" },
        });

        /** 每个弹窗用**新开的页面**测：弹窗关了再开会有 antd 的退场动画与遮罩残留，
         * 点下一个入口会被上一个弹窗的输入框拦（实测 60 次重试都不通），不如各测各的。
         *
         * `dark=true` ⇒ 挂载前写下 `isDarkMode`（这份夹具没写 = 全站默认的白天档）。
         * 必须在 goto 之前下笔：`useIsDarkMode()` 的初值在**挂载时**读一次 localStorage。
         *
         * ⚠️ 20261013：这一页现在**自己会跟着钟面切档**（挂了 `useAutoThemeSwitch()`，见
         * login-page.test.py 的 ③d），于是"不写 isDarkMode = 白天档"这条夹具会把**跑套件的
         * 那一刻**带进判据——23:00-06:00 之间跑，页面在挂载后一分钟内自动切夜，白天档那几条
         * 当场变红（20261013 23:4x 实测红 2 条）。钉在本地 14:00（ticker 的设计无动作时段）。 */
        const freshPage = async (dark = false) => {
          const ctx = await browser.newContext({
            viewport: { width: 1280, height: 900 },
          });
          const pg = await ctx.newPage();
          pg.on("pageerror", (e) => errs.push(String(e)));
          await pg.clock.install({ time: "2026-10-13T14:00:00" });
          if (dark) {
            await pg.addInitScript(
              "localStorage.setItem('isDarkMode', 'true');",
            );
          }
          await pg.goto(sb.url);
          await pg.evaluate(HELPERS);
          await pg.waitForTimeout(300);
          return { ctx, pg };
        };

        // ── 【一】注册弹窗 · 白天档（默认：不写 isDarkMode = 全站白天） ──
        {
          const { ctx, pg } = await freshPage();
          await pg.click(".login-links button:nth-child(3)");
          await pg.waitForSelector(".ant-modal-content", { timeout: 5_000 });
          await pg.waitForTimeout(500);

          expect(
            (await pg.locator(".ant-modal-content").count()) === 1,
            "真 antd 弹窗已挂载（.ant-modal-content）",
          ).toBe(true);
          expect(
            (await pg.locator(".ant-modal-mask").count()) === 1,
            "遮罩存在",
          ).toBe(true);
          const card = await probe(pg, ".ant-modal-content");
          expect(
            !!card && card.lum > 0.8,
            `白天弹窗底色是浅色（相对亮度 > 0.8，不是墨蓝那套） → ${card?.bg} lum=${card?.lum.toFixed(3)}`,
          ).toBe(true);
          const title = await probe(pg, ".ant-modal-title");
          expect(
            !!title && title.ratio >= 4.5,
            `标题对比度 ≥ 4.5:1 → ${title?.ratio.toFixed(2)}:1`,
          ).toBe(true);
          const body = await probe(pg, ".login-modal-body");
          expect(
            !!body && body.ratio >= 4.5,
            `正文对比度 ≥ 4.5:1 → ${body?.ratio.toFixed(2)}:1`,
          ).toBe(true);
          const listItem = await probe(pg, ".login-modal-body li");
          expect(
            !!listItem && listItem.ratio >= 4.5,
            `列表项对比度 ≥ 4.5:1 → ${listItem?.ratio.toFixed(2)}:1`,
          ).toBe(true);
          const bold = await probe(pg, ".login-modal-body b");
          expect(
            !!bold && bold.ratio >= 3,
            `高亮词（和纸深粉 #d94f9a）对比度 ≥ 3:1 → ${bold?.ratio.toFixed(2)}:1`,
          ).toBe(true);
          const close = await probe(pg, ".ant-modal-close");
          expect(
            !!close && close.ratio >= 3,
            `关闭图标对比度 ≥ 3:1 → ${close?.ratio.toFixed(2)}:1`,
          ).toBe(true);
          const btn = await probeGrad(pg, ".login-modal-primary");
          expect(
            !!btn && btn.stops.some((s) => s.includes("255, 215, 234")),
            `页脚主按钮是白天的浅粉渐变（不是夜间的金渐变） → ${(btn?.stops ?? []).join(" | ").slice(0, 80)}`,
          ).toBe(true);
          expect(
            !!btn && btn.ratio >= 4.5,
            `页脚主按钮文字压浅粉渐变可读（最差色标 ≥ 4.5:1） → ${btn?.ratio.toFixed(2)}:1 各色标 ${(btn?.perStop ?? []).map((r) => r.toFixed(1)).join(", ")}`,
          ).toBe(true);
          expect(
            (await pg.locator(".login-modal-foot button").count()) === 1 &&
              (await pg.locator(".login-modal-ghost").count()) === 0,
            "页脚只有一个出口（没有留言板按钮）",
          ).toBe(true);
          const centered = await pg.evaluate(() => {
            const f = document.querySelector(".login-modal-foot")!.getBoundingClientRect();
            const b = document.querySelector(".login-modal-foot button")!.getBoundingClientRect();
            return Math.abs(b.left + b.width / 2 - (f.left + f.width / 2)) <= 1;
          });
          expect(
            centered,
            "「知道了」水平居中（不与正文左边界对齐）",
          ).toBe(true);
          const reg = await pg.locator(".login-modal-body").innerText();
          expect(
            reg.includes("发布功能需要登录") &&
              reg.includes("无需登录") &&
              !reg.includes("河灯集"),
            `合规声明与后端口径一致（发布需登录） → ${reg.replace(/\s+/g, "").slice(0, 60)}`,
          ).toBe(true);
          const mrect = await pg.evaluate(() => {
            const r = document.querySelector(".ant-modal")!.getBoundingClientRect();
            return { top: r.top, bottom: r.bottom };
          });
          expect(
            mrect.top >= 0 && mrect.bottom <= 900,
            `弹窗不溢出视口 → top=${mrect.top.toFixed(0)} bottom=${mrect.bottom.toFixed(0)}`,
          ).toBe(true);
          await pg.screenshot({
            path: test.info().outputPath("login-modal-register.png"),
          });
          await ctx.close();
        }

        // ── 【一b】注册弹窗 · 夜间档（同一颗弹窗，20260921 那套墨蓝 + 河灯金） ──
        {
          const { ctx, pg } = await freshPage(true);
          await pg.click(".login-links button:nth-child(3)");
          await pg.waitForSelector(".ant-modal-content", { timeout: 5_000 });
          await pg.waitForTimeout(500);
          const cardN = await probe(pg, ".ant-modal-content");
          expect(
            !!cardN && cardN.lum < 0.15,
            `夜间弹窗底色是深色（相对亮度 < 0.15） → ${cardN?.bg} lum=${cardN?.lum.toFixed(3)}`,
          ).toBe(true);
          for (const [sel, name, floor] of [
            [".ant-modal-title", "标题", 4.5],
            [".login-modal-body", "正文", 4.5],
            [".login-modal-body li", "列表项", 4.5],
            [".login-modal-body b", "高亮词（河灯金）", 3],
            [".ant-modal-close", "关闭图标", 3],
          ] as const) {
            const pr = await probe(pg, sel);
            expect(
              !!pr && pr.ratio >= floor,
              `夜间 ${name} 对比度 ≥ ${floor}:1 → ${pr?.ratio.toFixed(2)}:1`,
            ).toBe(true);
          }
          const btnN = await probeGrad(pg, ".login-modal-primary");
          expect(
            !!btnN && btnN.stops.some((s) => s.includes("232, 184, 102")),
            `夜间页脚主按钮回到金渐变 → ${(btnN?.stops ?? []).join(" | ").slice(0, 80)}`,
          ).toBe(true);
          expect(
            !!btnN && btnN.ratio >= 4.5,
            `夜间按钮文字压金渐变可读（最差色标 ≥ 4.5:1） → ${btnN?.ratio.toFixed(2)}:1`,
          ).toBe(true);
          await ctx.close();
        }

        // ── 【二】重置密码弹窗（表单：输入框自身也要看得见） ──
        {
          const { ctx, pg } = await freshPage();
          // 先在登录框写账号，再开弹窗：验"自动带入账号"这条真渲染路径（桩脚本另有一段锁同一行为）
          await pg.fill("input#account", "sora");
          await pg.click(".login-links button:nth-child(1)");
          await pg.waitForSelector(".login-reset-form input", { timeout: 5_000 });
          await pg.waitForTimeout(500);
          expect(
            (await pg.locator(".login-reset-form input").first().inputValue()) === "sora",
            `打开时带入了登录框里的账号 → ${await pg.locator(".login-reset-form input").first().inputValue()}`,
          ).toBe(true);
          expect(
            (await pg.locator(".login-reset-form input").nth(1).inputValue()) === "",
            "恢复码框仍为空（只带账号）",
          ).toBe(true);
          const inp = await probe(pg, ".login-reset-form input");
          expect(
            !!inp && inp.ratio >= 4.5,
            `输入框文字对比度 ≥ 4.5:1 → ${inp?.ratio.toFixed(2)}:1`,
          ).toBe(true);
          const inputBgDiffers = await pg.evaluate(() => {
            const a = getComputedStyle(document.querySelector(".login-reset-form input")!).backgroundColor;
            const b = getComputedStyle(document.querySelector(".ant-modal-content")!).backgroundColor;
            return a !== b;
          });
          const inputBg = await pg.evaluate(() =>
            getComputedStyle(document.querySelector(".login-reset-form input")!).backgroundColor,
          );
          expect(
            inputBgDiffers,
            `输入框底色与弹窗底色不同（框看得见） → ${inputBg}`,
          ).toBe(true);
          const borderVisible = await pg.evaluate(() => {
            const s = getComputedStyle(document.querySelector(".login-reset-form input")!);
            return parseFloat(s.borderTopWidth) >= 1 && !s.borderTopColor.endsWith(", 0)");
          });
          expect(
            borderVisible,
            "输入框有可见边框（宽度 ≥1px 且非透明）",
          ).toBe(true);
          const sub = await probeGrad(pg, ".login-reset-form button");
          expect(
            !!sub && sub.ratio >= 4.5,
            `提交按钮文字压浅粉渐变可读（最差色标 ≥ 4.5:1） → ${sub?.ratio.toFixed(2)}:1 各色标 ${(sub?.perStop ?? []).map((r) => r.toFixed(1)).join(", ")}`,
          ).toBe(true);
          expect(
            (await pg.locator(".login-modal-foot").count()) === 0,
            "没有页脚（「取消」是多余的：X/遮罩/Esc 都能关）",
          ).toBe(true);
          expect(
            (await pg.locator(".login-modal-hint").count()) === 0 &&
              !(await pg.locator(".ant-modal-content").innerText()).includes("河灯集"),
            "没有「拿不到恢复码」引导行（那条路本身要登录，走不通）",
          ).toBe(true);
          const close2 = await probe(pg, ".ant-modal-close");
          expect(
            !!close2 && close2.ratio >= 3,
            `关闭 X 是唯一出口且可见（对比度 ≥ 3:1） → ${close2?.ratio.toFixed(2)}:1`,
          ).toBe(true);
          const sameBox = await pg.evaluate(() => {
            const i = document.querySelector(".login-reset-form input")!.getBoundingClientRect();
            const b = document.querySelector(".login-reset-form button")!.getBoundingClientRect();
            return {
              ok: Math.abs(i.left - b.left) <= 1 && Math.abs(i.width - b.width) <= 1,
              detail: `input ${i.left.toFixed(0)}+${i.width.toFixed(0)} / btn ${b.left.toFixed(0)}+${b.width.toFixed(0)}`,
            };
          });
          expect(
            sameBox.ok,
            `提交按钮与输入框同宽同左边界（不是居中小按钮） → ${sameBox.detail}`,
          ).toBe(true);
          await pg.screenshot({
            path: test.info().outputPath("login-modal-reset.png"),
          });
          await ctx.close();
        }

        // ── 【二b】重置密码弹窗 · 夜间档（浅字不许落在浅底上） ──
        // 这一批控件（`.login-reset-form` 那几条字色/底色）自 20261006 起挪到 `body.login-dark`
        // 底下（弹窗挂在 body 上，够不着页面里的 `.frontDark`）——**换了作用域就要重量一遍**，
        // 否则"没生效"与"生效了"在白天夹具里长得一模一样。
        {
          const { ctx, pg } = await freshPage(true);
          await pg.click(".login-links button:nth-child(1)");
          await pg.waitForSelector(".login-reset-form input", { timeout: 5_000 });
          await pg.waitForTimeout(500);
          const modalN = await probe(pg, ".ant-modal-content");
          expect(
            !!modalN && modalN.lum < 0.15,
            `夜间弹窗仍是深色 → ${modalN?.bg} lum=${modalN?.lum.toFixed(3)}`,
          ).toBe(true);
          const inpN = await probe(pg, ".login-reset-form input");
          expect(
            !!inpN && inpN.ratio >= 4.5,
            `夜间表单输入框文字对比度 ≥ 4.5:1（白字没落在白底上） → ${inpN?.ratio.toFixed(2)}:1`,
          ).toBe(true);
          const nInputBgDiffers = await pg.evaluate(() => {
            const a = getComputedStyle(document.querySelector(".login-reset-form input")!).backgroundColor;
            const b = getComputedStyle(document.querySelector(".ant-modal-content")!).backgroundColor;
            return { ok: a !== b, bg: a };
          });
          expect(
            nInputBgDiffers.ok,
            `夜间输入框底色与弹窗底色不同（框看得见） → ${nInputBgDiffers.bg}`,
          ).toBe(true);
          const pN = await probe(pg, ".login-reset-form p");
          expect(
            !!pN && pN.ratio >= 4.5,
            `夜间表单说明文字对比度 ≥ 4.5:1 → ${pN?.ratio.toFixed(2)}:1`,
          ).toBe(true);
          const subN = await probeGrad(pg, ".login-reset-form button");
          expect(
            !!subN &&
              subN.ratio >= 4.5 &&
              subN.stops.some((s) => s.includes("232, 184, 102")),
            `夜间提交按钮回到金渐变且可读 → ${subN?.ratio.toFixed(2)}:1`,
          ).toBe(true);
          await ctx.close();
        }

        // ── 【三】密码显隐图标（真 antd 图标组件） ──
        {
          const { ctx, pg } = await freshPage();
          expect(
            errs.length === 0,
            `无 JS 报错 → ${errs.slice(0, 2).join("; ")}`,
          ).toBe(true);
          expect(
            (await pg.locator(".pwd-toggle .anticon-eye").count()) === 1,
            "按钮内是真 EyeOutlined（.anticon-eye）",
          ).toBe(true);
          await pg.click(".pwd-toggle");
          await pg.waitForTimeout(200);
          expect(
            (await pg.locator(".pwd-toggle .anticon-eye-invisible").count()) === 1,
            "切换后变成 .anticon-eye-invisible",
          ).toBe(true);
          const iconSized = await pg.evaluate(() => {
            const r = document.querySelector(".pwd-toggle svg")!.getBoundingClientRect();
            return r.width > 8 && r.height > 8;
          });
          expect(
            iconSized,
            "图标有尺寸（> 0，不是塌成 0×0）",
          ).toBe(true);
          await pg.screenshot({
            path: test.info().outputPath("login-page-full.png"),
          });
          await ctx.close();
        }

        // ── 【四】品牌区头像的尺寸与上下间距（20260924 用户反馈"有点小、与上方文本和下方
        //    输入框距离不协调"）。这一节必须在本套件量（**不桩 antd**）：边长来自 antd Avatar
        //    的 size prop，打成 inline width/height 落在 .ant-avatar 上——桩会把它吃掉，
        //    量出来永远是 0。 ──
        {
          const { ctx, pg } = await freshPage();
          // className 是直接传给 antd Avatar 的 ⇒ 根 span 自己就同时带 `.login-avatar` 与
          // `.ant-avatar`（不是嵌套关系）。size prop 化成的 inline width/height 就在这个根元素上。
          await pg.waitForSelector(".ant-avatar.login-avatar", { timeout: 10_000 });
          const geo = await pg.evaluate(() => {
            const a = document.querySelector(".login-avatar")!.getBoundingClientRect();
            const h = document.querySelector(".login-brand h2")!.getBoundingClientRect();
            const f = document.querySelector(".field")!.getBoundingClientRect();
            const bx = document.querySelector(".login-box")!.getBoundingClientRect();
            return {
              aw: a.width,
              ah: a.height,
              above: a.top - h.bottom,
              below: f.top - a.bottom,
              cx: a.left + a.width / 2,
              bx: { left: bx.left, width: bx.width, top: bx.top, bottom: bx.bottom },
            };
          });
          expect(
            Math.abs(geo.aw - 84) <= 1 && Math.abs(geo.ah - 84) <= 1,
            `头像边长 84（20260924 由 64 调大） → ${geo.aw.toFixed(1)}×${geo.ah.toFixed(1)}`,
          ).toBe(true);
          expect(
            Math.abs(geo.above - 16) <= 2,
            `与上方标题的间距 = 16 → ${geo.above.toFixed(1)}`,
          ).toBe(true);
          expect(
            Math.abs(geo.below - 30) <= 2,
            `与下方第一个输入框的间距 = 30（比上方大一档，块内不贴） → ${geo.below.toFixed(1)}`,
          ).toBe(true);
          expect(
            Math.abs(geo.cx - (geo.bx.left + geo.bx.width / 2)) <= 2,
            `头像在卡片里水平居中（与卡片中心偏差 ≤2px） → 头像中心 ${geo.cx.toFixed(1)} / 卡片中心 ${(geo.bx.left + geo.bx.width / 2).toFixed(1)}`,
          ).toBe(true);
          expect(
            Math.abs(geo.bx.width - 400) <= 1 &&
              geo.bx.top >= 0 &&
              geo.bx.bottom <= 900,
            `卡片仍是 400 宽、不溢出视口 → ${geo.bx.width.toFixed(0)} 高 ${geo.bx.top.toFixed(0)}..${geo.bx.bottom.toFixed(0)}`,
          ).toBe(true);
          await ctx.close();
        }

        // 截图落在 playwright outputDir（.artifacts，不进仓库跟踪区）；
        // 本机无中文字体，截图中汉字是豆腐块；颜色与几何判据不受影响。
      },
    );
  });
});
