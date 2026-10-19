import { test, expect, type Browser, type Page } from "@playwright/test";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { build } from "esbuild";
import { FE_DIR } from "./sandbox";

/**
 * 图谱渲染数值断言（本机不能 vite build 的替代手段：esbuild 单文件打包 + CDP 断言）。
 * （原 tests/wordgraph_render.py，20261019 迁移）
 *
 * 不起服务：`page.route` 把 /graph/manifest.json 与产物文件从磁盘直接喂回去，
 * 所以**真实的 loader.ts 也一并被验了**（manifest 校验 → 动态 import → export default）。
 *
 * ⚠️ 两条**必须先喂回去**的事实（20261003 产物改由 API 供出之后）：
 *   ①  `/api/public/graph/manifest` 一律回 **200 + `{}`** —— 本沙箱没有 Rust/agent，
 *       这正是"从没重建过的站点"在生产上拿到的东西 ⇒ 顺带把 loader 的**回落**那条腿
 *       验到了（`HITS`）。**别改成 404**：那会让首页每次加载都往控制台扔一条红字，
 *       第一节"无 console error"那条断言会红，而红得与它声称在测的东西没关系。
 *   ②  manifest 里的 `site` 要**改写成沙箱页面自己的 origin**。committed 那份产物署名的是
 *       `https://saudade.site`，而沙箱页面住在 `http://vitrine.test` —— 照原样喂进去，
 *       运行期的语料归属闸会（正确地）判"不是本站"，`loadGraph()` 直接拒绝，下面每条断言
 *       都会因为"没画"而红，而红得与它们声称在测的东西一个字都没关系。第 9 节专门验这条闸。
 *
 * 断言，第 4 条是性能硬门槛：
 *   1. 画布真的画了东西（非透明像素 > 阈值、颜色 ≥ 2）
 *   2. 拖动改变画面
 *   3. 定位后视图确实朝命中簇移动，且命中簇被摆到画面中心
 *   4. **空闲 3 秒 rAF 计数增量为 0**（定位动画与辉光结束后必须彻底停下来）
 *   5. prefers-reduced-motion 下不抛错且瞬移到位
 *
 * 第 8 条是**滚轮归属**的判据（20260923 加，20261002 随"锁定态删除"反转）：画布吃到滚轮
 * 必须缩放图谱并 `preventDefault`（相机 dist 变、`window.scrollY` 不变）。旧版验的是相反的
 * 行为——"锁定"那套机制已按用户要求整体删除，未放大时页面照常滚动改由外壳的
 * `.vit-body{pointer-events:none}` 承担（滚轮也是指针事件），那一半只能在真页面里量，
 * 见 tests/e2e/vitrine-tear.spec.ts。页面仍带一条 1600px 的占位块：没有可滚动的文档，
 * "scrollY 必须为 0"这条腿就是空转。
 */

const GRAPH_DIR = path.join(FE_DIR, "public/graph");
const WG_SRC = path.join(
  FE_DIR,
  "src/frontHome/Content/ContentHome/Vitrine/wordgraph",
);

const CANVAS_W = 620;
const CANVAS_H = 460;
const DEFINE = JSON.stringify({
  VITE_HTTP_BASEURL: "",
  VITE_CDN_BASEURL: "",
  MODE: "production",
  DEV: false,
  PROD: true,
  BASE_URL: "/",
});

// 沙箱页面的地址。**必须是个真 URL**（见 newPage 里的 goto 注），而它的 origin 就是
// 运行期语料归属闸的比对基准 —— 所以这几条是同一个事实的三处写法，动一处要动三处。
const PAGE_URL = "http://vitrine.test/";
const PAGE_ORIGIN = "http://vitrine.test";

/** 与 palette.ts 的 PALETTE.edgeHot 同步（改了那里这里要一起改） */
const EDGE_HOT_RGB = "255, 232, 168";

/** 把 engine/loader/locate 打成一个 IIFE，导出挂到 window.WG。
 * 入口走 stdin（node API：contents + resolveDir），不在仓库里留测试专用源文件。 */
