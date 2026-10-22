/**
 * Adapted from PR #34's esbuild + loopback sandbox. Build real modules without
 * copying or patching src. Serve a fixed in-memory allowlist, with teardown even
 * when listen/use fails. No backend, production credentials or external network.
 */
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { compile } from 'sass'
import { test as base, expect } from '@playwright/test'

type Entry = 'axios' | 'announcement' | 'tags' | 'categories'
const frontend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const bundles = new Map<Entry, Promise<{ script: string; css: string }>>()

function bundle(entry: Entry): Promise<{ script: string; css: string }> {
  const cached = bundles.get(entry)
  if (cached) return cached
  const result = build({
    absWorkingDir: frontend,
    entryPoints: [`tests/browser/entries/${entry}.tsx`],
    bundle: true,
    format: 'iife',
    jsx: 'automatic',
    write: false,
    outfile: 'browser-bundle.js',
    plugins: [{ name: 'real-sass', setup(builder) {
      builder.onLoad({ filter: /\.(sass|scss)$/ }, args => ({ contents: compile(args.path).css, loader: 'css', resolveDir: path.dirname(args.path) }))
    } }],
    define: {
      'import.meta.env': JSON.stringify({
        VITE_HTTP_BASEURL: '', VITE_CDN_BASEURL: '', MODE: 'production',
        DEV: false, PROD: true, BASE_URL: '/',
      }),
      'process.env.NODE_ENV': '"production"',
    },
  }).then(result => ({ script: result.outputFiles.find(file => file.path.endsWith('.js'))!.text, css: result.outputFiles.find(file => file.path.endsWith('.css'))?.text || '' }))
  bundles.set(entry, result)
  return result
}

export const test = base.extend<{ entry: Entry; sandboxURL: string }>({
  entry: ['axios', { option: true }],
  sandboxURL: async ({ entry, page }, provide) => {
    const { script, css } = await bundle(entry)
    const files: Record<string, { type: string; body: string }> = {
      '/': { type: 'text/html', body: '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><link rel="stylesheet" href="/bundle.css"><style>body{margin:0;font-family:"Noto Sans CJK SC",sans-serif}</style><div id="root"></div><script src="/bundle.js"></script></html>' },
      '/bundle.js': { type: 'text/javascript', body: script },
      '/bundle.css': { type: 'text/css', body: css },
      '/login': { type: 'text/html', body: '<!doctype html><html lang="zh-CN"><title>登录落点</title><body>登录落点</body></html>' },
    }
    const server = http.createServer((req, res) => {
      const key = req.url || ''
      const file = Object.prototype.hasOwnProperty.call(files, key) ? files[key] : undefined
      if (!file || req.method !== 'GET') { res.writeHead(404).end(); return }
      res.writeHead(200, { 'Content-Type': `${file.type}; charset=utf-8` }).end(file.body)
    })
    const unexpected: string[] = []
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(0, '127.0.0.1', resolve)
      })
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('Sandbox did not bind a port')
      const origin = `http://127.0.0.1:${address.port}`
      await page.route('**/*', async route => {
        const url = new URL(route.request().url())
        if (url.origin === origin && Object.prototype.hasOwnProperty.call(files, url.pathname)) {
          await route.continue()
        } else {
          unexpected.push(`${route.request().method()} ${url.href}`)
          await route.abort('blockedbyclient')
        }
      })
      await provide(`${origin}/`)
      expect(unexpected, 'all network requests must be explicitly stubbed').toEqual([])
      expect(errors, 'no uncaught browser errors').toEqual([])
    } finally {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  },
})
export { expect } from '@playwright/test'
