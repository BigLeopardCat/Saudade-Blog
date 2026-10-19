import { test, expect } from "@playwright/test";
import { withSandbox, collectPageErrors, esbuildInSandbox } from "./sandbox";

/**
 * 对话框色块装饰器 `decorateColorSwatches` 回归（真 DOM 跑，20260921）
 * （原 tests/color-swatch.test.py，20261019 迁移）。
 *
 * 为什么用无头浏览器而不是 node 桩：这个装饰器**整个逻辑都在 DOM 上**
 * （TreeWalker 遍历文本节点、`closest('pre, code, a, …')` 判父级、把文本节点换成
 * `<span>` 片段）。手搓 DOM 桩只会测到桩本身，测不出 `closest` 匹配与树遍历的真实行为
 * （无头验证法的既有坑之一，见 docs）。esbuild 把 `src/utils/chatMarkdown.ts` 真源码
 * 打成一个 IIFE bundle，页面里直接调，无桩。
 *
 * 锁两件事：
 *   ① **放宽后的口径**（20260921 用户拍板）：任意 6 位色值都画色块——此前只认站内 8 色板，
 *      结果是 agent 答"配色建议"这类站外色值时一个色块都不渲染（用户实测反馈）；
 *   ② **不许越界**：`pre`/`code`/`a` 内部不画、8 位色值（带 alpha）不许被截半画、
 *      5 位/3 位非完整 6 位色值不画、重复调用不许叠加（幂等）。
 */

const ENTRY = `import { decorateColorSwatches, renderBlogMarkdown, chatColorPalette } from './src/utils/chatMarkdown';
(window as any).__decorate = decorateColorSwatches;
(window as any).__render = renderBlogMarkdown;
(window as any).__palette = chatColorPalette;
`;

const INDEX_HTML =
  '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"></head>' +
  '<body><div id="root"></div><script src="bundle.js"></script></body></html>';

// 页面里造一坨 DOM 再调装饰器，读回"哪些色值画了色块"
const PROBE = (html: string) => {
  const root = document.getElementById("root")!;
  root.innerHTML = html;
  const w = window as unknown as {
    __decorate: (root: HTMLElement) => void;
  };
  w.__decorate(root);
  w.__decorate(root); // 第二次：幂等性一起验
  return {
    chips: Array.from(root.querySelectorAll<HTMLElement>(".chat-swatch")).map(
      (c) => (c.getAttribute("aria-label") || "") + "|" + c.style.background,
    ),
    text: root.textContent || "",
  };
};
interface ProbeResult {
  chips: string[];
  text: string;
}

test.describe("对话框色块装饰器", () => {
  test.setTimeout(180_000);

  test("任意 6 位色值画块、站外站内都认、不越界、幂等", async ({ page }) => {
    await withSandbox({ "index.html": INDEX_HTML }, async (sb) => {
      await esbuildInSandbox(sb, {
        entry: "entry.ts",
        files: { "entry.ts": ENTRY },
        copySrc: true,
      });
      const errs = collectPageErrors(page);
      await page.goto(sb.url);
      await page.waitForTimeout(200);

      // ── ① 站外色值也画（放宽口径） ──
      const r1 = (await page.evaluate(
        PROBE,
        "<p>推荐 #f5e6d3 打底，配 #2b2b2b 的字</p>",
      )) as ProbeResult;
      expect(
        r1.chips.length === 2,
        `自造 hex 也有色块 → ${JSON.stringify(r1.chips)}`,
      ).toBe(true);
      expect(
        r1.chips.every((c) => {
          const bg = c.split("|")[1] ?? "";
          return bg === "rgb(245, 230, 211)" || bg === "rgb(43, 43, 43)";
        }),
        `色块底色 = 正文里的色值 → ${JSON.stringify(r1.chips)}`,
      ).toBe(true);
      expect(
        r1.text.includes("#f5e6d3") && r1.text.includes("#2b2b2b"),
        `编码文本原样保留（色块 + 编码并列） → ${r1.text}`,
      ).toBe(true);

      // ── ② 站内 8 色板仍全认 ──
      const pal = (await page.evaluate(
        () => (window as unknown as { __palette: string[] }).__palette,
      )) as string[];
      expect(pal.length === 8, `色板 8 色 → ${JSON.stringify(pal)}`).toBe(true);
      const r2 = (await page.evaluate(
        PROBE,
        `<p>${pal.join(" ")}</p>`,
      )) as ProbeResult;
      expect(
        r2.chips.length === 8,
        `8 色全部画出（大小写不敏感） → ${JSON.stringify(r2.chips)}`,
      ).toBe(true);
      const r3 = (await page.evaluate(
        PROBE,
        `<p>${pal.map((c) => c.toUpperCase()).join(" ")}</p>`,
      )) as ProbeResult;
      expect(
        r3.chips.length === 8,
        `大写写法同样画出 → ${JSON.stringify(r3.chips)}`,
      ).toBe(true);

      // ── ③ 不许越界 ──
      const r4 = (await page.evaluate(
        PROBE,
        "<pre><code>#1677ff</code></pre><p>#52c41a</p>",
      )) as ProbeResult;
      expect(
        r4.chips.length === 1 && r4.chips[0].startsWith("#52c41a"),
        `代码块内不画（代码块外的照画） → ${JSON.stringify(r4.chips)}`,
      ).toBe(true);
      const r5 = (await page.evaluate(
        PROBE,
        '<p><a href="#">#eb2f96</a></p>',
      )) as ProbeResult;
      expect(
        r5.chips.length === 0,
        `链接文本里不画 → ${JSON.stringify(r5.chips)}`,
      ).toBe(true);
      const r6 = (await page.evaluate(PROBE, "<p>#1677ff00</p>")) as ProbeResult;
      expect(
        r6.chips.length === 0,
        `8 位色值（带 alpha）不截半画 → ${JSON.stringify(r6.chips)}`,
      ).toBe(true);
      const r7 = (await page.evaluate(
        PROBE,
        "<p>#abc #12345 #xyzxyz</p>",
      )) as ProbeResult;
      expect(
        r7.chips.length === 0,
        `3 位 / 5 位 / 非十六进制都不画 → ${JSON.stringify(r7.chips)}`,
      ).toBe(true);
      const r8 = (await page.evaluate(
        PROBE,
        "<p>#1234567890</p>",
      )) as ProbeResult;
      expect(
        r8.chips.length === 0,
        `超长数字串不画（词边界挡住） → ${JSON.stringify(r8.chips)}`,
      ).toBe(true);

      // ── ④ 幂等与真实渲染路径 ──
      const r9 = (await page.evaluate(PROBE, "<p>#eb2f96</p>")) as ProbeResult;
      expect(
        r9.chips.length === 1,
        `连调两次不叠色块 → ${JSON.stringify(r9.chips)}`,
      ).toBe(true);
      const n = (await page.evaluate((md: string) => {
        const root = document.getElementById("root")!;
        root.innerHTML = (window as unknown as { __render: (t: string) => string })
          .__render(md);
        const w = window as unknown as {
          __chatDecorateColors?: (root: HTMLElement) => void;
        };
        if (w.__chatDecorateColors) w.__chatDecorateColors(root);
        return root.querySelectorAll(".chat-swatch").length;
      }, "试试 #eb2f96 和 #f5e6d3")) as number;
      expect(
        n === 2,
        `走真 markdown 渲染的是网页里那个全局（__chatDecorateColors） → ${n}`,
      ).toBe(true);
      expect(errs(), "无 JS 运行时报错").toEqual([]);
    });
  });
});
