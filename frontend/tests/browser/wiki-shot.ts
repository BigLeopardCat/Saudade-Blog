/** Capture real component fixtures for tutorials only when explicitly requested. */
import {mkdir} from 'node:fs/promises'
import path from 'node:path'
import type {Locator, Page} from '@playwright/test'

export async function wikiShot(page: Page, name: string, region?: Locator) {
  const output = process.env.WIKI_SCREENSHOT_DIR
  if (!output) return
  await mkdir(output, {recursive: true})
  await page.evaluate(async () => { await document.fonts.ready })
  await (region || page).screenshot({path: path.join(output, name + '.jpg'),
    type: 'jpeg', quality: 88, animations: 'disabled', scale: 'css'})
}
