import {useState} from 'react'
import {createRoot} from 'react-dom/client'
import AssetImage from '../../../src/components/AssetImage'
import '../../../src/utils/report'

function Fixture() {
    const [source, setSource] = useState('https://images.example/api/image_review/test?token=PRIVATE_REVIEW_TOKEN#PRIVATE_FRAGMENT')
    return <>
        <div style={{width: 335, height: 180}}>
            <AssetImage src={source} alt="测试封面" pending={<span role="status">图片加载中</span>}/>
        </div>
        <button onClick={() => setSource('/second.svg')}>更换图片</button>
        <button onClick={() => setSource('')}>移除图片</button>
    </>
}
createRoot(document.getElementById('root')!).render(<Fixture/>)
