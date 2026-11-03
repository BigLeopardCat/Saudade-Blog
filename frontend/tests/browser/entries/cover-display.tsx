import {useState} from 'react'
import {createRoot} from 'react-dom/client'
import CoverCropModal from '../../../src/components/CoverCropModal'
import {COMPLETE_COVER, coverCropStyle, type CoverCrop} from '../../../src/utils/coverCrop'

const portrait = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="300" height="900"><rect width="300" height="900" fill="pink"/><text x="10" y="30">TOP</text><text x="10" y="880">BOTTOM</text></svg>')
function Fixture() {
    const [source, setSource] = useState(portrait)
    const [open, setOpen] = useState(true)
    const [value, setValue] = useState<CoverCrop>(COMPLETE_COVER)
    return <>
        <button onClick={() => setOpen(true)}>调整封面</button>
        <button onClick={() => {setSource('data:image/png;base64,AA=='); setOpen(true)}}>使用损坏图片</button>
        <div style={{width: 'min(100%, 600px)', aspectRatio: '16/9', background: '#eee'}}>
            <img alt="保存的文章封面" src={source} style={{width: '100%', height: '100%', objectFit: 'cover', ...coverCropStyle(value)}}/>
        </div>
        <output aria-label="封面设置">{JSON.stringify(value)}</output>
        <CoverCropModal open={open} src={source} initialCard={value} onCancel={() => setOpen(false)}
            onConfirm={result => {setValue(result.card); setOpen(false)}}/>
    </>
}
createRoot(document.getElementById('root')!).render(<Fixture/>)
