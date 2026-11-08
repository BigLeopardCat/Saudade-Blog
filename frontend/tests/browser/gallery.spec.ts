import {test,expect} from './sandbox'
import type {GalleryImage} from '../../src/apis/galleryApi'

test.use({entry:'gallery',viewport:{width:1280,height:900}})

test.beforeEach(async({page,sandboxURL})=>{
  await page.route(`${sandboxURL}api/protect/gallery/transfers`,route=>{
    expect(route.request().method()).toBe('GET')
    return route.fulfill({json:{code:200,data:[]}})
  })
})

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
  await expect(page.getByRole('button',{name:'删除选中',exact:true})).toBeDisabled()
  const selector=page.getByRole('checkbox',{name:'选择图片 图片1'})
  const overlay=page.locator('.albumGrid .albumTile').first().locator('.ant-checkbox-wrapper')
  await expect(overlay).toHaveCSS('background-color','rgba(0, 0, 0, 0)')
  const inner=overlay.locator('.ant-checkbox-inner')
  await expect(inner).toHaveCSS('background-color','rgba(0, 0, 0, 0)')
  await overlay.hover()
  await expect(inner).toHaveCSS('background-color','rgba(0, 0, 0, 0)')
  expect((await overlay.boundingBox())!.width).toBeLessThanOrEqual(24)
  await selector.focus()
  await expect(inner).toHaveCSS('background-color','rgba(0, 0, 0, 0)')
  await expect(overlay).toHaveCSS('outline-style','solid')
  await page.keyboard.press('Space')
  await expect(selector).toBeChecked()
  await expect(inner).not.toHaveCSS('background-color','rgba(0, 0, 0, 0)')
  await expect(page.getByRole('button',{name:'删除选中',exact:true})).toBeEnabled()
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
  await expect(page.getByRole('button',{name:'删除选中',exact:true})).toBeEnabled()
  expect(deletes).toBe(0)
  await page.getByRole('button',{name:'删除选中',exact:true}).click()
  await expect(page.getByRole('dialog',{name:'删除图片'})).toBeVisible()
  expect(deletes).toBe(0)
  await page.getByRole('dialog',{name:'删除图片'}).getByRole('button',{name:/^取\s*消$/}).click()
  await page.getByRole('button',{name:'新建文件夹'}).click()
  await page.getByLabel('文件夹名称').fill('旅行')
  await page.getByRole('dialog',{name:'新建文件夹'}).getByRole('button',{name:/^创\s*建$/}).click()
  await expect(page.getByRole('tab').filter({hasText:'旅行'})).toBeVisible()
  await page.setViewportSize({width:390,height:900})
  await expect.poll(()=>page.locator('.albumList').evaluate(el=>getComputedStyle(el).gridTemplateColumns.split(' ').length)).toBe(1)
  expect(rows[0].imageUrl).toBe('/fixture/image-1.svg')
})


test('mobile gallery separates failed-image retry from viewing and deletion', async ({page,sandboxURL})=>{
  await page.setViewportSize({width:390,height:900})
  let reads=0
  const image:GalleryImage={imageKey:1,imageUrl:'/fixture/retry.svg',displayName:'重试图片',description:'',folderId:0,isFavorite:false,version:'a'.repeat(64)}
  await page.route('**/api/monitor/log',route=>route.fulfill({json:{code:200}}))
  await page.route('**/api/protect/images/r2',route=>route.fulfill({json:{code:200,data:{enabled:false,configured:false,credentials:false,usedBytes:0,limitBytes:100,publicBase:''}}}))
  await page.route('**/api/protect/gallery/folders',route=>route.fulfill({json:{code:200,data:[]}}))
  await page.route('**/api/protect/gallery/images**',route=>route.fulfill({json:{code:200,data:{items:[image],nextCursor:null}}}))
  await page.route('**/fixture/retry.svg',route=>{
    reads++
    return reads===1?route.fulfill({status:403,body:'denied'}):route.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="300" height="3000"><rect width="300" height="3000" fill="pink"/></svg>'})
  })
  await page.goto(sandboxURL)
  await expect(page.getByText('图片加载失败',{exact:true})).toBeVisible()
  expect(await page.locator('button button').count()).toBe(0)
  await page.getByRole('button',{name:'重新加载图片：重试图片'}).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect.poll(()=>reads).toBe(2)
  await expect(page.getByRole('img',{name:'重试图片'})).toBeVisible()
  await expect(page.getByRole('checkbox',{name:'选择图片 重试图片'})).not.toBeChecked()
  await page.getByRole('button',{name:'查看图片 重试图片'}).click()
  await expect(page.getByRole('dialog',{name:'重试图片',exact:true})).toBeVisible()
  await expect(page.locator('.albumDetailImage img')).toBeVisible()
})

