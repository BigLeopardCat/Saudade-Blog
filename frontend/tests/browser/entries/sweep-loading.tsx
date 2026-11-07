import {useState} from 'react'
import {createRoot} from 'react-dom/client'
import SweepLoading from '../../../src/components/SweepLoading'

function Fixture() {
    const [pending, setPending] = useState(true)
    return <main>
        <button type="button" onClick={() => setPending(false)}>完成加载</button>
        <section aria-label="浅色预览" style={{background: '#fff7fc', width: 180, height: 180,
            display: 'grid', placeItems: 'center'}}>{pending && <SweepLoading/>}</section>
        <section aria-label="深色预览" style={{background: '#241d2f', marginTop: 1600,
            width: 180, height: 180, display: 'grid', placeItems: 'center'}}>
            {pending && <SweepLoading/>}</section>
    </main>
}
createRoot(document.getElementById('root')!).render(<Fixture/>)
