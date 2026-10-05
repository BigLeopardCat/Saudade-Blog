#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""mermaid 图的配色是站点这套和纸色，不是 mermaid 内置 default（20261005）。

  python3 tests/mermaid-theme.test.py

现场（用户报「mermaid渲染的图配色给人一种零几年风格的古早感觉」）：文章页
（`ReadArticle/index.tsx` 的 plugins）与看板娘对话框（`utils/chatMarkdown.ts`
的 viewerEffect）都调裸 `mermaid()`，于是吃的是 mermaid 内置 `default` 主题——
淡紫节点 `#ECECFF`、淡黄分组 `#ffffde`、紫描边 `#9370DB`、字体 `trebuchet ms`
（那套取色是 mermaid 2014 年的默认值）。修法：两处共传 `utils/mermaidTheme.ts`
的 `MERMAID_CONFIG`（mermaid 是**全局单例**，两处必须同一个值）。

判据怎么算数：**真渲染**（mermaid 在真浏览器里跑出一张图），读节点/分组/连线/
标签的 computed 色与字体；并且同时跑**改动前那一臂**（`initialize({})` = 内置默认）
——那一臂必须量到 `#ECECFF`，否则说明这套探针根本看不见古早配色，前一条的绿是假的
（同族纪律：正控不红不算数）。

两臂都是**当场渲染**出来的，不读 `git show HEAD:`（提交之后它就等于被测对象，
见 mermaid-mobile-zoom.test.py 里那段注释）。
"""
import pathlib
import shutil
import subprocess
import tempfile

FE = pathlib.Path(__file__).resolve().parent.parent
SRC = FE / "src"
THEME_TS = SRC / "utils/mermaidTheme.ts"
READ_TSX = SRC / "frontHome/Content/ReadArticle/index.tsx"
CHAT_TS = SRC / "utils/chatMarkdown.ts"

PASS, FAIL = 0, 0


def check(desc: str, cond: bool, detail: str = "") -> None:
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"  ✓ {desc}")
    else:
        FAIL += 1
        print(f"  ✗ {desc}" + (f"  → {detail}" if detail else ""))


# 一张图里放齐三种会被主题影响的元素：普通节点（primary/mainBkg）、分组（cluster*）、
# 连线（lineColor）、节点文字（primaryTextColor）。
DIAGRAM = """
flowchart LR
  A[nginx] --> B[静态 dist]
  subgraph 反代
    A --> C[uvicorn :8010]
  end
