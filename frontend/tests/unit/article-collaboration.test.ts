import {describe, expect, it} from 'vitest'
import {createEditorSession, type EditorCommand, type Proposal} from '../../src/components/ArticleCollaboration/session'

function fixture(content = '第一节旧正文\n\n第二节旧正文') {
  let value = {title: '草稿标题', content, description: '原摘要'}, enabled = true
  let proposal: Proposal | null = null
  const writes: string[] = [], publications: string[] = []
  const session = createEditorSession({read: () => value, enabled: () => enabled,
    applyBody: content => {value = {...value, content}; writes.push(content)},
    applySummary: description => {value = {...value, description}},
    applyTitle: title => {value = {...value, title}},
    preparePublish: () => {publications.push(value.content)}, onProposal: p => {proposal = p}})
  let count = 0
  const read = () => session.execute({kind: 'article_editor', operation: 'read', command_id: `read-${count++}`})
  const propose = (edits = [{old_text: '第一节旧正文', new_text: '第一节新正文'}]) => {
    const snapshot = read()
    const cmd: EditorCommand = {kind: 'article_editor', operation: 'propose', command_id: `edit-${count++}`,
      editor_id: snapshot.editor_id, revision: snapshot.revision, edits}
    return {cmd, result: session.execute(cmd)}
  }
  return {session, read, propose, writes, publications, value: () => value, proposal: () => proposal,
    type: (content: string) => {value = {...value, content}}, disable: () => {enabled = false}}
}

