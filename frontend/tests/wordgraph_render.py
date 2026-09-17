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


# 画布调用录音器：把 moveTo/lineTo/stroke 的坐标与当时的描边色记下来，用来验
# "热边在近平面裁剪下仍然被画出来"——这条只能在真实 ctx 调用层观察
# （像素法分不清"线被裁短"和"线整条没了"）。
JS_REC_INSTALL = """() => {
  if (window.__recInstalled) { window.__rec.strokes = []; window.__rec.bad = 0; window.__rec.texts = []; return; }
  window.__recInstalled = true;
  window.__rec = { strokes: [], bad: 0, texts: [] };
  const P = CanvasRenderingContext2D.prototype;
  const ob = P.beginPath, om = P.moveTo, ol = P.lineTo, os = P.stroke;
  let segs = 0;
  P.beginPath = function () { segs = 0; return ob.call(this); };
  const chk = (x) => { if (!isFinite(x) || Math.abs(x) > 1e5) window.__rec.bad++; };
  P.moveTo = function (x, y) { segs++; chk(x); return om.call(this, x, y); };
  P.lineTo = function (x, y) { segs++; chk(x); return ol.call(this, x, y); };
  P.stroke = function () { window.__rec.strokes.push({ style: String(this.strokeStyle), segs }); return os.call(this); };
  const oft = P.fillText;
  P.fillText = function (t, x, y) { window.__rec.texts.push(String(t)); return oft.call(this, t, x, y); };
}"""

