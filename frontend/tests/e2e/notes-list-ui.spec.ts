import { test, expect, type Browser, type Page } from "@playwright/test";
import path from "node:path";
import {
  FE_DIR,
  compileSass,
  serveSandbox,
  esbuildInSandbox,
  collectPageErrors,
  type Sandbox,
} from "./sandbox";

/**
 * 后台「全部文章」列表页改版的无头验收：真组件 + 真 antd + 假后端。
 * （原 tests/notes-list-ui.test.py，20261019 迁移）
 *
 * 20260924 追加【五】：列表区铺满卡片、分页条移出滚动区钉在底部、`scroll.y` 撤掉后
 * 表头改靠 `position: sticky` 吸顶、每页条数可调（写进 URL）。四条都只有真跑一遍才
 * 看得见（几何、层级、以及"改每页条数会不会又去拉一次数据"），且它们**互相牵连**
 * ——少写 `tableLayout="fixed"` 列宽就失效、分页条留在滚动区里就会被滚走。
 *
 * 20260923 那轮的四处改动**也都只有真跑一遍才看得见**——
 *   · 「筛选栏收成一行」是布局结果：`layout="inline"` 下四个控件的 rect.top 是不是同一个值，
 *     读代码看不出来（`Col span={8}` 换掉之后，谁也不敢保证 antd 的 inline 一定不折行）；
 *   · 「新增文章按钮挪到标签按钮前」是个**顺序**判据：得拿两者的 getBoundingClientRect 比左右；
 *   · 「切页不再重新请求」是本轮唯一的**行为**变化，而且判据只有一个——桩里记的请求条数。
 *     光看"界面上页码变了"完全区分不出"前端切片"和"又拉了一遍整表"；
 *   · 「深链里的日期会被点搜索清掉」更是只有发出去的那份请求体说了算。
 *
 * 沿用既定手段（本机不能 vite build，见 CLAUDE.md §2）：esbuild 把**真组件**打成 bundle，
 * **只桩 axios 这一个边界**（路由用真的 MemoryRouter —— 这页的分页/筛选全靠 URL 真源，
 * 桩掉路由等于把被测对象换掉）；react-redux 用 esbuild alias 指到沙箱桩。sass 用
 * programmatic API 单独编译后内联进 index.html（组件里 `import './index.sass'` 由
 * `loader: {".sass":"text"}` 收下）。本机无中文字体（截图里汉字是豆腐块），断言全走数值
 * 与请求，不受影响。
 *
 * （TS 迁移注：原版每节各开一个 page、共享一次构建——这里 test.describe.serial +
 * beforeAll 建一次沙箱，每节 test 里各自 browser.newPage，与原版语义一致。）
 */

const DASH_CSS = path.join(FE_DIR, "src/pages/Dashboard/index.css");
const ALLNOTES_SASS = path.join(
  FE_DIR,
  "src/pages/Dashboard/Notes/AllNotes/index.sass",
);

// ── 假后端：只桩 axios 这一个边界 ─────────────────────────────────────────────
// 20 行 = 2.5 页（每页 8）⇒ 分页组件真的有多页可翻，"切第 2 页"才有意义。
const FAKE_AXIOS = `
// 假后端。\`window.__calls\` 记每一次请求 —— 本轮的硬判据（"切页有没有重新拉"）只能从它读。
const calls: any[] = (window as any).__calls = [];
localStorage.setItem('tokenKey', 'x.y.z');

const ROWS = Array.from({ length: 20 }, (_, i) => {
  const id = 100 + i;
  return {
    noteKey: id,
    noteTitle: '第 ' + (i + 1) + ' 篇测试文章（标题足够长，用来验证省略号列宽）',
    cover: '/static/cover' + (i % 3) + '.jpg',
    noteCategory: 2,
    noteTags: [5, 6],
    isTop: i % 4 === 0 ? 1 : 0,
    updateTime: '2026-09-1' + (i % 9) + ' 10:00:00',
    status: 'public',
    draftOf: null,
  };
});

const env = (data: any) => ({ status: 200, data: { code: 200, message: 'ok', data } });
const wire = (d: any) => (d == null ? d : JSON.parse(JSON.stringify(d)));
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

// 服务端本来会按 start_date/end_date 过滤；这里只照抄"收没收到这两个字段"这件事——
// 本轮的判据是"清掉之后不再发"，不是"服务端过滤得对不对"。
const http = async (cfg: any) => {
  const url = cfg.url as string;
  const method = (cfg.method || 'GET').toUpperCase();
  calls.push({ url, method, data: wire(cfg.data) });
  await delay(30);
  if (url === '/api/protected/notes/list') return env(ROWS);
  if (url === '/api/protected/notes/search') return env(ROWS);
  return env(null);
};

export default http;
`;

const ENTRY = `
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import AllNotes from './src/pages/Dashboard/Notes/AllNotes/index.tsx';
import Notes from './src/pages/Dashboard/Notes/index.tsx';

// MemoryRouter 不改浏览器地址栏（这正是它的用途），所以"导航去哪了"要自己记：
// 一个与页面同级的间谍组件，每次 location 变化就往 window.__loc 里追加一条。
function Spy() {
  const loc = useLocation();
  React.useEffect(() => {
    const w = window as any;
    w.__loc = (w.__loc || []).concat([loc.pathname + loc.search]);
  }, [loc]);
  return null;
}

// 不桩路由：这一页的页码/tab/筛选条件全部以 URL 为唯一真源（见 listState.ts 文件头），
// 桩掉 useSearchParams 等于把被测对象换掉。用真的 MemoryRouter，初始地址由测试给。
(window as any).__mount = (path: string) => createRoot(document.getElementById('root')!).render(
  <MemoryRouter initialEntries={[path]}>
    <Spy />
    <Routes>
      <Route path="/dashboard/notes/allnotes" element={<AllNotes />} />
    </Routes>
  </MemoryRouter>
);

// 第六节用：单独挂**笔记页外壳**（面包屑 + 左侧子菜单）本身。
// 它不读 redux、也不发请求，所以只需要一个裸 MemoryRouter；
// 挂到另一个 root 上，免得和上面那个 createRoot 抢同一个容器。
(window as any).__mountNotes = (path: string) => createRoot(document.getElementById('rootNotes')!).render(
  <MemoryRouter initialEntries={[path]}>
    <Routes>
      <Route path="/dashboard/notes/*" element={<Notes />} />
    </Routes>
  </MemoryRouter>
);
`;

