import type {Page} from '@playwright/test'
import {test,expect} from './sandbox'
import type {CommentAdminItem} from '../../src/apis/commentAdminApi'

test.use({entry:'comment-manage',viewport:{width:1400,height:900}})

type Read = {page:number;size:number;q:string;status:string|null;deleted:string|null;sort:string|null}
type Reply = {code:number;data?:CommentAdminItem[];total?:number;message?:string}
const comment=(id:number,approved=0):CommentAdminItem=>({id,noteId:19,noteTitle:'分页文章',content:`评论 ${id}`,
  userId:3,username:'reader',nickname:'读者',createTime:'2026-01-01 00:00:00',approved,isDeleted:0,
  aiResult:'flag',aiReason:'请补充与文章的关联'})
const rows=(count:number)=>Array.from({length:count},(_,i)=>comment(count-i))
const deferred=()=>{
  let release!:()=>void
  const ready=new Promise<void>(resolve=>{release=resolve})
  return {ready,release}
}
async function mockComments(page:Page, initial:CommentAdminItem[],
  override?:(input:Read,normal:Reply)=>Promise<Reply>|Reply){
  const state={rows:initial,reads:[] as Read[],writes:[] as {id:number;method:string;body:unknown}[],failWrites:false}
  await page.route('**/api/protected/websetting',route=>route.fulfill({json:{code:200,data:{}}}))
  await page.route('**/api/monitor/log',route=>route.fulfill({json:{code:200}}))
  await page.route('**/api/protect/comments**',async route=>{
    const request=route.request(),url=new URL(request.url())
    if(request.method()!=='GET'){
      const id=Number(url.pathname.split('/')[4])
      const body=request.method()==='PUT'?request.postDataJSON():null
      state.writes.push({id,method:request.method(),body})
      if(state.failWrites){await route.fulfill({json:{code:500,message:'写入失败'}});return}
      state.rows=state.rows.map(row=>row.id!==id?row:request.method()==='DELETE'
        ?{...row,isDeleted:1}:{...row,approved:body.approved===1?1:2,rejectReason:body.reason||null})
      await route.fulfill({json:{code:200,data:'ok'}})
      return
    }
    const input:Read={page:Number(url.searchParams.get('page')),size:Number(url.searchParams.get('page_size')),
      q:url.searchParams.get('q')||'',status:url.searchParams.get('status'),deleted:url.searchParams.get('deleted'),sort:url.searchParams.get('sort')}
    expect(input.size).toBe(10)
    expect(input.page).toBeGreaterThan(0)
    state.reads.push(input)
    const status:Record<string,number>={pending:0,passed:1,rejected:2}
    const filtered=state.rows.filter(row=>(input.status===null||row.approved===status[input.status])
      &&(input.deleted===null||(row.isDeleted!==0)===(input.deleted==='true'))
      &&(!input.q||[row.content,row.noteTitle,row.username,row.nickname].some(text=>text.includes(input.q))))
      .sort((a,b)=>input.sort==='asc'?a.id-b.id:b.id-a.id)
    const normal={code:200,data:filtered.slice((input.page-1)*10,input.page*10),total:filtered.length}
    await route.fulfill({json:override?await override(input,normal):normal})
  })
  return state
}
const bodyRows=(page:Page)=>page.locator('.ant-table-tbody tr[data-row-key]')
const table=(page:Page)=>page.locator('.ant-table-tbody')
const tab=(page:Page,name:string)=>page.getByRole('tab',{name,exact:true})
const search=(page:Page)=>page.getByPlaceholder('检索评论、昵称、用户名或文章标题…')
const currentPage=(page:Page)=>page.locator('.ant-pagination-item-active')

