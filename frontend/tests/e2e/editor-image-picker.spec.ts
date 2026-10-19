import { test, expect, type Browser, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  FE_DIR,
  withSandbox,
  esbuildInSandbox,
  collectPageErrors,
  htmlDoc,
} from "./sandbox";

/**
 * 编辑器那颗图片按钮：改成「图库优先，也能电脑本地上传」的无头验收（20261006，用户要求）。
 * （原 tests/editor-image-picker.test.py，20261019 迁移）
 *
 * 用户原话：「编辑文章时，编辑栏顶部图片那个按钮改为优先展示服务器上的图库，也可以电脑本地上传。」
 *
 * 那颗按钮是 bytemd 的**内置 action**（左组第 6 颗，`leftActions[5]`），点下去直接弹系统文件
 * 选择框；bytemd 没有任何口子能换掉它（插件 action 只能追加到末尾；不传 `uploadImages` 会连
 * 拖拽/粘贴上传一起关掉 —— 这三条前提由 `editor-image-button.test.mjs` 读源码钉住）。所以做法
 * 是：按钮原样留着，`src/components/Editor/index.tsx` 在**捕获阶段**拦下它的 click，改开我们
 * 自己的图库弹窗。
 *
 * "拦住了"这件事**只有真跑一遍才看得见** —— 静态读源码只能证明 `stopPropagation` 写在那个
 * 位置上，证明不了它真把 svelte 那个冒泡 handler 拦下了。本文件锁的就是它：
 *
 *   · 第一节：点那颗按钮**不许再弹系统文件框**。真负控 = 另打一份把 `e.stopPropagation()`
 *     抹掉的包，同一次点击**必须**触发 `filechooser`。少了这条负控，"没有 filechooser"可能
 *     只是因为沙箱里压根点不着那颗按钮（假绿）。
 *   · 第二节：弹窗优先是图库（默认页签「图库」、网格条数 = 桩数据条数、卡下面是展示名）。
 *     缩略图 src 必须是 **CDN 化后**的地址（本沙箱把 `VITE_CDN_BASEURL` 设成
 *     `https://cdn.example.com`；真站现在是空的 —— 空的时候这条重写规则等于不存在，断言会
 *     退化成"跟原始串一样"，所以这里必须非空）。
 *   · 第三节：选中一张 ⇒ 写进正文的是**库里那个原始串**（`/api/protect/download/…`，不是 CDN
 *     化后的），形态与 bytemd 自己插图逐字节一样（空文档 ⇒ `"\n![](url)"`），光标落回那一行。
 *     ⚠️ 用原生串是有后果的：写进正文的是 CDN 化地址的话，换公开域名之后
 *     `src/routes/upload.rs` 的删除判据就再也认不出这张图属于哪个桶了。
 *   · 第四节：本地上传那条路还在（点选 ⇒ 同一个上传函数 ⇒ 同样插进正文），且**上传被拒时
 *     正文一个字符都不变**。这一节的负控 = 另打一份把判据还原成修前那句
 *     `response.status !== 200` 的包（本仓失败是 HTTP 200 + code:500 ⇒ 那句恒真），它**必须**
 *     把 `![]()` 插进正文。
 *   · 第五节：图库为空 / 读不到时给的是人话，且「本地上传」仍然可用（不能把人卡死）。
 *   · 第六节：文件名里带**半角空格**时，插进正文的必须是编码后的地址（用户那张图不渲染的
 *     病根：CommonMark 的 link destination 不允许空白字符 ⇒ 整段退化成纯文本，一个 `<img>`
 *     都没生成）。负控 = 另打一份把 `encodeAssetUrl` 改成**恒等**的包，正文里必须出现裸空格。
 *
 * 见 CLAUDE.md §2：本机不能 vite build。esbuild 把**真组件**打成 bundle、只桩一个边界
 * （`src/apis/axios.tsx`）。三个必踩的坑：① 桩必须是**可调用对象**（`ImageMethods` 调的是
 * `http({...})`，别的模块调 `http.get(...)`）；② 假响应一律深拷贝（同一个数组引用会被 React
 * 的 Object.is 判等拦下 ⇒ 界面纹丝不动）；③ 样式用 text loader 吞成字符串、再由沙箱
 * **手工注入** `bytemd/dist/index.css` 与组件的 `index.css` —— 绕开 `katex/dist/katex.css` 里
 * 那些 `url(fonts/*.woff2)`（不绕就得给 esbuild 补字体 loader）。本机无中文字体（汉字渲染成
 * 豆腐块），断言全走数值、条数、class 与文档内容。
 */

const CDN = "https://cdn.example.com";
const DEFINE = JSON.stringify({
  VITE_HTTP_BASEURL: "",
  VITE_CDN_BASEURL: CDN,
  MODE: "production",
  DEV: false,
  PROD: true,
  BASE_URL: "/",
});
const LOADERS = {
  ".sass": "text",
  ".css": "text",
  ".png": "dataurl",
  ".svg": "dataurl",
} as const;
const RESET_CSS = "html,body,#root{height:100%;margin:0}*{box-sizing:border-box}";