describe('current draft collaboration', () => {
  it('reviews a title without applying it and independently accepts title and body', () => {
    const f = fixture(), snapshot = f.read()
    f.session.execute({kind:'article_editor',operation:'propose',command_id:'title-body',
      editor_id:snapshot.editor_id,revision:snapshot.revision,title:'更好的标题',
      edits:[{old_text:'第一节旧正文',new_text:'第一节新正文'}]})
    expect(f.value().title).toBe('草稿标题')
    f.session.accept('title')
    expect(f.value().title).toBe('更好的标题')
    expect(f.proposal()?.edits).toHaveLength(1)
    f.session.accept(0)
    expect(f.value().content).toContain('第一节新正文')
    expect(f.proposal()).toBeNull()
  })
  it('retains a title suggestion when the body is accepted or rejected independently', () => {
    for (const action of ['accept','reject'] as const) {
      const f=fixture(), snapshot=f.read()
      f.session.execute({kind:'article_editor',operation:'propose',command_id:action,
        editor_id:snapshot.editor_id,revision:snapshot.revision,title:'新标题',
        edits:[{old_text:'第一节旧正文',new_text:'第一节新正文'}]})
      f.session[action](0)
      expect(f.proposal()?.title).toBe('新标题')
      f.session.accept('title')
      expect(f.value().title).toBe('新标题')
      expect(f.proposal()).toBeNull()
    }
  })
  it('supports title-only review and rejects blank or unchanged titles', () => {
    const f=fixture(), snapshot=f.read()
    for (const title of [' ', '草稿标题', '字'.repeat(256)]) {
      expect(() => f.session.execute({kind:'article_editor',operation:'propose',command_id:title,
        editor_id:snapshot.editor_id,revision:snapshot.revision,title})).toThrow()
    }
    f.session.execute({kind:'article_editor',operation:'propose',command_id:'title',
      editor_id:snapshot.editor_id,revision:snapshot.revision,title:'新标题'})
    f.session.accept()
    expect(f.value().title).toBe('新标题')
    expect(f.writes).toEqual([])
  })
  it('opens publication once for the current draft, without publishing or applying suggestions', () => {
    const f=fixture(), snapshot=f.read()
    const command: EditorCommand={kind:'article_editor',operation:'prepare_publish',command_id:'publish',
      editor_id:snapshot.editor_id,revision:snapshot.revision}
    expect(f.session.execute(command).outcome).toBe('publication_ready')
    f.session.execute(command)
    expect(f.publications).toHaveLength(1)
    expect(f.writes).toEqual([])
    f.type('新输入')
    expect(() => f.session.execute({...command,command_id:'stale'})).toThrow(/草稿已变化/)
    const g=fixture(), before=g.read()
    g.propose()
    expect(() => g.session.execute({...command,command_id:'pending',
      editor_id:before.editor_id,revision:before.revision})).toThrow(/未处理的修改建议/)
    expect(g.publications).toEqual([])
  })
  it('reads the live working copy in bounded slices without writing', () => {
    const f = fixture('a'.repeat(24001))
    f.type('b'.repeat(24001))
    const snapshot = f.read()
    expect(snapshot.content).toBe('b'.repeat(12000))
    expect(snapshot.next_offset).toBe(12000)
    expect(snapshot.total_chars).toBe(24001)
    expect(f.writes).toEqual([])
  })
  it('pages Unicode code points without splitting emoji or skipping the next slice', () => {
    const f = fixture('a😀中🐱'), results = []
    for (let offset = 0; offset < 4; offset += 2) {
      results.push(f.session.execute({kind:'article_editor',operation:'read',
        command_id:`unicode-${offset}`,offset,limit:2}))
    }
    expect(results.map(row => row.content)).toEqual(['a😀','中🐱'])
    expect(results.map(row => row.total_chars)).toEqual([4,4])
    expect(results.map(row => row.next_offset)).toEqual([2,null])
    expect(results.map(row => row.content).join('')).toBe(f.value().content)
    expect(() => f.session.execute({kind:'article_editor',operation:'read',
      command_id:'beyond',offset:5,limit:2})).toThrow(/范围不合法/)
  })
  it('body proposals do not modify the draft until accepted; replay is idempotent', () => {
    const f = fixture(), {cmd, result} = f.propose()
    expect(f.writes).toEqual([])
    expect(result.outcome).toBe('proposed')
    expect(f.session.execute(cmd)).toEqual(result)
    f.session.accept()
    expect(f.value().content).toContain('第一节新正文')
    f.session.execute(cmd)
    expect(f.writes).toHaveLength(1)
    expect(f.proposal()).toBeNull()
  })
  it('supports out-of-order partial accepts even when a replacement creates another anchor', () => {
    const f = fixture('aaa\n\nbbb')
    f.propose([{old_text: 'aaa', new_text: 'ccc'}, {old_text: 'bbb', new_text: 'aaa'}])
    f.session.accept(1)
    f.session.accept(0)
    expect(f.value().content).toBe('ccc\n\naaa')
  })
  it('refuses stale body and summary writes without losing new user input', () => {
    const f = fixture(), snapshot = f.read()
    f.propose()
    f.type('用户新写的正文')
    expect(() => f.session.accept()).toThrow(/草稿已变化/)
    expect(() => f.session.execute({kind:'article_editor',operation:'summary',command_id:'summary',
      editor_id:snapshot.editor_id,revision:snapshot.revision,description:'新摘要'})).toThrow(/草稿已变化/)
    expect(f.value()).toMatchObject({content:'用户新写的正文',description:'原摘要'})
  })
  it('creates and directly replaces a summary without generating a body review', () => {
    const f = fixture(), snapshot = f.read()
    const applied = f.session.execute({kind:'article_editor',operation:'summary',command_id:'summary',
      editor_id:snapshot.editor_id,revision:snapshot.revision,description:'从正文生成的摘要'})
    expect(applied).toMatchObject({description:'从正文生成的摘要',outcome:'updated',
      revision:snapshot.revision+1})
    expect(f.value().description).toBe('从正文生成的摘要')
    expect(f.writes).toEqual([])
    expect(f.proposal()).toBeNull()
  })
  it('reports unchanged summaries explicitly and replays the original applied receipt', () => {
    const f = fixture(), snapshot = f.read()
    const noop = f.session.execute({kind:'article_editor',operation:'summary',command_id:'noop',
      editor_id:snapshot.editor_id,revision:snapshot.revision,description:'原摘要'})
    expect(noop).toMatchObject({description:'原摘要',outcome:'unchanged',revision:snapshot.revision})
    const command: EditorCommand = {kind:'article_editor',operation:'summary',command_id:'apply',
      editor_id:snapshot.editor_id,revision:snapshot.revision,description:'新摘要😀'}
    const applied = f.session.execute(command)
    expect(applied).toMatchObject({outcome:'updated',description:'新摘要😀',revision:snapshot.revision+1})
    expect(f.session.execute(command)).toEqual(applied)
    expect(f.read().revision).toBe(applied.revision)
  })
  it('does not report an ignored or altered summary write as completed', () => {
    for (const altered of ['原摘要','写成了其他内容']) {
      let value = {title:'草稿',content:'正文',description:'原摘要'}
      const session = createEditorSession({read:() => value, enabled:() => true,
        applyBody:() => {},onProposal:() => {},
        applySummary:() => {value = {...value,description:altered}}})
      const snapshot = session.execute({kind:'article_editor',operation:'read',command_id:'read'})
      expect(() => session.execute({kind:'article_editor',operation:'summary',command_id:'write',
        editor_id:snapshot.editor_id,revision:snapshot.revision,description:'新摘要'})).toThrow(/未能应用/)
    }
  })
  it('a summary update preserves and reports the pending body review', () => {
    const f = fixture()
    f.propose()
    const snapshot = f.read()
    expect(snapshot.proposal_id).toBe(f.proposal()?.id)
    const applied = f.session.execute({kind:'article_editor',operation:'summary',command_id:'summary',
      editor_id:snapshot.editor_id,revision:snapshot.revision,description:'新摘要'})
    expect(applied.proposal_id).toBe(snapshot.proposal_id)
    expect(f.read().proposal_id).toBe(snapshot.proposal_id)
    f.session.accept()
    expect(f.value()).toMatchObject({content:'第一节新正文\n\n第二节旧正文',description:'新摘要'})
  })
  it('supports creating a blank document and rejecting changes without writes', () => {
    const f = fixture('')
    f.propose([{old_text:'',new_text:'# 新文章\n\n正文'}])
    f.session.reject()
    expect(f.value().content).toBe('')
    f.propose([{old_text:'',new_text:'# 新文章\n\n正文'}])
    f.session.accept()
    expect(f.value().content).toContain('# 新文章')
  })
  it('rejects ambiguous, overlapping, wrong-document and disabled edits', () => {
    const f = fixture('aaa aaa bbb')
    expect(() => f.propose([{old_text:'aaa',new_text:'c'}])).toThrow(/多处匹配/)
    expect(() => f.propose([{old_text:'aaa aaa',new_text:'c'},{old_text:'aaa bbb',new_text:'d'}])).toThrow(/重叠/)
    const snapshot = f.read()
    expect(() => f.session.execute({kind:'article_editor',operation:'summary',command_id:'wrong',
      editor_id:'other',revision:snapshot.revision,description:'x'})).toThrow(/切换文章/)
    f.disable()
    expect(() => f.read()).toThrow(/尚未就绪/)
    expect(f.writes).toEqual([])
  })
})
