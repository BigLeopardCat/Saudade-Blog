import {useState} from 'react'
import {createRoot} from 'react-dom/client'
import NoteEditor from '../../../src/components/Editor'
import {Provider} from 'react-redux'
import store from '../../../src/store'

function Fixture() {
  const [content, setContent] = useState('')
  return <div style={{width: 1200}}>
    <NoteEditor noteContent={content} setNoteContent={setContent}/>
    <output aria-label="草稿状态">{content}</output>
  </div>
}

createRoot(document.getElementById('root')!).render(<Provider store={store}><Fixture/></Provider>)
