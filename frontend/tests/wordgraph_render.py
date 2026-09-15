#!/usr/bin/env python3
"""图谱渲染数值断言（本机不能 vite build 的替代手段：esbuild 单文件打包 + CDP 断言）。

    python3 tests/wordgraph_render.py

不起服务：`page.route` 把 /graph/manifest.json 与产物文件从磁盘直接喂回去，
所以**真实的 loader.ts 也一并被验了**（manifest 校验 → 动态 import → export default）。

五条断言，第 4 条是性能硬门槛：
  1. 画布真的画了东西（非透明像素 > 阈值、颜色 ≥ 2）
  2. 拖动改变画面
  3. 定位后视图确实朝命中簇移动，且命中簇被摆到画面中心
  4. **空闲 3 秒 rAF 计数增量为 0**（定位动画与辉光结束后必须彻底停下来）
  5. prefers-reduced-motion 下不抛错且瞬移到位
"""
from __future__ import annotations

import json
import pathlib
import subprocess
import sys
import tempfile

from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parent.parent
GRAPH_DIR = ROOT / "public" / "graph"
WG_SRC = ROOT / "src" / "frontHome" / "Content" / "ContentHome" / "Vitrine" / "wordgraph"

CANVAS_W, CANVAS_H = 620, 460
DEFINE = ('import.meta.env={"VITE_HTTP_BASEURL":"","VITE_CDN_BASEURL":"",'
          '"MODE":"production","DEV":false,"PROD":true,"BASE_URL":"/"}')

passed = failed = 0


def ok(cond, name, detail=None):
    global passed, failed
    if cond:
        passed += 1
        print(f"  ✓ {name}")
    else:
        failed += 1
        print(f"  ✗ FAIL: {name}" + (f"  → {detail}" if detail is not None else ""))


def bundle() -> str:
    """把 engine/loader/locate 打成一个 IIFE，导出挂到 window.WG。
    入口走 stdin，不在仓库里留测试专用源文件。
    ⚠️ esbuild 0.21 没有 `--resolve-dir`：stdin 的裸相对导入是**按 cwd 解析**的，
    所以必须 cwd=wordgraph 目录（`--stdin` 也不是合法 flag，不传入口文件即读 stdin）。"""
    out = pathlib.Path(tempfile.mkdtemp(prefix="wgr-")) / "wg.js"
    subprocess.run(
        [str(ROOT / "node_modules" / ".bin" / "esbuild"),
         "--bundle", "--format=iife", "--global-name=WG", "--target=es2020",
         "--loader=ts", "--sourcefile=entry.ts",
         f"--outfile={out}", f"--define:{DEFINE}", "--log-level=warning"],
        input="export * from './engine';\nexport * from './loader';\nexport * from './locate';\n",
        text=True, check=True, cwd=WG_SRC,
    )
    return out.read_text(encoding="utf-8")


PAGE = f"""<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{{margin:0;background:#101623}}
  #c{{display:block;width:{CANVAS_W}px;height:{CANVAS_H}px}}
</style></head><body><canvas id="c"></canvas></body></html>"""

# 画布统计 + 相机读数。都在页面里算，避免把几十万像素搬过 CDP。
JS_STATS = """() => {
  const cv = document.getElementById('c');
  const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
  let n = 0, sx = 0, sy = 0; const colors = new Set();
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] > 8) {
      n++; const p = i >> 2;
      sx += p % cv.width; sy += Math.floor(p / cv.width);
      colors.add((d[i] >> 5) + '_' + (d[i + 1] >> 5) + '_' + (d[i + 2] >> 5));
    }
  }
  return {n, colors: colors.size, cx: n ? sx / n : 0, cy: n ? sy / n : 0};
}"""

# "画面变了没有"用**逐像素差异**而不是质心位移：点云近似一个球，转它的时候
# 亮的像素在球面上换了一批，质心却几乎不动（实测拖动 120px 只移动 4.9px < 5）。
# 差异比例才是"画面确实换了"的忠实度量。
JS_SNAP = """() => {
  const cv = document.getElementById('c');
  window.__prev = new Uint8ClampedArray(
    cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data);
}"""
JS_DIFF = """() => {
  const cv = document.getElementById('c');
  const cur = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
  const prev = window.__prev;
  let ch = 0;
  for (let i = 0; i < cur.length; i += 4) {
    if (Math.abs(cur[i] - prev[i]) + Math.abs(cur[i + 1] - prev[i + 1])
        + Math.abs(cur[i + 2] - prev[i + 2]) > 24) ch++;
  }
  return ch / (cur.length / 4);
}"""