const STUB_REDUX = `
const state: any = {
  categories: { categories: [{ categoryKey: 2, categoryTitle: '编程', color: 'blue', icon: 'icon-bianji2' }] },
  tags: { tag: [{ key: 5, tagName: 'React' }, { key: 6, tagName: 'Asyncio' }] },
  note: { noteList: [] },
  user: { avatar: '', name: '管理员' },
};
export const useSelector = (fn: any) => fn(state);
export const useDispatch = () => (_action: any) => undefined;
export const Provider = ({ children }: any) => children;
export const connect = () => (C: any) => C;
`;

/**
 * 从 computedStyle 的 `rgb()/rgba()` 里取 alpha（`transparent` 按 0 算）。
 *
 * **不写"字符串里有没有 \`rgba(\`"**：`rgba(242,231,237,1)` 同样是实体色，
 * 按字样判会假红。这个函数只回答"透不透光"。
 */
function thBgAlpha(cssColor: string | undefined | null): number {
  const s = (cssColor ?? "").trim();
  if (s === "" || s === "transparent") return 0.0;
  const nums = (s.match(/[\d.]+/g) ?? []).map(Number);
  return nums.length >= 4 ? nums[3] : 1.0;
}

interface FormItem {
  label: string;
  top: number;
  bottom: number;
  left: number;
  right: number;
}
/** 四个筛选控件的几何 + 控件清单。`.ant-form-item` 里最后一个是没有 label 的按钮项。 */
async function formItems(page: Page): Promise<FormItem[]> {
  return page.evaluate(() => {
    const items = [...document.querySelectorAll(".AllCard .ant-form-item")];
    return items.map((el) => {
      const label = el.querySelector(".ant-form-item-label label");
      const b = el.getBoundingClientRect();
      return {
        label: label ? (label.textContent ?? "") : "",
        top: b.top,
        bottom: b.bottom,
        left: b.left,
        right: b.right,
      };
    });
  });
}