// ── 夹具：三条覆盖三种形态（本地盘路径 / R2 绝对地址 / 不带时间戳前缀的旧名）────────────
// (imageKey, 盘上的 url)。测试侧与 JS 侧（ENTRY 里）同名同序同值。
const FIX = [
  { imageKey: 901, imageUrl: "/api/protect/download/20260912013218_EMQX.png" },
  { imageKey: 902, imageUrl: "https://img.example.com/gallery/20261006000000_sunset.png" },
  { imageKey: 903, imageUrl: "/api/protect/download/old_pic.png" },
];
const PICK = FIX[0].imageUrl;                                             // 图库里点的那一张
const LOCAL_URL = "/api/protect/download/20261006000000_local.png";       // 本地上传接口回的 url

const FAKE_AXIOS = `
const calls: any[] = (window as any).__calls = [];
(window as any).__axiosStub = true;

const env = (data: any) => ({ status: 200, data: { code: 200, message: 'ok', data } });
const raw = (body: any) => ({ status: 200, data: body });
// ⚠️ 深拷贝：真 HTTP 每次都反序列化出一个新对象，这里面的数组是同一个引用 ⇒ 直接回引用会被
// React 的 Object.is 判等拦下、**不触发重渲染**，症状是"请求成功了但列表是空的"。
const wire = (d: any) => (d == null ? d : JSON.parse(JSON.stringify(d)));
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

const req = async (cfg: any) => {
  const url = cfg.url as string;
  const method = (cfg.method || 'GET').toUpperCase();
  const isForm = typeof FormData !== 'undefined' && cfg.data instanceof FormData;
  calls.push({
    url, method,
    // FormData 序列化出来是 {}，所以单记一份文件名 —— 上传断言靠它
    form: isForm ? { field: 'file', name: (cfg.data.get('file') as File)?.name || '' } : null,
    // 查询串（图库分页的游标与页大小都从这里断言；别的接口不带 params ⇒ null）
    params: cfg.params || null,
  });
  await delay(20);
  if (url === '/api/protect/images') {
    if ((window as any).__imgFail) return raw({ code: 500, message: '图库读取失败', data: '' });
    // 20261014：这条桩要**照着真接口的语义答** —— 真接口认 \`image_key < before\` 与 \`limit\`。
    // 桩若无视查询串（照旧整份回），分页那一节就会在"每页都是全量"的假世界里变绿。
    const all = ((window as any).__images as any[]) || [];
    const p = cfg.params || {};
    let rows = all;
    if (p.before != null) rows = rows.filter((r) => r.imageKey < p.before);
    if (p.limit != null) rows = rows.slice(0, p.limit);
    return env(wire(rows));
  }
  if (url === '/api/protect/upload') {
    if ((window as any).__upFail) return raw({ code: 500, message: 'R2 配额已满，暂时不能上传', data: '' });
    return env((window as any).__uploadUrl);
  }
  return env(null);
};

// ⚠️ 必须是**可调用对象**：\`src/apis/ImageMethods.tsx\` 写的是 \`http({ url, method })\`
// （默认导出当函数用），而别的模块写 \`http.get(...)\`。只做一种，另一种就是
// \`undefined is not a function\`，且组件里的 \`.catch\` 之后没有任何提示 ⇒ 空列表/白屏。
const http: any = (cfg: any) => req(cfg);
http.get = (url: string, cfg?: any) => req({ ...(cfg || {}), url, method: 'GET' });
http.post = (url: string, data?: any, cfg?: any) => req({ ...(cfg || {}), url, data, method: 'POST' });
http.put = (url: string, data?: any, cfg?: any) => req({ ...(cfg || {}), url, data, method: 'PUT' });
http.delete = (url: string, cfg?: any) => req({ ...(cfg || {}), url, method: 'DELETE' });
export default http;
`;

const entryTsx = (localUrl: string) => `
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import Editor_ from './src/components/Editor/index.tsx';

// 夹具（与测试侧同序同值）
const FIX = [
  { imageKey: 901, imageUrl: '/api/protect/download/20260912013218_EMQX.png' },
  { imageKey: 902, imageUrl: 'https://img.example.com/gallery/20261006000000_sunset.png' },
  { imageKey: 903, imageUrl: '/api/protect/download/old_pic.png' },
];
(window as any).__images = FIX;
(window as any).__uploadUrl = '${localUrl}';
(window as any).__imgFail = false;
(window as any).__upFail = false;

// 探针：直接问 CodeMirror 要正文与光标（与 React 状态无关，组件换写法也读得到）
const CM = () => (document.querySelector('.CodeMirror') as any).CodeMirror;
(window as any).__doc = () => CM().getValue();
// ⚠️ \`getSelection()\` 在 CodeMirror 5 里回的是**字符串**；要光标位置得用 listSelections()
//    拿 {anchor, head}（这条踩过：读到字符串 → 断言里 .get() 直接抛 AttributeError）。
(window as any).__sel = () => CM().listSelections()[0];

// 受控组件：模拟 NewNotes 的 setNoteContent（自动保存挂的就是它）。onChange 有没有被调到，
// 决定正文能不能存下来 —— 所以顺带记一笔。
const App = () => {
  const [v, setV] = React.useState('');
  return (
    // 容器要 >800px：bytemd 的 split 判据是 \`containerWidth >= 800\`，不到 800 时左组渲染的是
    // 「书写/预览」两个页签，**我们的拦截器在那个形态下不会命中**（见 mjs 第 ② 组）。
    <div style={{ width: 1200 }}>
      <Editor_
        noteContent={v}
        setNoteContent={(next: string) => {
          (window as any).__onChangeCount = ((window as any).__onChangeCount || 0) + 1;
          (window as any).__lastValue = next;
          setV(next);
        }}
      />
    </div>
  );
};

(window as any).__mount = () =>
  createRoot(document.getElementById('root')!).render(<App />);
`;