def main() -> int:
    mf = GRAPH_DIR / "manifest.json"
    if not mf.exists():
        print("找不到 public/graph/manifest.json——先跑 scripts/build_word_graph.py")
        return 1
    manifest = json.loads(mf.read_text(encoding="utf-8"))
    artifact = (GRAPH_DIR / manifest["file"]).read_text(encoding="utf-8")
    print(f"产物 {manifest['file']}（{manifest['bytes']} 字节）")

    js = bundle()
    print(f"bundle {len(js)} 字节\n")

    with sync_playwright() as pw:
        browser = pw.chromium.launch(args=["--no-sandbox", "--disable-dev-shm-usage"])
        try:
            run(browser, manifest, artifact, js)
        finally:
            browser.close()

    print(f"\n{'✓' if failed == 0 else '✗'} wordgraph-render: {passed} passed, {failed} failed")
    return 0 if failed == 0 else 1


def new_page(browser, manifest, artifact, js, reduced_motion=None):
    ctx = browser.new_context(viewport={"width": 900, "height": 700},
                              reduced_motion=reduced_motion)
    page = ctx.new_page()
    errors: list[str] = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.on("console", lambda m: errors.append(f"console.{m.type}: {m.text}")
            if m.type == "error" else None)
    # 整个源都由内存喂：页面本身 + /graph/*。**必须 goto 一个真 URL 而不是
    # set_content**——about:blank 没有 base URL，loader 里的相对 fetch 会直接
    # "Failed to parse URL"（而且那样也就验不到相对路径拼得对不对了）。
    def serve(route):
        path = route.request.url.split("?", 1)[0]
        if path.endswith("/graph/manifest.json"):
            route.fulfill(status=200, content_type="application/json", body=json.dumps(manifest))
        elif path.endswith(f"/graph/{manifest['file']}"):
            route.fulfill(status=200, content_type="text/javascript", body=artifact)
        else:
            route.fulfill(status=200, content_type="text/html", body=PAGE)
    page.route("**/*", serve)
    page.goto("http://vitrine.test/")
    # 计数器必须在 engine 构造之前装上
    page.evaluate("""() => {
      window.__raf = 0;
      const orig = window.requestAnimationFrame.bind(window);
      window.requestAnimationFrame = (cb) => { window.__raf++; return orig(cb); };
    }""")
    page.add_script_tag(content=js)
    page.wait_for_function("() => !!window.WG")
    return ctx, page, errors


