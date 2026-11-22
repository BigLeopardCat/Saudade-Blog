import {mkdir, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {chromium, expect} from '@playwright/test';

const output = process.env.README_SCREENSHOT_DIR;
if (!output) throw new Error('Set README_SCREENSHOT_DIR to an explicit output directory');
await mkdir(output, {recursive: true});
const browser = await chromium.launch();
const captures = [];
try {
  for (const locale of ['zh-CN', 'en']) {
    const context = await browser.newContext({viewport: {width: 1440, height: 1000},
      deviceScaleFactor: 1, colorScheme: 'light', locale});
    try {
      // Public pages only: do not create accounts, submit chat or mutate production.
      await context.route('**/*', route => ['GET', 'HEAD', 'OPTIONS'].includes(route.request().method())
        ? route.continue() : route.abort('blockedbyclient'));
      await context.addInitScript(value => localStorage.setItem('saudade.locale', value), locale);
      const page = await context.newPage();
      page.setDefaultTimeout(60000);
      await page.goto('https://saudade.site/', {waitUntil: 'domcontentloaded', timeout: 90000});
      await expect(page.locator('html')).toHaveAttribute('lang', locale);
      await expect(page.locator('#waifu-tool-hitokoto')).toBeAttached();
      await page.evaluate(async () => {
        await document.fonts.ready;
        await Promise.all(Array.from(document.images).filter(image => {
          const box = image.getBoundingClientRect();
          return box.bottom > 0 && box.top < innerHeight;
        }).map(image => image.decode().catch(() => {})));
      });
      const announcement = page.getByRole('button', {name: locale === 'en' ? 'Got it' : '我知道了', exact: true});
      if (await announcement.isVisible()) await announcement.click();
      const screenshot = async name => {
        await page.screenshot({path: path.join(output, name), type: 'jpeg', quality: 84,
          animations: 'disabled', scale: 'css'});
        captures.push({file: name, url: page.url(), locale, viewport: page.viewportSize()});
      };
      await screenshot(`blog-home-${locale}.jpg`);
      await page.locator('#waifu').hover();
      await page.locator('#waifu-tool-hitokoto').click();
      await expect(page.locator('#waifu-chat')).toBeVisible();
      await expect(page.locator('#waifu-chat')).toHaveClass(/active/);
      await expect(page.locator('#chat-empty')).toBeVisible();
      await screenshot(`lingyue-chat-${locale}.jpg`);
    } finally {await context.close();}
  }
  await writeFile(path.join(output, 'capture.json'), JSON.stringify({
    capturedAt: new Date().toISOString(), source: 'public demo, fresh anonymous browser contexts',
    requests: 'GET/HEAD/OPTIONS only; no login, model calls or submitted messages', captures,
  }, null, 2) + '\n');
} finally {await browser.close();}