"""

ENTRY = """import mermaid from 'mermaid'
import {{ MERMAID_CONFIG }} from {theme!r}
{mode}
;(window as any).__render = async (code) => {{
  const {{ svg }} = await mermaid.render('g1', code)
  const host = document.getElementById('host')
  host.innerHTML = svg
  return svg.length
}}
"""

FIXED_MODE = "mermaid.initialize(MERMAID_CONFIG)"
# 改动前那一臂：裸 `mermaid()` ⇒ 插件把**空**选项交给 initialize，主题就是内置 default
PREV_MODE = "mermaid.initialize({})"

PROBE = """() => {
  const c = (sel, prop) => {
    const e = document.querySelector(sel);
    return e ? getComputedStyle(e)[prop] : null;
  };
  const node = document.querySelector('.node .label-container, .node rect, .node path');
  const cluster = document.querySelector('.cluster rect, .cluster path, g.cluster rect');
  const edge = document.querySelector('.edgePath path, .flowchart-link');
  const label = document.querySelector('.nodeLabel, .node .label');
  return {
    nodeFill: node ? getComputedStyle(node).fill : null,
    nodeStroke: node ? getComputedStyle(node).stroke : null,
    clusterFill: cluster ? getComputedStyle(cluster).fill : null,
    clusterStroke: cluster ? getComputedStyle(cluster).stroke : null,
    edgeStroke: edge ? getComputedStyle(edge).stroke : null,
    labelFill: label ? getComputedStyle(label).fill : null,
    labelFont: label ? getComputedStyle(label).fontFamily : null,
    svgCount: document.querySelectorAll('#host svg').length,
  };
}"""


def bundle(ts_text: str, out: pathlib.Path) -> None:
    ts = out.with_suffix(".ts")
    ts.write_text(ts_text, encoding="utf-8")
    r = subprocess.run([str(FE / "node_modules/.bin/esbuild"), str(ts),
                        "--bundle", "--format=iife", f"--outfile={out}", "--log-level=error"],
                       cwd=str(FE), capture_output=True)
    if r.returncode != 0:
        raise SystemExit("esbuild 打包失败：\n" + r.stderr.decode("utf-8", "replace"))


def build_sandbox(js: pathlib.Path, name: str) -> pathlib.Path:
    sb = pathlib.Path(tempfile.mkdtemp(prefix=f"mm-theme-{name}-"))
    (sb / "app.js").write_text(js.read_text(encoding="utf-8"), encoding="utf-8")
    (sb / "index.html").write_text(
        '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">'
        '<meta name="viewport" content="width=device-width, initial-scale=1">'
        '<title>t</title></head>'
        '<body><div id="host" style="width:900px"></div>'
        '<script src="app.js"></script></body></html>',
        encoding="utf-8")
    return sb


# 打包入口必须落在 FE 树里：esbuild 从**入口文件所在目录**往上找 node_modules，
# 入口放 /tmp 的话 `import mermaid from 'mermaid'` 当场解析不到（裸包名按文件路径解析）。
# 落 node_modules 下（已被 gitignore 忽略），构建产物与沙箱再另开 /tmp 目录。
WORK = pathlib.Path(tempfile.mkdtemp(prefix=".mm-theme-build-", dir=str(FE / "node_modules")))
bundle(ENTRY.format(theme=str(THEME_TS), mode=FIXED_MODE), WORK / "fixed.js")
bundle(ENTRY.format(theme=str(THEME_TS), mode=PREV_MODE), WORK / "prev.js")
SB_FIXED = build_sandbox(WORK / "fixed.js", "fixed")
SB_PREV = build_sandbox(WORK / "prev.js", "prev")

from playwright.sync_api import sync_playwright  # noqa: E402

with sync_playwright() as p:
    br = p.chromium.launch()

    def render(url: str) -> dict:
        pg = br.new_page(viewport={"width": 1000, "height": 800})
        errs: list[str] = []
        pg.on("pageerror", lambda e: errs.append(str(e)))
        pg.goto(url)
        pg.wait_for_timeout(150)
        n = pg.evaluate("(code) => window.__render(code)", DIAGRAM)
        pg.wait_for_timeout(150)
        out = pg.evaluate(PROBE)
        out["errs"] = errs
        out["svgLen"] = n
        pg.close()
        return out

    print("① 夹具自检：两臂都真的渲染出了一张图（否则下面全绿也是假的）")
    fixed = render(SB_FIXED.as_uri() + "/index.html")
    prev = render(SB_PREV.as_uri() + "/index.html")
    check("修好臂渲染出 1 张 svg", fixed["svgCount"] == 1, str(fixed["svgCount"]))
    check("对照臂（改动前）渲染出 1 张 svg", prev["svgCount"] == 1, str(prev["svgCount"]))
    check("两臂都没有 JS 报错", not fixed["errs"] and not prev["errs"],
          str(fixed["errs"] + prev["errs"]))

    print("② 正控：改动前那一臂必须量到 mermaid 的默认配色（探针看得见古早色）")
    check(f'★对照臂节点底 = #ECECFF（实测 {prev["nodeFill"]}）——看不到它就说明这套探针'
          f'对配色无感，下面那几条的绿是假的',
          prev["nodeFill"] == "rgb(236, 236, 255)", str(prev["nodeFill"]))
    check(f'★对照臂分组底 = #ffffde（实测 {prev["clusterFill"]}）',
          prev["clusterFill"] == "rgb(255, 255, 222)", str(prev["clusterFill"]))
    check(f'  对照臂字体含 trebuchet（实测 {prev["labelFont"]}）',
          prev["labelFont"] is not None and "trebuchet" in prev["labelFont"].lower(),
          str(prev["labelFont"]))

    print("③ 修好臂：和纸配色（值 = utils/mermaidTheme.ts 里那几个）")
    check(f'★节点底 = 纸白 #fffdfa（实测 {fixed["nodeFill"]}）',
          fixed["nodeFill"] == "rgb(255, 253, 250)", str(fixed["nodeFill"]))
    # flowchart 的节点描边走 `nodeBorder`（#c9b8d2）而不是 `primaryBorderColor`（#d8cfe0）——
    # 两个键都配着（别的图种吃另一个），这里断言的是**真生效的那一个**（实测得出，不是照抄配置）
    check(f'★节点描边 = 藕紫 #c9b8d2（实测 {fixed["nodeStroke"]}）',
          fixed["nodeStroke"] == "rgb(201, 184, 210)", str(fixed["nodeStroke"]))
    check(f'★分组底 = 淡粉 #faf4f7（实测 {fixed["clusterFill"]}）',
          fixed["clusterFill"] == "rgb(250, 244, 247)", str(fixed["clusterFill"]))
    check(f'★分组框 = 淡紫 #e2cfe0（实测 {fixed["clusterStroke"]}）',
          fixed["clusterStroke"] == "rgb(226, 207, 224)", str(fixed["clusterStroke"]))
    check(f'★连线 = 灰紫 #9b8fa6（实测 {fixed["edgeStroke"]}）',
          fixed["edgeStroke"] == "rgb(155, 143, 166)", str(fixed["edgeStroke"]))
    check(f'★节点文字 = 墨紫 #4a3550（实测 {fixed["labelFill"]}）',
          fixed["labelFill"] == "rgb(74, 53, 80)", str(fixed["labelFill"]))
    check(f'★字体换成站点那串（实测 {fixed["labelFont"]}）——不再含 trebuchet',
          fixed["labelFont"] is not None and "trebuchet" not in fixed["labelFont"].lower(),
          str(fixed["labelFont"]))
    check("★两臂确实不同款（同一张图、同一次运行）",
          fixed["nodeFill"] != prev["nodeFill"] and fixed["clusterFill"] != prev["clusterFill"],
          f'{fixed["nodeFill"]} vs {prev["nodeFill"]}')

    print("④ 负空间：两处调用点都传了这份配置，裸 mermaid() 一处不剩")
    read_src = READ_TSX.read_text(encoding="utf-8")
    chat_src = CHAT_TS.read_text(encoding="utf-8")
    check("文章页 plugins 里是 `mermaid(MERMAID_CONFIG)`",
          "mermaid(MERMAID_CONFIG)" in read_src, "找不到这个字面")
    check("对话框 viewerEffect 里也是 `mermaid(MERMAID_CONFIG)`",
          "mermaid(MERMAID_CONFIG)" in chat_src, "找不到这个字面")
    hits = []
    for f in SRC.rglob("*"):
        if f.suffix not in (".ts", ".tsx") or f.name == "mermaidTheme.ts":
            continue
        for i, line in enumerate(f.read_text(encoding="utf-8").splitlines(), 1):
            s = line.strip()
            if s.startswith("//") or s.startswith("*"):
                continue
            if "mermaid()" in s:
                hits.append(f"{f.relative_to(FE)}:{i}  {s}")
    check("★全仓没有裸 `mermaid()` 了（漏一处就是「谁先渲染谁定调」的静默分叉）",
          not hits, " | ".join(hits))

    br.close()

# 打包入口落在 node_modules 下（见 WORK 那条注释），跑完清掉，别在依赖目录里积垃圾
shutil.rmtree(WORK, ignore_errors=True)

print(f"\n{'✗' if FAIL else '✓'} mermaid-theme：{PASS} 通过 / {FAIL} 失败")
raise SystemExit(1 if FAIL else 0)
