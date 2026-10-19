import { test, expect } from "@playwright/test";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import {
  FE_DIR,
  withSandbox,
  collectPageErrors,
  esbuildInSandbox,
} from "./sandbox";

/**
 * mermaid 图的配色是站点这套和纸色，不是 mermaid 内置 default（20261005）
 * （原 tests/mermaid-theme.test.py，20261019 迁移）。
 *
 * 现场（用户报「mermaid渲染的图配色给人一种零几年风格的古早感觉」）：文章页
 * （`ReadArticle/index.tsx` 的 plugins）与看板娘对话框（`utils/chatMarkdown.ts`
 * 的 viewerEffect）都调裸 `mermaid()`，于是吃的是 mermaid 内置 `default` 主题——
 * 淡紫节点 `#ECECFF`、淡黄分组 `#ffffde`、紫描边 `#9370DB`、字体 `trebuchet ms`
 * （那套取色是 mermaid 2014 年的默认值）。修法：两处共传 `utils/mermaidTheme.ts`
 * 的 `MERMAID_CONFIG`（mermaid 是**全局单例**，两处必须同一个值）。
 *
 * 判据怎么算数：**真渲染**（mermaid 在真浏览器里跑出一张图），读节点/分组/连线/
 * 标签的 computed 色与字体；并且同时跑**改动前那一臂**（`initialize({})` = 内置默认）
 * ——那一臂必须量到 `#ECECFF`，否则说明这套探针根本看不见古早配色，前一条的绿是假的
 * （同族纪律：正控不红不算数）。
 *
 * 两臂都是**当场渲染**出来的，不读 `git show HEAD:`（提交之后它就等于被测对象，
 * 见 mermaid-mobile-zoom.test.py 里那段注释）。
 */

const THEME_TS = path.join(FE_DIR, "src/utils/mermaidTheme.ts");
const READ_TSX = path.join(
  FE_DIR,
  "src/frontHome/Content/ReadArticle/index.tsx",
);
const CHAT_TS = path.join(FE_DIR, "src/utils/chatMarkdown.ts");

// 一张图里放齐三种会被主题影响的元素：普通节点（primary/mainBkg）、分组（cluster*）、
// 连线（lineColor）、节点文字（primaryTextColor）。
const DIAGRAM = `
flowchart LR
  A[nginx] --> B[静态 dist]
  subgraph 反代
    A --> C[uvicorn :8010]
  end
`;

const FIXED_MODE = "mermaid.initialize(MERMAID_CONFIG)";
// 改动前那一臂：裸 `mermaid()` ⇒ 插件把**空**选项交给 initialize，主题就是内置 default
const PREV_MODE = "mermaid.initialize({})";

const entryFor = (mode: string) =>
  [
    "import mermaid from 'mermaid'",
    `import { MERMAID_CONFIG } from ${JSON.stringify(THEME_TS)}`,
    mode,
    ";(window as any).__render = async (code) => {",
    "  const { svg } = await mermaid.render('g1', code)",
    "  const host = document.getElementById('host')",
    "  host.innerHTML = svg",
    "  return svg.length",
    "}",
    "",
  ].join("\n");

const MM_INDEX_HTML =
  '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">' +
  '<meta name="viewport" content="width=device-width, initial-scale=1">' +
  "<title>t</title></head>" +
  '<body><div id="host" style="width:900px"></div>' +
  '<script src="app.js"></script></body></html>';

interface MmProbe {
  nodeFill: string | null;
  nodeStroke: string | null;
  clusterFill: string | null;
  clusterStroke: string | null;
  edgeStroke: string | null;
  labelFill: string | null;
  labelFont: string | null;
  svgCount: number;
}
interface MmResult extends MmProbe {
  svgLen: number;
}

const MM_PROBE = (): MmProbe => {
  const node = document.querySelector(".node .label-container, .node rect, .node path");
  const cluster = document.querySelector(".cluster rect, .cluster path, g.cluster rect");
  const edge = document.querySelector(".edgePath path, .flowchart-link");
  const label = document.querySelector(".nodeLabel, .node .label");
  return {
    nodeFill: node ? getComputedStyle(node).fill : null,
    nodeStroke: node ? getComputedStyle(node).stroke : null,
    clusterFill: cluster ? getComputedStyle(cluster).fill : null,
    clusterStroke: cluster ? getComputedStyle(cluster).stroke : null,
    edgeStroke: edge ? getComputedStyle(edge).stroke : null,
    labelFill: label ? getComputedStyle(label).fill : null,
    labelFont: label ? getComputedStyle(label).fontFamily : null,
    svgCount: document.querySelectorAll("#host svg").length,
  };
};

/** 递归收集 src 下全部 .ts/.tsx（源码扫描用）。 */
function walkTs(dir: string, out: string[]): void {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkTs(p, out);
    else if (/\.(ts|tsx)$/.test(e.name) && e.name !== "mermaidTheme.ts") {
      out.push(p);
    }
  }
}

