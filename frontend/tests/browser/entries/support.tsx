import {createRoot} from 'react-dom/client'
import {MemoryRouter} from 'react-router-dom'
import Support from '../../../src/pages/Support'
import SupportMode from '../../../src/components/Live2dAgent/SupportMode'

const mode = location.hash
createRoot(document.getElementById('root')!).render(<MemoryRouter>{mode === '#widget' ? <>
  <style>{'#waifu-chat {position:relative;width:420px;height:580px;--drag-h:32px;--drag-w:38px;--chat-paper:#fff;--chat-ink:#31233b;--chat-line:#cab6cf;--chat-accent:#844474;}'}</style>
  <section id="waifu-chat" className="active">
    <div className="chat-messages">原对话记录</div>
    <button id="chat-close" type="button">关闭</button>
    <div data-chat-host-action></div>
    <div data-chat-host-panel></div>
  </section>
  <SupportMode/>
</> : <Support staff={mode === '#staff'}/>}</MemoryRouter>)
