/** Browser-local working copy. Its observations never grant server permissions. */
export type Edit = {old_text: string; new_text: string}
export type WorkingCopy = {title: string; content: string; description: string}
type ReviewEdit = Edit & {start: number}
export type Proposal = {id: string; base: WorkingCopy; revision: number; edits: ReviewEdit[]}
export type EditorCommand = {
  kind: 'article_editor'; operation: 'read' | 'propose' | 'summary'; command_id: string;
  editor_id?: string; revision?: number; offset?: number; limit?: number;
  edits?: Edit[]; description?: string;
}
export type Observation = {
  editor_id: string; revision: number; outcome: 'read' | 'proposed' | 'updated' | 'unchanged';
  title?: string; content?: string; description?: string; offset?: number;
  next_offset?: number | null; total_chars?: number; proposal_id?: string;
}

export function replaceExact(content: string, edit: Edit): string {
  if (!edit.old_text) {
    if (content) throw new Error('插入空匹配仅用于创建空白正文，请先读取当前草稿。')
    return edit.new_text
  }
  const index = content.indexOf(edit.old_text)
  if (index < 0 || content.indexOf(edit.old_text, index + 1) >= 0)
    throw new Error('修改原文不存在或存在多处匹配，请重新读取并提供唯一原文。')
  return content.slice(0, index) + edit.new_text + content.slice(index + edit.old_text.length)
}

function applyRanges(content: string, edits: ReviewEdit[]) {
  return [...edits].sort((a, b) => b.start - a.start).reduce((text, edit) => {
    if (text.slice(edit.start, edit.start + edit.old_text.length) !== edit.old_text)
      throw new Error('修改位置已变化，请重新读取草稿。')
    return text.slice(0, edit.start) + edit.new_text + text.slice(edit.start + edit.old_text.length)
  }, content)
}

export function createEditorSession(options: {
  read: () => WorkingCopy; enabled: () => boolean;
  applyBody: (content: string) => void; applySummary: (content: string) => void;
  onProposal: (proposal: Proposal | null) => void;
}) {
  const id = crypto.randomUUID()
  let revision = 0, last = options.read(), proposal: Proposal | null = null
  const replies = new Map<string, Observation>()
  const current = () => {
    const value = options.read()
    if (value.content !== last.content || value.description !== last.description || value.title !== last.title) {
      revision++
      last = {...value}
    }
    return {...value}
  }
  const ready = () => { if (!options.enabled()) throw new Error('编辑器尚未就绪、正在发布或草稿存在保存冲突。') }
  const check = (editorId: string | undefined, expected: number | undefined) => {
    ready(); current()
    if (editorId !== id || expected !== revision)
      throw new Error('草稿已变化或已切换文章，请重新读取；当前内容未被覆盖。')
  }
  const publish = (next: Proposal | null) => { proposal = next; options.onProposal(next) }
  const execute = (command: EditorCommand): Observation => {
    ready()
    const cached = replies.get(command.command_id)
    if (cached) return cached
    const value = current()
    let result: Observation
    if (command.operation === 'read') {
      const offset = command.offset ?? 0, limit = command.limit ?? 12000
      // Wire offsets count Unicode code points, including emoji as single points.
      const points = Array.from(value.content)
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > points.length
          || !Number.isSafeInteger(limit) || limit < 1 || limit > 24000) throw new Error('正文读取范围不合法。')
      const end = Math.min(points.length, offset + limit)
      result = {editor_id: id, revision, outcome: 'read', title: Array.from(value.title).slice(0, 1000).join(''),
        content: points.slice(offset, end).join(''), description: Array.from(value.description).slice(0, 16000).join(''),
        offset, next_offset: end < points.length ? end : null, total_chars: points.length,
        ...(proposal ? {proposal_id: proposal.id} : {})}
    } else {
      check(command.editor_id, command.revision)
      if (command.operation === 'summary') {
        if (typeof command.description !== 'string' || Array.from(command.description).length > 16000) throw new Error('摘要长度不合法。')
        const changed = value.description !== command.description
        if (changed) options.applySummary(command.description)
        const applied = current()
        if (applied.description !== command.description) throw new Error('摘要未能应用，请重新读取草稿。')
        result = {editor_id: id, revision, outcome: changed ? 'updated' : 'unchanged',
          description: applied.description,
          ...(proposal ? {proposal_id: proposal.id} : {})}
      } else if (command.operation === 'propose') {
        if (!Array.isArray(command.edits) || !command.edits.length || command.edits.length > 20)
          throw new Error('修改提案需包含 1 至 20 个修改。')
        const edits = command.edits.map(edit => {
          if (typeof edit.old_text !== 'string' || typeof edit.new_text !== 'string'
              || edit.old_text.length + edit.new_text.length > 48000 || edit.old_text === edit.new_text)
            throw new Error('修改内容不合法或没有变化。')
          // Every edit is independently reviewable against the same working copy.
          replaceExact(value.content, edit)
          return {...edit, start: value.content.indexOf(edit.old_text)}
        })
        const ordered = [...edits].sort((a, b) => a.start - b.start)
        if (ordered.some((edit, index) => index > 0 && edit.start < ordered[index - 1].start + ordered[index - 1].old_text.length)
            || (edits.length > 1 && edits.some(edit => !edit.old_text)))
          throw new Error('修改范围重叠，请将同一段的改写合并为一处修改。')
        const candidate = applyRanges(value.content, edits)
        if (Array.from(candidate).length > 1_000_000) throw new Error('草稿超过编辑范围。')
        const next = {id: crypto.randomUUID(), base: value, revision, edits}
        publish(next)
        result = {editor_id: id, revision, outcome: 'proposed', proposal_id: next.id}
      } else throw new Error('未知编辑操作。')
    }
    replies.set(command.command_id, result)
    if (replies.size > 64) replies.delete(replies.keys().next().value!)
    return result
  }
  const accept = (index?: number) => {
    if (!proposal) return
    ready()
    const before = current()
    if (before.content !== proposal.base.content || before.title !== proposal.base.title)
      throw new Error('草稿已变化，请重新生成提案。')
    const selected = index === undefined ? proposal.edits : [proposal.edits[index]]
    if (selected.some(edit => !edit)) throw new Error('修改提案已变化。')
    const after = applyRanges(before.content, selected)
    options.applyBody(after)
    const next = current()
    const remaining = proposal.edits.filter((_, i) => index !== undefined && i !== index)
      .map(edit => ({...edit, start: edit.start + selected.filter(item => item.start < edit.start)
        .reduce((delta, item) => delta + item.new_text.length - item.old_text.length, 0)}))
    publish(remaining.length ? {...proposal, base: next, revision, edits: remaining} : null)
  }
  const reject = (index?: number) => {
    if (!proposal) return
    const remaining = proposal.edits.filter((_, i) => index !== undefined && i !== index)
    publish(remaining.length ? {...proposal, edits: remaining} : null)
  }
  return {execute, accept, reject}
}
