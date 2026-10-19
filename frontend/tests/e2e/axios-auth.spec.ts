import { test, expect, type Page } from "@playwright/test";
import { withSandbox, collectPageErrors, esbuildInSandbox } from "./sandbox";

/**
 * 共享 axios 客户端的**令牌失效通道**（`src/apis/axios.tsx`）：本仓 `frontend/tests/`
 * 里的**第一条 401/403 断言**（20260926）（原 tests/axios-auth.test.py，20261019 迁移）。
 *
 * **为什么要有它。** `src/apis/axios.tsx` 的响应拦截器里有这样一段：401 ⇒ 清 `tokenKey`
 * + 弹「登录状态已过期，请重新登录」+ 1 秒后跳 `/login`；403 ⇒ **什么都不做**（注释里
 * 写着理由：令牌本身有效、只是角色不够，清令牌会让人陷入"登录→被踢→重新登录"的循环）。
 * 这段代码此前**一行覆盖都没有**——测试里所有走 axios 的沙箱都把
 * `src/apis/axios.tsx` 整个换成桩（`FAKE_AXIOS`），于是"桩里的 http"永远 200，
 * 真客户端那两个分支只存在于"读起来对"这个层面。
 *
 * 它值得单独一条沙箱的理由是：这段代码错了**也不会红**。
 *   · 401 那条要是没接上（或者调用方绕开客户端自己 `fetch`），管理员令牌失效时看到的
 *     是一句无信息的「请求失败」，而不是登录页——用户只能自己猜；
 *   · 403 那条要是"顺手也清令牌"，普通用户一进后台就被踢回登录页，且**每次重登都被踢**
 *     （他的令牌一直是有效的，403 会一直来）；
 *   · 跳转延时的 1000ms 要是变成 0，提示语一闪而过等于没提示。
 *
 * **手段**：这一条与其它沙箱相反，**不桩 axios 模块**——用的是真
 * `src/apis/axios.tsx`、真 axios（1.x）、真 XHR，只在 Playwright 那一层拦住网络
 * （`page.route`）。所以它验的正是那两个 if 分支本身。判据全在 DOM/localStorage/URL 上，
 * 不看源码（源码扫描锁不住"到底哪个分支被执行了"）。
 *
 * 唯一的桩是 `src/utils/runtimeApi.ts`（顶层读 `import.meta.env` 与 `window.location`
 * 的那层）：`runtimeBaseURL`/`cdnBaseURL` 置空、`resolveApiAssetUrl` 直通——被测的
 * 拦截器分支与它无关，桩掉只为让 baseURL 确定地落在同源（相对路径 `/api/…`）。
 */

const DEFINE_ENV =
  '{"VITE_HTTP_BASEURL":"","VITE_CDN_BASEURL":"","MODE":"production","DEV":false,"PROD":true,"BASE_URL":"/"}';

// 入口直接调客户端，不挂 React：这条测试要验的是客户端模块本身，不是某个页面。
// 结果（成功值 / 失败状态码）落在 window 上，由断言侧读。
const ENTRY = `import http from './src/apis/axios.tsx';

(window as any).__outcome = null;
(window as any).__call = (url: string) => {
  (window as any).__outcome = null;
  http.get(url)
    .then((r: any) => { (window as any).__outcome = { ok: true, status: r.status, data: r.data }; })
    .catch((e: any) => {
      (window as any).__outcome = { ok: false, status: (e && e.response && e.response.status) || null };
    });
  return true;
};
`;

// 唯一的桩：runtimeApi（见文件头）。axios.tsx 本体原样参与打包。
const STUB_RUNTIME_API = `export const runtimeBaseURL = '';
export const cdnBaseURL = '';
export const resolveApiAssetUrl = (url?: string) => (url || '');
`;

const INDEX_HTML =
  '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"></head>' +
  '<body><div id="root"></div><script src="bundle.js"></script></body></html>';

