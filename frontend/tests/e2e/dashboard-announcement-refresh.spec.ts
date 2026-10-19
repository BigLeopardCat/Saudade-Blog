import { test, expect } from "@playwright/test";
import { withSandbox, collectPageErrors, esbuildInSandbox } from "./sandbox";

/**
 * 后台公告管理页"列表不刷新"的无头验收（20260925）：真组件 + 假后端 + 真事件
 * （原 tests/dashboard-announcement-refresh.test.py，20261019 迁移）。
 *
 * 为什么值得单起一个脚本：
 *   · 判据全是**事件与时序**（`visibilitychange` / `focus` 到没到、去抖有没有生效、
 *     页面藏起来时该不该拉）——读代码只能看出"注册了监听"，看不出"到底拉了几次"；
 *   · 两条路径**必须能分开验**：路由切进本页会重新挂载（`<Outlet/>` 的语义），这条路本来
 *     就是通的；漏掉的是"本页一直开着、agent 在别处发了公告"。所以第一段先证明"重新挂载
 *     会重拉"，第二段才验本轮新加的那条。
 *
 * 沿用 user-center.test.py / dashboard-sidebar.test.py 那套既定手段（本机不能 vite build）：
 * esbuild 把**真组件**打成一个 bundle、只桩边界（axios），antd 与 react-dom 用真的。
 */

const DEFINE_ENV =
  '{"VITE_HTTP_BASEURL":"","VITE_CDN_BASEURL":"","MODE":"production","DEV":false,"PROD":true,"BASE_URL":"/"}';

// 边界：假后端。两件事——把每次请求记进 `window.__calls`，返回 `window.__rows` 里那一版
// 数据（测试中途换掉它，模拟"agent 在别处发了一条新公告"）。
const FAKE_AXIOS = `const http: any = (cfg: any) => {
  const w = window as any;
  w.__calls.push({ url: cfg.url, method: (cfg.method || 'GET').toUpperCase() });
  return Promise.resolve({ status: 200, data: { code: 200, data: w.__rows || [] } });
};
export default http;
`;

// 装卸分开给：`__clear` 让组件真的卸载（effect 清理跑一遍），`__mountChild` 再挂一次。
// **不另建 root** —— 对同一个容器调两次 `createRoot` 会吃 React 的告警，而且那样验的是
// "新 root 会不会跑 effect"，不是路由切回来这件事。
const ENTRY = `import * as React from 'react';
import { createRoot } from 'react-dom/client';
import AnnouncementPage from './src/pages/Dashboard/Announcement/index.tsx';
const root = createRoot(document.getElementById('root')!);
(window as any).__mount = () => root.render(<AnnouncementPage />);
(window as any).__clear = () => root.render(null);
`;

const INDEX_HTML =
  '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"></head>' +
  '<body><div id="root"></div><script src="bundle.js"></script>' +
  "<script>window.__mount();</script></body></html>";

interface AnnRow {
  id: number;
  title: string;
  content: string;
  createdAt: string;
}
const ROWS_1: AnnRow[] = [
  { id: 1, title: "旧公告：服务器维护", content: "第一版", createdAt: "2026-09-25 10:00" },
];
const ROWS_2: AnnRow[] = [
  ...ROWS_1,
  { id: 2, title: "新公告：agent 代发的那条", content: "第二版", createdAt: "2026-09-25 11:00" },
];