/** 负控包的字符串手术：**锚点必须唯一命中**，否则当场报错退出。
 *
 * 锚点失配 = 组件写法变了 ⇒ 这一节的负控证明不了任何事（会静默退化成"再打一份一样的包"）。
 * 红基线一律写成**内嵌字面量**，不读 `git show HEAD`（那会把测试钉死在某次提交上）。
 */
function mutate(rel: string, anchor: string, repl: string, why: string): string {
  const s = readFileSync(path.join(FE_DIR, "src", rel), "utf-8");
  const n = s.split(anchor).length - 1;
  if (n !== 1) {
    throw new Error(
      `负控锚点失配（${why}）：\`${anchor}\` 在 ${rel} 里命中 ${n} 处（应为 1）` +
        "—— 写法变了，本节的负控要先跟着改",
    );
  }
  return s.replace(anchor, repl);
}

// 页大小取自**唯一那一份**常数（`apis/ImageMethods.tsx`）：这里写死 60 就等于把契约抄成两份，
// 改了实现而没改这里的话，第七节的夹具会静默变得不再"大于一页"（那才是真正的假绿）。
const PAGE_SIZE = Number(
  readFileSync(path.join(FE_DIR, "src/apis/ImageMethods.tsx"), "utf-8").match(
    /GALLERY_PAGE_SIZE\s*=\s*(\d+)/,
  )?.[1],
);
// 服务端按 `image_key DESC` 出，>一页才谈得上续拉；多出的 5 张正是"最后一页"
const BIG = Array.from({ length: PAGE_SIZE + 5 }, (_, i) => ({
  imageKey: 3000 - i,
  imageUrl: `/api/protect/download/p${3000 - i}.png`,
}));

// 内置图片按钮（左组下标 5）。**必须带左组前缀**：右组下标 5 是「源码」那颗按钮。
const IMG = '.bytemd-toolbar-left > .bytemd-toolbar-icon[bytemd-tippy-path="5"]';
const FILE_INPUT = ".editor-image-picker-upload input[type=file]";
const MORE = ".editor-image-picker-more button";
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from("0".repeat(64)),
]);

interface Mounted {
  page: Page;
  errs: () => string[];
  choosers: number[];
}

async function mount(
  browser: Browser,
  opts: { url?: string; images?: unknown[] } = {},
): Promise<Mounted> {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
  });
  const errs = collectPageErrors(page);
  const choosers: number[] = [];
  // filechooser 记账挂在 mount 上（不是每次点击现挂，免得监听器越叠越多）；
  // 收到就必须 setFiles 收尾，否则那个 `<input type=file>` 一直等着人点。
  page.on("filechooser", (c) => {
    choosers.push(1);
    void c.setFiles([]);
  });
  page.setDefaultTimeout(15000); // 失败要快 —— 默认 30s 会把一次失误拖成半分钟
  await page.goto(opts.url ?? "");
  await page.evaluate((imgs) => {
    if (imgs) (window as any).__images = imgs;
    (window as any).__mount();
  }, opts.images ?? null);
  try {
    // 等左组图标出来（split 生效才渲染）。等不到，后面每一条都会超时 —— 先打现场。
    await page.waitForSelector(IMG, { timeout: 10000 });
  } catch (e) {
    const scene = await page.evaluate(() =>
      JSON.stringify({
        root: document.getElementById("root")!.children.length,
        toolbar: !!document.querySelector(".bytemd-toolbar"),
        leftIcons: document.querySelectorAll(
          ".bytemd-toolbar-left > .bytemd-toolbar-icon",
        ).length,
        paths: [...document.querySelectorAll(".bytemd-toolbar-icon")].map((e) =>
          e.getAttribute("bytemd-tippy-path"),
        ),
        cm: !!document.querySelector(".CodeMirror"),
        axiosStub: (window as any).__axiosStub === true,
      }),
    );
    console.error(
      `  ⚠ 等不到左组图标，现场：\n    ${scene}\n    页面异常：` +
        (errs().slice(0, 3).join("; ") || "（无）"),
    );
    throw e;
  }
  await page.waitForTimeout(300);
  return { page, errs, choosers };
}

/** antd 关弹窗是给 `.ant-modal-wrap` 加 `display:none`（节点还留在 DOM 里）⇒ 只数节点会把
 * "关了"读成"开着"，必须读计算样式。 */
const modalOpen = (pg: Page) =>
  pg.evaluate(() =>
    [...document.querySelectorAll(".ant-modal-wrap")].some(
      (el) => getComputedStyle(el).display !== "none",
    ),
  );

const cards = (pg: Page) =>
  pg.evaluate(() =>
    [...document.querySelectorAll(".editor-gallery-item")].map((img) => ({
      src: img.getAttribute("src"),
      name:
        img
          .closest(".ant-card")
          ?.querySelector(".editor-gallery-name")?.textContent ?? "",
    })),
  );

