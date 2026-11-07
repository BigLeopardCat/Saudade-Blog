import type {Page} from '@playwright/test'
import {test, expect} from './sandbox'

test.use({entry: 'editor-images', cdnBaseURL: 'https://images.example.test', viewport: {width: 1280, height: 900}})
const galleryAPI = '**/api/protect/gallery/images?*'
const uploadAPI = '**/api/protect/upload'
const imageAction = '.bytemd-toolbar-left > .bytemd-toolbar-icon[bytemd-tippy-path="5"]'
const localURL = '/api/protect/download/20260912013218_EMQX.png'
const remoteURL = 'https://original-images.example.test/gallery/20261006000000_sunset.png'
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGO40nDlPwAHfAMoc3ODKQAAAABJRU5ErkJggg==', 'base64')
const images = [
  {imageKey: 903, imageUrl: localURL},
  {imageKey: 902, imageUrl: remoteURL},
  {imageKey: 901, imageUrl: '/api/protect/download/old_pic.png'},
]

type PickerImage={imageKey:number;imageUrl:string;displayName?:string|null}
const row=(image:PickerImage)=>({displayName:null,description:'',folderId:0,isFavorite:false,version:'a'.repeat(64),...image})

async function gallery(page: Page, data: PickerImage[] = images, code = 200) {
  const requests: URL[] = []
  await page.route(galleryAPI, route => {
    expect(route.request().method()).toBe('GET')
    requests.push(new URL(route.request().url()))
    return route.fulfill({json: {code, data:{items:data.map(row),nextCursor:null}, message: code === 200 ? 'ok' : '图库暂时不可用'}})
  })
  return requests
}

async function openPicker(page: Page) {
  await page.locator(imageAction).click()
  const dialog = page.getByRole('dialog', {name: '插入图片'})
  await expect(dialog).toBeVisible()
  return dialog
}

async function selectUpload(page: Page, name = 'local.png') {
  const dialog = page.getByRole('dialog', {name: '插入图片'})
  await dialog.getByRole('tab', {name: '本地上传', exact: true}).click()
  await dialog.locator('input[type=file]').setInputFiles({name, mimeType: 'image/png', buffer: png})
  return dialog
}

test.beforeEach(async ({page, sandboxURL}) => {
  // Request the fixture before overriding its network-deny routes.
  await page.route('**/api/monitor/log', route => route.fulfill({json: {code: 200}}))
  for (const origin of ['https://images.example.test', 'https://original-images.example.test']) {
    await page.route(`${origin}/**`, route => route.fulfill({contentType: 'image/png', body: png}))
  }
  await page.route(`${new URL(sandboxURL).origin}/api/protect/download/**`, route => route.fulfill({contentType: 'image/png', body: png}))
})

test('the existing image action opens the gallery without opening the native file chooser', async ({page, sandboxURL}) => {
  const requests = await gallery(page)
  let choosers = 0
  page.on('filechooser', () => { choosers += 1 })
  await page.goto(sandboxURL)
  await expect(page.getByLabel('草稿状态')).toHaveJSProperty('textContent', '')
  const dialog = await openPicker(page)
  expect(choosers).toBe(0)
  await expect(dialog.getByRole('tab')).toHaveCount(2)
  await expect(dialog.getByRole('tab', {name: '图库', exact: true})).toHaveAttribute('aria-selected', 'true')
  await expect(dialog.locator('.editor-gallery-item')).toHaveCount(3)
  await expect(dialog.getByAltText('EMQX.png')).toHaveAttribute('src', `https://images.example.test${localURL}`)
  await expect(dialog.getByAltText('sunset.png')).toHaveAttribute('src', remoteURL)
  await expect(dialog.locator('.editor-gallery-name')).toHaveText(['EMQX.png', 'sunset.png', 'old_pic.png'])
  expect(requests).toHaveLength(1)
  await expect(page.locator(imageAction)).toBeAttached()

  // A real native chooser is still available through the local-upload tab.
  await dialog.getByRole('tab', {name: '本地上传', exact: true}).click()
  const chosen = page.waitForEvent('filechooser')
  await dialog.locator('.ant-upload-drag').click()
  await (await chosen).setFiles([])
  expect(choosers).toBe(1)
})

for (const [name, url] of [['EMQX.png', localURL], ['sunset.png', remoteURL]] as const) {
  test(`gallery insertion keeps the stored URL and reports controlled content: ${name}`, async ({page, sandboxURL}) => {
    await gallery(page)
    await page.goto(sandboxURL)
    const dialog = await openPicker(page)
    await dialog.getByAltText(name).click()
    await expect(dialog).toBeHidden()
    await expect(page.getByLabel('草稿状态')).toHaveJSProperty('textContent', `\n![](${url})`)
    const selection = await page.locator('.CodeMirror').evaluate(el => {
      const editor = (el as HTMLElement & {CodeMirror: {listSelections(): {anchor: {line: number; ch: number}}[]}}).CodeMirror
      return editor.listSelections()[0].anchor
    })
    expect(selection).toMatchObject({line: 1, ch: 0})
    await expect(page.locator('.CodeMirror')).toHaveClass(/CodeMirror-focused/)
  })
}

