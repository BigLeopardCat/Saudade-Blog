import http from "node:http";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createReadStream, statSync } from "node:fs";
import type { Page } from "@playwright/test";
import { build, type Loader } from "esbuild";
import sass from "sass";

/**
 * 沙箱基建：替代原 *.test.py 里每个文件各写一遍的
 * 「mkdtemp → 写 index.html → ThreadingHTTPServer → Playwright goto」脚手架。
 *
 * 判据哲学保持原样：**主判据是计算值与像素**，源码锁只做补充。
 *
 * 依赖形态注意：esbuild 与 sass 一律走 **node API**（import 而来），
 * 不经过 CLI——本机 `node_modules/esbuild/bin/esbuild` 是离线手段装出的
 * 原生 ELF、CLI sass 又有 chokidar 的 ESM 问题，node API 通路两者皆正常。
 */

export const FE_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

/** 每支沙箱的静态根目录下的 index.html。 */
export const SANDBOX_ENTRY = "/index.html";

export interface Sandbox {
  /** 沙箱根目录（可继续往里写额外文件）。 */
  dir: string;
  /** 沙箱入口 URL。 */
  url: string;
  /** 写一个相对沙箱根的文件。 */
  write: (rel: string, content: string) => Promise<void>;
  /** 关服务 + 删临时目录（由 withSandbox 的 finally 调，别漏调）。 */
  teardown: () => Promise<void>;
}

/**
 * 把 index.html（及可选的额外静态文件）写进临时目录并起一个静态服务。
 * 建议用 withSandbox（RAII 包装），它保证 teardown。
 */
export async function serveSandbox(
  files: Record<string, string>,
): Promise<Sandbox> {
  const dir = await mkdtemp(path.join(tmpdir(), "pw-sandbox-"));
  for (const [rel, content] of Object.entries(files)) {
    const target = path.join(dir, rel);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content, "utf-8");
  }
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(
      new URL(req.url ?? "/", "http://x").pathname,
    ).replace(/^\//, "");
    const abs = path.join(dir, rel);
    if (!abs.startsWith(dir) || rel === "") {
      res.writeHead(404).end("not found");
      return;
    }
    try {
      const st = statSync(abs);
      if (!st.isFile()) throw new Error("dir");
      res.writeHead(200, {
        "content-type": rel.endsWith(".js")
          ? "text/javascript"
          : rel.endsWith(".css")
            ? "text/css"
            : rel.endsWith(".html")
              ? "text/html"
              : "application/octet-stream",
      });
      createReadStream(abs).pipe(res);
    } catch {
      res.writeHead(404).end("not found");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no port");
  const port = addr.port;
  return {
    dir,
    url: `http://127.0.0.1:${port}${SANDBOX_ENTRY}`,
    write: async (rel, content) => {
      const target = path.join(dir, rel);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, content, "utf-8");
    },
    teardown: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(dir, { recursive: true, force: true });
    },
  };
}

/** serveSandbox 的 RAII 包装：块结束自动关服务、删临时目录。 */
export async function withSandbox<T>(
  files: Record<string, string>,
  fn: (sb: Sandbox) => Promise<T>,
): Promise<T> {
  const sb = await serveSandbox(files);
  try {
    return await fn(sb);
  } finally {
    await sb.teardown();
  }
}

/** 编译一个 sass 文件 → css 字符串（真 sass，与产线同源，node API）。 */
export function compileSass(sassFile: string): string {
  return sass.compile(sassFile).css.toString();
}

export interface EsbuildSandboxOpts {
  /** 入口文件相对沙箱根（如 "entry.tsx"），内容在 files 里给。 */
  entry: string;
  /** 要写进沙箱的源文件（入口 + 它 import 的本地桩/页面）。 */
  files?: Record<string, string>;
  /** 递归复制 frontend/src 到沙箱（需要真组件时）。先复制、后写 files ⇒ 桩可覆盖真文件。 */
  copySrc?: boolean;
  /** define 映射（如 import.meta.env 的整体替换）。 */
  define?: Record<string, string>;
  /** 按 IO 扩展名指定 loader（如 { ".sass": "text" }）。 */
  loaders?: Record<string, Loader>;
  /** 产物名（相对沙箱根），默认 bundle.js。 */
  outfile?: string;
}

/**
 * 用真 esbuild 把一段 TSX 入口打进沙箱（真 TSX / 真依赖，与产线同源）。
 *
 * 与原 *.py 沙箱同一套手法：入口与桩文件写进沙箱根，node_modules 以 symlink
 * 挂进沙箱（esbuild 解析 antd/axios 等真依赖用），以沙箱为 absWorkingDir 构建，
 * 产物 bundle.js 由 serveSandbox 直接供出。
 */
export async function esbuildInSandbox(
  sb: Sandbox,
  opts: EsbuildSandboxOpts,
): Promise<void> {
  const fsp = await import("node:fs/promises");
  if (opts.copySrc) {
    await fsp.cp(path.join(FE_DIR, "src"), path.join(sb.dir, "src"), {
      recursive: true,
    });
  }
  // 注意顺序：copySrc 先铺真源码，files 后写 ⇒ 桩/入口可覆盖同名真文件。
  for (const [rel, content] of Object.entries(opts.files ?? {})) {
    await sb.write(rel, content);
  }
  await fsp.symlink(
    path.join(FE_DIR, "node_modules"),
    path.join(sb.dir, "node_modules"),
    "dir",
  );
  await build({
    entryPoints: [opts.entry],
    bundle: true,
    format: "iife",
    outfile: path.join(sb.dir, opts.outfile ?? "bundle.js"),
    jsx: "automatic",
    define: opts.define,
    loader: opts.loaders,
    absWorkingDir: sb.dir,
    logLevel: "silent",
  });
}

/** 收集页面运行期异常（pageerror）的小工具，最终一次断言「全程无页面异常」。 */
export function collectPageErrors(page: Page): () => string[] {
  const errs: string[] = [];
  page.on("pageerror", (e) => errs.push(String(e)));
  return () => errs;
}

/** 最小 HTML 骨架：css 一段一段按序内联进 <head>。 */
export function htmlDoc(body: string, ...css: string[]): string {
  return (
    '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">' +
    css.map((c) => `<style>${c}</style>`).join("") +
    "</head><body>" +
    body +
    "</body></html>"
  );
}
