import { defineConfig } from "@playwright/test";

/**
 * 渲染层沙箱套件（由原 frontend/tests/*.test.py 迁移而来，20261019）。
 *
 * 这批测试的共同形态：把真 sass / 真 TSX 在沙箱里编译，写一个最小 index.html，
 * 起本地静态服务，再用无头 Chromium 量「计算值与像素」——判据不在源码里，
 * 在渲染结果里。每个 spec 自带沙箱（见 tests/e2e/sandbox.ts 的 serveSandbox），
 * 所以这里不用全局 webServer；@playwright/test 负责并发、重试、报告与超时。
 *
 * 用法：
 *   npx playwright test                 # 全部
 *   npx playwright test article-grid    # 单支
 *   npx playwright test --workers=1     # 低配机器串行
 *
 * CI（deploy.yml 的 e2e job）与本机跑同一条命令。
 */
export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 120_000,
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
  use: {
    browserName: "chromium",
    headless: true,
    // 沙箱页面大多不挂 React 全家桶，页面自身不产生网络请求；
    // 打桩的 fetch/XHR 由各 spec 自己用 page.route 拦。
    actionTimeout: 10_000,
    navigationTimeout: 15_000,
  },
  outputDir: "./tests/e2e/.artifacts",
});