test.describe("后台「全部文章」列表页改版", () => {
  test.setTimeout(240_000);
  test.describe.configure({ mode: "serial" });

  let sb: Sandbox;

  test.beforeAll(async () => {
    // sass 单独编译（组件里 `import './index.sass'` 由 loader:.sass=text 收下）
    const css = compileSass(ALLNOTES_SASS);
    sb = await serveSandbox({
      // 20260924：给页面一个**真实的高度上下文**。这页的列表区是 flex 撑满的
      // （\`.AllCard{height:100%}\`，真实环境里那一 100% 是后台壳的 \`.Card\` 给的 95vh），
      // 沙箱只挂了一个裸组件，没有父高度可继承 ⇒ 列表区退化成内容高、"铺满卡片"
      // 这类断言全是空转。这里用 \`#root{height:100%}\` 补上那一层。
      "index.html":
        '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">' +
        "<style>html,body,#root{height:100%;margin:0}</style>" +
        `<style>${css}</style></head><body>` +
        '<div id="root"></div><div id="rootNotes"></div>' +
        '<script src="bundle.js"></script></body></html>',
    });
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
        "react-redux": path.join(sb.dir, "stub-redux.tsx"),
      },
      loaders: { ".sass": "text" },
      files: {
        "src/apis/axios.tsx": FAKE_AXIOS,
        "stub-redux.tsx": STUB_REDUX,
        "entry.tsx": ENTRY,
      },
    });
  });

  test.afterAll(async () => {
    await sb.teardown();
  });

  interface Mounted {
    page: Page;
    errs: () => string[];
  }

  async function mount(
    browser: Browser,
    opts: { path?: string; size?: [number, number]; dashCss?: boolean } = {},
  ): Promise<Mounted> {
    const page = await browser.newPage({
      viewport: {
        width: opts.size?.[0] ?? 1440,
        height: opts.size?.[1] ?? 900,
      },
    });
    const errs = collectPageErrors(page);
    await page.goto(sb.url);
    if (opts.dashCss) {
      // 20261001：**后台壳那份样式表**（`Dashboard/index.css`）平时不在这个沙箱里——
      // 本套件只编译被测组件自己的 sass。可"表头底透不透光"这条规则的**出处**正是
      // 那份文件（`body.dash-skin .ant-table-wrapper … thead th`），不把它挂上就
      // 只能在 antd 自带的浅灰底上问一句"透不透"，**问到的是别人**。
      // 只挂在这一节自己的页面上（前面几节的页面不带），把全局选择器串味的面缩到最小。
      await page.evaluate(() => document.body.classList.add("dash-skin"));
      await page.addStyleTag({ path: DASH_CSS });
    }
    await page.evaluate(
      (p: string) =>
        (window as unknown as Record<string, (s: string) => void>).__mount(p),
      opts.path ?? "/dashboard/notes/allnotes",
    );
    await page.waitForSelector(".AllCard .ant-table-row", { timeout: 10000 });
    await page.waitForTimeout(300);
    return { page, errs };
  }

  // ── 一、筛选栏收成一行 ─────────────────────────────────────────────────────
  // 判据取"四个控件的 rect.top 是不是同一个值"而不是"表单高度 < N"：高度会被 padding
  // 和字号带偏，而 top 同不同一行是布局的直接后果。（1440 与 1280 各来一遍 —— inline
  // 布局窄屏会折行，1280 是后台侧栏展开后最常见的工作宽度。）
  test("【一】筛选栏收成一行（14 条）", async ({ browser }) => {
    for (const w of [1440, 1280] as const) {
      const { page, errs } = await mount(browser, { size: [w, 900] });
      const items = await formItems(page);
      const fields = items.filter((i) =>
        ["文章标题", "文章分类", "文章标签", "是否置顶"].includes(i.label),
      );
      const tops = fields.map((i) => i.top);
      const height =
        Math.max(...items.map((i) => i.bottom)) -
        Math.min(...items.map((i) => i.top));
      expect.soft(
        fields.length === 4,
        `${w}px：四个筛选控件都在（标题/分类/标签/置顶） → ${JSON.stringify(items.map((i) => i.label))}`,
      ).toBe(true);
      expect.soft(
        Math.max(...tops) - Math.min(...tops) < 4,
        `${w}px：四个控件 rect.top 相差 < 4px（确实同一行） → tops=${JSON.stringify(tops.map((t) => Math.round(t * 10) / 10))}`,
      ).toBe(true);
      expect.soft(
        fields.map((i) => i.left).every((l, i, a) => i === 0 || a[i - 1] <= l),
        `${w}px：控件按「标题→分类→标签→置顶」从左到右排 → ${JSON.stringify(fields.map((i) => Math.round(i.left)))}`,
      ).toBe(true);
      expect.soft(
        height < 100,
        `${w}px：整条筛选栏高度收敛到一行（< 100px） → 高度=${height.toFixed(1)}px`,
      ).toBe(true);
      // 反面判据：`Row`/`Col` 那套还留着的话，Form 的**直接子节点**里一定有个 `.ant-row`。
      // ⚠️ 不能用 `.AllCard .ant-row` 泛匹配 —— antd 的 `Form.Item` 内部自带
      // `.ant-form-item-row`（inline 布局下每个 item 一个），泛匹配会永远假红。
      expect.soft(
        (await page.evaluate(
          () => document.querySelectorAll(".AllCard form > .ant-row").length,
        )) === 0,
        `${w}px：不再有 Row/Col 包裹（form 的直接子节点里没有 .ant-row）`,
      ).toBe(true);
      // 发布时间控件撤掉后，页面上不该再有日期选择器（RangePicker 会渲染 .ant-picker）
      expect.soft(
        (await page.evaluate(
          () => document.querySelectorAll(".AllCard .ant-picker").length,
        )) === 0,
        `${w}px：「发布时间」控件已撤（.ant-picker 计数为 0）`,
      ).toBe(true);
      expect.soft(
        errs().length === 0,
        `${w}px：无页面异常 → ${errs().slice(0, 3).join("; ")}`,
      ).toBe(true);
      await page.close();
    }
  });

  // ── 二、新增文章按钮：缩小 + 挪到「全部文章」标签之前 ────────────────────────
  test("【二】「新增文章」按钮的位置与形态（9 条）", async ({ browser }) => {
    const { page } = await mount(browser);
    const geo = await page.evaluate(() => {
      const btn = [...document.querySelectorAll(".AllCard .ant-btn")].find(
        (b) => (b.textContent ?? "").includes("新增文章"),
      );
      const tab = document.querySelector(".AllCard .ant-tabs-tab");
      const r = (el: Element) => {
        const b = el.getBoundingClientRect();
        return {
          left: b.left,
          right: b.right,
          top: b.top,
          bottom: b.bottom,
          w: b.width,
          h: b.height,
        };
      };
      return {
        btn: btn ? r(btn) : null,
        tab: tab ? r(tab) : null,
        cls: btn ? btn.className : "",
        small: btn ? btn.classList.contains("ant-btn-sm") : false,
        fabAdd: document.querySelectorAll('.AllCard [aria-label="add"]').length,
        rrp: document.querySelectorAll(".AllCard .ant-picker-range").length,
      };
    });
    expect.soft(
      geo.btn !== null,
      `有一颗「新增文章」按钮 → ${geo.cls}`,
    ).toBe(true);
    expect.soft(
      geo.small && geo.btn!.h <= 26,
      `是 antd 的小号按钮（不再是 40px 的圆形 Fab） → h=${geo.btn ? geo.btn.h.toFixed(1) : "—"}`,
    ).toBe(true);
    expect.soft(
      geo.fabAdd === 0,
      `点它之前没有别的 add 按钮残留（旧 Fab 已删） → ${geo.fabAdd}`,
    ).toBe(true);
    // 20261006：「页面上的第一个页签」现在是**公开文章**（它排在「全部文章」前面），
    // 这条判据比的是"按钮在所有页签之前"，与第一个页签叫什么无关，故数值判据不动、
    // 只把措辞改准（页签顺序另有【三·补】专节锁）。
    expect.soft(
      geo.btn!.right <= geo.tab!.left + 0.5,
      `按钮在第一个页签（公开文章）之前（right <= tab.left） → btn.right=${geo.btn!.right.toFixed(1)} tab.left=${geo.tab!.left.toFixed(1)}`,
    ).toBe(true);
    expect.soft(
      geo.btn!.bottom > geo.tab!.top && geo.btn!.top < geo.tab!.bottom,
      `按钮与标签条同一行（垂直重叠）`,
    ).toBe(true);
    // 20260927 用户报「刷新按钮和后面的页标签太挤了」：tab 条左侧的附加内容里有两颗按钮
    // （新增文章 / 刷新），新增文章自带 margin-right、刷新没有 ⇒ 刷新与第一个标签之间
    // 只剩 antd 的默认值。判据取**刷新按钮右缘到第一个标签左缘的距离**，与页内既有的
    // 12px 节奏对齐（新增文章 → 刷新 就是 12px）。改成量距离而不是"某处有个 margin"：
    // margin 写在谁身上、被谁吃掉，读代码看不出来。
    const rgeo = await page.evaluate(() => {
      const btn = [...document.querySelectorAll(".AllCard .ant-btn")].find(
        (b) => (b.textContent ?? "").includes("刷新"),
      );
      const tab = document.querySelector(".AllCard .ant-tabs-tab");
      if (!btn || !tab) return null;
      const b = btn.getBoundingClientRect();
      const t = tab.getBoundingClientRect();
      return {
        right: b.right,
        left: t.left,
        gap: t.left - b.right,
        text: (btn.textContent ?? "").trim(),
      };
    });
    expect.soft(
      rgeo !== null && rgeo.gap > -0.5,
      `有一颗「刷新」按钮，且在标签条左侧 → ${JSON.stringify(rgeo)}`,
    ).toBe(true);
    expect.soft(
      rgeo !== null && rgeo.gap >= 12,
      `刷新按钮与后面的页标签不挤（间距 ≥ 12px） → gap=${rgeo ? rgeo.gap.toFixed(1) : "—"}px`,
    ).toBe(true);
    if (rgeo) {
      // 与「新增文章 → 刷新」的间距一致（同一行的两颗按钮不该用两套节奏）
      const gap2 = await page.evaluate(() => {
        const bs = [...document.querySelectorAll(".AllCard .ant-btn")];
        const add = bs.find((b) => (b.textContent ?? "").includes("新增文章"));
        const rf = bs.find((b) => (b.textContent ?? "").includes("刷新"));
        if (!add || !rf) return null;
        return rf.getBoundingClientRect().left - add.getBoundingClientRect().right;
      });
      expect.soft(
        gap2 !== null && Math.abs(rgeo.gap - gap2) <= 8,
        `与「新增文章 → 刷新」的间距同量级（同一套节奏） → refresh→tab=${rgeo.gap.toFixed(1)} add→refresh=${gap2}`,
      ).toBe(true);
    }
    await page.locator(".AllCard .ant-btn", { hasText: "新增文章" }).first().click();
    await page.waitForTimeout(250);
    // MemoryRouter 不动浏览器地址栏，导航去向由 entry 里那个 Spy 记进 window.__loc
    const locs = await page.evaluate(
      () => (window as unknown as Record<string, string[]>).__loc,
    );
    expect.soft(
      locs[locs.length - 1] === "/dashboard/notes/newnote",
      `点它导航到 /dashboard/notes/newnote → ${JSON.stringify(locs)}`,
    ).toBe(true);
    await page.close();
  });

  // ── 三、切页不再重新请求（本轮唯一的**行为**变化）───────────────────────────
  // 视口压到 700 高：列表区是 flex 撑满的，20 行 × 70px 必然溢出，否则"回顶"这条
  // 断言是空转（scrollTop 本来就没得滚）。前置条件单独断言。
  test("【三】切页不再重新请求 + 回顶（8 条）", async ({ browser }) => {
    const { page, errs } = await mount(browser, { size: [1440, 700] });
    const box = await page.evaluate(() => {
      const b = document.querySelector(".AllCard .custom-scroll-container")!;
      return { sh: b.scrollHeight, ch: b.clientHeight };
    });
    expect.soft(
      box.sh > box.ch + 40,
      `前置：列表内容真的溢出了（否则回顶断言是空转） → ${box.sh} vs ${box.ch}`,
    ).toBe(true);
    const n0 = await page.evaluate(
      () =>
        (window as unknown as Record<string, unknown[]>).__calls.length,
    );
    expect.soft(n0 === 1, `首屏拉了一次数据 → calls=${n0}`).toBe(true);
    await page.evaluate(
      () =>
        (document.querySelector(".AllCard .custom-scroll-container") as HTMLElement).scrollTop = 120,
    );
    await page.waitForTimeout(60);
    await page.locator(".AllCard .ant-pagination-item-2").first().click();
    await page.waitForTimeout(700);
    const n1 = await page.evaluate(
      () => (window as unknown as Record<string, unknown[]>).__calls.length,
    );
    expect.soft(
      n1 === n0,
      `切到第 2 页：**没有**再发请求（前端切片） → ${n0} → ${n1}`,
    ).toBe(true);
    expect.soft(
      (await page.evaluate(
        () =>
          (document.querySelector(".AllCard .custom-scroll-container") as HTMLElement).scrollTop,
      )) === 0,
      `切页后列表滚回顶部（scrollTop === 0）`,
    ).toBe(true);
    const firstTitle = await page.evaluate(
      () =>
        (document.querySelector(".AllCard .note-title-txt") as HTMLElement)
          .textContent ?? "",
    );
    expect.soft(
      firstTitle.includes("第 11 篇"),
      `第 2 页显示的是第 11 篇（每页 10 条，切片真的换了） → ${firstTitle}`,
    ).toBe(true);
    // 对照：切 tab 是**该**重新拉的（否则上面那条"没发请求"可能只是计数器不灵）
    await page
      .locator(".AllCard .ant-tabs-tab", { hasText: "私密文章" })
      .first()
      .click();
    await page.waitForTimeout(700);
    const n2 = await page.evaluate(
      () => (window as unknown as Record<string, unknown[]>).__calls.length,
    );
    expect.soft(
      n2 === n1 + 1,
      `对照：切 tab 会重新请求（说明计数器有效） → ${n1} → ${n2}`,
    ).toBe(true);
    expect.soft(
      (await page.evaluate(
        () =>
          (document.querySelector(
            ".AllCard .ant-pagination-item-active",
          ) as HTMLElement).textContent ?? "",
      )) === "1",
      `切 tab 后页码回到第 1 页`,
    ).toBe(true);
    expect.soft(
      errs().length === 0,
      `第三节无页面异常 → ${errs().slice(0, 3).join("; ")}`,
    ).toBe(true);
    await page.close();
  });

  // ── 三·补、「公开文章」页签（20261006 用户第 5 条）─────────────────────────
  // 用户原话：「不要给文章标签位置加个公开文章标签，是多余的…在『全部文章』页标签前加个
  // 『公开文章』，或者再加个筛选项。」→ 绿标撤掉、页签排在**最前**。
  // 两条判据分开：① 顺序与 key（`key` 仍是 '4'，页签顺序变了但 `?tab=` 的契约没变）；
  // ② 切过去时**发出去的请求体** —— 公开与否必须由后端判（前端一个条件都不加，
  //   只有 `only_public` 能表达"这个集合"）。光看界面看不出这两件事。
  test("【三·补】「公开文章」页签：排最前，筛选由后端做（9 条）", async ({
    browser,
  }) => {
    const { page, errs } = await mount(browser);
    const tabs = await page.evaluate(() =>
      [...document.querySelectorAll(".AllCard .ant-tabs-tab")].map((t) => ({
        text: (t.textContent ?? "").trim(),
        key:
          t.getAttribute("data-node-key") ??
          (t.querySelector('[role="tab"]') as HTMLElement | null)?.id ??
          "",
      })),
    );
    const labels = tabs.map((t) => t.text);
    expect.soft(tabs.length === 4, `共四个页签 → ${JSON.stringify(labels)}`).toBe(
      true,
    );
    expect.soft(
      JSON.stringify(labels.slice(0, 1)) === JSON.stringify(["公开文章"]),
      `第一个是「公开文章」 → ${JSON.stringify(labels.slice(0, 1))}`,
    ).toBe(true);
    expect.soft(
      JSON.stringify(labels.slice(1)) ===
        JSON.stringify(["全部文章", "私密文章", "草稿箱"]),
      `其余三个顺序不变（全部/私密/草稿） → ${JSON.stringify(labels.slice(1))}`,
    ).toBe(true);
    expect.soft(
      tabs.length > 0 && tabs[0].key.includes("4"),
      `「公开文章」的 key 仍是 '4'（显示顺序变了，\`?tab=\` 的契约没变） → ${JSON.stringify(tabs.slice(0, 1))}`,
    ).toBe(true);
    const n0 = await page.evaluate(
      () => (window as unknown as Record<string, unknown[]>).__calls.length,
    );
    await page
      .locator(".AllCard .ant-tabs-tab", { hasText: "公开文章" })
      .first()
      .click();
    await page.waitForTimeout(700);
    interface Call {
      url: string;
      method: string;
      data: Record<string, unknown> | null;
    }
    const calls = await page.evaluate(
      () =>
        (window as unknown as Record<string, Call[]>).__calls as unknown as Call[],
    );
    const last = calls[calls.length - 1] ?? ({} as Call);
    expect.soft(
      calls.length === n0 + 1,
      `切到「公开文章」会重新拉一次（切 tab 本来就该重拉） → ${n0} → ${calls.length}`,
    ).toBe(true);
    expect.soft(
      String(last.url ?? "").endsWith("/notes/search"),
      `请求走 /notes/search（不是 /notes/list —— 那个端点没有这个筛选） → ${last.url}`,
    ).toBe(true);
    expect.soft(
      JSON.stringify(last.data ?? null) === JSON.stringify({ only_public: true }),
      `请求体只有 only_public:true，没有前端臆断的 status/其它条件 → ${JSON.stringify(last.data)}`,
    ).toBe(true);
    expect.soft(
      (await page.locator(".AllCard .ant-table-row").count()) > 0,
      `不带筛选时列表仍然有行（不是空页） → ${await page.locator(".AllCard .ant-table-row").count()}`,
    ).toBe(true);
    const locs = await page.evaluate(
      () => (window as unknown as Record<string, string[]>).__loc,
    );
    expect.soft(
      (locs[locs.length - 1] ?? "").endsWith("tab=4"),
      `地址栏记的是 tab=4（深链/刷新能回到这个页签） → ${locs[locs.length - 1] ?? "—"}`,
    ).toBe(true);
    expect.soft(
      errs().length === 0,
      `三·补节无页面异常 → ${errs().slice(0, 3).join("; ")}`,
    ).toBe(true);
    await page.close();
  });

  // ── 四、深链里的日期条件点搜索会被清掉 ─────────────────────────────────────
  // 「发布时间」控件撤了，但 `?from=&to=` 仍在 URL 契约里（老深链要能进来）。风险在于
  // setParam 是合并语义：从深链进来再点搜索，旧日期会隐形地继续生效，而页面上已经
  // 没有任何控件能看见或清掉它 —— 所以 onFinish 里那两行显式清空必须有回归锁。
  test("【四】深链日期条件：能进来，且点搜索后被清掉（4 条）", async ({
    browser,
  }) => {
    const { page, errs } = await mount(browser, {
      path: "/dashboard/notes/allnotes?from=2026-09-01&to=2026-09-10",
    });
    interface Call {
      url: string;
      data: Record<string, string> | null;
    }
    const first = await page.evaluate(
      () =>
        (window as unknown as Record<string, Call[]>).__calls[0] as unknown as Call,
    );
    expect.soft(
      first.url === "/api/protected/notes/search" &&
        first.data?.start_date === "2026-09-01" &&
        first.data?.end_date === "2026-09-10",
      `带 ?from=&to= 进来：首请求按搜索走，且带上了日期条件 → ${JSON.stringify(first)}`,
    ).toBe(true);
    // ⚠️ 不能用 has_text="搜索"：antd 会给**两个汉字**的按钮自动插一个空格（渲染成「搜 索」），
    // 按整词匹配永远命中不了（20260922 在 user-center.test.py 上踩过同一个坑）。按 type 定位。
    await page.locator('.AllCard form button[type="submit"]').first().click();
    await page.waitForTimeout(700);
    const last = await page.evaluate(
      () =>
        (window as unknown as Record<string, Call[]>).__calls as unknown as Call[],
    );
    const lastCall = last[last.length - 1];
    expect.soft(
      lastCall.url === "/api/protected/notes/list",
      `点搜索：日期条件不再发出（from/to 被显式清空） → ${JSON.stringify(lastCall)}`,
    ).toBe(true);
    expect.soft(
      (await page.evaluate(
        () => document.querySelectorAll(".AllCard .ant-picker").length,
      )) === 0,
      `点搜索后 URL 里的 from/to 也消失了（.ant-picker 计数 0）`,
    ).toBe(true);
    expect.soft(
      errs().length === 0,
      `第四节无页面异常 → ${errs().slice(0, 3).join("; ")}`,
    ).toBe(true);
    await page.close();
  });

  // ── 五、列表区铺满卡片、分页条钉底、表头吸顶（20260924 重排）────────────────
  // 这一轮撤掉了 `scroll={{y:'56vh'}}`：那个定高滚动区在 900 高的窗口上只有 504px、
  // 刚好把每页最后一条藏进滚动区，而卡片下方还空着 150px。下面每条都只有真跑一遍
  // 才看得见（几何、层级、以及"改每页条数会不会又去拉一次数据"）。
  test("【五】列表区铺满卡片 + 分页条钉底 + 表头吸顶（14 条）", async ({
    browser,
  }) => {
    const { page, errs } = await mount(browser, {
      size: [1440, 900],
      dashCss: true,
    });
    interface RBox {
      t: number;
      b: number;
      h: number;
    }
    const geo = await page.evaluate(() => {
      const R = (el: Element): RBox => {
        const b = el.getBoundingClientRect();
        return {
          t: +b.top.toFixed(1),
          b: +b.bottom.toFixed(1),
          h: +b.height.toFixed(1),
        };
      };
      const card = document.getElementById("root")!; // 沙箱里它就是"页面高度"（见 index.html）
      const sr = document.querySelector(".AllCard .searchRes")!;
      const cont = document.querySelector(".AllCard .custom-scroll-container")!;
      const foot = document.querySelector(".AllCard .listFooter")!;
      const th = document.querySelector(".AllCard .ant-table-thead th")!;
      return {
        thBg: getComputedStyle(th).backgroundColor,
        card: R(card),
        sr: R(sr),
        cont: R(cont),
        foot: R(foot),
        legacyBody: document.querySelectorAll(".AllCard .ant-table-body").length,
        tableLayout: getComputedStyle(
          document.querySelector(".AllCard .ant-table table")!,
        ).tableLayout,
        panelBg: getComputedStyle(sr).backgroundColor,
        rows: document.querySelectorAll(".AllCard .ant-table-row").length,
        sizeChanger: document.querySelectorAll(".AllCard .ant-pagination-options")
          .length,
        total: (document.querySelector(".AllCard .listFooter") as HTMLElement)
          ?.textContent ?? "",
      };
    });
    expect.soft(geo.rows === 10, `每页 10 条（不再是 8） → rows=${geo.rows}`).toBe(
      true,
    );
    expect.soft(
      Math.abs(geo.sr.b - geo.card.b) < 3 && Math.abs(geo.foot.b - geo.card.b) < 3,
      `列表区一直铺到卡片底部（原来的空白没有了） → 面板底 ${geo.sr.b} / 分页底 ${geo.foot.b} / 卡片底 ${geo.card.b}`,
    ).toBe(true);
    expect.soft(
      Math.abs(geo.foot.t - geo.cont.b) < 3,
      `分页条紧贴滚动区下沿（在滚动区**之外**，滚多远都看得见） → 分页顶 ${geo.foot.t} / 滚动区底 ${geo.cont.b}`,
    ).toBe(true);
    // 撤掉 scroll.y 之后 rc-table 只渲染一张表（没有独立的表头/表体两张表），
    // 表头吸顶才能靠一行 position:sticky 做到
    expect.soft(
      geo.legacyBody === 0,
      `单表结构（没有 .ant-table-body 这层了） → legacyBody=${geo.legacyBody}`,
    ).toBe(true);
    expect.soft(
      geo.tableLayout === "fixed",
      `列宽仍是 fixed 布局（百分比列宽全靠它） → ${geo.tableLayout}`,
    ).toBe(true);
    expect.soft(geo.sizeChanger === 1, `分页条带每页条数选择器`).toBe(true);
    expect.soft(
      geo.total.includes("第 1-10 条") && geo.total.includes("共 20 篇"),
      `总数文案在位（第 x-y 条 / 共 N 篇） → ${geo.total.slice(0, 40)}`,
    ).toBe(true);
    const stuck = await page.evaluate(() => {
      const cont = document.querySelector(
        ".AllCard .custom-scroll-container",
      ) as HTMLElement;
      const th = document.querySelector(".AllCard .ant-table-thead th")!;
      cont.scrollTop = cont.scrollHeight;
      const ct = cont.getBoundingClientRect().top;
      const tt = th.getBoundingClientRect().top;
      return { scrolled: cont.scrollTop > 20, gap: Math.abs(ct - tt) };
    });
    expect.soft(
      stuck.scrolled && stuck.gap < 2,
      `列表滚到底时表头仍吸在滚动区顶部 → ${JSON.stringify(stuck)}`,
    ).toBe(true);
    // 吸顶表头的底色**必须不透明**。20260930 那轮把表头底改成了
    // `var(--washi-line-2)`（22% 的粉线）——它压掉了 antd 自带的实体底，
    // 于是滚上来的行**从表头里透出来**（用户实测："表头背景不要透明，会透过
    // 下方列表干扰视觉"）。判据只能读计算值：把 alpha 抽出来看是不是 1
    // （不写"有没有 rgba 字样"——`rgba(…, 1)` 同样是实体色，那样会假红）。
    // 三张吸顶表（文章/额度/留言）共用这条规则，这里量的是文章页。
    const thAlpha = thBgAlpha(geo.thBg);
    expect.soft(
      thAlpha >= 1.0,
      `吸顶表头底色不透明（行不会从表头里透出来） → th 底色 = ${geo.thBg}（alpha=${thAlpha}）`,
    ).toBe(true);
    // 对照：就地覆上当年那个 22% 的粉线，走完"浏览器算值 → 探针读回"整条路，
    // 必须当场判成透明 —— 否则上面那条"不透明"可能只是判据自己不敏感（比如
    // 读到的根本不是这条规则的底色）。
    // ⚠️ 表头带 `transition: background .2s`（antd 给的）——**过渡优先级高于一切**，
    // 包括行内 `!important`：赋值那一刻读 computedStyle 拿到的是过渡的起点（旧色），
    // 会得出"怎么改都不动"的假象。所以先把 transition 摘掉再改、读完再还原。
    const backToOld = await page.evaluate(() => {
      const th = document.querySelector(".AllCard .ant-table-thead th") as HTMLElement;
      const keep = th.style.cssText;
      th.style.transition = "none";
      th.style.backgroundColor = "rgba(198, 152, 192, 0.22)";
      const v = getComputedStyle(th).backgroundColor;
      th.style.cssText = keep;
      return v;
    });
    expect.soft(
      thBgAlpha(backToOld) < 1.0,
      `对照：把那层 22% 的粉线覆回去，探针当场判成透明 ⇒ 判据对透明度敏感 → 覆回后读到 ${backToOld}`,
    ).toBe(true);
    // 表头吸顶了还不够：行内那三颗 MUI Fab 自带 z-index:1050，会**画在表头上面**
    // （实测截图里第一行的操作按钮浮在表头上）。断言的是叠放次序本身，不是某张截图。
    const zs = await page.evaluate(() => {
      const th = document.querySelector(".AllCard .ant-table-thead th")!;
      const fab = document.querySelector(".AllCard .ant-table-row .MuiFab-root")!;
      return {
        th: +getComputedStyle(th).zIndex,
        fab: +getComputedStyle(fab).zIndex,
      };
    });
    expect.soft(
      zs.fab < zs.th,
      `行内 Fab 不再压在吸顶表头之上（z-index 已归零） → fab=${zs.fab} th=${zs.th}`,
    ).toBe(true);

    // 改每页条数：要写进 URL（返回列表/刷新后还在），且**不该**重新拉数据
    const nBefore = await page.evaluate(
      () => (window as unknown as Record<string, unknown[]>).__calls.length,
    );
    await page.locator(".AllCard .ant-pagination-options .ant-select").first().click();
    await page.waitForTimeout(300);
    await page
      .locator(".ant-select-item-option", { hasText: "20 条/页" })
      .first()
      .click();
    await page.waitForTimeout(700);
    const nAfter = await page.evaluate(
      () => (window as unknown as Record<string, unknown[]>).__calls.length,
    );
    expect.soft(
      nAfter === nBefore,
      `改每页条数：**没有**重新拉数据（数据与分页无关，只是切片变了） → ${nBefore} → ${nAfter}`,
    ).toBe(true);
    const locs = await page.evaluate(
      () => (window as unknown as Record<string, string[]>).__loc,
    );
    expect.soft(
      (locs[locs.length - 1] ?? "").includes("size=20"),
      `改每页条数：URL 里写上了 size=20 → ${JSON.stringify(locs)}`,
    ).toBe(true);
    expect.soft(
      (await page.evaluate(
        () => document.querySelectorAll(".AllCard .ant-table-row").length,
      )) === 20 &&
        (await page.evaluate(
          () => document.querySelectorAll(".AllCard .ant-pagination-item").length,
        )) === 1,
      `改每页条数：一屏 20 条、页数变 1`,
    ).toBe(true);
    expect.soft(
      errs().length === 0,
      `第五节无页面异常 → ${errs().slice(0, 3).join("; ")}`,
    ).toBe(true);
    await page.close();
  });

  // ── 六、面包屑与子菜单选中按路径派生（20261006 修）─────────────────────────
  // 病根与侧栏高亮是**同一个**：路由是 `createBrowserRouter`（真实 path、全仓无人写
  // hash），而这段原来读 `location.hash` ⇒ 恒不命中，面包屑**永远**是「未知页面」。
  // 旧实现下本节的每一条都必然红（它连 '全部文章' 都显示不出来），所以这里不需要另设对照。
  test("【六】笔记页面包屑（原来恒显示「未知页面」）（8 条）", async ({
    browser,
  }) => {
    const notesCrumb = async (
      routePath: string,
    ): Promise<{ got: string; errs: string[] }> => {
      const page = await browser.newPage({
        viewport: { width: 1280, height: 800 },
      });
      const errs = collectPageErrors(page);
      await page.goto(sb.url);
      await page.evaluate(
        (p: string) =>
          (window as unknown as Record<string, (s: string) => void>).__mountNotes(p),
        routePath,
      );
      await page.waitForSelector(".header .ant-breadcrumb", { timeout: 10000 });
      await page.waitForTimeout(200);
      const got = await page.evaluate(() => {
        const li = document.querySelectorAll(".header .ant-breadcrumb li");
        return li.length ? (li[li.length - 1].textContent ?? "").trim() : "";
      });
      const es = errs();
      await page.close();
      return { got, errs: es };
    };
    for (const [routePath, want] of [
      ["/dashboard/notes", "全部文章"],
      ["/dashboard/notes/alltags", "全部标签"],
      ["/dashboard/notes/allcategorize", "全部分类"],
      // 带参路径：老实现只认精确串，这条同样落进「未知页面」
      ["/dashboard/notes/newnote/123", "编辑文章"],
    ] as const) {
      const { got, errs } = await notesCrumb(routePath);
      expect.soft(
        got === want,
        `${routePath} → 面包屑「${want}」 → 得到「${got}」`,
      ).toBe(true);
      expect.soft(
        errs.length === 0,
        `${routePath} → 无页面异常 → ${errs.slice(0, 3).join("; ")}`,
      ).toBe(true);
    }
  });

  // ── 七、文章分类列的标签：文字要落在标签容器正中间 ──────────────────────────
  // 20261014 用户第 2 条。原来那一格是个行内 style 的居中 div，看着像居中、两轴其实都偏，
  // **两处偏移都是量出来的**（不是估的）：
  //   · 水平 −4.00px：antd 的 `.ant-tag` 自带 `margin-inline-end: 8px`，而 flex 的
  //     `justify-content:center` 居的是**外边距盒** ⇒ 边框盒整体左移 8/2；
  //   · 垂直 −1.50px：Tag 的 `line-height:20px` 里塞了个 antd `Space`（inline-flex），
  //     行盒被撑到 23px 而内容只有 20px ⇒ 图标+文字贴着内容盒上沿、底下空 3px，
  //     标签也比平时高 3px（25px vs 22px）。
  // （这两个数是**挂了 iconfont 在真页面上**量到的。本套件的沙箱不挂字体，`<i>` 是零宽
  //   空盒，同一处改回来只会读到 dx=−4.00px / dy=+2.00px / 内容盒 24px —— 方向与结论一样，
  //   数值别照抄。）
  // 判据取"标签边框盒中心 == 所在单元格中心"与"图标+文字这一组的中心 == 标签内容盒中心"
  // —— 两轴各一条，都在半像素内。**不判字面量高度**：22px 只是 antd 默认值的另一种写法，
  // 内容真居中了高度自然就回去了。
  //
  // 量的是 antd 的 `Space`（`.ant-space`）盒子，不是"图标盒 ∪ 文字盒"的并集 —— 这个沙箱
  // **不挂 iconfont**（本套件的 index.html 里没有那两份字体样式表），`<i>` 是个零宽空盒，
  // 拿它算并集等于只量了文字。`Space` 本来就是那个被撑开的 inline-flex 盒子，两处的偏差
  // （外边距盒居中的 −4px、行盒被撑开的那些余量）都落在它身上。
  test("【七】文章分类列的标签文本居中（8 条）", async ({ browser }) => {
    const { page, errs } = await mount(browser);
    interface CatGeo {
      dxTagTd: number;
      dxGroupContent: number;
      dyGroupContent: number;
      tagH: number;
      contentH: number;
      groupH: number;
      catDisplay: string;
      catAlign: string;
      tagsCount: number;
      tagsDisplay: string | null;
    }
    const geo = await page.evaluate(() => {
      const tds = [...document.querySelectorAll(".AllCard tbody .ant-table-row td")];
      const td = tds.find((t) => t.querySelector(".note-category-cell"));
      if (!td) return null;
      const tag = td.querySelector(".ant-tag")!;
      const grp = tag.querySelector(".ant-space");
      if (!grp) return null;
      const cs = getComputedStyle(tag);
      const R = (el: Element) => {
        const b = el.getBoundingClientRect();
        return {
          l: b.left,
          r: b.right,
          t: b.top,
          b: b.bottom,
          cx: b.left + b.width / 2,
          cy: b.top + b.height / 2,
          h: b.height,
        };
      };
      const tr = R(tag);
      const dr = R(td);
      const gr = R(grp);
      // 标签自己的**内容盒**（边框盒去掉边框与内边距）—— 判据是"这一组落在内容盒正中"，
      // 不是"落在边框盒正中"：antd 的 Tag 左右各 7px 内边距，拿边框盒当基准会把内边距算成偏差。
      const cL = tr.l + parseFloat(cs.borderLeftWidth) + parseFloat(cs.paddingLeft);
      const cR = tr.r - parseFloat(cs.borderRightWidth) - parseFloat(cs.paddingRight);
      const cT = tr.t + parseFloat(cs.borderTopWidth) + parseFloat(cs.paddingTop);
      const cB = tr.b - parseFloat(cs.borderBottomWidth) - parseFloat(cs.paddingBottom);
      const tg = document.querySelector(".AllCard tbody .note-tags-col .ant-tag");
      return {
        dxTagTd: tr.cx - dr.cx,
        dxGroupContent: gr.cx - (cL + cR) / 2,
        dyGroupContent: gr.cy - (cT + cB) / 2,
        tagH: tr.h,
        contentH: cB - cT,
        groupH: gr.h,
        catDisplay: cs.display,
        catAlign: cs.alignItems,
        // 对照组：**文章标签列**是"一排标签"共用一格，绝不能被上面那条 flex 居中规则沾上。
        // 判 display 同一件事要挑**样式表设的**属性 —— 那列的右外边距是组件里的**行内** style
        // （`marginInlineEnd: 4`，见 TagMethods.tsx），行内权重永远压过我的选择器，拿它当判据
        // 就算规则真泛化过去也是绿的（假对照）。`display` 由样表给，泛化就会真变红。
        tagsCount: document.querySelectorAll(".AllCard tbody .note-tags-col .ant-tag")
          .length,
        tagsDisplay: tg ? getComputedStyle(tg).display : null,
      } as CatGeo;
    });
    expect.soft(
      geo !== null,
      `文章分类列渲染出了「图标 + 文字」的标签`,
    ).toBe(true);
    if (geo) {
      expect.soft(
        Math.abs(geo.dxTagTd) < 0.5,
        `标签边框盒**水平**居中于所在单元格（|dx| < 0.5px，原来 −4.00px） → dx=${geo.dxTagTd >= 0 ? "+" : ""}${geo.dxTagTd.toFixed(2)}px`,
      ).toBe(true);
      expect.soft(
        Math.abs(geo.dxGroupContent) < 0.5,
        `「图标+文字」这一组**水平**居中于标签内容盒（|dx| < 0.5px） → dx=${geo.dxGroupContent >= 0 ? "+" : ""}${geo.dxGroupContent.toFixed(2)}px`,
      ).toBe(true);
      expect.soft(
        Math.abs(geo.dyGroupContent) < 0.5,
        `「图标+文字」这一组**垂直**居中于标签内容盒（|dy| < 0.5px，原来 −1.50px） → dy=${geo.dyGroupContent >= 0 ? "+" : ""}${geo.dyGroupContent.toFixed(2)}px`,
      ).toBe(true);
      // 内容盒高度应当就是那一组自己的高度，多出来的那几 px 正是"行盒被 inline-flex 撑开"
      // 的余量。判"两者之差 < 0.5"而不判具体数值 —— 字号/行高一改，绝对数就陈旧了。
      expect.soft(
        Math.abs(geo.contentH - geo.groupH) < 0.5,
        `标签内容盒高度 == 那一组自己的高度（没有撑出来的余量） → 内容盒=${geo.contentH}px 组=${geo.groupH}px 标签=${geo.tagH}px`,
      ).toBe(true);
      expect.soft(
        geo.catDisplay.includes("flex"),
        `文章分类列的标签确实是 flex 居中容器（两条竖轴居中的前提） → display=${geo.catDisplay}`,
      ).toBe(true);
      expect.soft(
        geo.tagsCount >= 2 && !(geo.tagsDisplay ?? "").includes("flex"),
        `对照：文章标签列的标签**不是** flex 居中容器（选择器没泛化到那一排） → 标签列 ${geo.tagsCount} 个 display=${geo.tagsDisplay}`,
      ).toBe(true);
    }
    expect.soft(
      errs().length === 0,
      `第七节无页面异常 → ${errs().slice(0, 3).join("; ")}`,
    ).toBe(true);
    await page.close();
  });
});
