import { test, expect, type Browser, type Page } from "@playwright/test";
import path from "node:path";
import {
  FE_DIR,
  compileSass,
  withSandbox,
  collectPageErrors,
  esbuildInSandbox,
} from "./sandbox";

/**
 * 站点设置「图库存储」页签（20261006，用户第 3 条）无头验收
 * （原 tests/r2-settings-tab.test.py，20261019 迁移）。
 *
 * 20261006 用户拍板「配置挪到站点设置，单一入口」：图库那边只留用量与灰态，R2 的桶名/
 * 前缀/公开域名/配额/开关**只有这一处入口**。于是这一页要是坏了（读不出值、存不进去、
 * 或者存的时候顺手把别的设置覆盖了），R2 图床就彻底用不了，而**页面上不会有任何报错**——
 * 正是必须真跑一遍才看得见的那类。所以本文件锁四件事：
 *
 *   · **它真的落在这一页**（第一节）—— 图库那颗按钮带 `{tab:'4'}` 跳过来，`initialTab`
 *     要认得出这个 state；认不出就落在「站点信息」上，用户以为按钮没生效。
 *   · **表单回填的是服务端存的值**（第二节）—— 桶名/前缀/域名/配额/开关五项逐一对上，
 *     且**哪一格是哪个**（三个 `addonBefore` 的字）也要对上：回填串了格等于改错字段。
 *   · **条子走的是 `utils/r2Quota`**（第三、四节）—— 可信读数显示"已用 X / 上限 Y（Z%）"；
 *     读数不可信（`listError`）时**只显示原因**，一个用量数字一个百分比都不许出现
 *     （「0.00 GB」会被读成「用量是 0」）。第四节是**真负控**：同一份 bundle，只让桩返回
 *     `listError`，第三节那几条必须红。
 *   · **保存只提交这五个键**（第五节）—— 这个接口的语义是"只写请求里带了的那些"，
 *     多带一个键就会**连带改写别的页签的设置**（留言/评论那几个开关就在同一张表里）。
 *     所以判据是**键集合相等**，不是"包含这五个"。负控同上（同一份 bundle 换个桩）。
 *
 * 见 CLAUDE.md §2：本机不能 vite build。esbuild 把**真组件**打成 bundle，只桩一个边界
 * （`src/apis/axios.tsx`）；页面 sass 用 node API 单独编译后注入（顺带过一遍编译）。
 * 本机无中文字体（汉字渲染成豆腐块），断言一律走数值、键名与 ASCII 数字。
 */

const DEFINE_ENV =
  '{"VITE_HTTP_BASEURL":"","VITE_CDN_BASEURL":"","MODE":"production","DEV":false,"PROD":true,"BASE_URL":"/"}';

// ── 夹具：桩里存的值 / 读数 ──
// 配额与用量都用整 0.5 档，好让"50%"这种断言不依赖浮点比较。
const GIB = 1024 ** 3;
const QUOTA_GB = 9.5;
const USED_BYTES = Math.trunc(4.75 * GIB);
const LIMIT_BYTES = Math.trunc(QUOTA_GB * GIB);

const STUB_RUNTIME_API = `export const runtimeBaseURL = '';
export const cdnBaseURL = '';
export const resolveApiAssetUrl = (url?: string) => (url || '');
`;

