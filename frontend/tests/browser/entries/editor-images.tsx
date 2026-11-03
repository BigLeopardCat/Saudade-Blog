import {useState} from 'react'
import {createRoot} from 'react-dom/client'
import NoteEditor from '../../../src/components/Editor'
import {GALLERY_PAGE_SIZE} from '../../../src/apis/ImageMethods'

function Fixture() {
  const [content, setContent] = useState('')
  return <div style={{width: 1200}}>
    <NoteEditor noteContent={content} setNoteContent={setContent}/>
    <output aria-label="草稿状态">{content}</output>
    <output aria-label="图库页大小">{GALLERY_PAGE_SIZE}</output>
  </div>
}

createRoot(document.getElementById('root')!).render(<Fixture/>)