async function bundle(): Promise<string> {
  const r = await build({
    stdin: {
      contents:
        "export * from './engine';\nexport * from './loader';\nexport * from './locate';",
      resolveDir: WG_SRC,
      loader: "ts",
      sourcefile: "entry.ts",
    },
    bundle: true,
    format: "iife",
    globalName: "WG",
    target: "es2020",
    define: { "import.meta.env": DEFINE },
    write: false,
    logLevel: "silent",
  });
  return r.outputFiles[0].text;
}

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;background:#101623}
  #c{display:block;width:${CANVAS_W}px;height:${CANVAS_H}px}
</style></head><body><canvas id="c"></canvas><div id="sp" style="height:1600px"></div></body></html>`;

/** 喂回去的请求计数（每建一个页面重置）。三笔各证明一件事：
 *   apiManifest  —— 先问 API 那条路（后台重建的产物优先）
 *   seedManifest —— API 缺席时回落到仓库里那份种子
 *   artifact     —— 真的去拉了产物（第 9 节里它必须保持 0：不是本站就**连拉都不拉**） */
interface Hits {
  apiManifest: number;
  seedManifest: number;
  artifact: number;
}

interface WGPage {
  ctx: Awaited<ReturnType<Browser["newContext"]>>;
  page: Page;
  errors: string[];
  hits: Hits;
}

/** `foreignSite` = 喂回去的 manifest 原样署名（committed 那份 `https://saudade.site`），
 * 给第 9 节验"别人的产物不画"用；默认改写成本沙箱页面自己的 origin
 * （= "产物属于本站"，正是生产上重建完的情形）。见模块头注那两条必须先喂回去的事实。 */
async function newPage(
  browser: Browser,
  manifest: Record<string, string>,
  artifact: string,
  js: string,
  opts: { reducedMotion?: "reduce"; foreignSite?: boolean } = {},
): Promise<WGPage> {
  const ctx = await browser.newContext({
    viewport: { width: 900, height: 700 },
    reducedMotion: opts.reducedMotion,
  });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(`console.error: ${m.text()}`);
  });
  const served = opts.foreignSite
    ? manifest
    : { ...manifest, site: PAGE_ORIGIN };
  const hits: Hits = { apiManifest: 0, seedManifest: 0, artifact: 0 };

  // 整个源都由内存喂：页面本身 + /graph/*。**必须 goto 一个真 URL 而不是
  // setContent**——about:blank 没有 base URL，loader 里的相对 fetch 会直接
  // "Failed to parse URL"（而且那样也就验不到相对路径拼得对不对了）。
  await page.route("**/*", (route) => {
    const p = route.request().url().split("?", 1)[0];
    if (p.endsWith("/api/public/graph/manifest")) {
      // 本沙箱没有 Rust/agent ⇒ 这条路的答案是"本站还没有服务端产物"，
      // 而它在生产上就是 **200 + `{}`**（见 src/routes/graph.rs 的头注：首页每次
      // 加载都问一次，做成 404 会让每个访客的控制台多一条红字）。
      // 于是 loader 的**回落**那条腿被真的走了一遍（计数见 hits）。
      hits.apiManifest++;
      void route.fulfill({
        status: 200,
        contentType: "application/json",
        body: "{}",
      });
    } else if (p.endsWith("/graph/manifest.json")) {
      hits.seedManifest++;
      void route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(served),
      });
    } else if (
      p.endsWith(`/graph/${manifest.file}`) ||
      p.endsWith(`/api/public/graph/artifact/${manifest.file}`)
    ) {
      hits.artifact++;
      void route.fulfill({
        status: 200,
        contentType: "text/javascript",
        body: artifact,
      });
    } else {
      void route.fulfill({ status: 200, contentType: "text/html", body: PAGE });
    }
  });
  await page.goto(PAGE_URL);
  // 计数器必须在 engine 构造之前装上
  await page.evaluate(() => {
    (window as any).__raf = 0;
    const orig = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = (cb: FrameRequestCallback) => {
      (window as any).__raf++;
      return orig(cb);
    };
  });
  await page.addScriptTag({ content: js });
  await page.waitForFunction(() => !!(window as any).WG);
  return { ctx, page, errors, hits };
}

