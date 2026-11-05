import {useEffect, useRef, useState} from 'react'
import {Alert, Button, message} from 'antd'
import {diffLines} from 'diff'
import getToken from '../../apis/getToken'
import {createEditorSession, type EditorCommand, type Proposal, type WorkingCopy} from './session'
import './index.css'

declare global {
  interface Window {
    __saudadeArticleEditor?: {execute: ReturnType<typeof createEditorSession>['execute']}
  }
}

type Props = WorkingCopy & {ready: boolean; blocked: boolean;
  readBody: () => string;
  onBody: (content: string) => void; onSummary: (summary: string) => void;
  onTitle?: (title: string) => void; onPreparePublish?: () => void}

export default function ArticleCollaboration(props: Props) {
  const latest = useRef(props)
  latest.current = props
  const [proposal, setProposal] = useState<Proposal | null>(null)
  const session = useRef<ReturnType<typeof createEditorSession> | null>(null)
  useEffect(() => {
    const token = getToken()
    const selected = createEditorSession({
      read: () => ({title: latest.current.title, description: latest.current.description,
        content: latest.current.readBody()}),
      enabled: () => latest.current.ready && !latest.current.blocked && !!token && token === getToken(),
      applyBody: content => {
        latest.current.onBody(content)
        latest.current = {...latest.current, content}
      },
      applySummary: description => {
        latest.current.onSummary(description)
        latest.current = {...latest.current, description}
      },
      applyTitle: title => {
        if (!latest.current.onTitle) throw new Error('当前编辑器不支持标题修改')
        latest.current.onTitle(title)
        latest.current = {...latest.current, title}
      },
      preparePublish: () => {
        if (!latest.current.onPreparePublish) throw new Error('当前编辑器不支持发布确认')
        latest.current.onPreparePublish()
      },
      onProposal: setProposal,
    })
    session.current = selected
    const bridge = {execute: (command: EditorCommand) => selected.execute(command)}
    window.__saudadeArticleEditor = bridge
    return () => {
      if (window.__saudadeArticleEditor === bridge) delete window.__saudadeArticleEditor
      session.current = null
    }
  }, [])
  const review = (action: () => void) => {
    try { action() } catch (e) { void message.warning(e instanceof Error ? e.message : '修改未应用') }
  }
  const stale = proposal && (proposal.base.content !== props.content
    || proposal.base.title !== props.title)
  return <section hidden={!proposal} className="article-collaboration" aria-label="文章协作编辑">
    {proposal && <section className="article-review" aria-label="正文修改建议">
      <div className="article-review-toolbar">
        <strong>{proposal.title !== undefined ? '文章修改建议' : '正文修改建议'} · {proposal.edits.length + Number(proposal.title !== undefined)} 处</strong>
        <span><Button disabled={!!stale || props.blocked} type="primary"
          onClick={() => review(() => session.current?.accept())}>全部采纳</Button>
          <Button onClick={() => session.current?.reject()}>全部放弃</Button></span>
      </div>
      {stale && <Alert type="warning" showIcon message="草稿已变化，请让助手读取当前内容后重新修改。你的输入已保留。"/>}
      <p className="article-review-legend"><del>删除</del> <ins>新增</ins> · 采纳后保存到草稿，发布由你决定</p>
      {proposal.title !== undefined && <article className="article-review-edit">
        <strong>文章标题</strong>
        <pre aria-label="标题修改"><del>{proposal.base.title}</del><ins>{proposal.title}</ins></pre>
        <div className="article-review-actions">
          <Button size="small" disabled={!!stale || props.blocked}
            onClick={() => review(() => session.current?.accept('title'))}>采纳标题</Button>
          <Button size="small" onClick={() => session.current?.reject('title')}>放弃标题</Button>
        </div>
      </article>}
      {proposal.edits.map((edit, index) => <article className="article-review-edit" key={`${proposal.id}-${index}`}>
        <pre aria-label={`第 ${index + 1} 处修改`}>
          {diffLines(edit.old_text, edit.new_text, {timeout: 100, maxEditLength: 2000})?.map((part, i) => {
            const content = part.value
            return part.added ? <ins key={i}>{content}</ins> : part.removed ? <del key={i}>{content}</del> : <span key={i}>{content}</span>
          }) ?? <><del>{edit.old_text}</del><ins>{edit.new_text}</ins></>}
        </pre>
        <div className="article-review-actions">
          <Button size="small" disabled={!!stale || props.blocked}
            onClick={() => review(() => session.current?.accept(index))}>采纳此处</Button>
          <Button size="small" onClick={() => session.current?.reject(index)}>放弃此处</Button>
        </div>
      </article>)}
    </section>}
  </section>
}
