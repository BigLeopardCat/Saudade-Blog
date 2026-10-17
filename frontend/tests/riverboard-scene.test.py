#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""河灯留言板「电影感重制」的画面判据（20261018）。

  python3 tests/riverboard-scene.test.py

为什么要有这一套：这一页的新渲染层（云、月晕、银河、大气透视、水面倒影、后期）
**失效方式是静默的**——烘出来的 canvas 尺寸算错、裁剪路径把整层裁没了、某个
`if` 恒假、异常被 catch 吞掉，页面照常渲染、tsc/lint/单测全绿，只是那层不见了。
"截图看一眼"正是 20261001 那次翻车的判据（整页截图里月盘只有 86 设备像素，
肉眼判不出它是一颗棕球还是月亮）。

所以判据落在**真渲染出来的 canvas 像素**上，而且每一条都配一个**反向对照**：
把那一层从源码里摘掉再打包一次，同一条判据必须当场变红。判据与对照在同一个
文件里，对照红了才证明判据不是空断言。

本套件是 `*.test.py`（Playwright 沙箱），**不进 CI**，由
`scripts/nightly_sandboxes.sh` 夜间跑（与 riverboard-contrast.test.py 同班）。

依赖：frontend/node_modules（esbuild/react/react-dom/sass）、playwright(python)、Pillow。
"""
import http.server
import json
import pathlib
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import threading

ROOT = pathlib.Path(__file__).resolve().parents[2]
FE = ROOT / "frontend"
RB = "src/pages/RiverBoard"

PASS, FAIL = 0, 0


def check(desc: str, cond: bool, detail: str = "") -> None:
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"  ✓ {desc}")
    else:
        FAIL += 1
        print(f"  ✗ {desc}" + (f"  → {detail}" if detail else ""))


# ────────────────────────── 沙箱 ──────────────────────────

SASS_JS = 'const sass=require("sass");process.stdout.write(sass.compile(process.argv[1]).css.toString());'

ENTRY = """\
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import RiverBoard from './src/pages/RiverBoard/index.tsx';

