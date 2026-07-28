import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const viteConfigPath = path.join(__dirname, '..', 'vite.config.ts');
const viteConfig = readFileSync(viteConfigPath, 'utf8');

assert.ok(viteConfig.includes('https://cdn.cat0.qzz.io/deploy/frontend/dist/'), 'Vite base should point to the CDN asset path');
console.log('vite base regression check passed');
