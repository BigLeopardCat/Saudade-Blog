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
RB = "src/pages/RiverBoard"          # 相对 frontend/（沙箱里打补丁用这个前缀）
RB_SRC = "pages/RiverBoard"          # 相对 _snapshot()（快照根就是 src/ 本身）

PASS, FAIL = 0, 0

# 喂给 /api/public/board 的假留言（24 条 ⇒ 页面挂满 DOM 河灯）
BOARD = {"code": 200, "data": [
    {"talkKey": 1000 + i, "content": "第 %d 条心愿", "cat": "愿寄忆诉"[i % 4],
     "v": i % 3, "author": "" if i % 5 == 0 else "旅人%d" % i,
     "createTime": "2026-10-1%d 2%d:0%d" % (i % 9, i % 6, i % 6)}
    for i in range(24)]}


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
#rzcss{}</style><link rel="stylesheet" href="rz.css"></head>
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


_SNAP: pathlib.Path | None = None


def _snapshot() -> pathlib.Path:
    """整个 run 的源码快照（进程内只做一次）。

    为什么非有这一层：`build_sandbox` 原来直接拷 `FE/src`，而一次运行要建十几个
    沙箱、跑好几分钟 —— 中途 src 被改一下，前后两个构建就不是同一份代码，跨构建
    的像素相减全成噪声。**实测踩过两次**：改完 `reflRowAlpha` 之后 `base` 与
    `flatChop` 分属两个版本，「碎」判据当场假红、还把方向指反了。快照一次，
    一次运行内所有构建自洽；运行期间改 src 只影响下一次运行。"""
    global _SNAP
    if _SNAP is None:
        _SNAP = pathlib.Path(tempfile.mkdtemp(prefix="rzsrc-")) / "src"
        shutil.copytree(FE / "src", _SNAP)
    return _SNAP


def _patch_scss(sb: pathlib.Path) -> None:
    """把真的 index.scss 编译进沙箱（不是手抄选择器）。读的也是快照。

    注意 `_snapshot()` 返回的**就是 src 目录本身**，所以这里用 `RB_SRC`（`src/` 之下
    的相对路径）拼，不能再用带 `src/` 前缀的 `RB`。"""
    src = _snapshot() / RB_SRC / "index.scss"
    tmp = sb / "_in.scss"
    tmp.write_text(src.read_text(encoding="utf-8"), encoding="utf-8")
    r = subprocess.run(["node", "-e", SASS_JS, str(tmp)], cwd=str(FE), capture_output=True)
    if r.returncode != 0:
        raise SystemExit("sass 编译失败：\n" + r.stderr.decode("utf-8", "replace"))
    (sb / "rz.css").write_text(r.stdout.decode("utf-8"), encoding="utf-8")