test.describe("后台公告列表刷新", () => {
  test.setTimeout(180_000);

  test("重挂载/焦点/可见性各自触发重拉，去抖与「藏起来不拉」都在", async ({ page }) => {
    await withSandbox({ "index.html": INDEX_HTML }, async (sb) => {
      await esbuildInSandbox(sb, {
        entry: "entry.tsx",
        files: { "entry.tsx": ENTRY, "src/apis/axios.tsx": FAKE_AXIOS },
        copySrc: true,
        define: { "import.meta.env": DEFINE_ENV },
        loaders: { ".css": "text" },
      });

      const errs = collectPageErrors(page);
      // `document.hidden` 在无头里恒 false，用可切换的 getter 换掉，才验得了"藏起来时不拉"。
      await page.addInitScript({
        content:
          "window.__calls = []; window.__rows = []; window.__hidden = false;" +
          "Object.defineProperty(document, 'hidden'," +
          "  { get: () => window.__hidden, configurable: true });",
      });
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.goto(sb.url);
      await page.waitForSelector(".ant-table", { timeout: 10_000 });
      await page.waitForTimeout(300);

      const getCount = (): Promise<number> =>
        page.evaluate(() =>
          ((window as unknown as { __calls?: Array<{ url: string; method: string }> }).__calls || [])
            .filter((c) => c.method === "GET" && c.url === "/api/public/announcements")
            .length,
        );
      const setRows = (rows: AnnRow[]) =>
        page.evaluate(
          (rs: AnnRow[]) => {
            (window as unknown as { __rows: AnnRow[] }).__rows = rs;
          },
          rows,
        );

      // ──【一】重新挂载 ⇒ 重拉一次（路由 `<Outlet/>` 切进本页的语义） ──
      const base = await getCount();
      expect(base === 1, `首次挂载拉了一次 → ${base}`).toBe(true);
      await setRows(ROWS_1);
      // ⚠️ 卸载与挂载**必须分两次 evaluate**：同一次里连着 render(null) + render(<C/>)，React 18
      // 会把它批量成一次更新，组件其实从没卸载过（本脚本首跑就踩了这个假象）。
      await page.evaluate(() =>
        (window as unknown as { __clear: () => void }).__clear(),
      );
      await page.waitForTimeout(250);
      const tableGone = await page.locator(".ant-table").count();
      expect(
        tableGone === 0,
        `组件真的卸载了（表格没了） → ${tableGone}`,
      ).toBe(true);
      await page.evaluate(() =>
        (window as unknown as { __mount: () => void }).__mount(),
      );
      await page.waitForSelector(".ant-table", { timeout: 10_000 });
      await page.waitForTimeout(500);
      const n1 = await getCount();
      expect(
        n1 === base + 1,
        `卸载再挂载 ⇒ 又拉一次（路由切进本页会看到最新的，走的就是这条） → ${n1}`,
      ).toBe(true);
      const shown1 = await page
        .locator(".ant-table", { hasText: "旧公告：服务器维护" })
        .count();
      expect(shown1 === 1, `第一版公告渲染出来了 → ${shown1}`).toBe(true);

      // ──【二】窗口重新获得焦点 / 标签页重新可见 ⇒ 重拉（agent 在别处发的公告能看到了） ──
      await setRows(ROWS_2); // agent 在别处发了一条
      await page.waitForTimeout(600); // 越过 500ms 去抖窗
      const stillN1 = await getCount();
      expect(
        stillN1 === n1,
        `还没切回来之前，列表纹丝不动（只在要看的时刻才拉） → ${stillN1}`,
      ).toBe(true);
      const absent = await page
        .locator(".ant-table", { hasText: "新公告：agent 代发的那条" })
        .count();
      expect(absent === 0, `新公告那时还不在表里 → ${absent}`).toBe(true);

      await page.evaluate(() => window.dispatchEvent(new Event("focus")));
      await page.waitForTimeout(600);
      const afterFocus = await getCount();
      expect(
        afterFocus === n1 + 1,
        `窗口获得焦点 ⇒ 拉了一次 → ${afterFocus}`,
      ).toBe(true);
      const shown2 = await page
        .locator(".ant-table", { hasText: "新公告：agent 代发的那条" })
        .count();
      expect(shown2 === 1, `新公告当场出现在表里 → ${shown2}`).toBe(true);

      // ──【三】去抖 + 藏起来时不拉 ──
      await page.evaluate(() => {
        document.dispatchEvent(new Event("visibilitychange"));
        window.dispatchEvent(new Event("focus"));
      });
      await page.waitForTimeout(300);
      const debounced = await getCount();
      expect(
        debounced === n1 + 2,
        `切回来时两个信号一起到（visibilitychange + focus）⇒ 去抖成 1 次 → ${debounced}`,
      ).toBe(true);

      await page.waitForTimeout(600);
      await page.evaluate(() => {
        (window as unknown as { __hidden: boolean }).__hidden = true;
        document.dispatchEvent(new Event("visibilitychange"));
      });
      await page.waitForTimeout(300);
      const hiddenCount = await getCount();
      expect(
        hiddenCount === n1 + 2,
        `页面藏起来时不做无用功 → ${hiddenCount}`,
      ).toBe(true);
      await page.evaluate(() => {
        (window as unknown as { __hidden: boolean }).__hidden = false;
        document.dispatchEvent(new Event("visibilitychange"));
      });
      await page.waitForTimeout(400);
      const visibleCount = await getCount();
      expect(
        visibleCount === n1 + 3,
        `重新可见 ⇒ 又拉一次 → ${visibleCount}`,
      ).toBe(true);

      // ──【四】页内「删除选中」的老行为没被改坏 ──
      await page.waitForTimeout(600);
      const before = await getCount();
      await page.click("text=删除选中"); // 一行都没选 ⇒ message.warning 提前返回、不发请求
      await page.waitForTimeout(400);
      const afterDelete = await getCount();
      expect(
        afterDelete === before,
        `没选行就点删除：不发请求（原行为） → ${afterDelete}`,
      ).toBe(true);

      expect(errs(), "全程没有页面错误").toEqual([]);
    });
  });
});
