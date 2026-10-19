import { test, expect, type Browser, type Page } from "@playwright/test";
import { withSandbox, collectPageErrors, esbuildInSandbox } from "./sandbox";

/**
 * SPA 侧错误上报的**真链路**沙箱（20261004）：真浏览器、真
 * `src/utils/report.ts`、真事件（不桩 fetch、不桩监听器），网络那一层被 Playwright 拦住
 * （原 tests/monitor-client.test.py，20261019 迁移）。
 *
 * 为什么必须有一条这样的：`tests/monitor-report.test.mjs` 验的是纯函数与源码接线，
 * **它证明不了"事件真的会走到上报"**——而这恰好是这次要修的东西。用户原话是
 * "前端日志覆盖不够吧，甚至是无效状态"，而"无效"的成因之一就是：以前那套全局捕获
 * （boot.js）包的是 `fetch`、`error` 监听又没带 capture，于是**资源加载失败从来没进过日志**。
 * "没进过"这件事，只有让浏览器真的加载一张 404 的图才能验。
 *
 * 六条判据：
 *   ① ★ 资源加载失败 ⇒ 真的发出一条 `resource_error`（含 url 与 webgl 标记）——这次修的主洞；
 *   ② ★ **运行时 JS 异常不许被这里再报一遍**（负空间：那归 boot.js 的 `js_error` 管，
 *      重复上报会把 `dup` 的语义糊掉）；
 *   ③ 同一处失败重复触发 ⇒ **只发一条**（页内去重，别把一个坏图刷成一百行）；
 *   ④ 上报端点自己挂掉 ⇒ 不报（否则 401/500 时是自激循环）；
 *   ⑤ 非资源标签（比如 div 上的 error）不误报；
 *   ⑥ 请求体形状：`type/message/stack/url/webgl` 四个字段，且 body 里没有换行。
 *
 * ⚠️ 低内存机器上串行跑（这条与其它沙箱同款要求：无头 Chrome 一次只起一个）。
 */

const DEFINE_ENV =
  '{"VITE_HTTP_BASEURL":"","VITE_CDN_BASEURL":"","MODE":"production","DEV":false,"PROD":true,"BASE_URL":"/"}';

// 唯一的桩：runtimeApi（`import.meta.env` 那层）——runtimeBaseURL/cdnBaseURL 置空，
// 让上报端点确定地落在同源相对路径 `/api/monitor/log`（与 axios-auth.spec.ts 同款）。
const STUB_RUNTIME_API = `export const runtimeBaseURL = '';
export const cdnBaseURL = '';
export const resolveApiAssetUrl = (url?: string) => (url || '');
`;

// 入口：import 那个副作用模块（之后页面里所有失败都由真事件触发），再把
// **真的 ErrorBoundary** 挂在另一个容器上——渲染期抛错只有 React 能接住，
// 而"接住了并上报了"这件事，源码断言（.mjs 那条）证明不了：它只证明"文件里写了"。
const ENTRY = `import './src/utils/report';
import React from 'react';
import { createRoot } from 'react-dom/client';
import ErrorBoundary from './src/components/ErrorBoundary';

(window as any).__ready = true;
(window as any).__crash = () => {
  const Boom = () => { throw new Error('sandbox-react-boom'); };
  createRoot(document.getElementById('crash')!).render(
    React.createElement(ErrorBoundary, { scope: 'page' }, React.createElement(Boom))
  );
};
`;

const INDEX_HTML =
  '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"></head>' +
  '<body><div id="root"></div><div id="crash"></div>' +
  '<script src="bundle.js"></script></body></html>';

interface Report {
  path: string;
  headers: Record<string, string>;
  body: Record<string, unknown> | null;
}