const FAKE_AXIOS = `const calls: any[] = (window as any).__calls = [];
(window as any).__axiosStub = true;
// 负控开关：地址上带 \`?bad=1\` 时，用量接口改回**读不出来**（\`listError\`），
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
  r2ImageQuotaGB: ${QUOTA_GB},
  r2ImageEnabled: true,
};
const USAGE = {
  enabled: true, configured: true, credentials: true,
  bucket: 'saudade-blog-image', prefix: 'gallery', publicBase: 'https://img.cat0.qzz.io',
  quotaGB: ${QUOTA_GB}, limitBytes: ${LIMIT_BYTES}, usedBytes: ${USED_BYTES}, listError: null,
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
    // 负控这份**刻意连 \`limitBytes\` 一起置 0**（＝"配额没配出个正数"那一种）：它是唯一
    // 能让"少一次 null 判断"暴露出来的取值 —— 那时 \`usagePercent(0, 0)\` 会返回 **100**，
    // 条子会变成一条满的假条子。只把 usedBytes 置 0 的话，朴素实现算出来也是 0%，
    // 第四节的断言就分不出对错了。
    if (bad) { u.listError = '列桶失败：HTTP 403'; u.usedBytes = 0; u.limitBytes = 0; }
    return env(u);
  }
  return env(null);
};

// ⚠️ 必须是**可调用对象**：这个页面里 MUI 那半边走 \`http({url,method})\`、
// 新页签走 \`http.get(...)\` —— 只做其中一种，另一种就是 \`undefined is not a function\`。
const http: any = (cfg: any) => req(cfg);
http.get = (url: string, cfg?: any) => req({ ...(cfg || {}), url, method: 'GET' });
http.post = (url: string, data?: any, cfg?: any) => req({ ...(cfg || {}), url, data, method: 'POST' });
http.put = (url: string, data?: any, cfg?: any) => req({ ...(cfg || {}), url, data, method: 'PUT' });
http.delete = (url: string, cfg?: any) => req({ ...(cfg || {}), url, method: 'DELETE' });
export default http;
`;

const ENTRY = `import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import UserControl from './src/pages/Dashboard/UserControl/index.tsx';

// 挂载点与真站一致的那一点：图库那颗「R2 存储」按钮是**带 state 跳过来**的
// （\`navigate('/dashboard/usercontrol', { state: { tab: '4' } })\`）。这里照抄那个 state ——
// 少写它，测的就不是用户真正走的那条路（第五节另有一条断言直接钉这个 state）。
(window as any).__mount = () => createRoot(document.getElementById('root')!).render(
  <MemoryRouter initialEntries={[{ pathname: '/dashboard/usercontrol', state: { tab: '4' } }]}>
    <UserControl />
  </MemoryRouter>
);
`;

interface FormState {
  addons: string[];
  values: string[];
  quota: string | undefined;
  enabled: boolean;
  usageLine: string;
  barWidth: string | null;
  barBg: string | null;
  text: string;
}
interface WriteCall {
  url: string;
  method: string;
  body: Record<string, unknown> | null;
}

// 表单的读法：三个文本框按 DOM 次序（= 页面上的次序），配额那个是 InputNumber。
const READ_FORM = (): FormState | null => {
  const box = document.querySelector(".r2_storage");
  if (!box) return null;
  const inps = [...box.querySelectorAll("input.ant-input")] as HTMLInputElement[];
  const quotaEl = box.querySelector(
    "input.ant-input-number-input",
  ) as HTMLInputElement | null;
  const bar = box.querySelector(".ant-progress-bg") as HTMLElement | null;
  return {
    addons: [...box.querySelectorAll(".ant-input-group-addon")].map((e) =>
      (e.textContent || "").trim(),
    ),
    values: inps.map((i) => i.value),
    quota: quotaEl?.value,
    enabled: !!box.querySelector(".ant-switch-checked"),
    // 「已用 / 上限（百分比）」那一行（读数不可信时它只有原因）
    usageLine: (box.querySelector("span") as HTMLElement | null)?.textContent || "",
    // 条子本体：有没有画出进度（`.ant-progress-bg` 的宽度百分比）与它的颜色
    barWidth: bar ? bar.style.width : null,
    barBg: bar ? getComputedStyle(bar).backgroundColor : null,
    // 整块可见文本（"不许出现数字"那条断言扫它）
    text: (box as HTMLElement).innerText,
  };
};