def run(browser, manifest, artifact, js):
    print("== 1. 首次绘制 ==")
    ctx, page, errors = new_page(browser, manifest, artifact, js)
    page.evaluate("""async () => {
      const data = await WG.loadGraph();
      const cv = document.getElementById('c');
      window.__eng = new WG.WordGraphEngine(cv, data, {});
      window.__data = data;
    }""")
    page.wait_for_timeout(500)
    s = page.evaluate(JS_STATS)
    ok(s["n"] > 2000, "画布画出了内容（非透明像素 > 2000）", s)
    ok(s["colors"] >= 2, "至少 2 种颜色（点按文章着色）", s)
    ok(errors == [], "首屏无 console error / pageerror", errors)

    print("== 2. 空闲 3 秒 rAF 必须为 0（性能硬门槛）==")
    a = page.evaluate("window.__raf")
    page.wait_for_timeout(3000)
    b = page.evaluate("window.__raf")
    ok(b - a == 0, "空闲 3s 内 rAF 计数增量为 0", {"delta": b - a})

    print("== 3. 拖动改变画面 ==")
    page.evaluate(JS_SNAP)
    cam0 = page.evaluate("window.__eng.getCamera()")
    page.mouse.move(400, 350)
    page.mouse.down()
    for x in range(400, 520, 20):
        page.mouse.move(x, 360)
    page.mouse.up()
    page.wait_for_timeout(300)
    changed = page.evaluate(JS_DIFF)
    cam1 = page.evaluate("window.__eng.getCamera()")
    ok(abs(cam1["yaw"] - cam0["yaw"]) > 0.1, "拖动改变了 yaw", {"before": cam0["yaw"], "after": cam1["yaw"]})
    ok(changed > 0.02, "拖动后 >2% 的像素发生变化（画面真的重绘了）", {"changed": round(changed, 4)})
    ok(cam1["pitch"] == max(-1.35, min(1.35, cam1["pitch"])), "pitch 在夹紧范围内", cam1["pitch"])

    print("== 4. 定位：视图朝命中簇移动且把簇摆到中心 ==")
    # 查询词特意选多命中且**空间上散开**的：只命中一个词的话"簇摆正"是恒真的
    # （质心就是那一个点本身），取景系数再错也测不出来。'异步编程' 只命中「异步」，
    # 测不出东西——用它跑过一版，断言是绿的但等于没测。
    page.evaluate("""() => {
      window.__eng.home(0);
      const hits = WG.locateLocal('线程协程并发', window.__data);
      window.__hits = hits;
      window.__eng.setHighlight(hits);
      window.__eng.flyTo(WG.cameraFor(window.__data, hits, window.__eng.getCamera()));
    }""")
    page.wait_for_timeout(1000)          # 飞行动画 720ms
    cam2 = page.evaluate("window.__eng.getCamera()")
    ok(abs(cam2["target"][0]) + abs(cam2["target"][1]) + abs(cam2["target"][2]) > 1e-6,
       "定位后相机 target 离开了原点", cam2["target"])
    ok(cam2["dist"] < 4.3 - 1e-6, "定位后推近了（dist < 首页机位）", cam2["dist"])
    placed = page.evaluate("""() => {
      const d = window.__data, cam = window.__eng.getCamera();
      const p = new WG.Projection(d.nodes.length);
      WG.projectNodes(d.nodes, cam, 620, 460, p);
      const idx = window.__hits.map(h => d.nodes.findIndex(n => n.w === h.w)).filter(i => i >= 0);
      let sx = 0, sy = 0, spread = 0;
      for (const i of idx) { sx += p.x[i]; sy += p.y[i]; }
      for (const i of idx) for (const j of idx) {
        const a = d.nodes[i], b = d.nodes[j];
        spread = Math.max(spread, Math.hypot(a.x-b.x, a.y-b.y, a.z-b.z));
      }
      return {n: idx.length, cx: sx / idx.length, cy: sy / idx.length, spread,
              words: window.__hits.map(h => h.w)};
    }""")
    ok(placed["n"] >= 3, "命中 ≥3 个词（'线程协程并发'）", placed)
    # 0.15 而不是更大：线程/协程/并发**本来就该挨着**（语义近邻），散开度只要
    # 远大于命中辉光的几像素半径，居中检查就不是恒真的。要的是"不是同一个点"。
    ok(placed["spread"] > 0.15, "命中簇在世界空间里是散开的（否则居中检查恒真）", placed)
    ok(abs(placed["cx"] - 310) < 60 and abs(placed["cy"] - 230) < 60,
       "命中簇的投影质心落在画面中心附近（±60px）", placed)

    s2 = page.evaluate(JS_STATS)
    ok(s2["n"] > 2000, "定位后画面仍有内容（没被清空）", s2)

    print("== 5. 定位动画 + 辉光结束后，rAF 必须重新归零 ==")
    page.wait_for_timeout(2400)          # 辉光 1.8s
    a = page.evaluate("window.__raf")
    page.wait_for_timeout(2000)
    b = page.evaluate("window.__raf")
    ok(b - a == 0, "定位过后仍能回到零 rAF（脉冲是有限的）", {"delta": b - a})

    print("== 6. 悬停读数 / 命中测试 ==")
    hit = page.evaluate("""() => {
      const d = window.__data, p = new WG.Projection(d.nodes.length), cam = {yaw:0,pitch:0,dist:5,target:[0,0,0]};
      WG.projectNodes(d.nodes, cam, 620, 460, p);
      const i = WG.pickNode(p, p.x[0], p.y[0]);
      const j = WG.pickNode(p, p.x[0] + 500, p.y[0]);
      return {same: i === 0, off: j};
    }""")
    ok(hit["same"], "落点处命中对应节点")
    ok(hit["off"] is None, "远偏移处不命中", hit)
    ok(errors == [], "全程无 console error / pageerror", errors)
    ctx.close()

    print("== 7. prefers-reduced-motion ==")
    ctx2, page2, errors2 = new_page(browser, manifest, artifact, js, reduced_motion="reduce")
    page2.evaluate("""async () => {
      const data = await WG.loadGraph();
      const cv = document.getElementById('c');
      const eng = new WG.WordGraphEngine(cv, data, {});
      const hits = WG.locateLocal('线程', data);
      eng.setHighlight(hits);
      eng.flyTo(WG.cameraFor(data, hits, eng.getCamera()));   // 应当瞬移
      window.__eng2 = eng;
    }""")
    page2.wait_for_timeout(400)
    cam3 = page2.evaluate("window.__eng2.getCamera()")
    ok(cam3["dist"] < 4.3 - 1e-6, "reduced-motion 下 flyTo 直接到位（不走动画）", cam3["dist"])
    s3 = page2.evaluate(JS_STATS)
    ok(s3["n"] > 2000, "reduced-motion 下照常渲染", s3)
    ok(errors2 == [], "reduced-motion 下无报错", errors2)
    ctx2.close()


if __name__ == "__main__":
    sys.exit(main())
