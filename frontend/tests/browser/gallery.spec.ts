import {test,expect} from './sandbox'
import type {GalleryImage} from '../../src/apis/galleryApi'

test.use({entry:'gallery',viewport:{width:1280,height:900}})

test('gallery opens details, selects explicitly, uses two list columns and updates metadata',async({page,sandboxURL})=>{
  let rows:GalleryImage[]=[1,2].map(id=>({imageKey:id,imageUrl:'/fixture/image-'+id+'.svg',
    displayName:'图片'+id,description:id===1?'清晨山景':'夕阳湖面',folderId:0,isFavorite:false,version:'a'.repeat(64)}))
  const folders=[{id:10,parentId:0,name:'封面',imageCount:0}]
  let deletes=0,changes=0
  await page.route('**/fixture/image-*',route=>route.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="100" height="80"><rect width="100" height="80" fill="pink"/></svg>'}))
  await page.route('**/api/protect/images/r2',route=>route.fulfill({json:{code:200,data:{enabled:false,configured:false,credentials:false,usedBytes:0,limitBytes:100,publicBase:''}}}))
  await page.route('**/api/protect/gallery/folders',async route=>{
    if(route.request().method()==='POST'){
      const body=route.request().postDataJSON()
      expect(body).toMatchObject({parentId:0,name:'旅行'})
      folders.push({id:11,parentId:0,name:body.name,imageCount:0})
      await route.fulfill({json:{code:200,data:folders.at(-1)}})
    }else await route.fulfill({json:{code:200,data:folders}})
  })
  await page.route('**/api/protect/gallery/images**',async route=>{
    const url=new URL(route.request().url())
    if(route.request().method()==='PUT'){
      const id=Number(url.pathname.split('/').at(-1)),{version,...patch}=route.request().postDataJSON()
      const old=rows.find(row=>row.imageKey===id)!
      expect(version).toBe(old.version)
      changes++
      const state={...old,...patch,version:String(changes).padStart(64,'0')}
      rows=rows.map(row=>row.imageKey===id?state:row)
      await route.fulfill({json:{code:200,data:{changed:true,beforeVersion:version,state}}})
    }else {
      const folder=url.searchParams.get('folderId')
      const items=rows.filter(row=>folder===null||row.folderId===Number(folder))
      await route.fulfill({json:{code:200,data:{items,nextCursor:null}}})
    }
  })
  await page.route('**/api/protect/delImg',async route=>{deletes++;await route.fulfill({json:{code:200,data:'deleted'}})})
  await page.goto(sandboxURL)
  await expect(page.getByRole('button',{name:'查看图片 图片1'})).toBeVisible()
  await expect(page.getByRole('button',{name:'删除选中（0）'})).toBeDisabled()
  const selector=page.getByRole('checkbox',{name:'选择图片 图片1'})
  const overlay=page.locator('.albumGrid .albumTile').first().locator('.ant-checkbox-wrapper')
  await expect(overlay).toHaveCSS('background-color','rgba(0, 0, 0, 0)')
  expect((await overlay.boundingBox())!.width).toBeLessThanOrEqual(24)
  await selector.focus()
  await page.keyboard.press('Space')
  await expect(selector).toBeChecked()
  await expect(page.getByRole('button',{name:'删除选中（1）'})).toBeEnabled()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await page.keyboard.press('Space')
  await expect(selector).not.toBeChecked()
  await page.getByRole('button',{name:'查看图片 图片1'}).click()
  const detail=page.getByRole('dialog',{name:'图片1',exact:true})
  await expect(detail).toBeVisible()
  await expect(detail.locator('.albumDetailImage')).toBeVisible()
  expect(deletes).toBe(0)
  expect(changes).toBe(0)
  await detail.getByRole('button',{name:'重命名',exact:true}).click()
  await page.getByLabel('图片显示名').fill('山景封面')
  await page.getByRole('button',{name:'保存名称'}).click()
  await expect(page.getByRole('dialog',{name:'山景封面',exact:true})).toBeVisible()
  await page.getByRole('button',{name:'star 收藏'}).click()
  await expect(page.getByRole('button',{name:'star 取消收藏'})).toBeVisible()
  await page.getByLabel('图片描述', {exact:true}).fill('适合技术博客的清晨山景')
  await page.getByRole('button',{name:'保存描述'}).click()
  await expect.poll(()=>rows[0].description).toBe('适合技术博客的清晨山景')
  await page.getByRole('button',{name:/^关\s*闭$/}).click()
  await page.getByText('列表',{exact:true}).click()
  const tracks=await page.locator('.albumList').evaluate(el=>getComputedStyle(el).gridTemplateColumns.split(' ').length)
  expect(tracks).toBe(2)
  await page.getByRole('checkbox',{name:'选择图片 山景封面'}).check()
  await expect(page.getByRole('button',{name:'删除选中（1）'})).toBeEnabled()
  expect(deletes).toBe(0)
  await page.getByRole('button',{name:'删除选中（1）'}).click()
  await expect(page.getByRole('dialog',{name:'删除图片'})).toBeVisible()
  expect(deletes).toBe(0)
  await page.getByRole('dialog',{name:'删除图片'}).getByRole('button',{name:/^取\s*消$/}).click()
  await page.getByRole('button',{name:'新建文件夹'}).click()
  await page.getByLabel('文件夹名称').fill('旅行')
  await page.getByRole('dialog',{name:'新建文件夹'}).getByRole('button',{name:/^创\s*建$/}).click()
  await expect(page.getByRole('button',{name:'📁 旅行（0）'})).toBeVisible()
  await page.setViewportSize({width:390,height:900})
  await expect.poll(()=>page.locator('.albumList').evaluate(el=>getComputedStyle(el).gridTemplateColumns.split(' ').length)).toBe(1)
  expect(rows[0].imageUrl).toBe('/fixture/image-1.svg')
})