test.describe("mermaid 和纸主题", () => {
  test.setTimeout(180_000);

  test("修好臂和纸配色、对照臂量得到内置 default、全仓无裸 mermaid()", async ({
    page,
  }) => {
    const errs = collectPageErrors(page);
    await page.setViewportSize({ width: 1000, height: 800 });

    const renderAt = async (url: string): Promise<MmResult> => {
      await page.goto(url);
      await page.waitForTimeout(150);
      const n = (await page.evaluate(
        (code: string) =>
          (window as unknown as { __render: (c: string) => Promise<number> }).__render(code),
        DIAGRAM,
      )) as number;
      await page.waitForTimeout(150);
      const out = (await page.evaluate(MM_PROBE)) as MmProbe;
      return { ...out, svgLen: n };
    };

    // esbuild 的 bare import（'mermaid'）从入口所在目录往上找 node_modules——
    // 基建把 node_modules 以 symlink 挂进沙箱、以沙箱为 absWorkingDir，入口放沙箱
    // 根即可解析（原 Python 版为此把构建目录塞进 node_modules，同一件事）。
    const fixed = await withSandbox({ "index.html": MM_INDEX_HTML }, async (sb) => {
      await esbuildInSandbox(sb, {
        entry: "entry.ts",
        files: { "entry.ts": entryFor(FIXED_MODE) },
        outfile: "app.js",
      });
      return renderAt(sb.url);
    });
    const prev = await withSandbox({ "index.html": MM_INDEX_HTML }, async (sb) => {
      await esbuildInSandbox(sb, {
        entry: "entry.ts",
        files: { "entry.ts": entryFor(PREV_MODE) },
        outfile: "app.js",
      });
      return renderAt(sb.url);
    });

    // ── ① 夹具自检：两臂都真的渲染出了一张图（否则下面全绿也是假的） ──
    expect(fixed.svgCount === 1, `修好臂渲染出 1 张 svg → ${fixed.svgCount}`).toBe(true);
    expect(prev.svgCount === 1, `对照臂（改动前）渲染出 1 张 svg → ${prev.svgCount}`).toBe(true);
    expect(errs(), "两臂都没有 JS 报错").toEqual([]);

    // ── ② 正控：改动前那一臂必须量到 mermaid 的默认配色（探针看得见古早色） ──
    expect(
      prev.nodeFill === "rgb(236, 236, 255)",
      `★对照臂节点底 = #ECECFF（实测 ${prev.nodeFill}）——看不到它就说明这套探针对配色无感，下面那几条的绿是假的`,
    ).toBe(true);
    expect(
      prev.clusterFill === "rgb(255, 255, 222)",
      `★对照臂分组底 = #ffffde（实测 ${prev.clusterFill}）`,
    ).toBe(true);
    expect(
      prev.labelFont !== null && prev.labelFont.toLowerCase().includes("trebuchet"),
      `  对照臂字体含 trebuchet（实测 ${prev.labelFont}）`,
    ).toBe(true);

    // ── ③ 修好臂：和纸配色（值 = utils/mermaidTheme.ts 里那几个） ──
    expect(
      fixed.nodeFill === "rgb(255, 253, 250)",
      `★节点底 = 纸白 #fffdfa（实测 ${fixed.nodeFill}）`,
    ).toBe(true);
    // flowchart 的节点描边走 `nodeBorder`（#c9b8d2）而不是 `primaryBorderColor`（#d8cfe0）——
    // 两个键都配着（别的图种吃另一个），这里断言的是**真生效的那一个**（实测得出，不是照抄配置）
    expect(
      fixed.nodeStroke === "rgb(201, 184, 210)",
      `★节点描边 = 藕紫 #c9b8d2（实测 ${fixed.nodeStroke}）`,
    ).toBe(true);
    expect(
      fixed.clusterFill === "rgb(250, 244, 247)",
      `★分组底 = 淡粉 #faf4f7（实测 ${fixed.clusterFill}）`,
    ).toBe(true);
    expect(
      fixed.clusterStroke === "rgb(226, 207, 224)",
      `★分组框 = 淡紫 #e2cfe0（实测 ${fixed.clusterStroke}）`,
    ).toBe(true);
    expect(
      fixed.edgeStroke === "rgb(155, 143, 166)",
      `★连线 = 灰紫 #9b8fa6（实测 ${fixed.edgeStroke}）`,
    ).toBe(true);
    expect(
      fixed.labelFill === "rgb(74, 53, 80)",
      `★节点文字 = 墨紫 #4a3550（实测 ${fixed.labelFill}）`,
    ).toBe(true);
    expect(
      fixed.labelFont !== null && !fixed.labelFont.toLowerCase().includes("trebuchet"),
      `★字体换成站点那串（实测 ${fixed.labelFont}）——不再含 trebuchet`,
    ).toBe(true);
    expect(
      fixed.nodeFill !== prev.nodeFill && fixed.clusterFill !== prev.clusterFill,
      `★两臂确实不同款（同一张图、同一次运行） → ${fixed.nodeFill} vs ${prev.nodeFill}`,
    ).toBe(true);

    // ── ④ 负空间：两处调用点都传了这份配置，裸 mermaid() 一处不剩 ──
    const readSrc = readFileSync(READ_TSX, "utf-8");
    const chatSrc = readFileSync(CHAT_TS, "utf-8");
    expect(
      readSrc.includes("mermaid(MERMAID_CONFIG)"),
      "文章页 plugins 里是 `mermaid(MERMAID_CONFIG)` → 找不到这个字面",
    ).toBe(true);
    expect(
      chatSrc.includes("mermaid(MERMAID_CONFIG)"),
      "对话框 viewerEffect 里也是 `mermaid(MERMAID_CONFIG)` → 找不到这个字面",
    ).toBe(true);
    const hits: string[] = [];
    const allTs: string[] = [];
    walkTs(path.join(FE_DIR, "src"), allTs);
    for (const f of allTs) {
      readFileSync(f, "utf-8")
        .split("\n")
        .forEach((line, i) => {
          const s = line.trim();
          if (s.startsWith("//") || s.startsWith("*")) return;
          if (s.includes("mermaid()")) {
            hits.push(`${path.relative(FE_DIR, f)}:${i + 1}  ${s}`);
          }
        });
    }
    expect(
      hits.join(" | "),
      "★全仓没有裸 `mermaid()` 了（漏一处就是「谁先渲染谁定调」的静默分叉）",
    ).toBe("");
  });
});