test.describe("站点设置「图库存储」页签", () => {
  test.setTimeout(180_000);

  test("页签定位、表单回填、用量条可信/不可信两态、保存键集合、配额下限", async ({ browser }) => {
    const pageCss = compileSass(
      path.join(FE_DIR, "src/pages/Dashboard/UserControl/index.sass"),
    );

    await withSandbox(
      {
        "index.html":
          '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">' +
          `<style>${pageCss}</style>` +
          '</head><body><div id="root"></div><script src="bundle.js"></script></body></html>',
      },
      async (sb) => {
        await esbuildInSandbox(sb, {
          entry: "entry.tsx",
          files: {
            "entry.tsx": ENTRY,
            "src/apis/axios.tsx": FAKE_AXIOS,
            "src/utils/runtimeApi.ts": STUB_RUNTIME_API,
          },
          copySrc: true,
          define: { "import.meta.env": DEFINE_ENV },
          loaders: { ".sass": "text", ".png": "dataurl", ".svg": "dataurl" },
        });

        const badUrl = sb.url + "?bad=1";

        const mount = async (br: Browser, url = sb.url) => {
          const ctx = await br.newContext({
            viewport: { width: 1440, height: 900 },
          });
          const page = await ctx.newPage();
          const errs = collectPageErrors(page);
          await page.goto(url);
          await page.evaluate(() =>
            (window as unknown as { __mount: () => void }).__mount(),
          );
          try {
            await page.waitForSelector(".r2_storage", { timeout: 10_000 });
          } catch {
            // 等不到「图库存储」那一块时把现场带出来（tabs / 激活项 / 已发出的请求），
            // 免得"红了一条不知道红在哪"。
            const scene = await page.evaluate(() =>
              JSON.stringify({
                root: document.getElementById("root")!.children.length,
                tabs: [...document.querySelectorAll(".ant-tabs-tab")].map((t) =>
                  (t as HTMLElement).innerText,
                ),
                active:
                  (
                    document.querySelector(".ant-tabs-tab-active") as HTMLElement | null
                  )?.innerText ?? null,
                calls: (
                  (window as unknown as { __calls?: Array<{ method: string; url: string }> })
                    .__calls || []
                ).map((c) => c.method + " " + c.url),
              }),
            );
            const w = (window as unknown as { __calls?: unknown[] });
            void w;
            console.log("  ⚠ 等不到「图库存储」那一块，现场：" + scene);
            console.log("    页面异常：" + (errs().slice(0, 3).join("; ") || "（无）"));
            throw new Error("r2_storage 未挂载");
          }
          await page.waitForTimeout(600);
          return { ctx, page, errs };
        };

        const form = (pg: Page) => pg.evaluate(READ_FORM) as Promise<FormState | null>;
        const writes = (pg: Page) =>
          pg.evaluate(() =>
            (
              (window as unknown as { __calls: Array<{ url: string; method: string; data: unknown }> })
                .__calls || []
            )
              .filter((c) => c.method !== "GET")
              .map((c) => ({ url: c.url, method: c.method, body: c.data as Record<string, unknown> | null })),
          ) as Promise<WriteCall[]>;

        const TAB_LABELS = ["站点信息", "社交媒体", "向量图谱", "图库存储"];

        // ── 【一】落在这一页 ──
        const s1 = await mount(browser);
        {
          const pg = s1.page;
          const labels = await pg.evaluate(() =>
            [...document.querySelectorAll(".ant-tabs-tab")].map((t) =>
              (t as HTMLElement).innerText.replace(/\s+/g, ""),
            ),
          );
          expect(
            JSON.stringify(labels) === JSON.stringify(TAB_LABELS),
            `四个页签按次序排列（新增的「图库存储」在最后） → ${JSON.stringify(labels)}`,
          ).toBe(true);
          const active = await pg.evaluate(
            () =>
              (document.querySelector(".ant-tabs-tab-active") as HTMLElement | null)
                ?.innerText ?? null,
          );
          expect(
            !!active && active.includes("图库存储"),
            `**落在「图库存储」上**（\`initialTab\` 认得 state.tab='4'） → ${active}`,
          ).toBe(true);
          expect(
            s1.errs(),
            `第一节无页面异常 → ${s1.errs().slice(0, 3).join("; ")}`,
          ).toEqual([]);
        }

        // ── 【二】表单回填的是服务端存的值，且哪一格是哪个 ──
        {
          const f = await form(s1.page);
          expect(
            JSON.stringify(f?.addons) === JSON.stringify(["桶名", "前缀", "公开域名"]),
            `三格的标签依次是 桶名 / 前缀 / 公开域名 → ${JSON.stringify(f?.addons)}`,
          ).toBe(true);
          expect(
            JSON.stringify(f?.values) ===
              JSON.stringify(["saudade-blog-image", "gallery", "https://img.cat0.qzz.io"]),
            `桶名/前缀/域名逐格回填（串格 = 改错字段） → ${JSON.stringify(f?.values)}`,
          ).toBe(true);
          expect(
            f?.quota === String(QUOTA_GB),
            `配额回填 ${QUOTA_GB}（面板显示的是**存着的**值，不是生效值） → ${f?.quota}`,
          ).toBe(true);
          expect(
            f?.enabled === true,
            `开关是打开的（\`r2ImageEnabled: true\`） → ${f?.enabled}`,
          ).toBe(true);

          // ── 【三】条子：可信读数显示三样 ──
          expect(
            !!f &&
              f.usageLine.includes("4.75 GB") &&
              f.usageLine.includes("9.50 GB") &&
              f.usageLine.includes("50%"),
            `那一行同时出现 4.75 GB / 9.50 GB / 50% → ${f?.usageLine}`,
          ).toBe(true);
          expect(
            f?.barWidth === "50%",
            `  条子本体画的是 50%（页面走的是 \`utils/r2Quota\` 的 \`usagePercent\`，不是自己算的） → ${f?.barWidth}`,
          ).toBe(true);
          expect(
            (await s1.page.locator(".ant-modal-wrap:visible").count()) === 0,
            "  这一页**没有**开任何弹窗（配置是页签，不是弹窗）",
          ).toBe(true);
          expect(
            s1.errs(),
            `第三节无页面异常 → ${s1.errs().slice(0, 3).join("; ")}`,
          ).toEqual([]);
          await s1.ctx.close();
        }

        // ── 【四】（负控）读数不可信 ⇒ 只显示原因 ──
        {
          const s = await mount(browser, badUrl);
          const b = await form(s.page);
          expect(
            !!b && b.text.includes("列桶失败") && b.text.includes("403"),
            `负控前置：确实换成了读不出来的那份读数（原因原文在） → ${b?.usageLine}`,
          ).toBe(true);
          expect(
            !!b && !/[\d.]+\s*(GB|GiB|MB)|%/.test(b.text),
            `负控：三样数字一条都不出现（「0.00 GB」会被读成「用量是 0」） → ${b?.usageLine}`,
          ).toBe(true);
          expect(
            b?.barWidth === "0%",
            `  条子**宽度必须是 0%**，不是 100% —— 「算不出来」与「用满了」是两回事，而 \`usagePercent\` 对 \`limit<=0\` 返回的正是 100：少一次 null 判断，条子就变成一条满的假条子（这一档的桩刻意把 \`limitBytes\` 也置了 0，就是这个原因） → ${b?.barWidth}`,
          ).toBe(true);
          expect(
            b?.barBg === "rgb(191, 191, 191)",
            `  且它是**灰**的（\`strokeColor\` 那条分支也没被绕过） → ${b?.barBg}`,
          ).toBe(true);
          expect(
            !!b && !b.text.includes("50%"),
            "  第三节的「三样都在」在它身上不成立（证明那条断言不是恒真）",
          ).toBe(true);
          await s.ctx.close();
        }

        // ── 【五】保存：只提交这五个键（多带一个键＝连带改写别的页签的设置） ──
        {
          const s = await mount(browser);
          const pg = s.page;
          await pg.locator(".r2_storage button.ant-btn-primary").click();
          await pg.waitForTimeout(600);
          const w = await writes(pg);
          expect(
            w.length === 1 &&
              w[0]!.method === "POST" &&
              w[0]!.url === "/api/protected/websetting",
            `点保存 ⇒ 恰好一条写请求，且是 POST /api/protected/websetting → ${JSON.stringify(w.map((x) => [x.method, x.url]))}`,
          ).toBe(true);
          const body = w[0]?.body ?? {};
          const want = [
            "r2ImageEnabled",
            "r2ImageBucket",
            "r2ImagePrefix",
            "r2ImagePublicBase",
            "r2ImageQuotaGB",
          ].sort();
          expect(
            JSON.stringify(Object.keys(body).sort()) === JSON.stringify(want),
            `  键集合**恰好相等**（不是「包含」——多带的键会被服务端照写） → ${JSON.stringify(Object.keys(body).sort())}`,
          ).toBe(true);
          expect(
            body.r2ImageBucket === "saudade-blog-image" &&
              body.r2ImagePrefix === "gallery" &&
              body.r2ImagePublicBase === "https://img.cat0.qzz.io" &&
              body.r2ImageQuotaGB === QUOTA_GB &&
              body.r2ImageEnabled === true,
            `  值就是表单里那五个（开关/桶名/前缀/域名/配额） → ${JSON.stringify(body)}`,
          ).toBe(true);
          const r2Gets = await pg.evaluate(
            () =>
              (
                (window as unknown as { __calls: Array<{ url: string; method: string }> })
                  .__calls || []
              ).filter(
                (c) => c.url === "/api/protect/images/r2" && c.method === "GET",
              ).length,
          );
          expect(
            r2Gets >= 2,
            `  保存成功后**重拉了**用量（用量条要跟上刚存下的配置） → ${r2Gets}`,
          ).toBe(true);
          expect(
            s.errs(),
            `第五节无页面异常 → ${s.errs().slice(0, 3).join("; ")}`,
          ).toEqual([]);

          // ── 【六】那一格的下限：填 0 ⇒ 出去的配额仍是正数 ──
          // 「这一格是会不会产生账单的那条线」的**下限版本**：配额只要落到 0 或负数，
          // 上传闸门就变得毫无意义（0 会让每一张都被拒、负数更荒谬），所以**出去的配额必须
          // 恒为正**。这条不变量由两处一起给：antd 的 `min={0.1}`（输入期就夹住）与组件里
          // 那道 `> 0`（提交前再拦一次）。这里测的是**合起来的结果**——真点一次、读请求体。
          //
          // ⚠️ 两条路测不到，本套件不假装测过：
          //   · "清空这一格"：antd `InputNumber` 清空只改自己的显示值、**不立刻回吐
          //     `onChange(null)`**（实测：DOM 已经空了，提交上去的仍是旧值 9.5）⇒ 点保存时
          //     走的还是旧配额。组件里那个 null 分支因此是防御性的那一半。
          //   · "让非正数真的发出去"：UI 上做不到（antd 先夹住了），所以"提交 0 被后端整笔拒绝"
          //     那条判据归 Rust 单测（`update_web_info`），不归这里。
          const before = (await writes(pg)).length;
          const q = pg.locator("input.ant-input-number-input");
          await q.click();
          await q.press("Control+a");
          await q.pressSequentially("0");
          await pg.waitForTimeout(300);
          await pg.locator(".r2_storage button.ant-btn-primary").click();
          await pg.waitForTimeout(500);
          const all = await writes(pg);
          const fresh = all.slice(before);
          expect(
            all.every(
              (x) =>
                !!x.body &&
                typeof x.body === "object" &&
                typeof x.body.r2ImageQuotaGB === "number" &&
                x.body.r2ImageQuotaGB > 0,
            ),
            `填 0 之后点保存：本页走过的所有请求体里，配额**没有一个非正数** → ${JSON.stringify(all.map((x) => x.body?.r2ImageQuotaGB))}`,
          ).toBe(true);
          expect(
            fresh.length === 1 &&
              fresh[0]!.url === "/api/protected/websetting",
            `  这一次确实又提交了一笔（不是「点了没反应」被当成通过） → ${JSON.stringify(fresh.map((x) => x.body?.r2ImageQuotaGB))}`,
          ).toBe(true);
          const afterForm = await form(pg);
          expect(
            !!afterForm &&
              !!afterForm.usageLine &&
              afterForm.usageLine.includes("4.75 GB"),
            `  且条子/表单**没有**跟着变（拒的是这一次提交，不是把页面搞乱） → ${afterForm?.usageLine}`,
          ).toBe(true);
          await s.ctx.close();
        }
      },
    );
  });
});
