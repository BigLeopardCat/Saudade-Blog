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
  mascot: `import {createRoot} from 'react-dom/client'; import {MemoryRouter} from 'react-router-dom';
    import NotFound from './src/components/NotFound';
    createRoot(document.getElementById('root')).render(<MemoryRouter><NotFound/></MemoryRouter>);`,
  editor: `import {createRoot} from 'react-dom/client'; import {useRef,useState} from 'react'; import {Card} from 'antd';
    import Editor from './src/components/Editor'; import Collaboration from './src/components/ArticleCollaboration';
    import './src/pages/Dashboard/index.css'; import './src/pages/Dashboard/Notes/NewNotes/index.sass';
    localStorage.setItem('tokenKey','offline-test');
    function Preview(){const [body,setBody]=useState(Array.from({length:12},(_,i)=>'原始段落 '+i+'。').join('\\n\\n'));
    const ref=useRef(null);return <div className="contain"><div className="content"><Card className="Card"><div className="header">笔记 / 新建文章</div>
    <div className="notes-container"><div className="article_title">文章标题：离线长差异测试</div>
    <Collaboration title="离线测试" content={body} description="" ready blocked={false} readBody={()=>ref.current?.read()??body}
    onBody={value=>ref.current?.apply(value)} onSummary={()=>{}}/>
    <div className="new_article"><Editor editorRef={ref} noteContent={body} setNoteContent={setBody}/></div>
    <output id="editor-bottom">编辑器底部</output></div></Card></div></div>}
    createRoot(document.getElementById('root')).render(<Preview/>);`,
};
const files = {};
for (const [name, contents] of Object.entries(sources)) {
  const result = await build({stdin:{contents,resolveDir:root,loader:'tsx'},bundle:true,write:false,
    outfile:'bundle.js',jsx:'automatic',loader:{'.svg':'dataurl','.png':'dataurl','.woff':'dataurl','.woff2':'dataurl','.ttf':'dataurl','.jpg':'dataurl','.gif':'dataurl','.mp4':'empty'},
    define:{'process.env.NODE_ENV':'"production"','import.meta.env':JSON.stringify({BASE_URL:'/',VITE_HTTP_BASEURL:'',MODE:'production'})},
    plugins:[{name:'sass',setup(builder){builder.onLoad({filter:/\.(sass|scss)$/},args=>({contents:compile(args.path).css,loader:'css',resolveDir:path.dirname(args.path)}))}}]});
  files[`/${name}.js`] = {type:'text/javascript',body:result.outputFiles.find(f=>f.path.endsWith('.js')).text};
  files[`/${name}.css`] = {type:'text/css',body:result.outputFiles.find(f=>f.path.endsWith('.css'))?.text||''};
  files[`/${name}`] = {type:'text/html',body:`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/${name}.css"><style>body{margin:0;background:#fbf6fa;font-family:system-ui,sans-serif}</style><div id="root"></div><script src="/${name}.js"></script>`};
}
for (const name of ['neutral','pain','cry','bump-small','bump-medium','bump-large'])
  files[`/mascot-404/${name}.png`] = {type:'image/png',body:await readFile(path.join(root,'public/mascot-404',name+'.png'))};
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
  }
  await page.emulateMedia({reducedMotion:'reduce'});
  await page.goto(origin+'/mascot');
  await page.waitForFunction(()=>document.querySelector('.mascot-error__scene')?.dataset.ready==='true');
  assert.equal(await page.locator('.mascot-error__scene').getAttribute('data-expression'),'cry');
  assert.equal(await page.getByRole('button',{name:'再看一次'}).count(),0);
  await page.setViewportSize({width:1440,height:900});
  await page.goto(origin+'/editor');
  await page.waitForFunction(()=>!!window.__saudadeArticleEditor);
  await page.evaluate(()=>{const editor=window.__saudadeArticleEditor;const snap=editor.execute({kind:'article_editor',operation:'read',command_id:'read'});
    editor.execute({kind:'article_editor',operation:'propose',command_id:'propose',editor_id:snap.editor_id,revision:snap.revision,
      edits:Array.from({length:12},(_,i)=>({old_text:'原始段落 '+i+'。',new_text:('润色后的段落 '+i+'。\n').repeat(20)}))})});
  assert.equal(await page.locator('.article-review-edit').count(),12);
  assert.ok(await page.locator('.Card').evaluate(el=>getComputedStyle(el).overflowY==='auto'&&el.scrollHeight>el.clientHeight));
  await page.locator('.Card').evaluate(el=>el.scrollTop=el.scrollHeight);
  assert.ok(await page.locator('#editor-bottom').evaluate(el=>{const r=el.getBoundingClientRect();const c=el.closest('.Card').getBoundingClientRect();return r.top>=c.top&&r.bottom<=c.bottom}));
  await page.screenshot({path:path.join(output,'editor-scroll-bottom.png')});
  await page.setViewportSize({width:375,height:900});
  assert.equal(await page.locator('.Card').evaluate(el=>getComputedStyle(el).overflowY),'visible');
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({passed:['404 ordered impacts and crying ending at desktop/mobile sizes','404 replay and reduced motion','long review scroll reaches editor bottom','mobile document flow'],screenshots:output},null,2));
} finally {await browser?.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve))}
