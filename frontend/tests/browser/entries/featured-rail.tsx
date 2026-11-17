import '../../../src/scene.css'
import station from '../../../src/assets/scenes/station-thumb.webp'
import riverside from '../../../src/assets/scenes/riverside-thumb.webp'
import atelier from '../../../src/assets/scenes/atelier-thumb.webp'
import rain from '../../../src/assets/scenes/rain-thumb.webp'
import '../../../src/frontHome/Content/ContentHome/featured.sass'
import {MemoryRouter} from 'react-router-dom'
import {createRoot} from 'react-dom/client'
import {useState} from 'react'
import FeaturedArticles from '../../../src/frontHome/Content/ContentHome/FeaturedArticles'
import ArticleCard from '../../../src/components/ArticleCard'
import CoverCropModal from '../../../src/components/CoverCropModal'
import type {NoteType} from '../../../src/interface/NoteType'
const cover = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300"><rect width="400" height="300" fill="#edc4d6"/><circle cx="100" cy="80" r="40" fill="#fff"/></svg>')
const notes: NoteType[] = Array.from({length: 7}, (_, index) => ({key: String(index + 1), noteKey: String(index + 1),
    noteTitle: `春日手记 ${index + 1}`, description: '车站里的春光，写进日常的片刻。', cover: [station,riverside,atelier,rain][index % 4], categories: '',
    noteTags: [], isTop: true, status: 'public', content: '', authorName: '写作者', authorAvatar: cover,
    createTime: new Date('2026-11-01'), updateTime: new Date('2026-11-02'), views: 12, likes: 3}))
function Fixture() {
    const [open, setOpen] = useState(false)
    const [items, setItems] = useState(notes)
    return <div className="frontRoot" style={{minHeight: '150vh', paddingTop: 120}}>
        <div style={{width: 'min(1120px, 92%)', margin: 'auto'}}>
            <FeaturedArticles items={items} categories={[]} tags={[]} name="" avatar=""/>
            <div style={{marginTop: 80, width: 'min(360px, 100%)'}} data-testid="ordinary-card"><ArticleCard item={notes[0]}/></div>
        </div>
        <div style={{position: 'fixed', bottom: 0, right: 0}}>
            <button onClick={() => setOpen(true)}>预览实际卡片</button>
            <button onClick={() => setItems(notes.slice(0,1))}>只显示一篇</button>
            <button onClick={() => setItems(items.length ? [] : notes)}>切换空列表</button>
            <button onClick={() => {document.documentElement.dataset.sceneDark = document.documentElement.dataset.sceneDark === 'true' ? 'false' : 'true'}}>切换昼夜</button>
        </div>
        <CoverCropModal open={open} src={notes[0].cover} article={notes[0]} onCancel={() => setOpen(false)} onConfirm={() => setOpen(false)}/>
    </div>
}
document.documentElement.dataset.scene = 'station'
createRoot(document.getElementById('root')!).render(<MemoryRouter><Fixture/></MemoryRouter>);