test.describe("SPA 错误上报真链路", () => {
  test.setTimeout(180_000);

  test("资源失败被捕获、运行时异常不重复、去重与自激闸都在", async ({ browser }) => {
    const REPORTS: Report[] = [];

    await withSandbox({ "index.html": INDEX_HTML }, async (sb) => {
      await esbuildInSandbox(sb, {
        entry: "entry.ts",
        files: {
          "entry.ts": ENTRY,
          "src/utils/runtimeApi.ts": STUB_RUNTIME_API,
        },
        copySrc: true,
        define: { "import.meta.env": DEFINE_ENV },
        loaders: { ".sass": "text" },
      });

      // 拦住上报请求，把请求体记下来（**不转发**给真后端：这条套件不依赖服务在跑）。
      const openPage = async (br: Browser) => {
        const ctx = await br.newContext();
        const pg = await ctx.newPage();
        const errs = collectPageErrors(pg);
        await pg.route("**/api/monitor/log", (route) => {
          let body: Record<string, unknown> | null = null;
          try {
            body = JSON.parse(route.request().postData() || "null");
          } catch {
            body = null;
          }
          REPORTS.push({
            path: new URL(route.request().url()).pathname,
            headers: route.request().headers(),
            body,
          });
          void route.fulfill({
            status: 200,
            contentType: "application/json",
            body: '{"ok":true}',
          });
        });
        await pg.goto(sb.url);
        await pg.waitForFunction(
          () =>
            (window as unknown as { __ready?: boolean }).__ready === true,
          undefined,
          { timeout: 10_000 },
        );
        return { ctx, pg, errs };
      };

      /** 只数**真正的上报**（带着 JSON 体的 POST）。
       *
       * ④ 那条会拿上报端点当图片地址用，于是同一个路由也会收到一次 **GET**（浏览器的图片
       * 请求，`body=None`）——把它算进"上报条数"的话，判据就成了"图片请求本身"，不是"有没有
       * 上报"。区分靠 body 在不在：上报必带 JSON 体。 */
      const posted = () => REPORTS.filter((r) => r.body !== null);

      /** 插一张真会 404 的图——`error` 在元素上派发、不冒泡，只有捕获阶段能收到。 */
      const fireResourceError = async (pg: Page, src: string) => {
        await pg.evaluate((s: string) => {
          const i = document.createElement("img");
          i.src = s;
          document.body.appendChild(i);
        }, src);
        await pg.waitForTimeout(400);
      };

      // ── 【一】资源加载失败 ⇒ 一条 resource_error（这次修的主洞） ──
      const first = await openPage(browser);
      await fireResourceError(first.pg, "/definitely-missing.png?v=1");
      expect(
        REPORTS.length === 1,
        `真的发出了上报（boot.js 那套在这里一个字都不会发） → ${JSON.stringify(REPORTS)}`,
      ).toBe(true);
      {
        const r = REPORTS[0];
        const body = (r?.body ?? {}) as Record<string, unknown>;
        expect(
          r?.path === "/api/monitor/log",
          `打的是上报端点 → ${r?.path}`,
        ).toBe(true);
        expect(
          body.type === "resource_error",
          `type = resource_error → ${JSON.stringify(body)}`,
        ).toBe(true);
        expect(
          String(body.url ?? "").endsWith("/definitely-missing.png?v=1"),
          `url 带上了那个失败的资源 → ${body.url}`,
        ).toBe(true);
        expect(
          String(body.message ?? "").includes("img"),
          `message 里说得出是哪种标签挂了（img 还是 script） → ${body.message}`,
        ).toBe(true);
        expect(
          ["yes", "no", "unknown"].includes(String(body.webgl)),
          `webgl 标记随载荷出去了（yes/no/unknown 三态之一） → ${body.webgl}`,
        ).toBe(true);
        expect(
          Object.values(body).every((v) => !String(v).includes("\n")),
          `body 里没有裸换行（一行一记录是对账侧的前提） → ${JSON.stringify(body)}`,
        ).toBe(true);
        expect(
          (r?.headers["content-type"] ?? "").includes("application/json"),
          `Content-Type 是 JSON → ${r?.headers["content-type"]}`,
        ).toBe(true);
      }

      // ── 【二】运行时 JS 异常**不**由这里上报（负空间：那归 boot.js 的 js_error） ──
      const before = REPORTS.length;
      await first.pg.evaluate(() => {
        setTimeout(() => {
          throw new Error("sandbox-runtime-boom");
        }, 0);
      });
      await first.pg.waitForTimeout(400);
      expect(
        REPORTS.length === before,
        `抛了一个真异常，但上报条数没变（target 是 window ⇒ 不是资源失败） → ${before} → ${REPORTS.length}`,
      ).toBe(true);
      expect(
        first.errs().some((e) => e.includes("sandbox-runtime-boom")),
        `异常确实发生了（否则上一条是假绿） → ${first.errs().slice(0, 2).join("; ")}`,
      ).toBe(true);
      await first.ctx.close();

      // ── 【三】同一处失败重复触发 ⇒ 只发一条 ──
      REPORTS.length = 0; // ★ 每条用例自己清账：不清的话数到的是上一节的遗留
      {
        const s = await openPage(browser);
        for (let i = 0; i < 3; i++) {
          await fireResourceError(s.pg, "/missing-dedupe.png");
        }
        expect(
          posted().length === 1,
          `同一个坏资源触发 3 次，只上报 1 条（页内去重） → ${JSON.stringify(posted().map((x) => x.body))}`,
        ).toBe(true);
        await s.ctx.close();
      }

      // ── 【四】上报端点自己挂掉 ⇒ 不报（自激循环的闸） ──
      REPORTS.length = 0;
      {
        const s = await openPage(browser);
        await fireResourceError(s.pg, "/api/monitor/log"); // 拿上报端点当图片地址：它当然不是图
        expect(
          posted().length === 0,
          `失败的是上报端点自己 ⇒ 一条上报都没有 → ${JSON.stringify(posted().map((x) => x.body))}`,
        ).toBe(true);
        expect(
          REPORTS.every((r) => r.body === null),
          `（那条 GET 是浏览器取图片本身，不是上报——它没有 JSON 体） → ${REPORTS.length}`,
        ).toBe(true);
        await s.ctx.close();
      }

      // ── 【五】非资源标签上的 error 不误报 ──
      REPORTS.length = 0;
      {
        const s = await openPage(browser);
        await s.pg.evaluate(() => {
          const d = document.createElement("div");
          document.body.appendChild(d);
          d.addEventListener("error", () => {}); // 让它有个监听器，更有"像是会响"的错觉
          d.dispatchEvent(new Event("error", { bubbles: false }));
        });
        await s.pg.waitForTimeout(300);
        expect(
          posted().length === 0,
          `div 上派发的 error ⇒ 不报（target 没有 tagName） → ${JSON.stringify(posted().map((x) => x.body))}`,
        ).toBe(true);
        expect(
          s.errs().length === 0,
          `五节无页面异常 → ${s.errs().slice(0, 2).join("; ")}`,
        ).toBe(true);
        await s.ctx.close();
      }

      // ── 【六】React 渲染期抛错：兜底卡挂上、同时上报一条 react_error ──
      REPORTS.length = 0;
      {
        const s = await openPage(browser);
        await s.pg.evaluate(() =>
          (window as unknown as { __crash: () => void }).__crash(),
        );
        await s.pg.waitForTimeout(800);
        const rs = posted();
        const body = (rs[0]?.body ?? {}) as Record<string, unknown>;
        expect(
          rs.length === 1 && body.type === "react_error",
          `上报了一条 react_error → ${JSON.stringify(rs.map((x) => x.body))}`,
        ).toBe(true);
        expect(
          String(body.message ?? "").startsWith("page: "),
          `message 带上了 scope（知道崩在哪一层） → ${body.message}`,
        ).toBe(true);
        expect(
          String(body.message ?? "").includes("sandbox-react-boom"),
          `message 带上了原始异常文本（否则只知道「崩了」） → ${body.message}`,
        ).toBe(true);
        expect(
          String(body.stack ?? "").includes("componentStack"),
          `stack 里带 componentStack（指出是哪个组件抛的） → ${body.stack}`,
        ).toBe(true);
        expect(
          String(body.url ?? "").endsWith("/index.html"),
          `url 是当前页 → ${body.url}`,
        ).toBe(true);
        // 兜底 UI：**用户看见的**那半边（判据不能只落在日志上）
        const card = await s.pg.evaluate(() =>
          !!document.querySelector(".errorBoundary__card"),
        );
        expect(
          card === true,
          `兜底卡真的渲染出来了（不是白屏） → ${card}`,
        ).toBe(true);
        const t = await s.pg.evaluate(
          () =>
            (document.querySelector(".errorBoundary__title") as HTMLElement | null)
              ?.textContent ?? "",
        );
        expect(
          t.includes("页面出了点小问题"),
          `卡上有给用户看的标题 → ${t}`,
        ).toBe(true);
        const msg = await s.pg.evaluate(
          () =>
            (document.querySelector(".errorBoundary__msg") as HTMLElement | null)
              ?.textContent ?? "",
        );
        expect(
          msg.includes("sandbox-react-boom"),
          `卡上写得出原始错误（用户截图就能报上来） → ${msg}`,
        ).toBe(true);
        const btns = await s.pg.evaluate(
          () => document.querySelectorAll(".errorBoundary__btn").length,
        );
        expect(
          btns === 2,
          `两个出口按钮都在（重试 / 回到首页） → ${btns}`,
        ).toBe(true);
        await s.ctx.close();
      }
    });
  });
});