test('gallery filenames with spaces insert a real Markdown image without changing Chinese or double-encoding', async ({page, sandboxURL}) => {
  const raw = '/api/protect/download/20261006033033_满月 (1) 副本（终稿）.png'
  await gallery(page, [{imageKey: 904, imageUrl: raw}])
  await page.goto(sandboxURL)
  const dialog = await openPicker(page)
  await dialog.getByAltText('满月 (1) 副本（终稿）.png').click()
  await expect(page.getByLabel('草稿状态')).toHaveJSProperty('textContent', '\n![](/api/protect/download/20261006033033_满月%20%281%29%20副本（终稿）.png)')
  const preview = page.locator('.bytemd-preview .markdown-body')
  await expect(preview.locator('img')).toHaveCount(1)
  await expect(preview.locator('img')).toHaveJSProperty('naturalWidth', 1)
  await expect(preview).not.toContainText('![](')
})

test('local upload sends the original file as multipart and inserts the returned URL', async ({page, sandboxURL}) => {
  await gallery(page)
  let uploads = 0
  await page.route(uploadAPI, route => {
    const request = route.request()
    expect(request.method()).toBe('POST')
    expect(request.headers()['content-type']).toMatch(/^multipart\/form-data; boundary=/)
    const body = request.postDataBuffer()!
    expect(body.includes(png)).toBe(true)
    expect(body.toString('latin1')).toContain('name="file"; filename="local.png"')
    uploads += 1
    return route.fulfill({json: {code: 200, data: '/api/protect/download/new image.png'}})
  })
  await page.goto(sandboxURL)
  const dialog = await openPicker(page)
  await selectUpload(page)
  await expect(dialog).toBeHidden()
  await expect(page.getByLabel('草稿状态')).toHaveJSProperty('textContent', '\n![](/api/protect/download/new%20image.png)')
  expect(uploads).toBe(1)
  await expect(page.locator('.bytemd-preview .markdown-body img')).toHaveJSProperty('naturalWidth', 1)
})

test('pasting a real clipboard image uses the shared upload callback and updates the draft', async ({page, context, sandboxURL}) => {
  let uploads = 0
  await page.route(uploadAPI, route => {
    expect(route.request().method()).toBe('POST')
    expect(route.request().postDataBuffer()!.includes(Buffer.from('89504e470d0a1a0a', 'hex'))).toBe(true)
    uploads += 1
    return route.fulfill({json: {code: 200, data: '/api/protect/download/clipboard.png'}})
  })
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], {origin: new URL(sandboxURL).origin})
  await page.goto(sandboxURL)
  await page.evaluate(async encoded => {
    const bytes = Uint8Array.from(atob(encoded), char => char.charCodeAt(0))
    await navigator.clipboard.write([new ClipboardItem({'image/png': new Blob([bytes], {type: 'image/png'})})])
  }, png.toString('base64'))
  await page.locator('.CodeMirror textarea').focus()
  await page.keyboard.press('Control+V')
  await expect(page.getByLabel('草稿状态')).toHaveJSProperty('textContent', '\n![](/api/protect/download/clipboard.png)')
  expect(uploads).toBe(1)
  await expect(page.getByRole('dialog')).toHaveCount(0)
})

for (const failure of ['business', 'http'] as const) {
  test(`${failure} upload failure preserves the document and allows retry in the same picker`, async ({page, sandboxURL}) => {
    await gallery(page)
    let uploads = 0
    await page.route(uploadAPI, route => {
      uploads += 1
      if (uploads === 1) return route.fulfill({status: failure === 'http' ? 503 : 200,
        json: {code: 500, data: '', message: '图片额度不足'}})
      return route.fulfill({json: {code: 200, data: '/api/protect/download/retry.png'}})
    })
    await page.goto(sandboxURL)
    await page.locator('.CodeMirror textarea').focus()
    await page.keyboard.insertText('失败前的草稿')
    const dialog = await openPicker(page)
    await selectUpload(page)
    await expect(page.locator('.ant-message-error')).toContainText(failure === 'business' ? '图片额度不足' : '上传失败：网络错误')
    await expect(dialog).toBeVisible()
    await expect(page.getByLabel('草稿状态')).toHaveJSProperty('textContent', '失败前的草稿')
    await expect(page.getByLabel('草稿状态')).not.toContainText('![]()')
    expect(uploads).toBe(1)
    await selectUpload(page, 'retry.png')
    await expect(dialog).toBeHidden()
    await expect(page.getByLabel('草稿状态')).toContainText('![](/api/protect/download/retry.png)')
    expect(uploads).toBe(2)
  })
}