def build_sandbox(patches: dict | None = None) -> pathlib.Path:
    """拷一份 src 出来打包。`patches` = {相对路径: [(old, new), …]}，用于出反向对照。"""
    sb = pathlib.Path(tempfile.mkdtemp(prefix="rzscene-"))
    shutil.copytree(_snapshot(), sb / "src")
    (sb / "node_modules").symlink_to(FE / "node_modules", target_is_directory=True)
    for rel, subs in (patches or {}).items():
        p = sb / rel
        s = p.read_text(encoding="utf-8")
        for old, new in subs:
            n = s.count(old)
            if n == 0:
                raise SystemExit(f"反向对照的锚点不在源码里了：{rel} :: {old[:60]}")
            if n > 1:
                # 只替换第一处会让对照**静默地打在别的函数上** —— 判据于是变成
                # 空断言而套件照旧全绿。锚点不唯一就必须当场红。
                raise SystemExit(f"反向对照的锚点在源码里出现 {n} 次（必须唯一）：{rel} :: {old[:60]}")
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
  /* ── 水面（阶段 2）──
     河道几何在这里重写一份（与 index.tsx 的 riverX/riverY 同源）。判据必须按
     "河道内部"取样而不是按矩形区域 —— 否则量到的一半是岸。 */
  const yH = H * 0.33;
  const riverX = (u, d) => {
    const bend = Math.sin(0.6 + d * 2.2);
    const c = W * (0.51 + 0.045 * bend);
    const hw = W * (0.15 + d * d * 1.08);
    return c + (u - 0.5) * 2 * hw;
  };
  const riverY = (d) => yH + (H * 1.06 - yH) * Math.pow(Math.max(0, d), 1.42);
  const depthOfY = (y) => Math.pow(Math.max(0, (y - yH) / (H * 1.06 - yH)), 1 / 1.42);
  const inRiver = (x, y) => {
    const d = depthOfY(y);
    if (d > 1.14) return false;
    return x > riverX(0, d) && x < riverX(1, d);
  };
  const riverMean = (y0, y1, xMin = -1e9, xMax = 1e9) => {
    let s = 0, n = 0;
    for (let y = y0 | 0; y < y1; y += 6) {
      const d = depthOfY(y);
      if (d > 1.12) continue;
      for (let u = 0.12; u <= 0.88; u += 0.04) {
        const x = riverX(u, d);
        if (x < xMin || x > xMax || x < 1 || x > W - 2) continue;
        s += lum(x, y); n++;
      }
    }
    return n ? s / n : 0;
  };
  const waterRowProf = (y0, y1) => {
    const out = [];
    for (let y = y0 | 0; y < y1; y += 3) {
      const d = depthOfY(y);
      if (d > 1.12) continue;
      let s = 0, n = 0;
      for (let u = 0.12; u <= 0.88; u += 0.04) {
        const x = riverX(u, d);
        if (x < 1 || x > W - 2) continue;
        s += lum(x, y); n++;
      }
      if (n) out.push(s / n);
    }
    return out;
  };
  const moonX = W * 0.7;
  // 河灯倒影：按 DOM 里真实的灯位量（灯在动，写死坐标量不到）
  let lampOn = 0, lampOff = 0, lampN = 0;
  for (const el of document.querySelectorAll('.rz-lantern')) {
    const r = el.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.bottom + 14;
    if (cy < H * 0.5 || cy > H - 90) continue;
    let a = 0, an = 0, b = 0, bn = 0;
    for (let y = cy; y < cy + 64; y += 4) {
      if (!inRiver(cx, y)) continue;
      a += lum(cx, y); an++;
      for (const ox of [-170, -140, 140, 170]) {
        if (!inRiver(cx + ox, y)) continue;
        b += lum(cx + ox, y); bn++;
      }
    }
    if (an > 4 && bn > 4) { lampOn += a / an; lampOff += b / bn; lampN++; }
  }
  const rowProf = waterRowProf(yH + 40, H - 40);
  let dsum = 0, dn = 0;
  for (let i = 1; i < rowProf.length; i++) { dsum += Math.abs(rowProf[i] - rowProf[i - 1]); dn++; }

  /* 倒影的"结构转移"：水面每一行的**横向**亮度剖面，与该行镜像到的那条天空行的
     横向剖面做相关（各自先去行均值）。倒影在不在，这条相关性最直接 —— 亮度差
     反而不行：远端水面反射的是山脊剪影，倒影会让它**变暗**（物理上就该如此），
     拿"变亮"当判据会把对的判成错的。 */
  const skyRowOf = (y) => yH - yH * Math.pow(Math.min(1, Math.max(0, (y - yH) / (H - yH))), 1.35);
  const sa = [], sb = [];
  for (let y = H * 0.55; y < H * 0.86; y += 7) {
    const d = depthOfY(y);
    if (d > 1.12) continue;
    const sy = skyRowOf(y);
    const A = [], B = [];
    for (let u = 0.14; u <= 0.86; u += 0.03) {
      const x = riverX(u, d);
      if (x < 1 || x > W - 2) continue;
      A.push(lum(x, y)); B.push(lum(x, sy));
    }
    if (A.length < 8) continue;
    const ma = A.reduce((p, c) => p + c, 0) / A.length;
    const mb = B.reduce((p, c) => p + c, 0) / B.length;
    for (let i = 0; i < A.length; i++) { sa.push(A[i] - ma); sb.push(B[i] - mb); }
  }
  let sa2 = 0, sb2 = 0, sab = 0;
  for (let i = 0; i < sa.length; i++) { sa2 += sa[i] * sa[i]; sb2 += sb[i] * sb[i]; sab += sa[i] * sb[i]; }
  const skyWaterCorr = (sa2 > 0 && sb2 > 0) ? sab / Math.sqrt(sa2 * sb2) : 0;

  /* 月亮列内部的行间高频（"碎"落在这一列上最明显） */
  const mcol = [];
  for (let y = H * 0.55; y < H * 0.88; y += 3) {
    const d = depthOfY(y);
    if (d > 1.12) continue;
    let s = 0, n = 0;
    for (let u = 0.14; u <= 0.86; u += 0.03) {
      const x = riverX(u, d);
      if (Math.abs(x - moonX) > 110 || x < 1 || x > W - 2) continue;
      s += lum(x, y); n++;
    }
    if (n) mcol.push(s / n);
  }
  let msum = 0, mn = 0;
  for (let i = 1; i < mcol.length; i++) { msum += Math.abs(mcol[i] - mcol[i - 1]); mn++; }

  /* 水线边缘带（浪花 + 岸线内侧柔光就在这几个像素里） */
  let eS = 0, eN = 0;
  for (let y = H * 0.45; y < H * 0.95; y += 5) {
    const d = depthOfY(y);
    if (d > 1.12) continue;
    for (const u of [0.004, 0.014, 0.024, 0.034, 0.966, 0.976, 0.986, 0.996]) {
      const x = riverX(u, d);
      if (x < 1 || x > W - 2) continue;
      eS += lum(x, y); eN++;
    }
  }

  /* ── 后期（阶段 3）──
     泛光 / 光轴 / 颗粒都画在画布上（DOM 暗角不参与），所以下面全部读画布像素。 */
  // 绕月心的圆环带（盘外一圈）：泛光把它抬起来，而盘内的月面不该被它动到
  const annulus = (r0, r1) => {
    let s = 0, n = 0;
    for (let rr = r0; rr <= r1; rr += 3) {
      for (let k = 0; k < 64; k++) {
        const a = (k / 64) * Math.PI * 2;
        const x = mx + Math.cos(a) * rr, y = my + Math.sin(a) * rr;
        if (x < 2 || x > W - 3 || y < 2 || y > H - 3) continue;
        s += lum(x, y); n++;
      }
    }
    return n ? s / n : 0;
  };
  // 月盘内部（半径 0.6mr 以内）：泛光**不许**把月面漂白 —— 月海细节靠这个量守住
  const discMean = () => {
    let s = 0, n = 0, mx2 = 0, mn2 = 0;
    for (let yy = -mr * 0.6; yy <= mr * 0.6; yy += 2) {
      for (let xx = -mr * 0.6; xx <= mr * 0.6; xx += 2) {
        if (xx * xx + yy * yy > mr * mr * 0.36) continue;
        const v = lum(mx + xx, my + yy);
        s += v; n++;
        // 月面"对比度"：盘内亮度的极差（月海是暗斑 ⇒ 有极差才有细节）
        mx2 = Math.max(mx2, v); mn2 = mn2 ? Math.min(mn2, v) : v;
      }
    }
    return { mean: n ? s / n : 0, range: mx2 - mn2 };
  };
  // 1px 步长的横向高频：颗粒是像素级噪声，天空自身的结构在 1px 尺度上是平的
  const fineHF = (x0, y0, x1, y1) => {
    let s = 0, n = 0;
    for (let y = y0 | 0; y < y1; y++) {
      for (let x = x0 | 0; x < x1 - 1; x++) { s += Math.abs(lum(x, y) - lum(x + 1, y)); n++; }
    }
    return n ? s / n : 0;
  };
  /* 光轴：绕月心的**角向亮度剖面**（沿半径积分，只取地平线之上）。
     判据不在这一侧出，而是拿它与「摘掉光轴」那一版**逐角相减** —— 两个构建之间
     只差光轴这一层，差值剖面就是光轴本身，星点/银河/月晕在相减里全消掉。
     （本机试过直接量角向起伏：那个量的大头是月晕被地平线裁掉造成的，摘掉光轴
     只动了 2%，是条空判据。）角向步长取 0.5°：光楔只有 0.6°–2° 宽，7.5° 的
     步长几乎条条跨过去。 */
  const rayProf = (() => {
    const r0 = mr * 2.2, r1 = mr * 6.5, K = 720;
    const out = [];
    for (let k = 0; k < K; k++) {
      const a = (k / K) * Math.PI * 2;
      let s = 0, n = 0;
      for (let rr = r0; rr <= r1; rr += 3) {
        const x = mx + Math.cos(a) * rr, y = my + Math.sin(a) * rr;
        if (x < 2 || x > W - 3 || y < 2 || y > yH - 4) continue;
        s += lum(x, y); n++;
      }
      out.push(n > 20 ? +(s / n).toFixed(3) : null);
    }
    return out;
  })();
  const disc = discMean();

  return {
    W, H, dpr: W / window.innerWidth,
    // 水面（阶段 2）
    waterLum: riverMean(yH + 50, H - 60),
    farWaterLum: riverMean(yH + 30, yH + 150),
    nearWaterLum: riverMean(H - 200, H - 60),
    moonColLum: riverMean(H * 0.55, H * 0.88, moonX - 90, moonX + 90),
    offColLum: riverMean(H * 0.55, H * 0.88, moonX - 420, moonX - 260),
    waterRowDelta: dn ? dsum / dn : 0,
    moonColRowDelta: mn ? msum / mn : 0,
    moonColProf: mcol.map((v) => +v.toFixed(3)),
    rowProf: rowProf.map((v) => +v.toFixed(3)),
    skyWaterCorr,
    edgeLum: eN ? eS / eN : 0,
    lampOnLum: lampN ? lampOn / lampN : 0,
    lampOffLum: lampN ? lampOff / lampN : 0,
    lampN,
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
    // 后期（阶段 3）
    moonRingLum: annulus(mr * 1.3, mr * 2.0),      // 盘外一圈：泛光抬这里
    moonDiscLum: disc.mean,                        // 盘内：泛光**不许**抬这里
    moonDiscRange: disc.range,                     // 盘内极差：月海细节的代理量
    // 远离一切发光体的左上天空：既在光轴射程（R=max(W,H)*0.5）之外，也不在银河带上
    farSkyLum: meanLum(W * 0.02, H * 0.05, W * 0.11, H * 0.16),
    grainHF: fineHF(W * 0.02, H * 0.05, W * 0.11, H * 0.16),
    rayProf,
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
        # 留言必须喂：不喂就没有 DOM 河灯，河灯倒影那条判据量的是空气
        pg.route("**/api/public/board*", lambda r: r.fulfill(
            status=200, content_type="application/json",
            body=json.dumps(BOARD, ensure_ascii=False)))
        pg.route("**/api/protected/**", lambda r: r.fulfill(
            status=200, content_type="application/json", body='{"code":500,"data":null}'))
        pg.route("**/api/protect/**", lambda r: r.fulfill(
            status=200, content_type="application/json", body='{"code":500,"data":null}'))
        pg.add_init_script(
            # 确定性 Math.random（LCG）：跨构建的像素对比必须同场景同灯位
            "let __s = 20261018; Math.random = () => {"
            "  __s = (Math.imul(__s, 1664525) + 1013904223) >>> 0;"
            "  return __s / 4294967296; };"
            # 冻结动画时钟。`amb.now` 按真实经过时间累加 —— 两次渲染差 200ms，
            # 碎光相位、灯位晃摆、流向纹就全都不同，跨构建相减得到的全是这份噪声，
            # 要量的那一层被淹掉（实测：明暗调制那条判据因此完全量不出来）。
            # 冻结后每个构建渲染的是**同一帧**。
            "(function(){"
            "  var frozen = null;"
            "  var raf = window.requestAnimationFrame.bind(window);"
            "  var origNow = performance.now.bind(performance);"
            "  window.__freezeClock = function(){ frozen = origNow(); };"
            "  performance.now = function(){ return frozen === null ? origNow() : frozen; };"
            "  window.requestAnimationFrame = function(cb){"
            "    return raf(function(t){ cb(frozen === null ? t : frozen); }); };"
            "})();")
        pg.goto(url, wait_until="domcontentloaded", timeout=90000)
        pg.wait_for_timeout(600)
        pg.evaluate("() => window.__mount()")
        # **挂载后立刻冻帧**，不是等场景跑一会儿再冻。河灯的位置由 `driveLanterns`
        # 按真实经过时间推进 —— 冻得晚，各次构建的灯就漂到了不同的地方，"灯下那一列"
        # 与"近端水面"量的其实是不同的画面（实测：同一份构建两次渲染灯数 3 vs 8，
        # 近端亮度差 16）。dt 恒 0 ⇒ 灯停在初始（已播种）位置，逐构建完全一致。
        pg.evaluate("() => window.__freezeClock()")
        pg.wait_for_timeout(wait)  # 真实时间等场景烘完；时钟是冻的，画面停在第一帧
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

    # ─────────────────────── 阶段 2 · 水面 ───────────────────────
    WATER = f"{RB}/render/water.ts"
    IDX = f"{RB}/index.tsx"
    REFL_ANCHOR = "export function drawReflection(ctx: CanvasRenderingContext2D, r: ReflBuild, geo: Geo): void {"
    # 这两个签名是多行的，锚点要取到 `{` 那一行（否则插进去的是函数参数表中间）。
    # **必须把参数表也带上**：`reduce: boolean\n): void {` 这种收尾在 water.ts 里
    # 不止一处（drawMoonColumn 与 drawLanternReflections 同形），只锚 `{` 那一行
    # 会命中的是**先出现**的那个函数 —— noLamp 那次对照会静默地把月亮柱摘掉、
    # 河灯倒影照旧，判据于是变成一条空断言。带上 list 那一行才唯一。
    GLIT_ANCHOR = "    moon: MoonGeom,\n    t: number,\n    soft: boolean,\n    reduce: boolean\n): number {"
    COL_ANCHOR = "    moon: MoonGeom,\n    t: number,\n    reduce: boolean\n): void {"
    LAMP_ANCHOR = "    list: ReflLantern[],\n    t: number,\n    reduce: boolean\n): void {"
    FRESNEL_RET = "    return 0.14 + 0.44 * Math.pow(1 - clamp01(e), 1.15);"
    CHOP_RET = "    return 1 - 0.94 * depth * chop;"

    print("\n④ 阶段 2 水面：五份构建（基准 + 四份「摘掉/改掉那一层」的反向对照）")
    wbuilds = {
        "base": build_sandbox(),
        # 倒影：整层不画 ⇒ 水面只剩底色 + 碎光
        "noRefl": build_sandbox({WATER: [(REFL_ANCHOR, REFL_ANCHOR + "\n    if (ctx) return;")]}),
        # 月光路：**柱体与碎光点一起摘**。这两者是同一个美术元素（"月光洒在河上"
        # 的底 + 细节），只摘碎光点时柱体仍把月亮列照亮，判据的余量会被压到 2%
        # ——等于一条空断言（实测）。
        "noGlit": build_sandbox({WATER: [
            (COL_ANCHOR, COL_ANCHOR + "\n    if (ctx) return;"),
            (GLIT_ANCHOR, GLIT_ANCHOR + "\n    if (ctx) return;")]}),
        # 河灯倒影：整层不画
        "noLamp": build_sandbox({WATER: [(LAMP_ANCHOR, LAMP_ANCHOR + "\n    if (ctx) return;")]}),
        # 菲涅尔拉平：远近一样强 ⇒ 倒影还在，但"远亮近暗"这条物理没了
        "flatFr": build_sandbox({WATER: [(FRESNEL_RET, "    return 0.36;")]}),
        # 明暗调制拉平：倒影还在，但不再被波纹切成短划（"碎"没了）
        "flatChop": build_sandbox({WATER: [(CHOP_RET, "    return 1;")]}),
        # 河道底色：把 baseFront 的打底改回**不透明满铺**（= 修复前的行为）
        # 复原"修复前"的那一笔：fillRect 是立即矩形填充、不理会当前路径
        "opaque": build_sandbox({IDX: [
            ('front.fill("evenodd");',
             "front.fill();\n        front.fillRect(-MARGIN - 8, v.yH - 4, w + MARGIN * 2 + 16, h + 44);")]}),
    }
    W_M = {}
    for k, sb in wbuilds.items():
        W_M[k] = render(serve(sb))
        if W_M[k].get("err"):
            raise SystemExit("挂载失败（%s）：%s" % (k, W_M[k]))
    for k, m in W_M.items():
        print("     %-9s %s" % (k, json.dumps(
            {kk: (round(vv, 2) if isinstance(vv, float) else vv) for kk, vv in m.items()
             if kk in ("waterLum", "farWaterLum", "nearWaterLum", "moonColLum",
                       "offColLum", "waterRowDelta", "lampOnLum", "lampOffLum", "lampN")},
            ensure_ascii=False)))

    wb = W_M["base"]
    print("\n⑤ 水面判据（每条都配反向对照；对照不红 = 判据是空断言）")

    check("对照构建本身是「活页面」（水面非黑、灯位量得到）",
          all(W_M[k]["waterLum"] > 2 for k in wbuilds) and wb["lampN"] >= 3,
          {k: round(W_M[k]["waterLum"], 2) for k in wbuilds} | {"lampN": wb["lampN"]})

    # 倒影：水面横向结构与镜像天空行的横向结构相关（"天上有什么，水里就该有什么"）
    check("倒影：水面横向亮度剖面与镜像天空行的相关性显著为正",
          wb["skyWaterCorr"] > 0.30,
          {"corr": round(wb["skyWaterCorr"], 3)})
    check("　└ 对照：摘掉倒影层后这条相关性塌到噪声水平",
          W_M["noRefl"]["skyWaterCorr"] < wb["skyWaterCorr"] * 0.6,
          {"with": round(wb["skyWaterCorr"], 3), "without": round(W_M["noRefl"]["skyWaterCorr"], 3)})

    # 菲涅尔：倒影的**贡献量**远端必须大于近端（"远看是镜子、近看是水"的根据）。
    # 用绝对值而不是带符号的增量：远端水面反射的是山脊剪影，倒影会让它变暗 ——
    # 物理上就该如此，拿"变亮"当判据会把对的判成错的。
    far_gain = abs(wb["farWaterLum"] - W_M["noRefl"]["farWaterLum"])
    near_gain = abs(wb["nearWaterLum"] - W_M["noRefl"]["nearWaterLum"])
    check("菲涅尔：倒影贡献量在远端（掠射）明显大于近端（俯视）",
          far_gain > near_gain * 1.5 and far_gain > 3,
          {"farGain": round(far_gain, 2), "nearGain": round(near_gain, 2)})
    # 反向对照：把菲涅尔拉平 ⇒ 上面那条比例必须塌掉
    flat_far = abs(W_M["flatFr"]["farWaterLum"] - W_M["noRefl"]["farWaterLum"])
    flat_near = abs(W_M["flatFr"]["nearWaterLum"] - W_M["noRefl"]["nearWaterLum"])
    check("　└ 对照：菲涅尔拉平后这条比例腰斩（否则判据没在量菲涅尔）",
          flat_far / max(1e-6, flat_near) < (far_gain / max(1e-6, near_gain)) * 0.55,
          {"with": round(far_gain / max(1e-6, near_gain), 2),
           "flat": round(flat_far / max(1e-6, flat_near), 2)})

    def rowdelta(a):
        if len(a) < 2:
            return 0.0
        return sum(abs(a[i] - a[i - 1]) for i in range(1, len(a))) / (len(a) - 1)

    # 碎（逐行明暗调制）：**不能**量"倒影贡献的逐行高频"。
    # 那个量里的大头是镜像天空自己的横向结构（山脊剪影、云带边），调制只是叠在
    # 上面的一层；把调制压深，那些锐边被一起压下去，于是"有调制"反而比"拉平调制"
    # 更平 —— 实测 rowdelta 0.44 / 0.68、hf5 0.41 / 0.83，方向是反的，这条判据
    # 此前一直靠余量勉强绿着。
    # 正解是**直接量调制本身**：base 与 flatChop 之间只差 reflRowAlpha 一个函数
    # （同一份 RNG 种子、同一个冻结时钟），所以两者行剖面之比
    # `q(i) = base(i) / flat(i)` 就是"这一行被调制了多少"。调制被摘掉 ⇒ q≡1 ⇒
    # 幅度 0；调制在场 ⇒ q 随行起伏。量的是它真的落在**合成后的画面**上，
    # 不是函数返回了什么。
    q = [max(1e-6, a) / max(1e-6, b)
         for a, b in zip(wb["rowProf"], W_M["flatChop"]["rowProf"])]
    q_amp = max(q) - min(q)
    q_rough = rowdelta(q)
    check("碎光：逐行明暗调制真的落在画面上（幅度够、且是逐行连贯不是逐行噪声）",
          q_amp > 0.12 and q_rough < q_amp * 0.6,
          {"q幅度": round(q_amp, 4), "q逐行": round(q_rough, 4),
           "逐行/幅度": round(q_rough / max(1e-9, q_amp), 3)})

    # 月光碎路：月亮那一列必须比同行的河面别处亮
    check("月光碎路：月亮所在列比同行别处亮（碎路锚在光源那一列）",
          wb["moonColLum"] > wb["offColLum"] * 1.12,
          {"moonCol": round(wb["moonColLum"], 2), "offCol": round(wb["offColLum"], 2)})
    # 要求**有量级**的收窄（<92%），不是"只要小一点就算过"：后者在柱体还在场时
    # 也能靠 2% 的噪声差通过 —— 一条判不出东西的判据。
    check("　└ 对照：摘掉整条月光路后，月亮那一列的优势腰斩",
          (W_M["noGlit"]["moonColLum"] / max(1e-6, W_M["noGlit"]["offColLum"]))
          < (wb["moonColLum"] / max(1e-6, wb["offColLum"])) * 0.92,
          {"with": round(wb["moonColLum"] / max(1e-6, wb["offColLum"]), 3),
           "without": round(W_M["noGlit"]["moonColLum"] / max(1e-6, W_M["noGlit"]["offColLum"]), 3)})

    # 河灯倒影：灯底下的水比同行的别处亮
    check("河灯倒影：灯底下那一列比同行别处亮",
          wb["lampOnLum"] > wb["lampOffLum"] * 1.05,
          {"under": round(wb["lampOnLum"], 2), "aside": round(wb["lampOffLum"], 2), "n": wb["lampN"]})
    check("　└ 对照：摘掉河灯倒影层后，灯下的优势收窄",
          (W_M["noLamp"]["lampOnLum"] / max(1e-6, W_M["noLamp"]["lampOffLum"]))
          < (wb["lampOnLum"] / max(1e-6, wb["lampOffLum"])),
          {"with": round(wb["lampOnLum"] / max(1e-6, wb["lampOffLum"]), 3),
           "without": round(W_M["noLamp"]["lampOnLum"] / max(1e-6, W_M["noLamp"]["lampOffLum"]), 3)})

    # 河道底色：baseFront 的不透明满铺曾把 backCv 的整条河（河水底色 / 河心天光带 /
    # 岸线内侧柔光 / 浪花 / 焦散）全盖住。判据落在**水线边缘带**上而不是整河均值 ——
    # 河水底色当初是按"和岸色接近"调的，整河均值只差 1%；真正被那一笔吃掉的是
    # 贴着水线的浪花与柔光。
    check("河道底色：改回不透明满铺后，水线边缘带明显变暗（那一笔确实盖住过河道）",
          wb["edgeLum"] > W_M["opaque"]["edgeLum"] * 1.08,
          {"evenodd": round(wb["edgeLum"], 2), "opaque": round(W_M["opaque"]["edgeLum"], 2)})

    # ─────────────────────── 阶段 3 · 后期处理 ───────────────────────
    POST = f"{RB}/render/post.ts"
    BLOOM_ANCHOR = "    const sw = glow.width;\n    const sh = glow.height;"
    RAYS_ANCHOR = "    ctx.save();\n    ctx.globalCompositeOperation = \"lighter\";\n    ctx.globalAlpha = alpha > 1 ? 1 : alpha;"
    GRAIN_ANCHOR = "    if (!grainPat) grainPat = ctx.createPattern(grainTexture(), \"repeat\");"
    MOONHALO_CALL = "haloSprite(255, 238, 200)"

    print("\n⑥ 阶段 3 后期：四份「摘掉那一层」的反向对照（基准沿用上面的 base）")
    pbuilds = {
        # 泛光：整段不合成回主画布（发光缓冲照画，只是不叠回来）
        "noBloom": build_sandbox({POST: [(BLOOM_ANCHOR, "    if (ctx) return;\n" + BLOOM_ANCHOR)]}),
        # 光轴：不画（只影响地平线之上）
        "noRays": build_sandbox({POST: [(RAYS_ANCHOR, "    if (ctx) return;\n" + RAYS_ANCHOR)]}),
        # 颗粒：不铺噪声
        "noGrain": build_sandbox({POST: [(GRAIN_ANCHOR, "    if (ctx) return;\n" + GRAIN_ANCHOR)]}),
        # 月晕：把环形光晕换成**全透明**贴图（发光缓冲里这一笔等于没画）。
        # 用 blobSprite(0,0,0) 而不是删掉调用：`lighter` 合成下黑色加零，等价于不画。
        "noMoonHalo": build_sandbox({IDX: [(MOONHALO_CALL, "blobSprite(0, 0, 0)")]}),
    }
    P_M = {}
    for k, sb in pbuilds.items():
        P_M[k] = render(serve(sb))
        if P_M[k].get("err"):
            raise SystemExit("挂载失败（%s）：%s" % (k, P_M[k]))
    for k, m in P_M.items():
        print("     %-11s %s" % (k, json.dumps(
            {kk: (round(vv, 3) if isinstance(vv, float) else vv) for kk, vv in m.items()
             if kk in ("moonRingLum", "moonDiscLum", "moonDiscRange", "farSkyLum",
                       "grainHF")},
            ensure_ascii=False)))

    print("\n⑦ 后期判据（每条都配反向对照；对照不红 = 判据是空断言）")

    check("对照构建本身是「活页面」（后期各档的月亮区都非黑）",
          all(P_M[k]["moonRingLum"] > 2 for k in pbuilds),
          {k: round(P_M[k]["moonRingLum"], 2) for k in pbuilds})

    # 泛光：抬的是**盘外那一圈**，不是全屏提亮。
    # 两条一起看才有意义：只判"月亮周围变亮"，一层全屏加光也能过。
    check("泛光：月盘外一圈的亮度在开泛光后显著抬升",
          wb["moonRingLum"] > P_M["noBloom"]["moonRingLum"] * 1.12,
          {"with": round(wb["moonRingLum"], 2), "without": round(P_M["noBloom"]["moonRingLum"], 2)})
    ring_gain = wb["moonRingLum"] - P_M["noBloom"]["moonRingLum"]
    far_gain = abs(wb["farSkyLum"] - P_M["noBloom"]["farSkyLum"])
    check("　└ 对照：同一份改动**没有**把远离月亮的天空一起抬起来（不是全屏提亮）",
          far_gain < ring_gain * 0.05,
          {"远处Δ": round(far_gain, 3), "月周Δ": round(ring_gain, 3),
           "远处/月周": round(far_gain / max(1e-9, ring_gain), 4)})

    # 月盘：泛光**不许**动盘面。月面是本页唯一"一字不许改"的资产，而 `lighter`
    # 合成天然会把它往白里推 —— 这条判据就是那道防线（实测第一版把月海漂没了）。
    check("月盘：泛光没有把盘面漂白（盘内亮度与极差都守住了）",
          wb["moonDiscLum"] < P_M["noBloom"]["moonDiscLum"] * 1.06
          and wb["moonDiscRange"] > P_M["noBloom"]["moonDiscRange"] * 0.9,
          {"盘内亮度 with/without": [round(wb["moonDiscLum"], 2), round(P_M["noBloom"]["moonDiscLum"], 2)],
           "盘内极差 with/without": [round(wb["moonDiscRange"], 2), round(P_M["noBloom"]["moonDiscRange"], 2)]})

    # 月晕：环形贴图单独摘掉 ⇒ 盘外那一圈必须掉下来（否则泛光的抬升另有来源）
    check("月晕：摘掉环形光晕贴图后，盘外那一圈明显变暗",
          wb["moonRingLum"] > P_M["noMoonHalo"]["moonRingLum"] * 1.10,
          {"with": round(wb["moonRingLum"], 2), "without": round(P_M["noMoonHalo"]["moonRingLum"], 2)})

    # 光轴：逐角相减的差值剖面。两条一起看 —— ① 光轴真的往天空里加了光；
    # ② 这份加光**不是各向同性**的（各向同性 = 那只是一圈更大的月晕，
    # 不是"绕月心放射的光柱"）。判据量的是形状，不是"有没有变亮"。
    rp_a, rp_b = wb["rayProf"], P_M["noRays"]["rayProf"]
    rdiff = [x - y for x, y in zip(rp_a, rp_b) if x is not None and y is not None]
    if len(rdiff) < 24:
        raise SystemExit("光轴差值剖面的有效角太少（%d）：地平线裁剪把取样带吃掉了" % len(rdiff))
    rmean = sum(rdiff) / len(rdiff)
    rstd = (sum((v - rmean) ** 2 for v in rdiff) / len(rdiff)) ** 0.5
    check("光轴：地平线之上那一圈天空在开光轴后被加亮（逐角差值剖面的均值）",
          rmean > 0.30,
          {"均值": round(rmean, 3), "有效角数": len(rdiff)})
    check("　└ 光轴不是各向同性的（差值剖面的起伏/均值 —— 各向同性就只是「更大的月晕」）",
          rstd / max(1e-9, rmean) > 0.4,
          {"起伏": round(rstd, 3), "起伏/均值": round(rstd / max(1e-9, rmean), 3)})

    # 颗粒：1px 步长的高频。落在**平坦夜空**上 —— 那里除了颗粒没有任何像素级结构
    check("颗粒：平坦夜空的像素级高频在摘掉颗粒后下降",
          wb["grainHF"] > P_M["noGrain"]["grainHF"] * 1.06,
          {"with": round(wb["grainHF"], 3), "without": round(P_M["noGrain"]["grainHF"], 3)})

    print("\n%s（通过 %d）" % ("全部通过" if FAIL == 0 else f"失败 {FAIL} 项", PASS))
    return 0 if FAIL == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