/** 当前网格里的 imageKey 序列（从缩略图 src 的 `p<key>.png` 反解，顺序即渲染顺序）。 */
const keys = (pg: Page) =>
  pg
    .evaluate(() =>
      [...document.querySelectorAll(".editor-gallery-item")]
        .map((i) => (i.getAttribute("src") || "").match(/p(\d+)\.png/))
        .map((m) => (m ? m[1] : "")),
    )
    .then((xs) => xs.filter(Boolean).map(Number));

/** 关掉图库弹窗（点右上角 X。真站里弹窗开着时遮罩会把整页盖住，工具栏那颗按钮点不到）。 */
async function closePicker(pg: Page) {
  if (!(await modalOpen(pg))) return;
  await pg.click(".ant-modal-close");
  await pg.waitForTimeout(400);
}

/** 点那颗内置图片按钮，返回本次点击的 filechooser 事件数。 */
async function clickImageIcon(m: Mounted): Promise<number> {
  if (await modalOpen(m.page)) {
    // 顺序错了：弹窗还开着就去点工具栏，遮罩会挡住点击 —— Playwright 会一直重试到超时，
    // 报出来的是"元素不可点击"，看不出真正的原因。这里直接说清楚。
    throw new Error(
      "调用顺序错：图库弹窗还开着就点工具栏那颗按钮（遮罩挡着，真站也点不到）",
    );
  }
  const before = m.choosers.length;
  await m.page.click(IMG);
  for (let i = 0; i < 20; i++) {
    // 给 bytemd 的 selectFiles 一点时间（真弹的话）
    if (m.choosers.length > before) break;
    await m.page.waitForTimeout(100);
  }
  await m.page.waitForTimeout(300); // 等图库列表回包 + 渲染
  return m.choosers.length - before;
}

async function pickTab(pg: Page, label: string) {
  await pg.click(`.ant-tabs-tab:has-text('${label}')`);
  await pg.waitForTimeout(300);
}

