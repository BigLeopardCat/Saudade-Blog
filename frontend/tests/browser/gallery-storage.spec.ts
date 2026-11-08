import {test,expect} from './sandbox'
import type {GalleryImage,GalleryTransferJob,GalleryTransferPreview} from '../../src/apis/galleryApi'
test.use({entry:'gallery',viewport:{width:1280,height:900}})

test('local-only library copies with approval and refreshes after durable completion',async({page,sandboxURL})=>{
  const image:GalleryImage={imageKey:1,imageUrl:'/fixture/a.svg',displayName:'山景',description:'清晨',folderId:0,isFavorite:false,version:'a'.repeat(64),storage:'local',storagePath:'a.png'}
  let rows=[image]
  let job:GalleryTransferJob|null=null
  let prepared:GalleryTransferPreview|null=null
  let approvals=0
  const filters:string[]=[]
  await page.route('**/fixture/*.svg',route=>route.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>'}))
  await page.route('**/api/protect/images/r2',route=>route.fulfill({json:{code:200,data:{configured:false,enabled:false,credentials:false,usedBytes:0,limitBytes:100}}}))
  await page.route('**/api/protect/gallery/folders',route=>route.fulfill({json:{code:200,data:[]}}))
  await page.route('**/api/protect/gallery/images**',route=>{
    const storage=new URL(route.request().url()).searchParams.get('storage');if(storage)filters.push(storage)
    return route.fulfill({json:{code:200,data:{items:storage==='r2'?[]:rows,nextCursor:null}}})
  })
  await page.route('**/api/protect/gallery/transfers/prepare',route=>{
    expect(approvals).toBe(0)
    prepared={version:'b'.repeat(64),expiresAt:Math.floor(Date.now()/1000)+900,intent:route.request().postDataJSON(),destinationName:'未分类',images:[image]}
    return route.fulfill({json:{code:200,data:prepared}})
  })
  await page.route('**/api/protect/gallery/transfers',route=>{
    if(route.request().method()==='POST'){
      approvals++;expect(route.request().postDataJSON()).toEqual({version:prepared!.version,expiresAt:prepared!.expiresAt,intent:prepared!.intent})
      job={id:prepared!.version,status:'queued',result:null,error:null}
      return route.fulfill({json:{code:200,data:job}})
    }
    return route.fulfill({json:{code:200,data:job?[job]:[]}})
  })
  await page.goto(sandboxURL)
  await expect(page.getByRole('button',{name:'传到本站'})).toBeEnabled()
  await expect(page.getByRole('button',{name:'传到 R2'})).toHaveCount(0)
  await page.getByRole('button',{name:'查看图片 山景'}).click()
  await page.getByRole('button',{name:'复制到',exact:true}).click()
  const modal=page.getByRole('dialog',{name:'复制图片'})
  await expect(page.getByRole('dialog')).toHaveCount(1)
  await modal.getByRole('button',{name:/^取\s*消$/}).click()
  await expect(page.getByRole('dialog',{name:'山景',exact:true})).toBeVisible()
  await page.getByRole('button',{name:'复制到',exact:true}).click()
  await expect(page.getByRole('dialog')).toHaveCount(1)
  const storage=modal.getByRole('combobox',{name:'目标存储'})
  await storage.press('ArrowDown')
  await expect(storage).toHaveAttribute('aria-expanded','true')
  await page.locator('.ant-select-dropdown:visible').getByText('本地存储',{exact:true}).click()
  await modal.getByRole('combobox',{name:'目标文件夹'}).click()
  await page.locator('.ant-select-dropdown:visible').getByText('未分类',{exact:true}).click()
  await modal.getByRole('button',{name:'查看预览'}).click()
  await expect(modal.getByRole('region',{name:'复制预览'})).toContainText('山景')
  expect(approvals).toBe(0)
  await modal.getByRole('button',{name:'确认复制'}).click()
  await expect(modal).toHaveCount(0)
  await expect(page.getByText('正在处理 1 项图片传输')).toBeVisible()
  expect(prepared!.intent).toEqual({mode:'copy',imageIds:[1],storage:'local',folderId:0})
  rows=[image,{...image,imageKey:2,imageUrl:'/fixture/b.svg',displayName:'山景副本',storagePath:'b.png'}]
  job={id:prepared!.version,status:'complete',result:{mode:'copy',sourceIds:[1],imageIds:[2]},error:null}
  await expect(page.getByRole('button',{name:'查看图片 山景副本',exact:true})).toBeVisible({timeout:10000})
  await expect(page.getByText('正在处理 1 项图片传输')).toHaveCount(0)
  await page.getByRole('button',{name:/^关\s*闭$/}).click()
  await page.getByText('本地',{exact:true}).click()
  await expect.poll(()=>filters).toContain('local')
  expect(approvals).toBe(1)
})
