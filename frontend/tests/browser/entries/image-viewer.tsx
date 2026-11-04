import {createRoot} from 'react-dom/client'
import Live2dAgent from '../../../src/components/Live2dAgent'

// Mount the actual dashboard agent entry without fetching external widget assets.
;(window as Window & {__agentChatInjected?: boolean}).__agentChatInjected = true
const pictures = [[4096,1024], [1024,4096], [1024,20000]]
createRoot(document.getElementById('root')!).render(<>
  <Live2dAgent/>
  {pictures.map(([width,height],index) => <img key={index} alt={`图片${index}`}
    style={{width:80,height:80,objectFit:'contain'}}
    src={'data:image/svg+xml,'+encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="#b9a8d9"/></svg>`)}
    onClick={event => window.__openZoomOverlay?.(event.currentTarget)}/>) }
</>)
