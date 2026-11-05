import {useRef, useState} from 'react'
import {createRoot} from 'react-dom/client'
import ArticleCollaboration from '../../../src/components/ArticleCollaboration'
import Editor, {type EditorHandle} from '../../../src/components/Editor'

localStorage.setItem('tokenKey', 'offline-editor-fixture')
function Preview() {
  const [content, setContent] = useState('# 第一节\n\n原始正文。\n\n第二节正文。')
  const [description, setDescription] = useState('')
  const editor = useRef<EditorHandle>(null)
  return <>
    <ArticleCollaboration title="协作草稿" content={content} description={description} ready blocked={false}
      readBody={() => editor.current?.read() ?? content}
      onBody={next => editor.current?.apply(next)} onSummary={setDescription}/>
    <Editor editorRef={editor} noteContent={content} setNoteContent={setContent}/>
    <output aria-label="文章摘要概述">{description}</output>
    <output aria-label="草稿正文">{content}</output>
  </>
}
createRoot(document.getElementById('root')!).render(<Preview/>)
