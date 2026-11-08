import {test,expect} from './sandbox'
import type {GenerationJob} from '../../src/apis/imageGenerationApi'

test.use({entry:'gallery',viewport:{width:1280,height:900}})
test.beforeEach(async({page})=>{
  await page.route('**/api/protect/gallery/transfers',route=>route.fulfill({json:{code:200,data:[]}}))
})
test('image generation requires request approval and a separate visible-result acceptance',async({page,sandboxURL})=>{
  const id='6b9e2bf1-56af-428c-8177-e3ad0641e036'
  let job:GenerationJob|null=null
  let paidCalls=0,accepts=0
  const prompt='为 Rust 异步编程文章绘制清晰温柔的封面，不加文字。'
  await page.route('**/api/protect/images/r2',route=>route.fulfill({json:{code:200,data:{enabled:false,configured:false,usedBytes:0,limitBytes:100,publicBase:''}}}))
  await page.route('**/api/protect/gallery/folders',route=>route.fulfill({json:{code:200,data:[]}}))
  await page.route('**/api/protect/gallery/images**',route=>route.fulfill({json:{code:200,data:{items:[],nextCursor:null}}}))
  await page.route('**/api/protect/image-generation/options',route=>route.fulfill({json:{code:200,data:{configured:true,models:['fixture-image'],defaultModel:'fixture-image'}}}))
  await page.route('**/api/protect/image-generation/jobs**',async route=>{
    const path=new URL(route.request().url()).pathname
    if(route.request().method()==='POST'){
      if(path.endsWith('/approve')){
        expect(route.request().postDataJSON()).toEqual({version:'a'.repeat(64)})
        paidCalls++
        job={...job!,status:'review',outputHash:'b'.repeat(64),previewUrl:'/fixture/generated.svg'}
      }else if(path.endsWith('/accept')){
        expect(route.request().postDataJSON()).toEqual({version:'b'.repeat(64)})
        accepts++
        job={...job!,status:'saving'}
      }else{
        const draft=route.request().postDataJSON()
        expect(draft).toEqual({prompt,model:'fixture-image',size:'1536x1024',quality:'high',referenceIds:[]})
        job={id,request:{...draft,provider:'https://api.openai.com/v1',references:[]},requestHash:'a'.repeat(64),status:'pending',
          outputHash:null,previewUrl:null,imageId:null,imageRemoved:false,error:null,usage:null,createdAt:'2026-11-04T12:00:00Z'}
      }
      await route.fulfill({json:{code:200,data:job}})
    }else await route.fulfill({json:{code:200,data:path.endsWith('/jobs')?(job?[{id:job.id,title:job.request.prompt,status:job.status}]:[]):job}})
  })
  await page.route('**/fixture/generated.svg',route=>route.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="300" height="200"><rect width="300" height="200" fill="pink"/></svg>'}))
  await page.goto(sandboxURL)
  await page.getByRole('button',{name:'AI 生图'}).click()
  const dialog=page.getByRole('dialog',{name:'AI 生图',exact:true})
  // Finish the opening motion before comparing content-driven size changes.
  await page.getByLabel('提示词',{exact:true}).click()
  await dialog.screenshot({animations:'disabled'});
  const initialHeight=(await dialog.boundingBox())!.height
  await page.getByLabel('提示词',{exact:true}).fill(prompt.repeat(100))
  await expect.poll(async()=>Math.abs((await dialog.boundingBox())!.height-initialHeight)).toBeLessThan(2)
  await page.getByLabel('提示词',{exact:true}).fill(prompt)
  await dialog.getByRole('button',{name:'预览请求'}).click()
  await expect(dialog.locator('.generationPrompt')).toHaveText(prompt)
  await expect(dialog.getByText('未使用参考图',{exact:true})).toBeVisible()
  expect(Math.abs((await dialog.boundingBox())!.height-initialHeight)).toBeLessThan(2)
  await expect(dialog.locator('.generationHistoryTitle')).toHaveText(prompt)
  await dialog.locator('.generationHistoryItem').hover()
  await expect(page.getByRole('tooltip')).toHaveText(prompt)
  await page.mouse.move(0,0)
  expect(paidCalls).toBe(0)
  expect(accepts).toBe(0)
  await dialog.getByRole('button',{name:'确认提示词与参考图，开始生成'}).click()
  await expect(dialog.getByRole('img',{name:'本次生成结果'})).toBeVisible()
  expect(paidCalls).toBe(1)
  expect(accepts).toBe(0)
  await dialog.getByRole('button',{name:'确认结果并存入图库'}).click()
  await expect(dialog.getByRole('heading',{name:'正在保存',exact:true})).toBeVisible()
  await expect(dialog.getByRole('img',{name:'本次生成结果'})).toBeVisible()
  await expect(dialog.getByText('已存入图库，图片编号 31。可在文章编辑页选择封面，或请助手设置。')).toHaveCount(0)
  job={...job!,status:'accepted',imageId:31}
  await expect(dialog.getByText('已存入图库，图片编号 31。可在文章编辑页选择封面，或请助手设置。')).toBeVisible()
  expect(paidCalls).toBe(1)
  expect(accepts).toBe(1)
})

test('history menus preserve selection and layout, copy full prompts and retry only into approval',async({page,sandboxURL})=>{
  const oldId='db0bb0fa-0c38-499f-a060-347c841d1a51'
  const runningId='0cfa1af9-eaeb-42c5-85ed-37cec24b0a2e'
  const savingId='734b2d82-714c-44b0-a8e5-718c6b6400e5'
  const retryId='ce5ea452-ae55-4eb6-bac3-b30b8d1aa14d'
  const prompt='完整提示词：保留这一整段，而非历史标题的节选。\n'+('樱花与银白长发猫耳角色。'.repeat(40))
  const makeJob=(id:string,status:string):GenerationJob=>({id,status,
    request:{provider:'https://api.openai.com/v1',model:'fixture-image',prompt:id===oldId?prompt:'执行中的另一个请求 '+status,size:'1536x1024',quality:'high',
      references:[{imageId:4,name:'冻结参考图',digest:'c'.repeat(64),previewUrl:'/fixture/reference.svg'}]},
    requestHash:'a'.repeat(64),previewUrl:null,outputHash:null,imageId:null,imageRemoved:false,error:null,usage:null,createdAt:'2026-11-07T00:00:00Z'})
  const records=new Map([[oldId,makeJob(oldId,'unknown')],[runningId,makeJob(runningId,'generating')],[savingId,makeJob(savingId,'saving')]])
  let retries=0,paidCalls=0
  const deleted:string[]=[]
  await page.context().grantPermissions(['clipboard-read','clipboard-write'])
  await page.route('**/fixture/reference.svg',route=>route.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"/>'}))
  await page.route('**/api/protect/images/r2',route=>route.fulfill({json:{code:200,data:{enabled:false,configured:false,usedBytes:0,limitBytes:100,publicBase:''}}}))
  await page.route('**/api/protect/gallery/folders',route=>route.fulfill({json:{code:200,data:[]}}))
  await page.route('**/api/protect/gallery/images**',route=>route.fulfill({json:{code:200,data:{items:[],nextCursor:null}}}))
  await page.route('**/api/protect/image-generation/options',route=>route.fulfill({json:{code:200,data:{configured:true,models:['fixture-image'],defaultModel:'fixture-image'}}}))
  await page.route('**/api/protect/image-generation/jobs**',async route=>{
    const path=new URL(route.request().url()).pathname
    const id=path.split('/')[5]
    if(route.request().method()==='DELETE'){
      expect(id).not.toBe(runningId)
      expect(id).not.toBe(savingId)
      deleted.push(id)
      records.delete(id)
      await route.fulfill({json:{code:200,data:null}})
    }else if(route.request().method()==='POST'){
      if(!path.endsWith('/retry'))paidCalls++
      expect(path).toBe(`/api/protect/image-generation/jobs/${oldId}/retry`)
      expect(route.request().postData()).toBeNull()
      retries++
      const draft={...records.get(oldId)!,id:retryId,status:'pending',retryOf:oldId,retrySourceStatus:'unknown'}
      records.set(retryId,draft)
      await route.fulfill({json:{code:200,data:draft}})
    }else if(path.endsWith('/jobs')){
      await route.fulfill({json:{code:200,data:[...records.values()].map(job=>({id:job.id,status:job.status,title:job.request.prompt.slice(0,22)+'…'}))}})
    }else{
      await route.fulfill({json:{code:200,data:records.get(id)}})
    }
  })
  await page.goto(sandboxURL)
  await page.getByRole('button',{name:'AI 生图',exact:true}).click()
  const dialog=page.getByRole('dialog',{name:'AI 生图',exact:true})
  const card=(id:string)=>dialog.locator(`.generationHistoryItem[data-job-id="${id}"]`)
  await card(runningId).locator('.generationHistorySelect').click()
  await expect(dialog.getByRole('heading',{name:'正在生成',exact:true})).toBeVisible()
  await expect(card(runningId)).toHaveAttribute('data-running','true')
  await expect(card(savingId)).toHaveAttribute('data-running','true')
  await card(runningId).getByRole('button',{name:/生图记录操作/}).click()
  await expect(page.getByRole('menuitem',{name:'重试',exact:true})).toHaveAttribute('aria-disabled','true')
  await expect(page.getByRole('menuitem',{name:'删除记录',exact:true})).toHaveAttribute('aria-disabled','true')
  await page.keyboard.press('Escape')
  await expect(page.getByRole('menu')).toHaveCount(0)
  await expect(dialog).toBeVisible()
  await card(savingId).getByRole('button',{name:/生图记录操作/}).click()
  await expect(page.getByRole('menuitem',{name:'重试',exact:true})).toHaveAttribute('aria-disabled','true')
  await expect(page.getByRole('menuitem',{name:'删除记录',exact:true})).toHaveAttribute('aria-disabled','true')
  await page.keyboard.press('Escape')
  await expect(page.getByRole('menu')).toHaveCount(0)
  const height=(await dialog.boundingBox())!.height
  const before=await card(oldId).boundingBox()
  await card(oldId).getByRole('button',{name:/生图记录操作/}).click()
  await expect(card(runningId).locator('.generationHistorySelect')).toHaveAttribute('aria-current','true')
  expect(await card(oldId).boundingBox()).toEqual(before)
  expect((await dialog.boundingBox())!.height).toBe(height)
  await page.getByRole('menuitem',{name:'复制完整提示词',exact:true}).click()
  await expect.poll(()=>page.evaluate(()=>navigator.clipboard.readText())).toBe(prompt)
  await expect(card(runningId).locator('.generationHistorySelect')).toHaveAttribute('aria-current','true')
  await card(oldId).getByRole('button',{name:/生图记录操作/}).click()
  await page.getByRole('menuitem',{name:'重试',exact:true}).click()
  await expect(dialog.getByText('原请求结果尚未核实。批准这个新草稿可能再次计费，请先核对服务商调用记录。',{exact:true})).toBeVisible()
  await expect(dialog.getByRole('button',{name:'确认提示词与参考图，开始生成',exact:true})).toBeVisible()
  await expect(card(retryId).locator('.generationHistorySelect')).toHaveAttribute('aria-current','true')
  await expect(dialog.locator('.generationPrompt')).toHaveText(prompt)
  await expect(dialog.getByRole('img',{name:'冻结参考图'})).toBeVisible()
  expect(records.get(oldId)?.status).toBe('unknown')
  expect(retries).toBe(1)
  expect(paidCalls).toBe(0)
  await card(oldId).getByRole('button',{name:/生图记录操作/}).click()
  await page.getByRole('menuitem',{name:'删除记录',exact:true}).click()
  await expect(card(oldId)).toHaveCount(0)
  await expect(card(retryId).locator('.generationHistorySelect')).toHaveAttribute('aria-current','true')
  expect(deleted).toEqual([oldId])
  await card(retryId).getByRole('button',{name:/生图记录操作/}).click()
  await page.getByRole('menuitem',{name:'删除记录',exact:true}).click()
  await expect(card(retryId)).toHaveCount(0)
  await expect(dialog.getByLabel('提示词',{exact:true})).toBeVisible()
  expect(paidCalls).toBe(0)
  await dialog.getByLabel('提示词',{exact:true}).focus()
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
})

test('gallery deletion invalidates cached generation facts and never presents a removed image as still retained',async({page,sandboxURL})=>{
  const id='dc374055-000d-4d92-bbc7-c8e6c63a65fe'
  let removed=false,detailReads=0,paidCalls=0
  const intent={action:'delete',imageIds:[31]}
  const frozen={version:'d'.repeat(64),expiresAt:4_000_000_000,intent}
  const image={imageKey:31,imageUrl:'/fixture/retained.svg',displayName:'保留过的图',description:'',folderId:0,isFavorite:false,version:'a'.repeat(64)}
  const job=():GenerationJob=>({id,status:'accepted',imageId:31,imageRemoved:removed,
    previewUrl:'/fixture/retained.svg',outputHash:'b'.repeat(64),requestHash:'c'.repeat(64),error:null,usage:null,
    request:{provider:'https://api.openai.com/v1',model:'fixture-image',prompt:'保留过的图',size:'1024x1024',quality:'high',references:[]},createdAt:'2026-11-07T00:00:00Z'})
  await page.route('**/fixture/retained.svg',route=>route.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="100" height="80"/>'}))
  await page.route('**/api/protect/images/r2',route=>route.fulfill({json:{code:200,data:{configured:false}}}))
  await page.route('**/api/protect/gallery/folders',route=>route.fulfill({json:{code:200,data:[]}}))
  await page.route('**/api/protect/gallery/images**',route=>route.fulfill({json:{code:200,data:{items:removed?[]:[image],nextCursor:null}}}))
  await page.route('**/api/protect/image-generation/options',route=>route.fulfill({json:{code:200,data:{configured:true,models:['fixture-image'],defaultModel:'fixture-image'}}}))
  await page.route('**/api/protect/image-generation/jobs**',route=>{
    if(route.request().method()==='POST'){paidCalls++;return route.fulfill({status:500,json:{code:500}})}
    if(new URL(route.request().url()).pathname.endsWith('/jobs'))return route.fulfill({json:{code:200,data:[{id,status:'accepted',title:'保留过的图'}]}})
    detailReads++
    return route.fulfill({json:{code:200,data:job()}})
  })
  await page.route('**/api/protect/gallery/image-actions/prepare',route=>{
    expect(route.request().postDataJSON()).toEqual(intent)
    return route.fulfill({json:{code:200,data:{...frozen,matchedIds:[31],destination:null,previewTruncated:false,
      preview:[{imageId:31,displayName:image.displayName,folderId:0,isFavorite:false}]}}})
  })
  await page.route('**/api/protect/gallery/image-actions',route=>{
    expect(route.request().postDataJSON()).toEqual(frozen)
    removed=true
    return route.fulfill({json:{code:200,data:{action:'delete',changed:true,beforeVersion:frozen.version,
      matchedIds:[31],changedIds:[31],cleanupPendingIds:[31]}}})
  })
  await page.goto(sandboxURL)
  const openHistory=async()=>{
    await page.getByRole('button',{name:'AI 生图',exact:true}).click()
    const modal=page.getByRole('dialog',{name:'AI 生图',exact:true})
    await modal.locator(`.generationHistoryItem[data-job-id="${id}"] .generationHistorySelect`).click()
    return modal
  }
  const first=await openHistory()
  await expect(first.getByRole('img',{name:'本次生成结果'})).toBeVisible()
  await expect(first.getByText('已存入图库，图片编号 31。可在文章编辑页选择封面，或请助手设置。')).toBeVisible()
  expect(detailReads).toBe(1)
  await first.getByRole('button',{name:/^关\s*闭$/}).click()
  await page.getByRole('checkbox',{name:'选择图片 保留过的图'}).check()
  await page.getByRole('button',{name:'删除选中',exact:true}).click()
  const confirmation=page.getByRole('dialog',{name:'删除图片',exact:true})
  await confirmation.getByRole('button',{name:'查看预览',exact:true}).click()
  await expect(confirmation.getByRole('region',{name:'删除预览'})).toBeVisible()
  await confirmation.getByRole('button',{name:'确认删除',exact:true}).click()
  await expect(confirmation).toHaveCount(0)
  const after=await openHistory()
  await expect(after.getByRole('heading',{name:'图片已从图库移除',exact:true})).toBeVisible()
  await expect(after.locator('.generationHistoryStatus')).toHaveText('图片已从图库移除')
  await expect(after.getByText('图片已从图库移除，曾保存的任务结果仍保留。',{exact:true})).toBeVisible()
  await expect(after.getByRole('img',{name:'本次生成结果'})).toHaveCount(0)
  await expect(after.getByText('已存入图库，图片编号 31。可在文章编辑页选择封面，或请助手设置。')).toHaveCount(0)
  await expect(after.getByText('生成失败',{exact:true})).toHaveCount(0)
  expect(detailReads).toBe(2)
  expect(paidCalls).toBe(0)
})
