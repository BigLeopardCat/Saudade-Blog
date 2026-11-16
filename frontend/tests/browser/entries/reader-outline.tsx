import '../../../src/index.css'
import '../../../src/frontHome/main.css'
import '../../../src/scene.css'
import '../../../src/frontHome/Content/ReadArticle/index.sass'
import {createRoot} from 'react-dom/client'
import {useState} from 'react'
import {MemoryRouter, useNavigate} from 'react-router-dom'
import ReadingOutline from '../../../src/frontHome/Content/ReadArticle/ReadingOutline'
import {useReaderLayout} from '../../../src/components/Live2dAgent/useReaderLayout'
function Reader() {
    useReaderLayout()
    const navigate = useNavigate()
    const [empty, setEmpty] = useState(false)
    return <div className="frontRoot"><header className="headContainer" style={{position: 'fixed', top: 16, height: 60}}>阅读导航</header>
        <div style={{position: 'fixed', bottom: 0, right: 0, zIndex: 2000}}>
            <button onClick={() => navigate('/')}>返回首页</button><button onClick={() => setEmpty(value => !value)}>切换空目录</button>
            <button onClick={() => {document.getElementById('delayed-image')!.style.height = '480px'}}>图片加载完成</button>
        </div>
        <div className="readContainer"><div className="readContent"><div className="readBody"><div id="content">
            {empty ? <p>没有标题的文章</p> : <><h1>春日手记</h1><div id="delayed-image" style={{height: 40}}/>
                <p style={{height: 600}}>第一节正文</p><h2>沿途风景</h2><p style={{height: 750}}>第二节正文</p>
                <h2>沿途风景</h2><p style={{height: 650}}>第三节正文</p><h2>抵达</h2><p>末节正文</p></>}
            </div></div><div className="navigation"><ReadingOutline sourceKey={String(empty)}/></div></div></div>
        <div style={{height: 900}}>文章评论与页脚</div>
    </div>
}
createRoot(document.getElementById('root')!).render(<MemoryRouter initialEntries={['/article/7']}><Reader/></MemoryRouter>)
