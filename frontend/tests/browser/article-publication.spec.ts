import {test, expect} from './sandbox'

test.use({entry:'article-publication', viewport:{width:1280,height:1000}})

for (const pendingSave of [false,true]) {
  test(`accept title/body and publish in place (pending save: ${pendingSave})`, async ({page,sandboxURL}) => {
    let version='v1'
    let releaseSave: () => void = () => {}
    const saveGate = new Promise<void>(resolve => {releaseSave=resolve})
    const publications: Record<string, unknown>[]=[]
    const saves: Record<string, unknown>[]=[]
    await page.route('**/api/protected/draft/editor/7', route => route.fulfill({json:{code:200,data:{version,
      note:{id:7,noteTitle:'原标题',noteContent:'原始正文',description:'原摘要',noteCategory:1,
        noteTags:'',status:'private',isTop:0,cover:''},draft:null}}}))
    await page.route('**/api/public/tags*', route=>route.fulfill({json:{code:200,data:[]}}))
    await page.route('**/api/protected/draft/autosave', async route => {
      const body=route.request().postDataJSON()
      saves.push(body)
      expect(body.expectedVersion).toBe(version)
      if (pendingSave) await saveGate
      version='v2'
      await route.fulfill({json:{code:200,data:{id:7,draftId:70,isRevision:true,version,updateTime:'2026-11-04 12:00:00'}}})
    })
    await page.route('**/api/protected/notes/7', async route => {
      const body=route.request().postDataJSON()
      expect(body.expectedVersion).toBe(version)
      publications.push(body)
      await route.fulfill({json:{code:200,data:'saved'}})
    })
    await page.route('**/api/protected/notes/list', route=>route.fulfill({json:{code:200,data:[]}}))
    await page.goto(sandboxURL)
    await expect(page.locator('.CodeMirror')).toBeVisible()
    await expect(page.getByLabel('文章摘要概述')).toHaveValue('原摘要')
    await page.evaluate(()=>{
      const editor=window.__saudadeArticleEditor!
      const s=editor.execute({kind:'article_editor',operation:'read',command_id:'read'})
      editor.execute({kind:'article_editor',operation:'propose',command_id:'edit',
        editor_id:s.editor_id,revision:s.revision,title:'新标题',edits:[{old_text:'原始正文',new_text:'采纳后的正文'}]})
    })
    await expect(page.getByLabel('标题修改')).toContainText('新标题')
    expect(publications).toEqual([])
    await page.getByRole('button',{name:'全部采纳'}).click()
    await expect(page.locator('.article_title input')).toHaveValue('新标题')
    await expect(page.locator('.CodeMirror')).toContainText('采纳后的正文')
    if (pendingSave) await expect.poll(()=>saves.length).toBe(1)
    const prepared=await page.evaluate(()=>{
      const editor=window.__saudadeArticleEditor!
      const s=editor.execute({kind:'article_editor',operation:'read',command_id:'read-current'})
      return editor.execute({kind:'article_editor',operation:'prepare_publish',command_id:'publish',
        editor_id:s.editor_id,revision:s.revision})
    })
    expect(prepared.outcome).toBe('publication_ready')
    const dialog=page.getByRole('dialog',{name:'发布文章'})
    await expect(dialog).toBeVisible()
    await expect(dialog.getByRole('radio',{name:'公开'})).toBeChecked()
    expect(publications).toEqual([])
    await dialog.getByRole('button',{name:/^发\s*布$/}).click()
    if (pendingSave) {
      expect(publications).toEqual([])
      releaseSave()
    }
    await expect(page.getByRole('heading',{name:'文章列表'})).toBeVisible()
    expect(publications).toHaveLength(1)
    expect(publications[0]).toMatchObject({noteTitle:'新标题',noteContent:'采纳后的正文',description:'原摘要',status:'public'})
    // The dialog can publish directly, regardless of whether the autosave debounce fired.
    expect(saves.length).toBeLessThanOrEqual(1)
  })

}
