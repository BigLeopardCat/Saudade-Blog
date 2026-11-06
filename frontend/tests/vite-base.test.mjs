import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const viteConfigPath = path.join(__dirname, '..', 'vite.config.ts');
const viteConfig = readFileSync(viteConfigPath, 'utf8');

assert.ok(/base:\s*['"]\//.test(viteConfig), 'Vite base 应为同源 "/"（资源由本机 nginx 服务）');
console.log('vite base regression check passed');
