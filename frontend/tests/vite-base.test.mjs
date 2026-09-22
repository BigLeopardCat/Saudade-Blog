import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const viteConfigPath = path.join(__dirname, '..', 'vite.config.ts');
const viteConfig = readFileSync(viteConfigPath, 'utf8');

// 20260923 更正：这条断言盯的是 20260819 那次「Vite base 改 CDN」的实验，而那之后
// base 已经回到 '/'（线上首页引的是同源 /js/index-*.js，nginx 也只服务本地 dist；
// CI 里那步往 R2 deploy/frontend/dist/** 的 CDN 上传至今仍在跑但没人读）。
// 断言改成盯**当前事实**：base 若是又被写成 CDN 地址，站内资源会整体跨域，这里会红。
assert.ok(/base:\s*['"]\//.test(viteConfig), 'Vite base 应为同源 "/"（资源由本机 nginx 服务）');
console.log('vite base regression check passed');