/** 画布统计（非透明像素数 / 颜色档数 / 质心），在页面里算，避免把几十万像素搬过 CDP。 */
const stats = (pg: Page) =>
  pg.evaluate(() => {
    const cv = document.getElementById("c") as HTMLCanvasElement;
    const d = cv.getContext("2d")!.getImageData(0, 0, cv.width, cv.height).data;
    let n = 0;
    let sx = 0;
    let sy = 0;
    const colors = new Set<number>();
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] > 8) {
        n++;
        const p = i >> 2;
        sx += p % cv.width;
        sy += Math.floor(p / cv.width);
        colors.add(
          (d[i] >> 5) * 1000000 + (d[i + 1] >> 5) * 1000 + (d[i + 2] >> 5),
        );
      }
    }
    return { n, colors: colors.size, cx: n ? sx / n : 0, cy: n ? sy / n : 0 };
  });

/** 快照当前画布（与 JS_DIFF 配对）。 */
const snap = (pg: Page) =>
  pg.evaluate(() => {
    const cv = document.getElementById("c") as HTMLCanvasElement;
    (window as any).__prev = new Uint8ClampedArray(
      cv.getContext("2d")!.getImageData(0, 0, cv.width, cv.height).data,
    );
  });

// "画面变了没有"用**逐像素差异**而不是质心位移：点云近似一个球，转它的时候
// 亮的像素在球面上换了一批，质心却几乎不动（实测拖动 120px 只移动 4.9px < 5）。
// 差异比例才是"画面确实换了"的忠实度量。
const diff = (pg: Page) =>
  pg.evaluate(() => {
    const cv = document.getElementById("c") as HTMLCanvasElement;
    const cur = cv.getContext("2d")!.getImageData(0, 0, cv.width, cv.height).data;
    const prev = (window as any).__prev as Uint8ClampedArray;
    let ch = 0;
    for (let i = 0; i < cur.length; i += 4) {
      if (
        Math.abs(cur[i] - prev[i]) +
          Math.abs(cur[i + 1] - prev[i + 1]) +
          Math.abs(cur[i + 2] - prev[i + 2]) >
        24
      )
        ch++;
    }
    return ch / (cur.length / 4);
  });