test('501st old pending comment is reachable and server filters reset pagination',async({page,sandboxURL})=>{
  const dataset=rows(501).map(row=>({...row,approved:row.id===1?0:1}))
  const state=await mockComments(page,dataset)
  await page.goto(sandboxURL)
  await expect(bodyRows(page)).toHaveCount(10)
  await expect(page.locator('.cm-count')).toHaveText('共 501 条评论')
  await page.locator('.cm-foot li[title="51"]').click()
  await expect(bodyRows(page)).toHaveCount(1)
  await expect(table(page)).toContainText('评论 1')
  await tab(page,'待审').click()
  await expect(currentPage(page)).toHaveAttribute('title','1')
  await expect(page.locator('.cm-count')).toHaveText('共 1 条评论')
  expect(state.reads.at(-1)).toMatchObject({page:1,status:'pending',deleted:'false'})
  await tab(page,'全部').click()
  await page.locator('.cm-foot li[title="51"]').click()
  const before=state.reads.length
  await search(page).fill('分页文章')
  expect(state.reads).toHaveLength(before)
  await search(page).press('Enter')
  await expect.poll(()=>state.reads.at(-1)?.q).toBe('分页文章')
  expect(state.reads.at(-1)?.page).toBe(1)
  await page.getByRole('button',{name:'时序 ↓',exact:true}).click()
  await expect.poll(()=>state.reads.at(-1)?.sort).toBe('asc')
  expect(state.reads.at(-1)?.page).toBe(1)
  await expect(bodyRows(page).first()).toContainText('评论 1')
})

test('late search response cannot replace the currently selected query',async({page,sandboxURL})=>{
  const gate=deferred(),started=deferred()
  const state=await mockComments(page,[{...comment(1),content:'old'},{...comment(2),content:'new'}],async(input,normal)=>{
    if(input.q==='old'){started.release();await gate.ready}
    return normal
  })
  await page.goto(sandboxURL)
  await expect(bodyRows(page)).toHaveCount(2)
  await search(page).fill('old');await search(page).press('Enter');await started.ready
  await search(page).fill('new');await search(page).press('Enter')
  await expect(bodyRows(page)).toHaveCount(1)
  await expect(table(page)).toContainText('new')
  const response=page.waitForResponse(response=>new URL(response.url()).searchParams.get('q')==='old')
  gate.release();await response
  await expect(table(page)).not.toContainText('old')
  expect(state.reads.map(read=>read.q)).toEqual(['','old','new'])
})

for(const first of [true,false]){
  test(`${first?'first-page':'refresh'} business failure is explicit and retries without claiming empty results`,async({page,sandboxURL})=>{
    let fail=first
    await mockComments(page,[comment(1)],(_input,normal)=>fail?{code:500,message:'查询暂不可用'}:normal)
    await page.goto(sandboxURL)
    if(!first){
      await expect(bodyRows(page)).toHaveCount(1)
      fail=true
      await page.getByRole('button',{name:/刷\s*新$/}).click()
    }
    await expect(page.getByRole('alert')).toContainText('查询暂不可用')
    await expect(page.getByText('暂无评论',{exact:true})).toHaveCount(0)
    if(!first)await expect(table(page)).toContainText('评论 1')
    fail=false
    await page.getByRole('button',{name:/^重\s*试$/}).click()
    await expect(page.getByRole('alert')).toHaveCount(0)
    await expect(bodyRows(page)).toHaveCount(1)
  })
}

for(const action of ['audit','delete'] as const){
  test(`${action} refreshes the same filtered page and falls back when the last page becomes empty`,async({page,sandboxURL})=>{
    const state=await mockComments(page,rows(11))
    await page.goto(sandboxURL)
    await tab(page,'待审').click()
    await expect.poll(()=>state.reads.at(-1)?.status).toBe('pending')
    await page.locator('.cm-foot li[title="2"]').click()
    await expect(bodyRows(page)).toHaveCount(1)
    const row=bodyRows(page).first()
    if(action==='audit')await row.getByRole('button',{name:/^通\s*过$/}).click()
    else{
      await row.getByRole('button',{name:/^删\s*除$/}).click()
      await page.locator('.ant-popconfirm').getByRole('button',{name:/^删\s*除$/}).click()
    }
    await expect(currentPage(page)).toHaveAttribute('title','1')
    await expect(bodyRows(page)).toHaveCount(10)
    expect(state.reads.slice(-2).map(input=>input.page)).toEqual([2,1])
    expect(state.writes).toHaveLength(1)
    expect(state.writes[0]).toMatchObject({id:1,method:action==='audit'?'PUT':'DELETE'})
    if(action==='delete'){
      await tab(page,'已删除').click()
      await expect(bodyRows(page)).toHaveCount(1)
      await expect(table(page)).toContainText('已删除（公开侧不再显示）')
      await expect(bodyRows(page).getByRole('button')).toHaveCount(0)
    }
  })
}