test("编辑器图片按钮：图库优先、本地上传、失败不改文、空态不卡人、空格编码、分页续拉", async ({
  browser,
}) => {
  test.setTimeout(240_000);
  await withSandbox({}, async (sb) => {
    // 真站那两份样式：bytemd 自己那份（工具栏/弹层）+ 组件的 index.css（弹窗网格与名字截断）。
    // 少了 bytemd 那份，`.bytemd-toolbar-left` 之类的几何都不成立；少了组件那份，图库网格的
    // 滚动与名字那一行就无从比对。
    const pageCss = [
      readFileSync(
        path.join(FE_DIR, "node_modules/bytemd/dist/index.css"),
        "utf-8",
      ),
      readFileSync(
        path.join(FE_DIR, "src/components/Editor/index.css"),
        "utf-8",
      ),
    ].join("\n");
    const html = htmlDoc(
      '<div id="root"></div><script src="bundle.js"></script>',
      RESET_CSS,
      pageCss,
    );

    const base = {
      entry: "entry.tsx",
      copySrc: true,
      define: { "import.meta.env": DEFINE },
      loaders: LOADERS,
    };
    // 主包：真 Editor 组件 + 桩 axios（files 后写 ⇒ 覆盖 copySrc 铺出的真文件）
    await esbuildInSandbox(sb, {
      ...base,
      files: {
        "src/apis/axios.tsx": FAKE_AXIOS,
        "entry.tsx": entryTsx(LOCAL_URL),
      },
    });
    await sb.write("index.html", html);

    // 负控甲（第一节）：抹掉 `e.stopPropagation()` ⇒ 同一次点击必须弹出系统文件框
    await esbuildInSandbox(sb, {
      ...base,
      subdir: "nostop",
      files: {
        "entry.tsx": entryTsx(LOCAL_URL),
        "src/components/Editor/index.tsx": mutate(
          "components/Editor/index.tsx",
          "e.stopPropagation()",
          "/* 负控：拦下的那一下没了 */",
          "stopPropagation",
        ),
      },
    });
    await sb.write("nostop/index.html", html);

    // 负控乙（第四节）：把成功判据还原成**修前那句**（`response.status !== 200`）。本仓的失败
    // 信封是 HTTP 200 + `code:500` + `data:''` ⇒ 那句恒真 ⇒ 失败会被当成功、`![]()` 插进正文。
    // 这条负控要求正文那句"一个字符都不变"的断言**能红**。
    //
    // ⚠️ 它必须**同时**拆掉两道闸才有反应（这道题考试的重点）：① `handleImageUpload` 判
    // `code !== 200` 就不返回（失败时它 `throw`）② 图库弹窗还要 `imgs[0].url` 为真才插。
    // 只拆其中一个，正文照样一动不动 —— 也就是说第四节那条断言是**两层防线共同**守住的，
    // 单拆一层还红不了。负控要证明的是"这条断言不是假绿"，所以两层都得跟着还原。
    await esbuildInSandbox(sb, {
      ...base,
      subdir: "oldcheck",
      files: {
        "entry.tsx": entryTsx(LOCAL_URL),
        "src/components/Editor/index.tsx": mutate(
          "components/Editor/index.tsx",
          "if (response.data?.code !== 200) {",
          "if (response.status !== 200) {",
          "上传成功判据",
        ),
        "src/components/Editor/ImagePicker.tsx": mutate(
          "components/Editor/ImagePicker.tsx",
          "if (!url) {",
          "if (false) {",
          "弹窗侧的空 url 闸",
        ),
      },
    });
    await sb.write("oldcheck/index.html", html);

    // 负控丙（第六节）：把编码函数改成**恒等** ⇒ 带空格的文件名必须把裸空格带回正文。
    // 没有它，第六节那条"正文里是 %20 形态"可能只是"反正也没有空格"（假绿）。
    // 锚点跟着实现走：20261006 起编码是「按码点切 + 逐字符 `isForbidden` 判定」。
    // 把它换成"恒等"，整串照旧拼回去（`head + name`）⇒ 与 `return url` 同义。
    await esbuildInSandbox(sb, {
      ...base,
      subdir: "noencode",
      files: {
        "entry.tsx": entryTsx(LOCAL_URL),
        "src/utils/assetUrl.ts": mutate(
          "utils/assetUrl.ts",
          "(isForbidden(ch) ? pctEncode(ch) : ch)",
          "ch",
          "assetUrl 编码",
        ),
      },
    });
    await sb.write("noencode/index.html", html);

    // 负控丁（第七节）：把"下一页的游标"从**最后一张**改成**第一张** ⇒ 第二次请求必然把
    // 第一页原样再要一遍，列表里出现重复行、最后一页永远够不着。没有它，第七节那条
    // "点完变成 65 张且不重复"可能只是"桩反正把整份都回了"（假绿）。
    await esbuildInSandbox(sb, {
      ...base,
      subdir: "badcursor",
      files: {
        "entry.tsx": entryTsx(LOCAL_URL),
        "src/utils/galleryPager.ts": mutate(
          "utils/galleryPager.ts",
          "const last = loaded.current[loaded.current.length - 1];",
          "const last = loaded.current[0];",
          "分页游标",
        ),
      },
    });
    await sb.write("badcursor/index.html", html);

    const sub = (name: string) => new URL(`${name}/index.html`, sb.url).toString();

    const mounted: Array<[Mounted, string]> = [];

    // ══════════════════════════════════════════════════════════════════════
    // ① 点那颗按钮：不再弹系统文件框，改成开图库弹窗（负控：抹掉 stopPropagation ⇒ 必须弹）
    // ══════════════════════════════════════════════════════════════════════
    const main = await mount(browser, { url: sb.url });
    mounted.push([main, "主档"]);
    const { page } = main;
    expect(await modalOpen(page), "点击前没有弹窗").toBe(false);
    const choosers = await clickImageIcon(main);
    expect.soft(choosers, "点击**没有**触发系统文件框（filechooser）").toBe(0);
    expect(await modalOpen(page), "弹窗开出来了").toBe(true);
    expect
      .soft(
        await page.evaluate((sel) => !!document.querySelector(sel), IMG),
        "那颗按钮本身还在原位（左组下标 5，图标/位置都没动）",
      )
      .toBe(true);

    // 负控：同一次点击，抹掉 stopPropagation 的那份包**必须**弹系统文件框。它同时证明上面
    // 那句 `choosers == 0` 不是假绿（沙箱里确实点得着这颗按钮、bytemd 的 handler 也在）。
    const nostop = await mount(browser, { url: sub("nostop") });
    mounted.push([nostop, "负控甲（抹 stopPropagation）"]);
    const nchoosers = await clickImageIcon(nostop);
    expect
      .soft(nchoosers, "负控：抹掉 stopPropagation ⇒ 同一次点击弹出系统文件框")
      .toBeGreaterThanOrEqual(1);
    // 注意：负控那一档我们**自己那颗弹窗也会开**（捕获监听照样跑，只是不再掐断冒泡）
    // —— 所以这里只能断言"系统文件框确实弹了"，那才是"被拦住的是什么"的证据。

    // ══════════════════════════════════════════════════════════════════════
    // ② 弹窗优先展示图库（默认页签 + 网格条数 + 展示名 + 缩略图 CDN 化）
    // ══════════════════════════════════════════════════════════════════════
    await page.waitForTimeout(300);
    const tabs = await page.evaluate(() =>
      [...document.querySelectorAll(".ant-tabs-tab")].map((t) =>
        (t.textContent || "").trim(),
      ),
    );
    const active = await page.evaluate(
      () =>
        (document.querySelector(".ant-tabs-tab-active") as HTMLElement | null)
          ?.textContent || "",
    );
    expect.soft(tabs.length, "弹窗里有两个页签").toBe(2);
    expect
      .soft(active.includes("图库"), "默认选中「图库」（用户要求：优先展示服务器上的图库）")
      .toBe(true);
    const grid = await cards(page);
    expect.soft(grid.length, "网格条数 = 图库里的图片数").toBe(FIX.length);
    expect
      .soft(grid[0]?.src, "缩略图 src 是 CDN 化后的地址（本地盘那条）")
      .toBe(CDN + PICK);
    expect
      .soft(
        grid[1]?.src,
        "R2 那种绝对地址原样用（只重写 /api/protect/download/ 前缀）",
      )
      .toBe(FIX[1].imageUrl);
    expect
      .soft((grid[0]?.name || "").trim(), "卡下面那行是展示名（剥掉上传时压的 14 位时间戳前缀）")
      .toBe("EMQX.png");
    expect
      .soft(
        (grid[2]?.name || "").trim(),
        "不带那个前缀的旧名原样显示（宁可显示全名也不许截错）",
      )
      .toBe("old_pic.png");
    expect
      .soft(
        await page.evaluate(
          () =>
            (window as any).__calls.filter(
              (c: any) => c.url === "/api/protect/images" && c.method === "GET",
            ).length,
        ),
        "图库列表真的请求了 GET /api/protect/images",
      )
      .toBeGreaterThanOrEqual(1);

    // ══════════════════════════════════════════════════════════════════════
    // ③ 选中一张 ⇒ 写进正文的是**库里那个原始串**，形态与 bytemd 自己插的逐字节一样
    // ══════════════════════════════════════════════════════════════════════
    const docBefore = await page.evaluate(() => (window as any).__doc());
    await page.click(".editor-gallery-item");
    await page.waitForTimeout(500);
    const doc = await page.evaluate(() => (window as any).__doc());
    const sel = await page.evaluate(() => (window as any).__sel());
    expect
      .soft(docBefore, "点击前正文是空的（下面那条不是「本来就有」）")
      .toBe("");
    expect
      .soft(doc, "空文档里插一张 = `\\n![](原始串)`（与 bytemd 自己插图同形）")
      .toBe(`\n![](${PICK})`);
    expect
      .soft(
        doc.includes(PICK) && !doc.includes(CDN),
        "写进正文的是**库里那个原始串**，不是 CDN 化后的地址",
      )
      .toBe(true);
    expect
      .soft(
        sel?.anchor?.line === 1 && sel?.anchor?.ch === 0,
        "光标落在刚插入的那一行上",
      )
      .toBe(true);
    expect(await modalOpen(page), "插入后弹窗关闭").toBe(false);
    expect
      .soft(
        await page.evaluate(() => (window as any).__lastValue || ""),
        "onChange 被调到（NewNotes 的自动保存挂的就是它，正文这才存得住）",
      )
      .toBe(doc);

    // ══════════════════════════════════════════════════════════════════════
    // ④ 本地上传那条路还在（成功插进正文；被拒时一个字符都不许变 —— 负控：还原修前判据）
    // ══════════════════════════════════════════════════════════════════════
    await clickImageIcon(main);
    await pickTab(page, "本地上传");
    expect
      .soft(
        await page.evaluate(
          (sel) => document.querySelectorAll(sel).length,
          FILE_INPUT,
        ),
        "「本地上传」页签里是拖拽/点选的上传区",
      )
      .toBe(1);
    await page.setInputFiles(FILE_INPUT, {
      name: "screenshot.png",
      mimeType: "image/png",
      buffer: PNG,
    });
    await page.waitForTimeout(700);
    const doc4 = await page.evaluate(() => (window as any).__doc());
    const uploads = await page.evaluate(
      () => (window as any).__calls.filter((c: any) => c.url === "/api/protect/upload"),
    );
    expect
      .soft(
        uploads.length > 0 &&
          uploads[uploads.length - 1].form?.name === "screenshot.png",
        "上传走的是同一个 POST /api/protect/upload，字段名 file",
      )
      .toBe(true);
    expect
      .soft(
        doc4.includes(LOCAL_URL) && doc4.split("![](").length - 1 === 2,
        "上传成功后插进正文（用的是接口返回的那个 url）",
      )
      .toBe(true);
    expect
      .soft(!doc4.includes("![]()"), "插进去的不是空 url（失败才可能插出 `![]()`）")
      .toBe(true);
    expect(await modalOpen(page), "插入后弹窗关闭").toBe(false);

    // 失败态：上传被服务端拒绝（本仓失败 = HTTP 200 + code:500）
    await clickImageIcon(main);
    await page.evaluate(() => {
      (window as any).__upFail = true;
    });
    await pickTab(page, "本地上传");
    const docBeforeFail = await page.evaluate(() => (window as any).__doc());
    await page.setInputFiles(FILE_INPUT, {
      name: "toobig.png",
      mimeType: "image/png",
      buffer: PNG,
    });
    await page.waitForTimeout(700);
    expect
      .soft(
        await page.evaluate(() => (window as any).__doc()),
        "上传被拒时正文**一个字符都不变**",
      )
      .toBe(docBeforeFail);
    expect(await modalOpen(page), "上传被拒时弹窗**不关**（人能接着换一张试）").toBe(true);
    expect
      .soft(
        (await page.evaluate(() => document.body.innerText)).includes("R2 配额已满"),
        "错误提示用的是服务端那句话",
      )
      .toBe(true);

    await closePicker(page); // 上面那条是"故意不关"，进第五节前得自己关掉

    // 负控：判据还原成修前那句（`response.status !== 200`，本仓恒真）⇒ 它必须把 `![]()` 插进去
    const oldcheck = await mount(browser, { url: sub("oldcheck") });
    mounted.push([oldcheck, "负控乙（修前判据）"]);
    await clickImageIcon(oldcheck);
    await oldcheck.page.evaluate(() => {
      (window as any).__upFail = true;
    });
    await pickTab(oldcheck.page, "本地上传");
    await oldcheck.page.setInputFiles(FILE_INPUT, {
      name: "toobig.png",
      mimeType: "image/png",
      buffer: PNG,
    });
    await oldcheck.page.waitForTimeout(700);
    expect
      .soft(
        (await oldcheck.page.evaluate(() => (window as any).__doc())).includes("![]()"),
        "负控：两道闸都还原成修前那样 ⇒ 同一个失败回包被当成功、`![]()` 插进正文",
      )
      .toBe(true);

    // ══════════════════════════════════════════════════════════════════════
    // ⑤ 图库为空 / 读不到：给人话，且「本地上传」仍然可用（不能把人卡死）
    // ══════════════════════════════════════════════════════════════════════
    await page.evaluate(() => {
      (window as any).__images = [];
    });
    await clickImageIcon(main);
    await page.waitForTimeout(400);
    expect
      .soft(
        await page.evaluate(() => document.querySelectorAll(".ant-empty").length),
        "图库为空时说人话（不是一片空白）",
      )
      .toBe(1);
    await pickTab(page, "本地上传");
    expect
      .soft(
        await page.evaluate(
          (sel) => document.querySelectorAll(sel).length,
          FILE_INPUT,
        ),
        "空图库时「本地上传」仍然可用",
      )
      .toBe(1);
    await closePicker(page);

    await page.evaluate(() => {
      (window as any).__images = null;
      (window as any).__imgFail = true;
    });
    await clickImageIcon(main);
    await page.waitForTimeout(400);
    expect
      .soft(
        await page.evaluate(
          () => document.querySelectorAll(".ant-alert-error").length,
        ),
        "图库读不到时显示失败原因（不许拿空网格冒充「图库里没有图」）",
      )
      .toBe(1);
    expect
      .soft(
        (await page.evaluate(() => document.body.innerText)).includes("图库读取失败"),
        "失败原因用的是服务端那句话",
      )
      .toBe(true);
    await pickTab(page, "本地上传");
    expect
      .soft(
        await page.evaluate(
          (sel) => document.querySelectorAll(sel).length,
          FILE_INPUT,
        ),
        "图库读不到时「本地上传」仍然可用",
      )
      .toBe(1);

    // ══════════════════════════════════════════════════════════════════════
    // ⑥ 文件名带空格 ⇒ 插进正文的是编码后的地址（负控：编码改成恒等 ⇒ 裸空格回到正文）
    // ══════════════════════════════════════════════════════════════════════
    // 用户那张不渲染的图就是这个形态：上传时文件名 = 时间戳 + 原名，**空格原样留着**，
    // 而 `![](${url})` 裸拼 ⇒ CommonMark 的 link destination 不允许空白字符，整段退化成
    // 纯文本（一个 `<img>` 都没生成；文件在、`%20` 访问 200 —— 不是文件问题）。
    const SPACEY = "/api/protect/download/20261006033033_sunset (1) 副本.png";
    const SPACEY_ENC = "/api/protect/download/20261006033033_sunset%20%281%29%20副本.png";

    /** 同一个上传动作在某一档包上跑一遍，回正文。挂载后正文必须是空的（下面有前置断言）。 */
    const uploadSpacey = async (m: Mounted) => {
      await m.page.evaluate((u) => {
        (window as any).__uploadUrl = u;
        (window as any).__upFail = false;
        (window as any).__imgFail = false;
        (window as any).__images = [];
      }, SPACEY);
      await clickImageIcon(m);
      await pickTab(m.page, "本地上传");
      await m.page.setInputFiles(FILE_INPUT, {
        name: "sunset (1) 副本.png",
        mimeType: "image/png",
        buffer: PNG,
      });
      await m.page.waitForTimeout(700);
      return m.page.evaluate(() => (window as any).__doc()) as Promise<string>;
    };

    const main6 = await mount(browser, { url: sb.url });
    mounted.push([main6, "第六节主档"]);
    expect
      .soft(
        await main6.page.evaluate(() => (window as any).__doc()),
        "前置：新页面正文是空的（下面的整串断言才有意义）",
      )
      .toBe("");
    const doc6 = await uploadSpacey(main6);
    expect
      .soft(doc6, "带空格的文件名：插进正文的是 %20 形态")
      .toBe(`\n![](${SPACEY_ENC})`);
    expect
      .soft(doc6.includes(SPACEY), "反面：正文里**没有**裸空格形态的地址")
      .toBe(false);
    expect
      .soft(doc6.includes("副本"), "只编禁区字符：中文/全角标点没被一起编掉")
      .toBe(true);

    // 负控丙：同一段流程在**恒等编码**的包上跑，裸空格必须原样落进正文
    const noencode = await mount(browser, { url: sub("noencode") });
    mounted.push([noencode, "负控丙（编码改成恒等）"]);
    const ndoc = await uploadSpacey(noencode);
    expect
      .soft(
        ndoc,
        "负控：encodeAssetUrl 改成恒等 ⇒ 裸空格原样进正文（说明上面那条判据是有效的）",
      )
      .toBe(`\n![](${SPACEY})`);

    // ══════════════════════════════════════════════════════════════════════
    // ⑦ 一页装不下时「载入更多」续拉（游标 = 最后一张；负控：改成第一张 ⇒ 重复行）
    // ══════════════════════════════════════════════════════════════════════
    // 用户报的是"整页拉"这件事（20261014）：图库攒到几百张时，每开一次选图弹窗就把整表
    // 拉一遍。这一节锁的是"分页真的发生了"——
    //   · 第一页只回页大小那么多，且请求里**带上了 limit**；
    //   · 「载入更多」把**已加载的最后一张**当游标（服务端认 `image_key < before`）；
    //   · 续拉是**追加**（第二页接在后面，不是把第一页换掉），且不出现重复行；
    //   · 凑不满一页 ⇒ `hasMore` 变假、按钮消失（界面不再假装"还有"）。
    expect(PAGE_SIZE, "前置：页大小常数读得出来（读不出说明 ImageMethods 写法变了）").toBeGreaterThan(0);

    const main7 = await mount(browser, { url: sb.url, images: BIG });
    mounted.push([main7, "第七节主档"]);
    expect
      .soft(
        BIG.length > PAGE_SIZE,
        `前置：夹具比一页大（否则这一节什么都没证明）${BIG.length} vs ${PAGE_SIZE}`,
      )
      .toBe(true);
    await clickImageIcon(main7);
    await main7.page.waitForTimeout(300);
    expect
      .soft((await cards(main7.page)).length, "第一页只渲染页大小那么多张")
      .toBe(PAGE_SIZE);
    let imgCalls = await main7.page.evaluate(
      () => (window as any).__calls.filter((c: any) => c.url === "/api/protect/images"),
    );
    expect
      .soft(
        imgCalls.length > 0 && imgCalls[imgCalls.length - 1].params?.limit === PAGE_SIZE,
        "请求里带了 limit = 页大小（不带就是整表拉，正是本轮要治的那件事）",
      )
      .toBe(true);
    expect
      .soft(
        imgCalls.length > 0 &&
          !("before" in (imgCalls[imgCalls.length - 1].params || {})),
        "第一页不带 before（不传就是第一页）",
      )
      .toBe(true);
    expect
      .soft(
        await main7.page.evaluate(
          (sel) => document.querySelectorAll(sel).length,
          MORE,
        ),
        "第一页正好取满 ⇒ 出现「载入更多」",
      )
      .toBe(1);
    expect
      .soft(
        (await keys(main7.page)).slice(0, 1),
        "第一页就是服务端给的那一段（第一张 = 夹具头一张）",
      )
      .toEqual([BIG[0].imageKey]);

    await main7.page.click(MORE);
    await main7.page.waitForTimeout(600);
    imgCalls = await main7.page.evaluate(
      () => (window as any).__calls.filter((c: any) => c.url === "/api/protect/images"),
    );
    const ks = await keys(main7.page);
    const tail = imgCalls.length ? imgCalls[imgCalls.length - 1].params?.before : null;
    expect
      .soft(
        tail === BIG[PAGE_SIZE - 1].imageKey,
        `「载入更多」发的请求带上了 before = **已加载的最后一张**的 imageKey（before=${tail} 期望=${BIG[PAGE_SIZE - 1].imageKey}）`,
      )
      .toBe(true);
    expect
      .soft(ks.length, "续拉是**追加**：总数 = 一页 + 第二页")
      .toBe(BIG.length);
    expect
      .soft(ks.slice(0, 1), "第二页接在**后面**（头一张没变 —— 不是换了一页）")
      .toEqual([BIG[0].imageKey]);
    expect
      .soft(
        new Set(ks).size === ks.length,
        "没有重复行（同一张图出现两次 = 游标取错了）",
      )
      .toBe(true);
    expect
      .soft(ks, "续拉后网格里是两组不同的 key（第一段 + 尾巴）")
      .toEqual(BIG.map((b) => b.imageKey));
    expect
      .soft(
        await main7.page.evaluate(
          (sel) => document.querySelectorAll(sel).length,
          MORE,
        ),
        "第二页凑不满 ⇒ 「载入更多」消失（界面不再假装还有）",
      )
      .toBe(0);

    // 负控丁：游标改成"第一张" ⇒ 第二次请求把第一页原样再要一遍，列表里**必须**出现重复行
    const bad = await mount(browser, { url: sub("badcursor"), images: BIG });
    mounted.push([bad, "负控丁（游标取第一张）"]);
    await clickImageIcon(bad);
    await bad.page.waitForTimeout(300);
    if (
      (await bad.page.evaluate((sel) => document.querySelectorAll(sel).length, MORE)) === 1
    ) {
      await bad.page.click(MORE);
      await bad.page.waitForTimeout(600);
    }
    const nks = await keys(bad.page);
    expect
      .soft(
        nks.length > new Set(nks).size,
        `负控：游标取第一张 ⇒ 第二页把第一页重复了一遍（说明上面那条'不重复'不是假绿）${nks.length} 行 / ${new Set(nks).size} 个不同 key`,
      )
      .toBe(true);

    for (const [m, name] of mounted) {
      expect.soft(m.errs(), `${name}没有页面异常`).toEqual([]);
      await m.page.close();
    }
  });
});
