// Run against an isolated Vite dev server. All API requests are intercepted; no production writes.
// PLAYWRIGHT_MODULE_PATH=file:///.../playwright/index.mjs node tests/riverboard.browser.mjs
import assert from 'node:assert/strict';
import { mkdir, rename } from 'node:fs/promises';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');
const out = process.env.RIVER_SCREENSHOTS || '/tmp/riverboard-preview';
await mkdir(out,{recursive:true});
const browser = await chromium.launch({headless:true,args:['--no-sandbox','--enable-unsafe-swiftshader','--use-angle=swiftshader']});
const url = process.env.RIVER_TEST_URL || 'http://127.0.0.1:5174/guestbook';
const rows = Array.from({length:18},(_,i)=>({talkKey:i+1,content:['愿你三冬暖，愿你春不寒。','把今晚的月色，寄给远方的你。','愿世间美好，都与你我不期而遇。'][i%3],cat:['愿','寄','忆'][i%3],v:i%3,author:'渡河人',createTime:'2026-10-22 20:30:00',approved:1}));
const errors=[];
try {
 const context=await browser.newContext({viewport:{width:1440,height:900},locale:'zh-CN',timezoneId:'Asia/Shanghai'});
 await context.addInitScript(()=>{if(location.protocol==='http:'||location.protocol==='https:')localStorage.setItem('river-quality','still');let seed=74621;Math.random=()=>((seed=(Math.imul(seed,1664525)+1013904223)>>>0)/4294967296)});
 await context.route('**/*',route=>new URL(route.request().url()).origin===new URL(url).origin?route.continue():route.abort('blockedbyclient'));
 const page=await context.newPage();page.setDefaultTimeout(30000);page.on('pageerror',e=>errors.push(e.message));
 let failBoard=false, emptyBoard=false, failPost=true, posts=[];
 const routeAPI=async route=>{
  const r=route.request(),path=new URL(r.url()).pathname;
  let data=[];let code=200;
  if(path==='/api/public/board') {
   if(r.method()==='POST') {posts.push(r.postDataJSON());data='Pending';if(failPost){code=500;data=null;}}
   else {data=emptyBoard?[]:rows;if(failBoard){code=500;data=null;}}
  } else if(path==='/api/protected/profile') data={nickname:'渡河人'};
  else if(path==='/api/protect/board/mine') data=rows.slice(0,2).map(x=>({...x,mine:true}));
  await route.fulfill({json:{code,data,message:code===200?'ok':'injected failure'}});
 };
 await page.route('**/api/**',routeAPI);
 if(process.env.RIVER_RECORD_ONLY!=='1') {
 await page.goto(url,{waitUntil:'networkidle',timeout:90000});
 assert.equal(await page.locator('vite-error-overlay').count(),0,'Vite must compile the actual route without an error overlay');
 console.log('page mounted', await page.locator('.rz-canvas').evaluate(c=>c.riverStats));
 await page.waitForFunction(()=>document.querySelector('.rz-landscape')?.complete && document.querySelector('.rz-canvas')?.riverStats?.frames>5, null, {timeout:45000});
 await page.waitForTimeout(1000);
 assert.equal(await page.locator('script[src*="boot.js"]').count(),0,'assistant does not start a second renderer on entry');
 const stats=()=>page.locator('.rz-canvas').evaluate(c=>({...c.riverStats}));
 const initial=await stats();assert.equal(initial.fpsLimit,45);assert.ok(initial.backingPixels>0 && initial.backingPixels<1440*900);assert.equal(initial.renderer,'river-refraction');
 assert.equal(await page.locator('.rz-quality').count(),0);assert.equal(await page.getByRole('button',{name:'返回博客',exact:true}).textContent(),'返回博客');
 await page.screenshot({path:out+'/desktop.png'});console.log('desktop captured');
 // Water responds to pointer input without installing another timer / render loop.
 const waterPoint=await page.evaluate(()=>{for(let y=540;y<730;y+=20)for(let x=450;x<1000;x+=20){const el=document.elementFromPoint(x,y);if(el&&!el.closest('.rz-lantern,button,[role=dialog]'))return{x,y}}throw Error('no exposed water in fixture')});
 await page.mouse.click(waterPoint.x,waterPoint.y);assert.equal(await page.getByRole('dialog').count(),0);await page.waitForTimeout(250);await page.screenshot({path:out+'/ripple.png'});
 // Public reading, focus trap, Escape, and paused background.
 await page.getByRole('button',{name:'灯影集',exact:true}).click();
 await page.getByRole('dialog',{name:'灯影集',exact:true}).waitFor();await page.waitForTimeout(120);
 const paused=await stats();assert.equal(paused.paused,true);await page.waitForTimeout(300);assert.equal((await stats()).frames,paused.frames);
 const focusTargets=page.getByRole('dialog',{name:'灯影集',exact:true}).locator('button:not(:disabled),input,textarea,select,[tabindex="0"]');
 await focusTargets.last().focus();await page.keyboard.press('Tab');assert.equal(await focusTargets.first().evaluate(el=>el===document.activeElement),true,'Tab wraps to the first dialog control');
 await page.keyboard.press('Shift+Tab');assert.equal(await focusTargets.last().evaluate(el=>el===document.activeElement),true,'Shift+Tab wraps to the last dialog control');
 assert.ok(await page.evaluate(()=>!!document.activeElement?.closest('[role="dialog"]')),'Tab remains in dialog');
 assert.equal(await page.locator('.rz-root').evaluate(root=>root.scrollTop),0,'focus scroll must stay inside the album list');
 const albumBounds=await page.locator('.rz-album-box').boundingBox();assert.ok(albumBounds && albumBounds.y>=0 && albumBounds.y+albumBounds.height<=901,'album dialog stays in viewport after keyboard navigation');
 await page.screenshot({path:out+'/album.png'});console.log('album keyboard and viewport checked');
 await page.keyboard.press('Escape');await page.waitForTimeout(160);assert.equal(await page.getByRole('dialog').count(),0);assert.equal((await stats()).paused,false);
 // Logged-out gate is still enforced.
 await page.getByRole('button',{name:'点一盏河灯',exact:false}).click();await page.getByRole('dialog',{name:'留言板公告'}).waitFor();await page.keyboard.press('Escape');assert.equal(posts.length,0);console.log('logged-out gate checked');
 // Full authenticated three-step flow; pending is visibly unlit, never presented as approved.
 await page.evaluate(()=>localStorage.setItem('tokenKey','isolated-fixture-token'));
 await page.getByRole('button',{name:'点一盏河灯',exact:false}).click();
 await page.locator('.rz-lamp-card').nth(1).click();await page.screenshot({path:out+'/choose-lamp.png'});await page.getByRole('button',{name:'下一程'}).click();
 await page.locator('.rz-cat-card').nth(1).click();await page.getByRole('button',{name:'下一程'}).click();
 console.log('wish writing step ready');await page.locator('.rz-wish-input').fill('愿山河无恙，故人安康。');
 await page.getByRole('button',{name:'放下河灯',exact:true}).click();
 await page.getByRole('alert').waitFor();await page.screenshot({path:out+'/wish-writing.png'});assert.equal(await page.locator('.rz-wish-input').inputValue(),'愿山河无恙，故人安康。');
 failPost=false;await page.getByRole('button',{name:'放下河灯',exact:true}).click();
 await page.getByText('灯已入河',{exact:true}).waitFor();assert.equal(posts.length,2);assert.equal(posts[1].v,1);assert.equal(posts[1].cat,'寄');
 assert.equal(await page.locator('.rz-unlit').count(),1);await page.screenshot({path:out+'/pending.png'});console.log('failed write and pending retry checked');await page.keyboard.press('Escape');
 // The single atmosphere mode respects the OS motion preference live.
 await page.emulateMedia({reducedMotion:'reduce'});await page.waitForFunction(()=>document.querySelector('.rz-canvas')?.riverStats?.fpsLimit===0 && document.querySelector('.rz-canvas')?.riverStats?.paused);const reduced=await stats();await page.waitForTimeout(300);assert.equal((await stats()).frames,reduced.frames);
 await page.emulateMedia({reducedMotion:'no-preference'});
 await page.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,get:()=>true});document.dispatchEvent(new Event('visibilitychange'))});await page.waitForTimeout(100);const hidden=await stats();await page.waitForTimeout(250);assert.equal((await stats()).frames,hidden.frames);
 await page.evaluate(()=>{delete document.hidden;document.dispatchEvent(new Event('visibilitychange'))});await page.waitForTimeout(150);assert.equal((await stats()).paused,false);
 await page.setViewportSize({width:390,height:844});await page.waitForTimeout(350);
 assert.ok(await page.getByRole('button',{name:'点一盏河灯',exact:false}).isVisible());
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,'no horizontal overflow');
 await page.screenshot({path:out+'/mobile.png'});
 await page.setViewportSize({width:844,height:390});await page.waitForTimeout(350);await page.screenshot({path:out+'/landscape.png'});
 assert.ok(await page.getByRole('button',{name:'灯影集',exact:true}).isVisible());
 console.log('motion lifecycle and viewports checked');
 // Business failures do not silently become empty success or real-looking demo posts.
 failBoard=true;await page.reload({waitUntil:'networkidle'});await page.getByText(/留言加载失败/).waitFor();assert.ok(await page.getByRole('button',{name:'重试',exact:true}).isVisible());
 failBoard=false;emptyBoard=true;await page.getByRole('button',{name:'重试',exact:true}).click();await page.getByText('河上尚无人留灯，愿你是第一位',{exact:true}).waitFor();assert.equal(await page.locator('.rz-lantern').count(),0);
 assert.deepEqual(errors,[]);
 console.log(JSON.stringify({passed:['desktop/portrait/landscape','pointer ripple','public reading','dialog pause/focus/Escape','logged-out gate','failed submit preserves input and retry returns pending','single atmosphere mode ignores old quality preferences; reduced-motion/hidden pause and resume','business failure/retry/empty state','no eager assistant','no page errors'],initial},null,2));
 }
 // A short real-browser recording documents the movement; it is not a GPU benchmark.
 if(process.env.RIVER_RECORD==='1') {
  await page.goto('about:blank');
  failBoard=false;emptyBoard=false;
  const videoContext=await browser.newContext({viewport:{width:1280,height:800},locale:'zh-CN',timezoneId:'Asia/Shanghai',recordVideo:{dir:out+'/recordings',size:{width:1280,height:800}}});
  await videoContext.route('**/*',route=>new URL(route.request().url()).origin===new URL(url).origin?route.continue():route.abort('blockedbyclient'));
  const videoPage=await videoContext.newPage();videoPage.on('pageerror',error=>errors.push(error.message));await videoPage.route('**/api/**',routeAPI);
  await videoPage.goto(url,{waitUntil:'networkidle'});
  await videoPage.waitForFunction(()=>document.querySelector('.rz-canvas')?.riverStats?.frames>10);
  await videoPage.waitForTimeout(1800);
  await videoPage.mouse.move(450,500);await videoPage.mouse.move(900,560,{steps:16});
  const clearWater=await videoPage.evaluate(()=>{for(let y=470;y<640;y+=20)for(let x=450;x<1000;x+=20){const el=document.elementFromPoint(x,y);if(el&&!el.closest('.rz-lantern,button,[role=dialog]'))return{x,y}}throw Error('no exposed water for recording')});
  await videoPage.mouse.click(clearWater.x,clearWater.y);await videoPage.waitForTimeout(1400);
  if(await videoPage.getByRole('dialog').count())await videoPage.keyboard.press('Escape');
  await videoPage.getByRole('button',{name:'灯影集',exact:true}).click();await videoPage.waitForTimeout(1200);
  const video=videoPage.video();await videoContext.close();if(video)await rename(await video.path(),out+'/river-atmosphere.webm');
  assert.deepEqual(errors,[]);console.log('atmosphere recording saved');
 }
 await context.close();
} finally {await browser.close();}