(window as any).__mount = () => createRoot(document.getElementById('root')!).render(
  <MemoryRouter initialEntries={['/guestbook']}>
    <RiverBoard />
  </MemoryRouter>
);
"""

HTML = """<!doctype html><html><head><meta charset="utf-8">
<style>html,body{margin:0;padding:0;background:#03050c;overflow:hidden}
#rzcss{}</style><style id="rzcss"></style></head>
<body><div id="root"></div><script src="bundle.js"></script></body></html>"""


def _esbuild(sb: pathlib.Path, out: str = "bundle.js") -> None:
    r = subprocess.run(
        [str(FE / "node_modules/.bin/esbuild"), "entry.tsx",
         "--bundle", "--format=iife", "--outfile=" + out,
         "--loader:.scss=text", "--loader:.css=text", "--jsx=automatic",
         "--loader:.png=dataurl", "--loader:.svg=dataurl", "--loader:.jpg=dataurl",
         "--define:import.meta.env={}"],
        cwd=str(sb), capture_output=True)
    if r.returncode != 0:
        raise SystemExit("esbuild 打包失败：\n%s" % r.stderr.decode("utf-8", "replace"))


def _patch_scss(sb: pathlib.Path) -> None:
    """把真的 index.scss 编译进沙箱（不是手抄选择器）。"""
    src = FE / RB / "index.scss"
    tmp = sb / "_in.scss"
    tmp.write_text(src.read_text(encoding="utf-8"), encoding="utf-8")
    r = subprocess.run(["node", "-e", SASS_JS, str(tmp)], cwd=str(FE), capture_output=True)
    if r.returncode != 0:
        raise SystemExit("sass 编译失败：\n" + r.stderr.decode("utf-8", "replace"))
    (sb / "rz.css").write_text(r.stdout.decode("utf-8"), encoding="utf-8")


def build_sandbox(patches: dict | None = None) -> pathlib.Path:
    """拷一份 src 出来打包。`patches` = {相对路径: [(old, new), …]}，用于出反向对照。"""
    sb = pathlib.Path(tempfile.mkdtemp(prefix="rzscene-"))
    shutil.copytree(FE / "src", sb / "src")
    (sb / "node_modules").symlink_to(FE / "node_modules", target_is_directory=True)
    for rel, subs in (patches or {}).items():
        p = sb / rel
        s = p.read_text(encoding="utf-8")
        for old, new in subs:
            if old not in s:
                raise SystemExit(f"反向对照的锚点不在源码里了：{rel} :: {old[:60]}")
            s = s.replace(old, new, 1)
        p.write_text(s, encoding="utf-8")
    (sb / "entry.tsx").write_text(ENTRY, encoding="utf-8")
    (sb / "index.html").write_text(HTML, encoding="utf-8")
    _patch_scss(sb)
    _esbuild(sb)
    return sb


class _Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a):  # noqa: D102
        pass


def serve(sb: pathlib.Path) -> str:
    h = lambda *a, **k: _Quiet(*a, directory=str(sb), **k)  # noqa: E731
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), h)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return "http://127.0.0.1:%d/index.html" % srv.server_address[1]


# ────────────────────────── 量测 ──────────────────────────

MEASURE = r"""
() => {
  const cv = document.querySelector('canvas.rz-canvas');
  if (!cv) return { err: 'no canvas' };
  const g = document.createElement('canvas');
  g.width = cv.width; g.height = cv.height;
  const gc = g.getContext('2d');
  gc.drawImage(cv, 0, 0);
  const W = g.width, H = g.height;
  const d = gc.getImageData(0, 0, W, H).data;
  const lum = (x, y) => {
    const i = ((y | 0) * W + (x | 0)) * 4;
    return 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
  };
  const meanLum = (x0, y0, x1, y1) => {
    let s = 0, n = 0;
    for (let y = y0 | 0; y < y1; y += 2) for (let x = x0 | 0; x < x1; x += 2) { s += lum(x, y); n++; }
    return n ? s / n : 0;
  };
  /* 横向结构度：**16px 步长**的 |Δ| 均值。
     为什么不用 4px：星星是 1-3px 的点，用细步长量出来的"结构"大半是星点，
     云层摘掉了判据也掉不下去（实测 2.77 → 1.98，掉不到一半）。云的特征尺度
     是 50-150px，16px 步长照样量得到，星点则被跨过去了。 */
  const rowVar = (x0, x1, y0, y1) => {
    let s = 0, n = 0;
    for (let y = y0 | 0; y < y1; y += 4) {
      for (let x = x0 | 0; x < x1 - 16; x += 16) {
        s += Math.abs(lum(x, y) - lum(x + 16, y)); n++;
      }
    }
    return n ? s / n : 0;
  };
  // 月心与月盘半径（与 index.tsx 的 MOON 常量同源）
  const mx = W * 0.7, my = H * 0.16, mr = Math.min(W, H) * 0.078;
  // 以月心为心的环形扇区均值（只取左右各 60° 的扇面，避开月盘本身）
  const sector = (r0, r1, dirX) => {
    let s = 0, n = 0;
    for (let rr = r0; rr <= r1; rr += Math.max(2, (r1 - r0) / 24)) {
      for (let a = -1.0; a <= 1.0; a += 0.08) {
        const x = mx + dirX * rr, y = my + a * rr * 0.85;
        if (x < 2 || x > W - 3 || y < 2 || y > H - 3) continue;
        s += (lum(x, y - 1) + lum(x, y) + lum(x, y + 1)) / 3; n++;
      }
    }
    return n ? s / n : 0;
  };
  return {
    W, H, dpr: W / window.innerWidth,
    // 绝对下限：整幅天空不能是黑的（对照构建也得是"活页面"，否则 A/B 无意义）
    skyTopLum: meanLum(W * 0.05, H * 0.005, W * 0.95, H * 0.02),
    // 云：上部天空带（远山之上）的横向结构度 + 平均亮度
    cloudStruct: rowVar(W * 0.05, W * 0.95, H * 0.03, H * 0.15),
    cloudLum: meanLum(W * 0.05, H * 0.03, W * 0.95, H * 0.15),
    // 月晕：同一半径上朝月侧 vs 背月侧（方向性），以及中景扇区的绝对亮度
    haloNear: sector(mr * 2.6, mr * 4.0, 1),
    haloFar: sector(mr * 2.6, mr * 4.0, -1),
    haloMid: (sector(W * 0.10, W * 0.19, 1) + sector(W * 0.10, W * 0.19, -1)) / 2,
    // 银河带：带轴在 y∈[0.02H,0.08H] 处落在 x≈0.76-0.84W；带外取同高度左端
    mwBand: meanLum(W * 0.755, H * 0.02, W * 0.845, H * 0.08),
    mwOff: meanLum(W * 0.30, H * 0.02, W * 0.39, H * 0.08),
    // 远山雾纱：最远那层山脊之上那一带 vs 它上方的天空
    ridgeFarBand: meanLum(W * 0.10, H * 0.215, W * 0.35, H * 0.245),
    ridgeFarSky: meanLum(W * 0.10, H * 0.150, W * 0.35, H * 0.175),
  };
}
"""


def render(url: str, soft: bool = False, wait: int = 9000) -> dict:
    from playwright.sync_api import sync_playwright
    args = ["--force-device-scale-factor=1"]
    if soft:
        args += ["--disable-webgl", "--disable-webgl2", "--disable-gpu"]
    with sync_playwright() as p:
        br = p.chromium.launch(args=args)
        pg = br.new_page(viewport={"width": 1440, "height": 900}, device_scale_factor=1)
        pg.route("**/live2d-widgets/**", lambda r: r.abort())
        pg.route("**/live2d_model/**", lambda r: r.abort())
        pg.route("**/cubism5/**", lambda r: r.abort())
        pg.goto(url, wait_until="domcontentloaded", timeout=90000)
        pg.wait_for_timeout(600)
        pg.evaluate("() => window.__mount()")
        pg.wait_for_timeout(wait)
        m = pg.evaluate(MEASURE)
        if soft:
            m["canvasCount"] = pg.evaluate("() => document.querySelectorAll('canvas').length")
        br.close()
    return m


def free_port_ok() -> bool:
    s = socket.socket()
    try:
        s.bind(("127.0.0.1", 0))
        return True
    finally:
        s.close()


def main() -> int:
    if not free_port_ok():
        raise SystemExit("本机端口不可用")
    try:
        import playwright  # noqa: F401
    except ImportError:
        raise SystemExit("缺 playwright(python)")

    SKY = f"{RB}/render/sky.ts"
    HALO_ANCHOR = "export function drawMoonHalo(ctx: CanvasRenderingContext2D, geo: Geo, moon: MoonGeom): void {"
    MW_ANCHOR = "export function drawMilkyWay(ctx: CanvasRenderingContext2D, geo: Geo, seed = 7): void {"
    RIDGE_ANCHOR = "export function drawRidges(ctx: CanvasRenderingContext2D, geo: Geo, moon: MoonGeom): void {"

    print("\n① 四份构建（基准 + 三份「摘掉那一层」的反向对照）")
    builds = {
        "base": build_sandbox(),
        # 云：把密度阈值顶到 2.0 ⇒ 没有任何像素过阈 ⇒ 整层 alpha=0
        "noCloud": build_sandbox({SKY: [
            ("            if (v <= cfg.thr) continue;", "            if (v <= 2) continue;")]}),
        "noHalo": build_sandbox({SKY: [(HALO_ANCHOR, HALO_ANCHOR + "\n    if (ctx) return;")]}),
        "noMilky": build_sandbox({SKY: [(MW_ANCHOR, MW_ANCHOR + "\n    if (ctx) return;")]}),
        "noRidge": build_sandbox({SKY: [(RIDGE_ANCHOR, RIDGE_ANCHOR + "\n    if (ctx) return;")]}),
    }
    M = {}
    for k, sb in builds.items():
        M[k] = render(serve(sb))
        if M[k].get("err"):
            raise SystemExit("挂载失败（%s）：%s" % (k, M[k]))
    for k, m in M.items():
        print("     %-8s %s" % (k, json.dumps(
            {kk: (round(vv, 2) if isinstance(vv, float) else vv) for kk, vv in m.items()},
            ensure_ascii=False)))

    b = M["base"]

    print("\n② 每一条判据都配一个反向对照（对照不红 = 判据是空断言）")

    check("对照构建本身是「活页面」（天空非黑、有结构）—— 否则 A/B 无意义",
          M["noCloud"]["skyTopLum"] > 2 and M["noHalo"]["skyTopLum"] > 2
          and M["noMilky"]["skyTopLum"] > 2 and M["noRidge"]["skyTopLum"] > 2,
          {k: round(M[k]["skyTopLum"], 2) for k in ("noCloud", "noHalo", "noMilky", "noRidge")})

    # 云：16px 步长的横向结构度
    # 云的判据落在**亮度**上而不是"结构度"上：结构度是 16px 步长的 |Δ|，
    # 银河的柔光团与月晕的渐变在这个尺度上也有贡献，实测基准 5.42 / 摘掉云 4.04
    # （只有 1.34 倍，而同一构建两次渲染之间的抖动就有 ±0.5）—— 那条判据分不开。
    # 云比夜空亮一个量级（云受光面 ~150-176，夜空 ~10-30），亮度差是能分开的那一维。
    check("体积云：上部天空带亮度在摘掉云层后显著下降",
          b["cloudLum"] > M["noCloud"]["cloudLum"] * 1.08,
          {"with": round(b["cloudLum"], 2), "without": round(M["noCloud"]["cloudLum"], 2)})
    check("体积云：上部天空带的横向结构在摘掉云层后也下降（辅助判据）",
          b["cloudStruct"] > M["noCloud"]["cloudStruct"] * 1.20,
          {"with": round(b["cloudStruct"], 3), "without": round(M["noCloud"]["cloudStruct"], 3)})

    # 月晕：中景扇区的绝对亮度（朝月 + 背月两侧取平均，避开银河带的方向偏差）
    check("月晕：中景扇区亮度在摘掉月晕后显著下降",
          b["haloMid"] > M["noHalo"]["haloMid"] * 1.12,
          {"with": round(b["haloMid"], 2), "without": round(M["noHalo"]["haloMid"], 2)})
    # 方向性：光心在受光面一侧 ⇒ 朝月侧应比背月侧亮（这是一条**图内**对照）
    check("月晕：同一半径上朝月侧比背月侧亮（光心偏在受光面一侧）",
          b["haloNear"] > b["haloFar"] * 1.03,
          {"near": round(b["haloNear"], 2), "far": round(b["haloFar"], 2)})

    # 银河：带轴处的绝对亮度
    check("银河带：带轴处亮度在摘掉银河后显著下降",
          b["mwBand"] > M["noMilky"]["mwBand"] * 1.04,
          {"with": round(b["mwBand"], 2), "without": round(M["noMilky"]["mwBand"], 2)})

    # 远山雾纱：最远那层山脊之上那一带的加光
    check("大气透视：最远那层山脊之上的雾纱带亮度在摘掉远山后显著下降",
          b["ridgeFarBand"] > M["noRidge"]["ridgeFarBand"] * 1.08,
          {"with": round(b["ridgeFarBand"], 2), "without": round(M["noRidge"]["ridgeFarBand"], 2)})

    print("\n③ 降级档：软渲染（无 WebGL）下这一页仍要出画面")
    soft = render(serve(build_sandbox()), soft=True)
    check("软渲染下 canvas 仍在且有内容（不是黑屏）",
          soft.get("W", 0) > 100 and soft.get("skyTopLum", 0) > 2,
          {"W": soft.get("W"), "skyTopLum": round(soft.get("skyTopLum", -1), 2)})

    print("\n%s（通过 %d）" % ("全部通过" if FAIL == 0 else f"失败 {FAIL} 项", PASS))
    return 0 if FAIL == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
