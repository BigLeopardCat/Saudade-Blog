import {test,expect} from './sandbox'
import type {GenerationJob} from '../../src/apis/imageGenerationApi'

test.use({entry:'gallery',viewport:{width:1280,height:900}})
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
        job={...job!,status:'accepted',imageId:31}
      }else{
        const draft=route.request().postDataJSON()
        expect(draft).toEqual({prompt,model:'fixture-image',size:'1536x1024',quality:'high',referenceIds:[]})
        job={id,request:{...draft,provider:'https://api.openai.com/v1',references:[]},requestHash:'a'.repeat(64),status:'pending',
          outputHash:null,previewUrl:null,imageId:null,error:null,usage:null,createdAt:'2026-11-04T12:00:00Z'}
      }
      await route.fulfill({json:{code:200,data:job}})
    }else await route.fulfill({json:{code:200,data:path.endsWith('/jobs')?(job?[{id:job.id,title:job.request.prompt,status:job.status}]:[]):job}})
  })
  await page.route('**/fixture/generated.svg',route=>route.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="300" height="200"><rect width="300" height="200" fill="pink"/></svg>'}))
  await page.goto(sandboxURL)
  await page.getByRole('button',{name:'AI 生图'}).click()
  const dialog=page.getByRole('dialog',{name:'AI 生图',exact:true})
  await page.getByLabel('提示词',{exact:true}).fill(prompt)
  await dialog.getByRole('button',{name:'预览请求'}).click()
  await expect(dialog.getByText(prompt,{exact:true})).toBeVisible()
  await expect(dialog.getByText('未使用参考图',{exact:true})).toBeVisible()
  expect(paidCalls).toBe(0)
  expect(accepts).toBe(0)
  await dialog.getByRole('button',{name:'确认提示词与参考图，开始生成'}).click()
  await expect(dialog.getByRole('img',{name:'本次生成结果'})).toBeVisible()
  expect(paidCalls).toBe(1)
  expect(accepts).toBe(0)
  await dialog.getByRole('button',{name:'确认结果并存入图库'}).click()
  await expect(dialog.getByText('已存入图库，图片编号 31。可在文章编辑页选择封面，或请助手设置。')).toBeVisible()
  expect(paidCalls).toBe(1)
  expect(accepts).toBe(1)
})