for (const state of ['empty', 'unavailable'] as const) {
  test(`${state} gallery gives explicit feedback and keeps local upload available`, async ({page, sandboxURL}) => {
    await gallery(page, [], state === 'empty' ? 200 : 500)
    await page.goto(sandboxURL)
    const dialog = await openPicker(page)
    if (state === 'empty') await expect(dialog).toContainText('图库里还没有图片')
    else {
      await expect(dialog.getByRole('alert')).toContainText('图库暂时不可用')
      await expect(dialog).not.toContainText('图库里还没有图片')
    }
    await dialog.getByRole('tab', {name: '本地上传', exact: true}).click()
    await expect(dialog.locator('.editor-image-picker-upload')).toBeVisible()
  })
}

test('pagination sends the last image key, appends without duplicates, and blocks overlapping loads', async ({page, sandboxURL}) => {
  const requests: URL[] = []
  let pageSize = 0
  let release!: () => void
  const pending = new Promise<void>(resolve => { release = resolve })
  await page.route(galleryAPI, async route => {
    const url = new URL(route.request().url())
    requests.push(url)
    const limit = Number(url.searchParams.get('limit'))
    if(!pageSize)pageSize=limit
    expect(limit).toBe(pageSize)
    const before = url.searchParams.get('before')
    if (requests.length === 2) await pending
    const all = Array.from({length: pageSize + 5}, (_, i) => ({imageKey: 3000 - i, imageUrl: `/api/protect/download/image${3000 - i}.png`}))
    const remaining=all.filter(image=>before===null||image.imageKey<Number(before))
    const items=remaining.slice(0,limit)
    return route.fulfill({json:{code:200,data:{items:items.map(row),nextCursor:remaining.length>limit?items.at(-1)!.imageKey:null}}})
  })
  await page.goto(sandboxURL)
  const dialog = await openPicker(page)
  await expect.poll(()=>pageSize).toBeGreaterThan(0)
  expect(Number.isSafeInteger(pageSize)&&pageSize<=100).toBe(true)
  const thumbnails = dialog.locator('.editor-gallery-item')
  await expect(thumbnails).toHaveCount(pageSize)
  expect(requests[0].searchParams.has('before')).toBe(false)
  const more = dialog.getByRole('button', {name: '载入更多'})
  await more.click()
  try {
    await expect.poll(() => requests.length).toBe(2)
    await more.dispatchEvent('click')
    await more.dispatchEvent('click')
    expect(requests).toHaveLength(2)
    expect(requests[1].searchParams.get('before')).toBe(String(3000 - pageSize + 1))
  } finally {
    release()
  }
  await expect(thumbnails).toHaveCount(pageSize + 5)
  await expect(more).toHaveCount(0)
  const names = await dialog.locator('.editor-gallery-name').allTextContents()
  expect(names).toEqual(Array.from({length: pageSize + 5}, (_, i) => `image${3000 - i}.png`))
  expect(new Set(names).size).toBe(names.length)
})

test('UUID-backed images display their original metadata name and keep the stored URL on insertion',async({page,sandboxURL})=>{
  const url='/api/protect/download/54fc8b80c1304d1e94d2c1815122b3e7.png'
  await gallery(page,[{imageKey:930,imageUrl:url,displayName:'猫咪的原始封面.png'}])
  await page.goto(sandboxURL)
  const dialog=await openPicker(page)
  await expect(dialog.locator('.editor-gallery-name')).toHaveText('猫咪的原始封面.png')
  await dialog.getByAltText('猫咪的原始封面.png').click()
  await expect(page.getByLabel('草稿状态')).toHaveJSProperty('textContent',`\n![](${url})`)
})

test('an explicit cursor continues a short page and a failed continuation retains prior images for retry',async({page,sandboxURL})=>{
  const cursors:(string|null)[]=[]
  const items=[{imageKey:9,imageUrl:'/api/protect/download/a.png',displayName:'海边'},
    {imageKey:8,imageUrl:'/api/protect/download/b.png',displayName:'山景'},
    {imageKey:7,imageUrl:'/api/protect/download/c.png',displayName:'夜空'}]
  await page.route(galleryAPI,route=>{
    const before=new URL(route.request().url()).searchParams.get('before')
    cursors.push(before)
    if(cursors.length===2)return route.fulfill({status:503,json:{code:503,message:'后续页暂不可用'}})
    return route.fulfill({json:{code:200,data:{items:(before===null?items.slice(0,2):items.slice(2)).map(row),nextCursor:before===null?8:null}}})
  })
  await page.goto(sandboxURL)
  const dialog=await openPicker(page)
  const thumbnails=dialog.locator('.editor-gallery-item')
  await expect(thumbnails).toHaveCount(2)
  const more=dialog.getByRole('button',{name:'载入更多'})
  await more.click()
  await expect(dialog.getByRole('alert')).toContainText('后续页暂不可用')
  await expect(thumbnails).toHaveCount(2)
  await expect(dialog.locator('.editor-gallery-name')).toHaveText(['海边','山景'])
  await more.click()
  await expect(thumbnails).toHaveCount(3)
  await expect(dialog.locator('.editor-gallery-name')).toHaveText(['海边','山景','夜空'])
  await expect(more).toHaveCount(0)
  expect(cursors).toEqual([null,'8','8'])
})
