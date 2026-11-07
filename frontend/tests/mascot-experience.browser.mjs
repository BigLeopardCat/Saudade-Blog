// Offline checks against real components and styles. Run with PLAYWRIGHT_MODULE
// and CHROMIUM_EXECUTABLE when using an existing browser install.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile, mkdir} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {build} from 'esbuild';
import {compile} from 'sass';
const root = fileURLToPath(new URL('../', import.meta.url));
const {chromium} = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE) : 'playwright');
const output = process.env.MASCOT_PREVIEW_DIR || '/tmp/saudade-mascot-experience';
const sources = {
  mascot: `import {createRoot} from 'react-dom/client'; import {RouterProvider} from 'react-router-dom'; import {HelmetProvider} from 'react-helmet-async';
    import router from './src/router';
    import './src/index.css';
    document.body.insertAdjacentHTML('beforeend','<div id="waifu">已加载看板娘</div><div id="waifu-toggle">唤回看板娘</div><section id="waifu-chat">已加载聊天</section>');
    createRoot(document.getElementById('root')).render(<HelmetProvider><RouterProvider router={router}/></HelmetProvider>);`,
  editor: `import {createRoot} from 'react-dom/client'; import {useRef,useState} from 'react'; import {Card} from 'antd';
    import Editor from './src/components/Editor'; import Collaboration from './src/components/ArticleCollaboration';
    import './src/pages/Dashboard/index.css'; import './src/pages/Dashboard/Notes/NewNotes/index.sass';
    localStorage.setItem('tokenKey','offline-test');
    function Preview(){const [body,setBody]=useState(Array.from({length:12},(_,i)=>'原始段落 '+i+'。').join('\\n\\n'));
    const ref=useRef(null);return <div className="contain"><div className="content"><Card className="Card"><div className="header">笔记 / 新建文章</div>
    <main className="dashboardPage" aria-label="后台内容"><div className="notes-container"><div className="article-toolbar">离线长差异测试</div>
    <Collaboration title="离线测试" content={body} description="" ready blocked={false} readBody={()=>ref.current?.read()??body}
    onBody={value=>ref.current?.apply(value)} onSummary={()=>{}}/>
    <div className="new_article"><Editor editorRef={ref} noteContent={body} setNoteContent={setBody}/></div>
    <output id="editor-bottom">编辑器底部</output></div></main></Card></div></div>}
    createRoot(document.getElementById('root')).render(<Preview/>);`,
};
const files = {};
for (const [name, contents] of Object.entries(sources)) {
  const result = await build({stdin:{contents,resolveDir:root,loader:'tsx'},bundle:true,write:false,
    outfile:'bundle.js',jsx:'automatic',loader:{'.svg':'dataurl','.png':'dataurl','.woff':'dataurl','.woff2':'dataurl','.ttf':'dataurl','.jpg':'dataurl','.gif':'dataurl','.mp4':'empty'},
    define:{'__SITE_AUTHOR__':'"示例作者"','__SITE_KEYWORDS__':'""','__SITE_URL__':'"https://example.test"','__SITE_TITLE__':'"示例博客"','__SITE_DESCRIPTION__':'"博客简介"','process.env.NODE_ENV':'"production"','import.meta.env':JSON.stringify({BASE_URL:'/',VITE_HTTP_BASEURL:'',MODE:'production'})},
    plugins:[
      // Keep the real route hierarchy and NotFound. Stub only unrelated destinations
      // so this routing regression does not bundle dashboard charts/home media.
      {name:'route-destinations',setup(builder){
        builder.onResolve({filter:/^\./},args=>{
          if(args.importer!==path.join(root,'src/router/index.tsx')||['../components/NotFound','./spaNavigate.ts'].includes(args.path))return;
          return {path:args.path,namespace:'route-fixture'};
        });
        builder.onLoad({filter:/.*/,namespace:'route-fixture'},args=>({loader:'tsx',resolveDir:root,contents:
          args.path==='../App.tsx'?
            `import {Outlet} from 'react-router-dom';export default function App(){return <><header>公共页顶部栏</header><Outlet/><footer>公共页页脚</footer></>}`:
          args.path==='../components/AuthRouter.tsx'?'export const AuthRouter=({children})=>children':
            'export default function Page(){return <h1>测试首页</h1>}'
        }));
      }},
      {name:'sass',setup(builder){builder.onLoad({filter:/\.(sass|scss)$/},args=>({contents:compile(args.path).css,loader:'css',resolveDir:path.dirname(args.path)}))}}
    ]});
  files[`/${name}.js`] = {type:'text/javascript',body:result.outputFiles.find(f=>f.path.endsWith('.js')).text};
  files[`/${name}.css`] = {type:'text/css',body:result.outputFiles.find(f=>f.path.endsWith('.css'))?.text||''};
  files[`/${name}`] = {type:'text/html',body:`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/${name}.css">${name==='mascot'?'':'<style>body{margin:0;background:#fbf6fa;font-family:system-ui,sans-serif}</style>'}<div id="root"></div><script src="/${name}.js"></script>`};
}
files['/'] = files['/mascot'];
let imageBytes = 0;
for (const name of ['neutral','pain','cry','bump-small','bump-medium','bump-large']) {
  const body=await readFile(path.join(root,'public/mascot-404',name+'.webp'));
  imageBytes+=body.length;
  files[`/mascot-404/${name}.webp`] = {type:'image/webp',body};
}
assert.ok(imageBytes<256*1024,`404 image budget exceeded: ${imageBytes} bytes`);
const server=createServer((req,res)=>{const file=files[req.url];if(!file){res.writeHead(404).end();return}res.writeHead(200,{'Content-Type':file.type}).end(file.body)});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin=`http://127.0.0.1:${server.address().port}`;
let browser;
try {
  await mkdir(output,{recursive:true});
  browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_EXECUTABLE?{executablePath:process.env.CHROMIUM_EXECUTABLE}:{}),args:['--no-sandbox']});
  const page=await browser.newPage({viewport:{width:1440,height:1000}});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/*',r=>r.request().url().startsWith(origin+'/')?r.continue():r.abort());
  for(const width of [1440,375]) {
    await page.setViewportSize({width,height:1000});
    await page.goto(origin+'/mascot');
    await page.waitForFunction(()=>document.querySelector('.mascot-error__scene')?.dataset.ready==='true');
    assert.equal(await page.locator('header, footer').count(),0,'404 must not inherit the public layout');
    for (const selector of ['#waifu','#waifu-toggle','#waifu-chat']) assert.equal(await page.locator(selector).isVisible(),false);
    const screen=await page.locator('.mascot-error').boundingBox();
    assert.equal(screen.y,0); assert.equal(screen.height,1000);
    await page.evaluate(()=>{window.impacts=[];new MutationObserver(()=>window.impacts.push(document.querySelectorAll('.mascot-error__bump.is-visible').length)).observe(document.querySelector('.mascot-error__character'),{subtree:true,attributes:true,attributeFilter:['class']})});
    await page.waitForFunction(()=>document.querySelector('.mascot-error__scene')?.dataset.expression==='cry');
    assert.deepEqual(await page.evaluate(()=>[...new Set(window.impacts)].filter(n=>n>0)),[1,2,3]);
    assert.equal(await page.locator('.mascot-error__digit').allTextContents().then(x=>x.join('')),'404');
    assert.equal(await page.locator('.mascot-error__bump.is-visible').count(),3);
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    await page.screenshot({path:path.join(output,`404-${width}.png`),fullPage:true});
    await page.getByRole('button',{name:'再看一次'}).click();
    await page.waitForFunction(()=>document.querySelector('.mascot-error__scene')?.dataset.expression==='neutral');
    await page.waitForFunction(()=>document.querySelector('.mascot-error__scene')?.dataset.expression==='cry');
    await page.getByRole('link',{name:'带她回首页'}).click();
    await page.waitForURL(origin+'/');
    await page.locator('header').waitFor();
    assert.equal(await page.locator('#waifu').isVisible(),true,'leaving 404 restores the existing widget');
    await page.goBack();
    await page.locator('.mascot-error').waitFor();
    assert.equal(await page.locator('header, footer').count(),0,'SPA back navigation also uses the standalone layout');
  }
  await page.emulateMedia({reducedMotion:'reduce'});
  await page.goto(origin+'/mascot');
  await page.waitForFunction(()=>document.querySelector('.mascot-error__scene')?.dataset.ready==='true');
  assert.equal(await page.locator('.mascot-error__scene').getAttribute('data-expression'),'cry');
  assert.equal(await page.getByRole('button',{name:'再看一次'}).count(),0);
  const cold=await browser.newPage({viewport:{width:375,height:1000}});
  const cdp=await cold.context().newCDPSession(cold);
  await cdp.send('Network.enable');
  await cdp.send('Network.setCacheDisabled',{cacheDisabled:true});
  await cdp.send('Network.emulateNetworkConditions',{offline:false,latency:60,downloadThroughput:3_000_000/8,uploadThroughput:3_000_000/8});
  await cold.goto(origin+'/mascot');
  await cold.waitForFunction(()=>document.querySelector('.mascot-error__scene')?.dataset.ready==='true');
  const coldAssets=await cold.evaluate(()=>performance.getEntriesByType('resource').filter(r=>r.name.includes('/mascot-404/')).map(r=>({url:r.name,bytes:r.encodedBodySize,start:r.startTime,end:r.responseEnd})));
  assert.equal(coldAssets.length,6);
  assert.ok(coldAssets.every(r=>r.url.endsWith('.webp')));
  assert.ok(coldAssets.reduce((sum,r)=>sum+r.bytes,0)<256*1024);
  const coldImageMs=Math.round(Math.max(...coldAssets.map(r=>r.end))-Math.min(...coldAssets.map(r=>r.start)));
  await cold.close();
  const stalled=await browser.newPage({viewport:{width:375,height:1000}});
  const heldImages=[];
  stalled.on('pageerror',error=>errors.push(error.message));
  await stalled.route('**/*',route=>{
    const url=route.request().url();
    if(!url.startsWith(origin+'/'))return route.abort();
    // Leave images pending: a failed-fast stub would not exercise this cold-start boundary.
    if(url.startsWith(origin+'/mascot-404/')){heldImages.push(url);return;}
    return route.continue();
  });
  await stalled.goto(origin+'/mascot',{waitUntil:'domcontentloaded'});
  await stalled.getByRole('heading',{name:'呜…页面不见了'}).waitFor({state:'visible',timeout:3000});
  assert.ok(heldImages.length>0,'Cold-image fixture did not hold any request');
  assert.equal(await stalled.locator('.mascot-error__scene').getAttribute('data-ready'),'false');
  assert.equal(await stalled.locator('.mascot-error__digit').allTextContents().then(x=>x.join('')),'404');
  assert.ok(await stalled.locator('.mascot-error__digit').evaluateAll(items=>items.length===3&&items.every(item=>
    getComputedStyle(item).opacity==='1'&&getComputedStyle(item).animationName==='none')));
  await stalled.screenshot({path:path.join(output,'404-stalled-images.png'),fullPage:true});
  await stalled.getByRole('link',{name:'带她回首页'}).click({timeout:3000});
  await stalled.waitForURL(origin+'/',{waitUntil:'domcontentloaded'});
  await stalled.locator('header').waitFor();
  await stalled.close();
  await page.setViewportSize({width:1440,height:900});
  await page.goto(origin+'/editor');
  await page.waitForFunction(()=>!!window.__saudadeArticleEditor);
  await page.evaluate(()=>{const editor=window.__saudadeArticleEditor;const snap=editor.execute({kind:'article_editor',operation:'read',command_id:'read'});
    editor.execute({kind:'article_editor',operation:'propose',command_id:'propose',editor_id:snap.editor_id,revision:snap.revision,
      edits:Array.from({length:12},(_,i)=>({old_text:'原始段落 '+i+'。',new_text:('润色后的段落 '+i+'。\n').repeat(20)}))})});
  assert.equal(await page.locator('.article-review-edit').count(),12);
  assert.ok(await page.locator('.dashboardPage').evaluate(el=>getComputedStyle(el).overflowY==='auto'&&el.scrollHeight>el.clientHeight));
  await page.locator('.dashboardPage').evaluate(el=>el.scrollTop=el.scrollHeight);
  assert.ok(await page.locator('#editor-bottom').evaluate(el=>{const r=el.getBoundingClientRect();const c=el.closest('.dashboardPage').getBoundingClientRect();return r.top>=c.top&&r.bottom<=c.bottom}));
  await page.screenshot({path:path.join(output,'editor-scroll-bottom.png')});
  await page.setViewportSize({width:375,height:900});
  assert.equal(await page.locator('.dashboardPage').evaluate(el=>getComputedStyle(el).overflowY),'visible');
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({passed:['real router: standalone 404, no header/footer, return home and SPA back','404 ordered impacts and crying ending at desktop/mobile sizes','404 replay and reduced motion','3Mbps cold cache: six WebP assets under 256KiB','stalled images: static 404 and return-home link remain usable','long review scroll reaches editor bottom','mobile document flow'],imageBytes,coldImageMs,screenshots:output},null,2));
} finally {await browser?.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve))}
