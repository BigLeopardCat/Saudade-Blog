import '../../../src/index.css'
import '../../../src/components/CommentSection/index.sass'
import {useState} from 'react'
import {createRoot} from 'react-dom/client'
import StickerPicker from '../../../src/components/CommentSection/StickerPicker'

function Preview() {
  const [value, setValue] = useState('')
  return <div className="commentSection" style={{position:'fixed',bottom:8,left:12,width:320,overflow:'hidden'}}>
    <div className="commentForm">
      <output aria-label="已选表情">{value}</output>
      <StickerPicker onPick={name => setValue(`:${name}:`)} />
    </div>
  </div>
}
createRoot(document.getElementById('root')!).render(<Preview />)
