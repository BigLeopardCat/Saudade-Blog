import {useState} from 'react'
import {createRoot} from 'react-dom/client'
import {Provider} from 'react-redux'
import store from '../../../src/store'
import NoteEditor from '../../../src/components/Editor'

function Preview() {
  const [content, setContent] = useState('# 编辑预览\n\n正文与 **强调**。\n\n[链接](https://example.com)\n\n`const value = 1`')
  return <>
    <div className="markdown-body" data-testid="outside-preview">文章页画布</div>
    <NoteEditor noteContent={content} setNoteContent={setContent}/>
  </>
}

createRoot(document.getElementById('root')!).render(<Provider store={store}><Preview/></Provider>)