test("词图谱渲染：首绘/空闲零 rAF/拖动/定位居中/命中测试/近平面热边/滚轮归属/reduced-motion/语料归属闸", async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const mf = path.join(GRAPH_DIR, "manifest.json");
  if (!existsSync(mf)) {
    throw new Error("找不到 public/graph/manifest.json——先跑 scripts/build_word_graph.py");
  }
  const manifest = JSON.parse(readFileSync(mf, "utf-8")) as Record<string, string>;
  const artifact = readFileSync(
    path.join(GRAPH_DIR, manifest.file),
    "utf-8",
  );
  const js = await bundle();

  // ══ 1. 首次绘制 ══
  const w1 = await newPage(browser, manifest, artifact, js);
  const page = w1.page;
  await page.evaluate(async () => {
    const WG = (window as any).WG;
    const data = await WG.loadGraph();
    const cv = document.getElementById("c")!;
    (window as any).__eng = new WG.WordGraphEngine(cv, data, {});
    (window as any).__data = data;
  });
  await page.waitForTimeout(500);
  const s1 = await stats(page);
  expect.soft(s1.n, "画布画出了内容（非透明像素 > 2000）").toBeGreaterThan(2000);
  expect.soft(s1.colors, "至少 2 种颜色（点按文章着色）").toBeGreaterThanOrEqual(2);
  expect.soft(w1.errors, "首屏无 console error / pageerror").toEqual([]);
  // loader 的两条腿各走了一次（20261003）：先问 API（重建产物优先），API 说"还没有"
  // 再回落仓库里的种子。计数而不是打桩 —— 这条判据读的是**真发出去的请求**。
  expect.soft(w1.hits.apiManifest, "先问 API 那条路（后台重建的产物优先）").toBe(1);
  expect.soft(w1.hits.seedManifest, "API 缺席时回落到仓库里那份种子").toBe(1);
  expect.soft(w1.hits.artifact, "产物只拉一次（模块级缓存在起作用）").toBe(1);

  // ══ 2. 空闲 3 秒 rAF 必须为 0（性能硬门槛）══
  const a2 = await page.evaluate(() => (window as any).__raf);
  await page.waitForTimeout(3000);
  const b2 = await page.evaluate(() => (window as any).__raf);
  expect.soft(b2 - a2, "空闲 3s 内 rAF 计数增量为 0").toBe(0);

  // ══ 3. 拖动改变画面 ══
  await snap(page);
  const cam0 = await page.evaluate(() => (window as any).__eng.getCamera());
  await page.mouse.move(400, 350);
  await page.mouse.down();
  for (let x = 400; x < 520; x += 20) {
    await page.mouse.move(x, 360);
  }
  await page.mouse.up();
  await page.waitForTimeout(300);
  const changed = await diff(page);
  const cam1 = await page.evaluate(() => (window as any).__eng.getCamera());
  expect
    .soft(Math.abs(cam1.yaw - cam0.yaw), "拖动改变了 yaw")
    .toBeGreaterThan(0.1);
  expect
    .soft(changed, "拖动后 >2% 的像素发生变化（画面真的重绘了）")
    .toBeGreaterThan(0.02);
  expect
    .soft(
      cam1.pitch === Math.max(-1.35, Math.min(1.35, cam1.pitch)),
      "pitch 在夹紧范围内",
    )
    .toBe(true);

  // ══ 4. 定位：视图朝命中簇移动且把簇摆到中心 ══
  // 查询词特意选多命中且**空间上散开**的：只命中一个词的话"簇摆正"是恒真的
  // （质心就是那一个点本身），取景系数再错也测不出来。'异步编程' 只命中「异步」，
  // 测不出东西——用它跑过一版，断言是绿的但等于没测。
  await page.evaluate(() => {
    const WG = (window as any).WG;
    (window as any).__eng.home(0);
    const hits = WG.locateLocal("线程协程并发", (window as any).__data);
    (window as any).__hits = hits;
    (window as any).__eng.setHighlight(hits);
    (window as any).__eng.flyTo(
      WG.cameraFor(
        (window as any).__data,
        hits,
        (window as any).__eng.getCamera(),
      ),
    );
  });
  await page.waitForTimeout(1000); // 飞行动画 720ms
  const cam2 = await page.evaluate(() => (window as any).__eng.getCamera());
  expect
    .soft(
      Math.abs(cam2.target[0]) + Math.abs(cam2.target[1]) + Math.abs(cam2.target[2]),
      "定位后相机 target 离开了原点",
    )
    .toBeGreaterThan(1e-6);
  const homeDist = await page.evaluate(
    () => (window as any).WG.HOME_CAM.dist,
  ); // 别写死：默认机位会随实测调整
  expect
    .soft(cam2.dist, "定位后推近了（dist < 首页机位）")
    .toBeLessThan(homeDist - 1e-6);
  const placed = await page.evaluate(() => {
    const WG = (window as any).WG;
    const d = (window as any).__data;
    const cam = (window as any).__eng.getCamera();
    const p = new WG.Projection(d.nodes.length);
    WG.projectNodes(d.nodes, cam, 620, 460, p);
    const idx = (window as any).__hits
      .map((h: { w: string }) => d.nodes.findIndex((n: { w: string }) => n.w === h.w))
      .filter((i: number) => i >= 0);
    let sx = 0;
    let sy = 0;
    let spread = 0;
    for (const i of idx) {
      sx += p.x[i];
      sy += p.y[i];
    }
    for (const i of idx) {
      for (const j of idx) {
        const a = d.nodes[i];
        const b = d.nodes[j];
        spread = Math.max(spread, Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z));
      }
    }
    return {
      n: idx.length,
      cx: sx / idx.length,
      cy: sy / idx.length,
      spread,
      words: (window as any).__hits.map((h: { w: string }) => h.w),
    };
  });
  expect.soft(placed.n, "命中 ≥3 个词（'线程协程并发'）").toBeGreaterThanOrEqual(3);
  // 阈值只要"远大于同一个点"即可——这条是**防恒真**，不是测布局质量：命中簇
  // 塌成一个点时质心居中就成了同义反复。20260917 换 UMAP 后 线程/协程/并发 从
  // 0.19 收到 0.135（相关词更聚，正是换布局的目的），阈值随之从 0.15 放到 0.08。
  expect
    .soft(placed.spread, "命中簇在世界空间里是散开的（否则居中检查恒真）")
    .toBeGreaterThan(0.08);
  expect
    .soft(
      Math.abs(placed.cx - 310) < 60 && Math.abs(placed.cy - 230) < 60,
      "命中簇的投影质心落在画面中心附近（±60px）",
    )
    .toBe(true);

  const s4 = await stats(page);
  expect.soft(s4.n, "定位后画面仍有内容（没被清空）").toBeGreaterThan(2000);

  // ══ 5. 定位动画 + 辉光结束后，rAF 必须重新归零 ══
  await page.waitForTimeout(2400); // 辉光 1.8s
  const a5 = await page.evaluate(() => (window as any).__raf);
  await page.waitForTimeout(2000);
  const b5 = await page.evaluate(() => (window as any).__raf);
  expect.soft(b5 - a5, "定位过后仍能回到零 rAF（脉冲是有限的）").toBe(0);

  // ══ 6. 悬停读数 / 命中测试 ══
  const hit = await page.evaluate(() => {
    const WG = (window as any).WG;
    const d = (window as any).__data;
    const p = new WG.Projection(d.nodes.length);
    const cam = { yaw: 0, pitch: 0, dist: 5, target: [0, 0, 0] };
    WG.projectNodes(d.nodes, cam, 620, 460, p);
    // 挑"屏幕空间最孤立的点"来验命中：pickNode 取命中半径内**离相机最近**的那个，
    // 20260917 换成 UMAP 布局后点挨得更近（22% 的点与邻居距离 <0.02），拿固定下标
    // 当靶子会合法地命中邻居、把断言弄红——要测的是"点得中"，不是"点 0 号中 0 号"。
    let best = -1;
    let bestGap = -1;
    for (let i = 0; i < d.nodes.length; i++) {
      if (p.d[i] <= 0.05) continue;
      let gap = Infinity;
      for (let j = 0; j < d.nodes.length; j++) {
        if (i === j || p.d[j] <= 0.05) continue;
        gap = Math.min(gap, Math.hypot(p.x[i] - p.x[j], p.y[i] - p.y[j]));
      }
      if (gap > bestGap) {
        bestGap = gap;
        best = i;
      }
    }
    const i = WG.pickNode(p, p.x[best], p.y[best]);
    const j = WG.pickNode(p, p.x[best] + 500, p.y[best]);
    return { same: i === best, off: j, best, gap: Math.round(bestGap * 10) / 10 };
  });
  expect.soft(hit.same, "孤立点的像素处命中的就是它自己").toBe(true);
  expect.soft(hit.off, "远偏移处不命中").toBe(null);

  // ══ 6b. 邻居被推到相机后方时，热边仍要画出来（近平面裁剪）══
  // 画布调用录音器：把 moveTo/lineTo/stroke 的坐标与当时的描边色记下来，用来验
  // "热边在近平面裁剪下仍然被画出来"——这条只能在真实 ctx 调用层观察
  // （像素法分不清"线被裁短"和"线整条没了"）。
  await page.evaluate(() => {
    const w = window as any;
    if (w.__recInstalled) {
      w.__rec.strokes = [];
      w.__rec.bad = 0;
      w.__rec.texts = [];
      return;
    }
    w.__recInstalled = true;
    w.__rec = { strokes: [], bad: 0, texts: [] };
    const P = CanvasRenderingContext2D.prototype as any;
    const ob = P.beginPath;
    const om = P.moveTo;
    const ol = P.lineTo;
    const os = P.stroke;
    let segs = 0;
    P.beginPath = function () {
      segs = 0;
      return ob.call(this);
    };
    const chk = (x: number) => {
      if (!isFinite(x) || Math.abs(x) > 1e5) w.__rec.bad++;
    };
    P.moveTo = function (x: number, y: number) {
      segs++;
      chk(x);
      return om.call(this, x, y);
    };
    P.lineTo = function (x: number, y: number) {
      segs++;
      chk(x);
      return ol.call(this, x, y);
    };
    P.stroke = function () {
      w.__rec.strokes.push({ style: String(this.strokeStyle), segs });
      return os.call(this);
    };
    const oft = P.fillText;
    P.fillText = function (t: string, x: number, y: number) {
      w.__rec.texts.push(String(t));
      return oft.call(this, t, x, y);
    };
  });
  const picked = await page.evaluate(() => {
    const d = (window as any).__data;
    const eng = (window as any).__eng;
    const deg = new Map<number, number>();
    for (const e of d.edges) {
      deg.set(e[0], (deg.get(e[0]) || 0) + 1);
      deg.set(e[1], (deg.get(e[1]) || 0) + 1);
    }
    let sel = -1;
    let nb = -1;
    for (const e of d.edges) {
      if ((deg.get(e[0]) || 0) >= 2) {
        sel = e[0];
        nb = e[1];
        break;
      }
    }
    if (sel < 0) return null;
    eng.setSelected(sel);
    const a = d.nodes[sel];
    const b = d.nodes[nb];
    // 相机摆成"看向 nb、眼睛落在 nb 前 0.02"：nb 的 depth = 0.02 ≤ NEAR（已在近平面内），
    // sel 的 depth = |nb−sel|+0.02 > NEAR（仍在相机前方）—— 正是用户顺着高亮线飞过去的那一刻
    const L = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z) || 1;
    const dir = [(b.x - a.x) / L, (b.y - a.y) / L, (b.z - a.z) / L];
    const pitch = Math.asin(Math.max(-1, Math.min(1, dir[1])));
    const yaw = Math.atan2(dir[0], dir[2]);
    const eye = [b.x + dir[0] * 0.02, b.y + dir[1] * 0.02, b.z + dir[2] * 0.02];
    const dist = eng.getCamera().dist;
    eng.flyTo(
      {
        yaw,
        pitch,
        dist,
        target: [
          eye[0] - dir[0] * dist,
          eye[1] - dir[1] * dist,
          eye[2] - dir[2] * dist,
        ],
      },
      0,
    );
    return { sel, nb };
  });
  await page.waitForTimeout(300);
  expect
    .soft(picked, "找到可测的选中点 + 邻居")
    .toBeTruthy();
  if (picked) {
    const rec = await page.evaluate(
      () => (window as any).__rec as { strokes: Array<{ style: string; segs: number }>; bad: number; texts: string[] },
    );
    const hot = rec.strokes.filter(
      (st) => st.style.includes(EDGE_HOT_RGB) && st.segs > 0,
    );
    expect
      .soft(
        hot.length > 0,
        "邻居落在近平面内时热边仍然被绘制（旧实现是整条丢）",
      )
      .toBe(true);
    expect.soft(rec.bad, "没有任何线段坐标落到 FAR_X（−1e6）上").toBe(0);
  }

  // ══ 6c. 悬浮时，邻居的名字也画在点上（N 层由悬停驱动）══
  // ⚠️ 这条必须挑一个"不悬浮时确实没有名字"的邻居——否则 A 层（重要度前 22 常驻）
  //    或 B 层（按深度补位）早就把它画上了，断言会**空转**（第一版就是这么空转的：
  //    挑中的 Bearer 本来就在 A 层里，把引擎改动暂存掉测试照样绿）。
  await page.evaluate(() => {
    (window as any).__rec.texts = [];
  });
  await page.mouse.move(3, 3); // 先把光标挪开，取"没有悬浮"的基线
  await page.waitForTimeout(250);
  const base: string[] = await page.evaluate(
    () => (window as any).__rec.texts,
  );
  const pick = await page.evaluate((baseline: string[]) => {
    const WG = (window as any).WG;
    const d = (window as any).__data;
    const eng = (window as any).__eng;
    const cv = document.getElementById("c") as HTMLCanvasElement;
    const w = cv.clientWidth;
    const h = cv.clientHeight;
    eng.setSelected(null);
    const p = new WG.Projection(d.nodes.length);
    WG.projectNodes(d.nodes, eng.getCamera(), w, h, p);
    const inside = (i: number) =>
      p.d[i] > 0.05 && p.x[i] > 24 && p.x[i] < w - 24 && p.y[i] > 24 && p.y[i] < h - 24;
    for (const e of d.edges) {
      for (const [a, b] of [
        [e[0], e[1]],
        [e[1], e[0]],
      ]) {
        if (!inside(a) || !inside(b)) continue;
        if (baseline.includes(d.nodes[b].w)) continue; // 不悬浮时就有名字 ⇒ 测不出 N 层
        if (d.nodes[a].w === d.nodes[b].w) continue;
        return { x: p.x[a], y: p.y[a], wa: d.nodes[a].w, wb: d.nodes[b].w };
      }
    }
    return null;
  }, base);
  expect
    .soft(pick, "找到一对「悬浮才有名字」的邻居（A/B 层不会提前画它）")
    .toBeTruthy();
  if (pick) {
    await page.mouse.move(pick.x, pick.y);
    await page.waitForTimeout(350);
    const texts: string[] = await page.evaluate(
      () => (window as any).__rec.texts,
    );
    expect
      .soft(
        texts.includes(pick.wb),
        `悬浮 ${pick.wa} 时，邻居 ${pick.wb} 的名字被画到画布上（不悬浮时没有）→ 基线里已有=${base.includes(pick.wb)}`,
      )
      .toBe(true);
    expect
      .soft(texts.includes(pick.wa), "被悬浮那个词自己的名字也在")
      .toBe(true);
  }

  // ══ 8. 滚轮归画布：缩放图谱、页面不动 ══
  // ⚠️ 20261002 反转了：这里是"锁定态"的判据，而锁定整套已按用户要求删除
  // （"不需要锁定功能和按钮了"）⇒ 断言从"锁定时滚轮穿透到页面"改成下面这两条。
  // 页面为什么还能正常滚：靠外壳的 `.vitrine:not(.is-zoomed) .vit-body{pointer-events:none}`
  // （见 Vitrine/index.sass），滚轮也是指针事件 ⇒ 未放大时根本到不了画布。
  // 那个规则在真实页面里成立、在这里**不成立**（本页只有一张裸画布，没有 `.vit-body` 祖先），
  // 所以这条腿只能验引擎这一半：画布吃到滚轮 ⇒ 缩放 + preventDefault。
  await page.evaluate(() => {
    window.scrollTo(0, 0);
  });
  const d0 = await page.evaluate(
    () => (window as any).__eng.getCamera().dist,
  );
  await page.mouse.move(310, 230);
  await page.mouse.wheel(0, 300);
  await page.waitForTimeout(300);
  const sc1 = await page.evaluate(() => window.scrollY);
  const d1 = await page.evaluate(
    () => (window as any).__eng.getCamera().dist,
  );
  expect.soft(d1 !== d0, "滚轮改的是相机 dist（缩放/穿云）").toBe(true);
  expect
    .soft(sc1, "页面不被滚轮带走（onWheel 里 preventDefault 生效）")
    .toBe(0);

  // ══ 8b. 拖拽改机位（没有锁定态挡着了）══
  // 同样反转自旧的"锁定时拖拽不改变机位"。现在引擎没有 `locked` 这道闸，
  // 指针事件到达画布就一定生效——第三、四条的性能前提是"出帧只由交互驱动"，
  // 这条坏掉的话图谱会变成一块不吃任何操作的静态图。
  const cam0b = await page.evaluate(() => (window as any).__eng.getCamera());
  await page.mouse.move(300, 220);
  await page.mouse.down();
  for (let x = 300; x < 420; x += 20) {
    await page.mouse.move(x, 230);
  }
  await page.mouse.up();
  await page.waitForTimeout(200);
  const cam1b = await page.evaluate(() => (window as any).__eng.getCamera());
  expect
    .soft(cam1b.yaw !== cam0b.yaw, "拖拽改变机位（onDown/onMove 生效）")
    .toBe(true);

  expect.soft(w1.errors, "全程无 console error / pageerror").toEqual([]);
  await w1.ctx.close();

  // ══ 7. prefers-reduced-motion ══
  const w7 = await newPage(browser, manifest, artifact, js, {
    reducedMotion: "reduce",
  });
  const p7 = w7.page;
  await p7.evaluate(async () => {
    const WG = (window as any).WG;
    const data = await WG.loadGraph();
    const cv = document.getElementById("c")!;
    const eng = new WG.WordGraphEngine(cv, data, {});
    const hits = WG.locateLocal("线程", data);
    eng.setHighlight(hits);
    eng.flyTo(WG.cameraFor(data, hits, eng.getCamera())); // 应当瞬移
    (window as any).__eng2 = eng;
  });
  await p7.waitForTimeout(400);
  const cam3 = await p7.evaluate(() => (window as any).__eng2.getCamera());
  const homeDist2 = await p7.evaluate(() => (window as any).WG.HOME_CAM.dist);
  expect
    .soft(cam3.dist, "reduced-motion 下 flyTo 直接到位（不走动画）")
    .toBeLessThan(homeDist2 - 1e-6);
  const s7 = await stats(p7);
  expect.soft(s7.n, "reduced-motion 下照常渲染").toBeGreaterThan(2000);
  expect.soft(w7.errors, "reduced-motion 下无报错").toEqual([]);
  await w7.ctx.close();

  // ══ 9. 别人的产物不画（运行期语料归属闸）══
  // 20261003 那道语料归属闸从构建期搬到了运行期（判据见 `loader.ts::siteMatches`）。
  // 搬家的理由是"别人用不了"：构建期比的是构建机上的 SITE_URL，迁移到新域名的人
  // **永远**过不了闸。搬完之后必须确认它仍然拦得住——这正是本节。
  //
  // 这里 manifest **原样喂**（foreignSite）：committed 那份署名 `https://saudade.site`，
  // 而页面住在 `http://vitrine.test` ⇒ 判据必须拒绝。两条腿都要验：
  //   ① `loadGraph()` 抛 `SiteMismatchError`（不是别的错，也不是静默画出来）；
  //   ② **产物一个字节都没被请求**——归属判断在取产物**之前**。"先下载了再判断"
  //      等于先把别人的文章搬进访客的浏览器，那是这道闸唯一真正要防的事。
  const w9 = await newPage(browser, manifest, artifact, js, { foreignSite: true });
  const p9 = w9.page;
  await p9.evaluate(async () => {
    (window as any).__err = null;
    try {
      await (window as any).WG.loadGraph();
    } catch (e) {
      (window as any).__err = { name: (e as Error).name, msg: String((e as Error).message) };
    }
  });
  const err = await p9.evaluate(() => (window as any).__err);
  expect
    .soft(
      err !== null && err.name === "SiteMismatchError",
      "产物不属于本站 ⇒ loadGraph 抛 SiteMismatchError",
    )
    .toBe(true);
  expect
    .soft(w9.hits.artifact, "★ 归属判断在**取产物之前**：别人的产物一个字节都没下载")
    .toBe(0);
  expect
    .soft(w9.hits.seedManifest, "manifest 本身照读（判据靠它，不靠猜）")
    .toBe(1);
  expect.soft(w9.errors, "全程无 console error").toEqual([]);
  await w9.ctx.close();
});
