import {createRoot} from 'react-dom/client'
import Article from '../../../src/frontHome/Content/ContentHome/Article'
import type {NoteType} from '../../../src/interface/NoteType'
import type {CategoriesType} from '../../../src/interface/CategoriesType'
import '../../../src/frontHome/main.css'
import '../../../src/frontHome/Content/ContentHome/index.sass'

const shapes: [string, string, number][] = [
    ['短标题', ' ', 0],
    ['图谱文档', '一段简短介绍', 3],
    ['异步并发：进程、线程、协程、任务与事件循环', '正文简介。'.repeat(20), 6],
    ['设备接入指南', '另一段介绍', 0],
    ['博客智能助手架构文档', '架构与工具说明'.repeat(8), 10],
    ['版本管理', ' ', 2],
]
const tags = Array.from({length: 10}, (_, tagKey) => ({tagKey: tagKey + 1,
    title: `标签${tagKey + 1}`, color: '#735b91', children: []}))
const categories: CategoriesType[] = [{categoryKey: 1, key: 1, categoryTitle: '编程随笔',
    pathName: '', introduce: '', icon: '', noteCount: 12, color: '#735b91'}]
const stamp = new Date('2026-01-01T00:00:00Z')
const pendingCover = location.hash === '#loading-cover'
createRoot(document.getElementById('root')!).render(<div className="ContentContainer">
    <div className="allArticles">{Array.from({length: pendingCover ? 1 : 12}, (_, index) => {
        const [noteTitle, description, n] = shapes[index % shapes.length]
        const item: NoteType = {key: String(index), noteKey: String(index), noteCategory: '1',
            noteTitle, description, noteTags: tags.slice(0, n).map(tag => tag.tagKey),
            cover: pendingCover ? '/fixture/card-cover.svg' : '', createTime: stamp, updateTime: stamp, categories: '', isTop: false,
            content: '', status: 'public', authorName: '示例作者', authorAvatar: '',
            views: 128, likes: 36, favorites: 12, comments: 4}
        return <Article key={item.key} item={item} index={index} Categories={categories}
            tagList={tags} avatar="" name="示例作者" enter={false}/>
    })}</div>
</div>)