// 被拦截的假后端：路径 → 状态码。真后端在这三种情形下都是 HTTP 状态码层面的事
// （401/403 由 `src/middleware.rs::auth_guard` 直接回，不是 body 里的 code）。
const ROUTES: Record<string, number> = {
  "/api/ok": 200,
  "/api/expired": 401,
  "/api/denied": 403,
};
// 每次拦截到的 (path, Authorization 头) —— 用来验请求拦截器那条前缀归一
const SEEN: Array<[string, string | undefined]> = [];

interface Outcome {
  ok: boolean;
  status: number | null;
  data?: { path?: string };
}

const outcome = (pg: Page): Promise<Outcome> =>
  pg.evaluate(() => (window as unknown as { __outcome: Outcome }).__outcome);
const tokenNow = (pg: Page): Promise<string | null> =>
  pg.evaluate(() => localStorage.getItem("tokenKey"));
// 当前屏上的 antd message 文案（抹空白——antd 会在两个汉字之间插空格）。
const notices = (pg: Page): Promise<string[]> =>
  pg.evaluate(() =>
    [...document.querySelectorAll(".ant-message-notice-content")].map((e) =>
      (e.textContent || "").replace(/\s+/g, ""),
    ),
  );

test.describe("共享 axios 客户端：令牌失效通道", () => {
  test.setTimeout(180_000);

  test("401 清token+提示+延时跳登录；403 刻意无为；Bearer 前缀归一", async ({
    browser,
  }) => {
    await withSandbox({ "index.html": INDEX_HTML }, async (sb) => {
      await esbuildInSandbox(sb, {
        entry: "entry.tsx",
        files: {
          "entry.tsx": ENTRY,
          "src/utils/runtimeApi.ts": STUB_RUNTIME_API,
        },
        copySrc: true,
        define: { "import.meta.env": DEFINE_ENV },
        loaders: { ".sass": "text" },
      });

      // 新上下文 + 新页面（每个用例一个干净 origin 里的 localStorage），装上路由拦截。
      const openPage = async (token?: string, url = "/api/ok") => {
        const ctx = await browser.newContext();
        const pg = await ctx.newPage();
        const errs = collectPageErrors(pg);
        await pg.route("**/api/**", (route) => {
          const path = new URL(route.request().url()).pathname;
          const auth = route.request().headers()["authorization"];
          SEEN.push([path, auth]);
          const status = ROUTES[path] ?? 404;
          const body = JSON.stringify({
            code: status === 200 ? 200 : 500,
            path,
            auth: auth ?? null,
          });
          void route.fulfill({ status, contentType: "application/json", body });
        });
        await pg.goto(sb.url);
        if (token != null) {
          await pg.evaluate(
            (t: string) => localStorage.setItem("tokenKey", t),
            token,
          );
        }
        await pg.evaluate(
          (u: string) =>
            (window as unknown as { __call: (u: string) => boolean }).__call(u),
          url,
        );
        await pg.waitForTimeout(600);
        return { ctx, pg, errs };
      };

      // ──【一】200：正常放行（下面两条 401/403 的对照，也是"桩没把它焊死"的证明） ──
      {
        const { ctx, pg, errs } = await openPage("x.y.z", "/api/ok");
        const o = await outcome(pg);
        expect(
          !!o && o.ok && o.status === 200 && o.data?.path === "/api/ok",
          `请求成功且拿到响应体（拦截器原样放行） → ${JSON.stringify(o)}`,
        ).toBe(true);
        expect(
          (await tokenNow(pg)) === "x.y.z",
          `200 不动令牌 → ${await tokenNow(pg)}`,
        ).toBe(true);
        const ns = await notices(pg);
        expect(
          ns.length === 0,
          `200 不弹过期提示（提示只在 401 那条分支里） → ${JSON.stringify(ns)}`,
        ).toBe(true);
        expect(errs(), "一节无页面异常").toEqual([]);
        await ctx.close();
      }

      // ──【二】401：清本地令牌、弹提示、延时跳 /login ──
      {
        const { ctx, pg, errs } = await openPage("x.y.z", "/api/expired");
        const o = await outcome(pg);
        expect(
          !!o && !o.ok && o.status === 401,
          `调用方拿到的是**失败**（拦截器仍 reject，没有把 401 吞成成功） → ${JSON.stringify(o)}`,
        ).toBe(true);
        expect(
          (await tokenNow(pg)) === null,
          `401 立刻清掉 localStorage 的 tokenKey → ${await tokenNow(pg)}`,
        ).toBe(true);
        const ns = await notices(pg);
        expect(
          ns.some((x) => x.includes("登录状态已过期")),
          `弹出「登录状态已过期，请重新登录」 → ${JSON.stringify(ns)}`,
        ).toBe(true);
        // 跳转是**延时**的：提示语得先被看见。这条同时锁住"别把 1000 改成 0"。
        expect(
          !pg.url().endsWith("/login"),
          `此刻**还没**跳走（提示要留得住，不是一闪而过） → ${pg.url()}`,
        ).toBe(true);
        let jumped = true;
        try {
          await pg.waitForURL("**/login", { timeout: 5_000 });
        } catch {
          jumped = false;
        }
        expect(
          jumped,
          `约 1 秒后跳到 /login（用户被送到能重新登录的地方） → ${pg.url()}`,
        ).toBe(true);
        expect(errs(), "二节无页面异常").toEqual([]);
        await ctx.close();
      }

      // ──【三】403：**刻意什么都不做**（这段不对称是注释里写明的设计，得有人守着） ──
      {
        const { ctx, pg, errs } = await openPage("x.y.z", "/api/denied");
        const o = await outcome(pg);
        expect(
          !!o && !o.ok && o.status === 403,
          `调用方同样拿到失败（403 仍 reject 给调用方，只是没有全局副作用） → ${JSON.stringify(o)}`,
        ).toBe(true);
        expect(
          (await tokenNow(pg)) === "x.y.z",
          `403 **不**清令牌（令牌本身是有效的，清的代价是让人反复重登） → ${await tokenNow(pg)}`,
        ).toBe(true);
        const ns = await notices(pg);
        expect(
          !ns.some((x) => x.includes("登录状态已过期")),
          `403 不弹「登录状态已过期」（角色不够不是登录过期） → ${JSON.stringify(ns)}`,
        ).toBe(true);
        await pg.waitForTimeout(1500);
        expect(
          !pg.url().endsWith("/login"),
          `403 之后 1.5 秒仍停在本页（没有偷偷跳登录） → ${pg.url()}`,
        ).toBe(true);
        expect(errs(), "三节无页面异常").toEqual([]);
        await ctx.close();
      }

      // ──【四】请求拦截器：Bearer 前缀归一（后端 strip_prefix("Bearer ")，裸 token 会鉴权失败） ──
      SEEN.length = 0;
      {
        const { ctx } = await openPage("bare-token", "/api/ok");
        expect(
          SEEN.some(([, a]) => a === "Bearer bare-token"),
          `裸 token 被补成 \`Bearer bare-token\`（不补的话后端 strip 不掉、鉴权失败） → ${JSON.stringify(SEEN)}`,
        ).toBe(true);
        await ctx.close();
      }
      SEEN.length = 0;
      {
        const { ctx } = await openPage("Bearer already", "/api/ok");
        expect(
          SEEN.some(([, a]) => a === "Bearer already"),
          `已经是 \`Bearer …\` 的不重复叠加（不会出现 \`Bearer Bearer …\`） → ${JSON.stringify(SEEN)}`,
        ).toBe(true);
        await ctx.close();
      }
      SEEN.length = 0;
      {
        const { ctx, errs } = await openPage(undefined, "/api/ok");
        expect(
          SEEN.every(([, a]) => a === undefined),
          `没有令牌时不带 Authorization 头（后台会被 401 挡，但不该发一个 \`Bearer null\`） → ${JSON.stringify(SEEN)}`,
        ).toBe(true);
        expect(errs(), "四节无页面异常").toEqual([]);
        await ctx.close();
      }
    });
  });
});