test('top folder tabs preserve hierarchy, sibling switching and explicit directory deletion',async({page,sandboxURL})=>{
  const folders=[{id:10,parentId:0,name:'封面',imageCount:0},
    {id:11,parentId:10,name:'旅行',imageCount:0},{id:12,parentId:0,name:'插画',imageCount:1}]
  const visits:(string|null)[]=[]
  let deletes=0
  await page.route('**/api/protect/images/r2',route=>route.fulfill({json:{code:200,data:{enabled:false,configured:false,credentials:false,usedBytes:0,limitBytes:100,publicBase:''}}}))
  await page.route('**/api/protect/gallery/folders**',async route=>{
    if(route.request().method()==='DELETE'){
      deletes++
      expect(route.request().url()).toMatch(/\/11$/)
      folders.splice(folders.findIndex(folder=>folder.id===11),1)
      await route.fulfill({json:{code:200,data:true}})
    }else await route.fulfill({json:{code:200,data:folders}})
  })
  await page.route('**/fixture/all-only.svg',route=>route.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="100" height="80"/>'}))
  await page.route('**/api/protect/gallery/images**',route=>{
    const folder=new URL(route.request().url()).searchParams.get('folderId')
    visits.push(folder)
    return route.fulfill({json:{code:200,data:{items:folder===null?[{imageKey:1,imageUrl:'/fixture/all-only.svg',
      displayName:'未分类样例',description:'',folderId:0,isFavorite:false,version:'a'.repeat(64)}]:[],nextCursor:null}}})
  })
  await page.goto(sandboxURL)
  const navigation=page.getByRole('navigation',{name:'图库分类'})
  const folderTab=(name:string)=>navigation.getByRole('tab').filter({
    has:page.locator('.albumFolderLabel > span').filter({hasText:new RegExp('(^| / )'+name+'$')})})
  const navigationBox=(await navigation.boundingBox())!
  const imageBox=(await page.locator('.albumGrid').boundingBox())!
  expect(navigationBox.y+navigationBox.height).toBeLessThanOrEqual(imageBox.y)
  expect(navigationBox.x).toBe(imageBox.x)
  expect(imageBox.width).toBe(navigationBox.width)
  await expect(folderTab('旅行')).toContainText('封面 / 旅行')
  await folderTab('旅行').focus()
  await page.keyboard.press('Enter')
  await expect.poll(()=>visits.at(-1)).toBe('11')
  await expect(folderTab('旅行')).toHaveAttribute('aria-selected','true')
  await expect(folderTab('封面')).toBeVisible()
  await expect(folderTab('插画')).toBeVisible()
  await expect(page.getByRole('button',{name:'删除空文件夹'})).toHaveCount(0)
  await expect(page.getByRole('menuitem',{name:'删除文件夹'})).toHaveCount(0)
  await folderTab('插画').click()
  await expect.poll(()=>visits.at(-1)).toBe('12')
  await navigation.getByRole('button',{name:'文件夹操作'}).click()
  await expect(page.getByRole('menuitem',{name:'删除文件夹'})).toHaveAttribute('aria-disabled','true')
  await page.keyboard.press('Escape')
  await folderTab('旅行').click()
  await navigation.getByRole('button',{name:'文件夹操作'}).click()
  await page.getByRole('menuitem',{name:'删除文件夹'}).click()
  const modal=page.getByRole('dialog',{name:'删除文件夹',exact:true})
  await expect(modal).toContainText('旅行')
  expect(deletes).toBe(0)
  await modal.getByRole('button',{name:/^取\s*消$/}).click()
  expect(deletes).toBe(0)
  await navigation.getByRole('button',{name:'文件夹操作'}).click()
  await page.getByRole('menuitem',{name:'删除文件夹'}).click()
  await modal.getByRole('button',{name:'删除文件夹',exact:true}).click()
  await expect.poll(()=>deletes).toBe(1)
  await expect(folderTab('旅行')).toHaveCount(0)
  await expect(folderTab('插画')).toBeVisible()
  await navigation.getByRole('tab',{name:'全部图片',exact:true}).click()
  await expect(page.getByRole('button',{name:'查看图片 未分类样例'})).toBeVisible()
  await expect(page.locator('.albumLibrary .ant-breadcrumb').getByRole('button')).toHaveCount(1)
  expect(visits.filter(folder=>folder===null)).toHaveLength(1)
  await page.setViewportSize({width:390,height:760})
  expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
  await expect(navigation).toBeVisible()
  await expect(navigation.getByRole('tab',{name:'全部图片',exact:true})).toHaveAttribute('aria-selected','true')
})

test('mobile folder tabs expose overflow categories without widening the gallery',async({page,sandboxURL})=>{
  await page.setViewportSize({width:390,height:760})
  const folders=Array.from({length:12},(_,index)=>({id:index+1,parentId:0,name:`旅行相册分类${index+1}`,imageCount:0}))
  folders[11].name+='远行'.repeat(30)
  const visits:(string|null)[]=[]
  await page.route('**/api/protect/images/r2',route=>route.fulfill({json:{code:200,data:{configured:false}}}))
  await page.route('**/api/protect/gallery/folders',route=>route.fulfill({json:{code:200,data:folders}}))
  await page.route('**/api/protect/gallery/images**',route=>{
    visits.push(new URL(route.request().url()).searchParams.get('folderId'))
    return route.fulfill({json:{code:200,data:{items:[],nextCursor:null}}})
  })
  await page.goto(sandboxURL)
  const navigation=page.getByRole('navigation',{name:'图库分类'})
  await navigation.locator('.ant-tabs-nav-more').click()
  const overflow=page.getByRole('listbox',{name:'expanded dropdown'})
  await expect(overflow).toBeVisible()
  expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
  await overflow.getByRole('option').filter({hasText:'旅行相册分类12'}).click()
  await expect.poll(()=>visits.at(-1)).toBe('12')
  await expect(navigation.getByRole('tab').filter({hasText:'旅行相册分类12'})).toHaveAttribute('aria-selected','true')
  expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
  await expect(page.getByRole('button',{name:'新建文件夹'})).toBeVisible()
})

for(const conflict of [false,true]){
  test(`batch move previews once and submits one frozen transaction${conflict?' with conflict recovery':''}`,async({page,sandboxURL})=>{
    let rows:GalleryImage[]=[1,2].map(id=>({imageKey:id,imageUrl:'/fixture/image-'+id+'.svg',
      displayName:'图片'+id,description:'',folderId:0,isFavorite:id===1,version:'a'.repeat(64)}))
    const prepares:unknown[]=[],writes:unknown[]=[]
    let singleWrites=0,release!:()=>void
    const waiting=new Promise<void>(resolve=>{release=resolve})
    const intent={action:'move',imageIds:[1,2],folderId:10}
    const frozen={version:'b'.repeat(64),expiresAt:4_000_000_000,intent}
    await page.route('**/fixture/image-*',route=>route.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="100" height="80"/>'}))
    await page.route('**/api/protect/images/r2',route=>route.fulfill({json:{code:200,data:{configured:false}}}))
    await page.route('**/api/protect/gallery/folders',route=>route.fulfill({json:{code:200,data:[
      {id:10,parentId:0,name:'封面',imageCount:rows.filter(row=>row.folderId===10).length},
    ]}}))
    await page.route('**/api/protect/gallery/images**',route=>{
      if(route.request().method()==='PUT')singleWrites++
      const folder=new URL(route.request().url()).searchParams.get('folderId')
      return route.fulfill({json:{code:200,data:{items:rows.filter(row=>folder===null||row.folderId===Number(folder)),nextCursor:null}}})
    })
    await page.route('**/api/protect/gallery/image-actions/prepare',route=>{
      prepares.push(route.request().postDataJSON())
      expect(prepares.at(-1)).toEqual(intent)
      return route.fulfill({json:{code:200,data:{...frozen,matchedIds:[1,2],
        preview:rows.map(row=>({imageId:row.imageKey,displayName:row.displayName,folderId:row.folderId,isFavorite:row.isFavorite})),
        previewTruncated:false,destination:{id:10,parentId:0,name:'封面'}}}})
    })
    await page.route('**/api/protect/gallery/image-actions',async route=>{
      writes.push(route.request().postDataJSON())
      expect(writes.at(-1)).toEqual(frozen)
      if(writes.length===1)await waiting
      if(conflict&&writes.length===1)return route.fulfill({status:409,json:{code:409,message:'图片已变化，请重新预览'}})
      rows=rows.map(row=>({...row,folderId:10,version:'c'.repeat(64)}))
      return route.fulfill({json:{code:200,data:{action:'move',changed:true,beforeVersion:frozen.version,
        matchedIds:[1,2],changedIds:[1,2],cleanupPendingIds:[]}}})
    })
    await page.goto(sandboxURL)
    await page.getByRole('checkbox',{name:'选择图片 图片1'}).check()
    await page.getByRole('checkbox',{name:'选择图片 图片2'}).check()
    const action=page.getByRole('button',{name:'移动选中',exact:true})
    const actionWidth=(await action.boundingBox())!.width
    await action.click()
    let modal=page.getByRole('dialog',{name:'移动图片',exact:true})
    expect(prepares).toHaveLength(0)
    expect(writes).toHaveLength(0)
    await modal.getByRole('button',{name:/^取\s*消$/}).click()
    await expect(page.getByRole('checkbox',{name:'选择图片 图片1'})).toBeChecked()
    await action.click()
    modal=page.getByRole('dialog',{name:'移动图片',exact:true})
    await modal.getByRole('combobox',{name:'目标文件夹'}).click()
    await page.locator('.ant-select-dropdown:visible').getByText('封面',{exact:true}).click()
    await modal.getByRole('button',{name:'查看预览',exact:true}).click()
    await expect(modal.getByRole('region',{name:'移动预览'})).toContainText('共 2 张')
    await expect(modal.getByRole('region',{name:'移动预览'})).toContainText('图片1')
    expect(prepares).toHaveLength(1)
    expect(writes).toHaveLength(0)
    const confirm=modal.getByRole('button',{name:'确认移动',exact:true})
    const width=(await confirm.boundingBox())!.width
    await confirm.click()
    await expect.poll(()=>writes.length).toBe(1)
    await expect(modal.getByRole('button',{name:/^取\s*消$/})).toBeDisabled()
    expect((await modal.locator('.ant-modal-footer .ant-btn-primary').boundingBox())!.width).toBe(width)
    expect(singleWrites).toBe(0)
    release()
    if(conflict){
      await expect(modal.getByRole('alert')).toBeVisible()
      expect(rows.map(row=>row.folderId)).toEqual([0,0])
      await expect(page.getByRole('checkbox',{name:'选择图片 图片1'})).toBeChecked()
      await modal.getByRole('button',{name:'修改目标',exact:true}).click()
      await modal.getByRole('button',{name:'查看预览',exact:true}).click()
      await expect(modal.getByRole('region',{name:'移动预览'})).toBeVisible()
      await modal.getByRole('button',{name:'确认移动',exact:true}).click()
    }
    await expect(modal).toHaveCount(0)
    await expect(page.getByText('已移动 2 张图片',{exact:true})).toBeVisible()
    await expect(page.getByRole('checkbox',{name:'选择图片 图片1'})).not.toBeChecked()
    expect(writes).toHaveLength(conflict?2:1)
    expect(prepares).toHaveLength(conflict?2:1)
    expect(singleWrites).toBe(0)
    expect(rows.map(row=>row.isFavorite)).toEqual([true,false])
    expect((await action.boundingBox())!.width).toBe(actionWidth)
    await page.getByRole('navigation',{name:'图库分类'}).getByRole('tab').filter({hasText:'封面'}).click()
    await expect(page.getByRole('button',{name:'查看图片 图片1'})).toBeVisible()
    await expect(page.getByRole('button',{name:'查看图片 图片2'})).toBeVisible()
    await expect(page.getByRole('navigation',{name:'图库分类'}).locator('.albumFolderLabel small')).toHaveText('2')
  })
}

for(const detail of [false,true]){
  test(`${detail?'image detail':'batch'} deletion freezes an explicit preview and reports pending storage cleanup`,async({page,sandboxURL})=>{
    let rows:GalleryImage[]=[1,2].map(id=>({imageKey:id,imageUrl:'/fixture/delete-'+id+'.svg',
      displayName:'删除样例'+id,description:'',folderId:0,isFavorite:false,version:'a'.repeat(64)}))
    const imageIds=detail?[1]:[1,2]
    const intent={action:'delete',imageIds}
    const frozen={version:'d'.repeat(64),expiresAt:4_000_000_000,intent}
    let preparations=0,writes=0,legacyDeletes=0
    await page.route('**/fixture/delete-*',route=>route.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="100" height="80"/>'}))
    await page.route('**/api/protect/images/r2',route=>route.fulfill({json:{code:200,data:{configured:false}}}))
    await page.route('**/api/protect/gallery/folders',route=>route.fulfill({json:{code:200,data:[]}}))
    await page.route('**/api/protect/gallery/images**',route=>route.fulfill({json:{code:200,data:{items:rows,nextCursor:null}}}))
    await page.route('**/api/protect/delImg',route=>{legacyDeletes++;return route.fulfill({json:{code:200,data:'legacy'}})})
    await page.route('**/api/protect/gallery/image-actions/prepare',route=>{
      preparations++
      expect(route.request().postDataJSON()).toEqual(intent)
      return route.fulfill({json:{code:200,data:{...frozen,matchedIds:imageIds,destination:null,previewTruncated:false,
        preview:rows.filter(row=>imageIds.includes(row.imageKey)).map(row=>({imageId:row.imageKey,
          displayName:row.displayName,folderId:row.folderId,isFavorite:row.isFavorite}))}}})
    })
    await page.route('**/api/protect/gallery/image-actions',route=>{
      writes++
      expect(route.request().postDataJSON()).toEqual(frozen)
      rows=rows.filter(row=>!imageIds.includes(row.imageKey))
      return route.fulfill({json:{code:200,data:{action:'delete',changed:true,beforeVersion:frozen.version,
        matchedIds:imageIds,changedIds:imageIds,cleanupPendingIds:imageIds}}})
    })
    await page.goto(sandboxURL)
    if(detail){
      await page.getByRole('button',{name:'查看图片 删除样例1'}).click()
      await page.getByRole('dialog',{name:'删除样例1',exact:true}).getByRole('button',{name:/^删\s*除$/}).click()
    }else{
      for(const id of imageIds)await page.getByRole('checkbox',{name:'选择图片 删除样例'+id}).check()
      await page.getByRole('button',{name:'删除选中',exact:true}).click()
    }
    const modal=page.getByRole('dialog',{name:'删除图片',exact:true})
    expect(preparations).toBe(0)
    expect(writes).toBe(0)
    await modal.getByRole('button',{name:'查看预览',exact:true}).click()
    await expect(modal.getByRole('region',{name:'删除预览'})).toContainText('删除样例1')
    await expect(modal.getByRole('region',{name:'删除预览'})).toContainText('共 '+imageIds.length+' 张')
    await expect(modal.getByRole('combobox')).toHaveCount(0)
    expect(writes).toBe(0)
    await modal.getByRole('button',{name:'确认删除',exact:true}).click()
    await expect(modal).toHaveCount(0)
    await expect(page.getByText(`已从图库移除 ${imageIds.length} 张图片；${imageIds.length} 张文件待后台清理`,{exact:true})).toBeVisible()
    expect(preparations).toBe(1)
    expect(writes).toBe(1)
    expect(legacyDeletes).toBe(0)
    await expect(page.getByRole('button',{name:'查看图片 删除样例1'})).toHaveCount(0)
    if(detail)await expect(page.getByRole('dialog',{name:'删除样例1',exact:true})).toHaveCount(0)
  })
}

test('a referenced-image deletion cannot advance without a valid prepared preview',async({page,sandboxURL})=>{
  let writes=0
  await page.route('**/api/protect/images/r2',route=>route.fulfill({json:{code:200,data:{configured:false}}}))
  await page.route('**/api/protect/gallery/folders',route=>route.fulfill({json:{code:200,data:[]}}))
  await page.route('**/fixture/referenced.svg',route=>route.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="100" height="80"/>'}))
  await page.route('**/api/protect/gallery/images**',route=>route.fulfill({json:{code:200,data:{items:[{
    imageKey:1,imageUrl:'/fixture/referenced.svg',displayName:'已引用图片',description:'',folderId:0,isFavorite:false,version:'a'.repeat(64),
  }],nextCursor:null}}}))
  await page.route('**/api/protect/gallery/image-actions/prepare',route=>route.fulfill({status:409,json:{code:409,message:'图片仍被文章引用，不能删除'}}))
  await page.route('**/api/protect/gallery/image-actions',route=>{writes++;return route.fulfill({status:500,json:{code:500}})})
  await page.goto(sandboxURL)
  await page.getByRole('checkbox',{name:'选择图片 已引用图片'}).check()
  await page.getByRole('button',{name:'删除选中',exact:true}).click()
  const modal=page.getByRole('dialog',{name:'删除图片',exact:true})
  await modal.getByRole('button',{name:'查看预览',exact:true}).click()
  await expect(modal.getByRole('alert')).toContainText('图片仍被文章引用，不能删除')
  await expect(modal.getByRole('button',{name:'确认删除',exact:true})).toHaveCount(0)
  expect(writes).toBe(0)
  await modal.getByRole('button',{name:/^取\s*消$/}).click()
  await expect(page.getByRole('checkbox',{name:'选择图片 已引用图片'})).toBeChecked()
})