# 与 palette.ts 的 PALETTE.edgeHot 同步（改了那里这里要一起改）
EDGE_HOT_RGB = "255, 232, 168"


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
    home_dist = page.evaluate("() => WG.HOME_CAM.dist")      # 别写死：默认机位会随实测调整
    ok(cam2["dist"] < home_dist - 1e-6, "定位后推近了（dist < 首页机位）", cam2["dist"])
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
    # 阈值只要"远大于同一个点"即可——这条是**防恒真**，不是测布局质量：命中簇
    # 塌成一个点时质心居中就成了同义反复。20260917 换 UMAP 后 线程/协程/并发 从
    # 0.19 收到 0.135（相关词更聚，正是换布局的目的），阈值随之从 0.15 放到 0.08。
    ok(placed["spread"] > 0.08, "命中簇在世界空间里是散开的（否则居中检查恒真）", placed)
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
      // 挑"屏幕空间最孤立的点"来验命中：pickNode 取命中半径内**离相机最近**的那个，
      // 20260917 换成 UMAP 布局后点挨得更近（22% 的点与邻居距离 <0.02），拿固定下标
      // 当靶子会合法地命中邻居、把断言弄红——要测的是"点得中"，不是"点 0 号中 0 号"。
      let best = -1, bestGap = -1;
      for (let i = 0; i < d.nodes.length; i++) {
        if (p.d[i] <= 0.05) continue;
        let gap = Infinity;
        for (let j = 0; j < d.nodes.length; j++) {
          if (i === j || p.d[j] <= 0.05) continue;
          gap = Math.min(gap, Math.hypot(p.x[i] - p.x[j], p.y[i] - p.y[j]));
        }
        if (gap > bestGap) { bestGap = gap; best = i; }
      }
      const i = WG.pickNode(p, p.x[best], p.y[best]);
      const j = WG.pickNode(p, p.x[best] + 500, p.y[best]);
      return {same: i === best, off: j, best, gap: Math.round(bestGap * 10) / 10};
    }""")
    ok(hit["same"], "孤立点的像素处命中的就是它自己", hit)
    ok(hit["off"] is None, "远偏移处不命中", hit)
    print("== 6b. 邻居被推到相机后方时，热边仍要画出来（近平面裁剪）==")
    page.evaluate(JS_REC_INSTALL)
    picked = page.evaluate("""() => {
      const d = window.__data, eng = window.__eng;
      const deg = new Map();
      for (const e of d.edges) { deg.set(e[0], (deg.get(e[0]) || 0) + 1); deg.set(e[1], (deg.get(e[1]) || 0) + 1); }
      let sel = -1, nb = -1;
      for (const e of d.edges) { if ((deg.get(e[0]) || 0) >= 2) { sel = e[0]; nb = e[1]; break; } }
      if (sel < 0) return null;
      eng.setSelected(sel);
      const a = d.nodes[sel], b = d.nodes[nb];
      // 相机摆成"看向 nb、眼睛落在 nb 前 0.02"：nb 的 depth = 0.02 ≤ NEAR（已在近平面内），
      // sel 的 depth = |nb−sel|+0.02 > NEAR（仍在相机前方）——正是用户顺着高亮线飞过去的那一刻
      const L = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z) || 1;
      const dir = [(b.x - a.x) / L, (b.y - a.y) / L, (b.z - a.z) / L];
      const pitch = Math.asin(Math.max(-1, Math.min(1, dir[1])));
      const yaw = Math.atan2(dir[0], dir[2]);
      const eye = [b.x + dir[0] * 0.02, b.y + dir[1] * 0.02, b.z + dir[2] * 0.02];
      const dist = eng.getCamera().dist;
      eng.flyTo({ yaw, pitch, dist,
                  target: [eye[0] - dir[0] * dist, eye[1] - dir[1] * dist, eye[2] - dir[2] * dist] }, 0);
      return { sel, nb };
    }""")
    page.wait_for_timeout(300)
    if not picked:
        ok(False, "找到可测的选中点 + 邻居", picked)
    else:
        rec = page.evaluate("() => window.__rec")
        hot = [st for st in rec["strokes"] if EDGE_HOT_RGB in st["style"] and st["segs"] > 0]
        ok(bool(hot), "邻居落在近平面内时热边仍然被绘制（旧实现是整条丢）",
           {"sel": picked, "hotStrokes": len(hot), "total": len(rec["strokes"])})
        ok(rec["bad"] == 0, "没有任何线段坐标落到 FAR_X（−1e6）上", rec["bad"])

    print("== 6c. 悬浮时，邻居的名字也画在点上（N 层由悬停驱动）==")
    # ⚠️ 这条必须挑一个"不悬浮时确实没有名字"的邻居——否则 A 层（重要度前 22 常驻）
    #    或 B 层（按深度补位）早就把它画上了，断言会**空转**（第一版就是这么空转的：
    #    挑中的 Bearer 本来就在 A 层里，把引擎改动暂存掉测试照样绿）。
    page.evaluate("() => { window.__rec.texts = []; }")
    page.mouse.move(3, 3)                        # 先把光标挪开，取"没有悬浮"的基线
    page.wait_for_timeout(250)
    base = set(page.evaluate("() => window.__rec.texts"))
    pick = page.evaluate("""(baseline) => {
      const d = window.__data, eng = window.__eng;
      const cv = document.getElementById('c');
      const w = cv.clientWidth, h = cv.clientHeight;
      eng.setSelected(null);
      const p = new WG.Projection(d.nodes.length);
      WG.projectNodes(d.nodes, eng.getCamera(), w, h, p);
      const inside = (i) => p.d[i] > 0.05 && p.x[i] > 24 && p.x[i] < w - 24 && p.y[i] > 24 && p.y[i] < h - 24;
      for (const e of d.edges) {
        for (const [a, b] of [[e[0], e[1]], [e[1], e[0]]]) {
          if (!inside(a) || !inside(b)) continue;
          if (baseline.includes(d.nodes[b].w)) continue;   // 不悬浮时就有名字 ⇒ 测不出 N 层
          if (d.nodes[a].w === d.nodes[b].w) continue;
          return { x: p.x[a], y: p.y[a], wa: d.nodes[a].w, wb: d.nodes[b].w };
        }
      }
      return null;
    }""", list(base))
    if not pick:
        ok(False, "找到一对「悬浮才有名字」的邻居（A/B 层不会提前画它）", pick)
    else:
        page.mouse.move(pick["x"], pick["y"])
        page.wait_for_timeout(350)
        texts = page.evaluate("() => window.__rec.texts")
        ok(pick["wb"] in texts,
           f"悬浮 {pick['wa']} 时，邻居 {pick['wb']} 的名字被画到画布上（不悬浮时没有）",
           {"baseline_has": pick["wb"] in base, "texts": texts[:12]})
        ok(pick["wa"] in texts, "被悬浮那个词自己的名字也在", texts[:12])

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
    home_dist2 = page2.evaluate("() => WG.HOME_CAM.dist")
    ok(cam3["dist"] < home_dist2 - 1e-6, "reduced-motion 下 flyTo 直接到位（不走动画）", cam3["dist"])
    s3 = page2.evaluate(JS_STATS)
    ok(s3["n"] > 2000, "reduced-motion 下照常渲染", s3)
    ok(errors2 == [], "reduced-motion 下无报错", errors2)
    ctx2.close()


if __name__ == "__main__":
    sys.exit(main())