test('review on a nonempty page keeps the page and renders stored rejection state and reason',async({page,sandboxURL})=>{
  const state=await mockComments(page,rows(21))
  await page.goto(sandboxURL)
  await expect(bodyRows(page)).toHaveCount(10)
  await page.locator('.cm-foot li[title="2"]').click()
  await expect(bodyRows(page).first()).toContainText('评论 11')
  await bodyRows(page).first().getByRole('button',{name:/^驳\s*回$/}).click()
  const modal=page.getByRole('dialog',{name:'驳回这条评论？'})
  await expect(modal.getByRole('button',{name:'确认驳回',exact:true})).toBeDisabled()
  await modal.getByRole('button',{name:'采用 AI 说明',exact:true}).click()
  await modal.getByRole('button',{name:'确认驳回',exact:true}).click()
  await expect(modal).toBeHidden()
  await expect(currentPage(page)).toHaveAttribute('title','2')
  await expect(bodyRows(page).first()).toContainText('未通过')
  await expect(bodyRows(page).first()).toContainText('驳回理由：请补充与文章的关联')
  expect(state.writes[0]).toEqual({id:11,method:'PUT',body:{approved:0,reason:'请补充与文章的关联'}})
  expect(state.reads.at(-1)?.page).toBe(2)
})

test('failed review keeps its draft and does not invalidate the confirmed page',async({page,sandboxURL})=>{
  const state=await mockComments(page,[comment(1)])
  state.failWrites=true
  await page.goto(sandboxURL)
  await expect(bodyRows(page)).toHaveCount(1)
  await bodyRows(page).getByRole('button',{name:/^驳\s*回$/}).click()
  const modal=page.getByRole('dialog')
  const reason=modal.getByPlaceholder('例如：与文章主题无关的广告（也可以点上面的常见类型，再改成更贴这条的说法）')
  await reason.fill('具体理由')
  const before=state.reads.length
  await modal.getByRole('button',{name:'确认驳回',exact:true}).click()
  await expect(page.locator('.ant-message-error')).toContainText('写入失败')
  await expect(modal).toBeVisible()
  await expect(reason).toHaveValue('具体理由')
  expect(state.reads).toHaveLength(before)
  state.failWrites=false
  await modal.getByRole('button',{name:'确认驳回',exact:true}).click()
  await expect(modal).toBeHidden()
  await expect(bodyRows(page)).toContainText('未通过')
})

test('agent read turns do not reload the page, while a confirmation attempt refreshes it',async({page,sandboxURL})=>{
  const state=await mockComments(page,rows(11))
  await page.goto(sandboxURL)
  await expect(bodyRows(page)).toHaveCount(10)
  await page.locator('.cm-foot li[title="2"]').click()
  await expect(bodyRows(page)).toHaveCount(1)
  const before=state.reads.length
  await page.evaluate(()=>{
    for(const detail of [{},{confirmationAttempted:false},{confirmationAttempted:false,articleIdsToRefresh:[19]}]){
      window.dispatchEvent(new CustomEvent('agent-turn-done',{detail}))
    }
  })
  await page.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve()))))
  expect(state.reads).toHaveLength(before)
  state.rows=state.rows.map(row=>row.id===1?{...row,content:'确认后的事实'}:row)
  await page.evaluate(()=>window.dispatchEvent(new CustomEvent('agent-turn-done',{
    detail:{confirmationAttempted:true,articleIdsToRefresh:[]},
  })))
  await expect(table(page)).toContainText('确认后的事实')
  expect(state.reads).toHaveLength(before+1)
  expect(state.reads.at(-1)?.page).toBe(2)
})
