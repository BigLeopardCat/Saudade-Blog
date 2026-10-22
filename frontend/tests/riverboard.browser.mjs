// Run against an isolated Vite dev server. All API requests are intercepted; no production writes.
// PLAYWRIGHT_MODULE_PATH=file:///.../playwright/index.mjs node tests/riverboard.browser.mjs
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');
const out = process.env.RIVER_SCREENSHOTS || '/tmp/riverboard-preview';
await mkdir(out,{recursive:true});
const browser = await chromium.launch({headless:true,args:['--no-sandbox']});
const url = process.env.RIVER_TEST_URL || 'http://127.0.0.1:5174/guestbook';
const rows = Array.from({length:18},(_,i)=>({talkKey:i+1,content:['愿你三冬暖，愿你春不寒。','把今晚的月色，寄给远方的你。','愿世间美好，都与你我不期而遇。'][i%3],cat:['愿','寄','忆'][i%3],v:i%3,author:'渡河人',createTime:'2026-10-22 20:30:00',approved:1}));
const errors=[];
try {
 const context=await browser.newContext({viewport:{width:1440,height:900}});
 await context.addInitScript(()=>{let seed=74621;Math.random=()=>((seed=(Math.imul(seed,1664525)+1013904223)>>>0)/4294967296)});
 const page=await context.newPage();page.setDefaultTimeout(30000);page.on('pageerror',e=>errors.push(e.message));
 let failBoard=false, emptyBoard=false, failPost=true, posts=[];
 await page.route('**/api/**',async route=>{
  const r=route.request(),path=new URL(r.url()).pathname;
  let data=[];let code=200;
  if(path==='/api/public/board') {
   if(r.method()==='POST') {posts.push(r.postDataJSON());data='Pending';if(failPost){code=500;data=null;}}
   else {data=emptyBoard?[]:rows;if(failBoard){code=500;data=null;}}
  } else if(path==='/api/protected/profile') data={nickname:'渡河人'};
  else if(path==='/api/protect/board/mine') data=rows.slice(0,2).map(x=>({...x,mine:true}));
  await route.fulfill({json:{code,data,message:code===200?'ok':'injected failure'}});
 });
 await page.goto(url,{waitUntil:'networkidle',timeout:90000});
 console.log('page mounted', await page.locator('.rz-canvas').evaluate(c=>c.riverStats));
 await page.waitForFunction(()=>document.querySelector('.rz-landscape')?.complete && document.querySelector('.rz-canvas')?.riverStats?.frames>5, null, {timeout:45000});
 await page.waitForTimeout(1000);
 assert.equal(await page.locator('script[src*="boot.js"]').count(),0,'assistant does not start a second renderer on entry');
 const stats=()=>page.locator('.rz-canvas').evaluate(c=>({...c.riverStats}));
 const initial=await stats();assert.equal(initial.fpsLimit,30);assert.ok(initial.backingPixels<600000);
 await page.screenshot({path:out+'/desktop.png'});console.log('desktop captured');
 // Water responds to pointer input without installing another timer / render loop.
 const waterPoint=await page.evaluate(()=>{for(let y=540;y<730;y+=20)for(let x=450;x<1000;x+=20){const el=document.elementFromPoint(x,y);if(el&&!el.closest('.rz-lantern,button,[role=dialog]'))return{x,y}}throw Error('no exposed water in fixture')});
 await page.mouse.click(waterPoint.x,waterPoint.y);assert.equal(await page.getByRole('dialog').count(),0);await page.waitForTimeout(250);await page.screenshot({path:out+'/ripple.png'});
 // Public reading, focus trap, Escape, and paused background.
 await page.getByRole('button',{name:'灯影集',exact:true}).click();
 await page.getByRole('dialog',{name:'灯影集',exact:true}).waitFor();await page.waitForTimeout(120);
 const paused=await stats();assert.equal(paused.paused,true);await page.waitForTimeout(300);assert.equal((await stats()).frames,paused.frames);
 for(let i=0;i<18;i++)await page.keyboard.press('Tab');
 assert.ok(await page.evaluate(()=>!!document.activeElement?.closest('[role="dialog"]')),'Tab remains in dialog');
 await page.screenshot({path:out+'/album.png'});
 await page.keyboard.press('Escape');await page.waitForTimeout(160);assert.equal(await page.getByRole('dialog').count(),0);assert.equal((await stats()).paused,false);
 // Logged-out gate is still enforced.
 await page.getByRole('button',{name:'点一盏河灯',exact:false}).click();await page.getByRole('dialog',{name:'留言板公告'}).waitFor();await page.keyboard.press('Escape');assert.equal(posts.length,0);
 // Full authenticated three-step flow; pending is visibly unlit, never presented as approved.
 await page.evaluate(()=>localStorage.setItem('tokenKey','isolated-fixture-token'));
 await page.getByRole('button',{name:'点一盏河灯',exact:false}).click();
 await page.locator('.rz-lamp-card').nth(1).click();await page.getByRole('button',{name:'下一程'}).click();
 await page.locator('.rz-cat-card').nth(1).click();await page.getByRole('button',{name:'下一程'}).click();
 await page.locator('.rz-wish-input').fill('愿山河无恙，故人安康。');
 await page.getByRole('button',{name:'放下河灯',exact:true}).click();
 await page.getByRole('alert').waitFor();assert.equal(await page.locator('.rz-wish-input').inputValue(),'愿山河无恙，故人安康。');
 failPost=false;await page.getByRole('button',{name:'放下河灯',exact:true}).click();
 await page.getByText('灯已入河',{exact:true}).waitFor();assert.equal(posts.length,2);assert.equal(posts[1].v,1);assert.equal(posts[1].cat,'寄');
 assert.equal(await page.locator('.rz-unlit').count(),1);await page.screenshot({path:out+'/pending.png'});await page.keyboard.press('Escape');
 // User quality changes and reduced-motion changes apply live, without duplicate loops.
 await page.getByRole('button',{name:'静谧',exact:true}).click();await page.waitForTimeout(120);const still=await stats();await page.waitForTimeout(300);assert.equal((await stats()).frames,still.frames);
 await page.getByRole('button',{name:'沉浸',exact:true}).click();await page.emulateMedia({reducedMotion:'reduce'});await page.waitForTimeout(120);const reduced=await stats();await page.waitForTimeout(300);assert.equal((await stats()).frames,reduced.frames);
 await page.emulateMedia({reducedMotion:'no-preference'});
 await page.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,get:()=>true});document.dispatchEvent(new Event('visibilitychange'))});await page.waitForTimeout(100);const hidden=await stats();await page.waitForTimeout(250);assert.equal((await stats()).frames,hidden.frames);
 await page.evaluate(()=>{delete document.hidden;document.dispatchEvent(new Event('visibilitychange'))});await page.waitForTimeout(150);assert.equal((await stats()).paused,false);
 await page.setViewportSize({width:390,height:844});await page.waitForTimeout(350);
 assert.ok(await page.getByRole('button',{name:'点一盏河灯',exact:false}).isVisible());
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,'no horizontal overflow');
 await page.screenshot({path:out+'/mobile.png'});
 await page.setViewportSize({width:844,height:390});await page.waitForTimeout(350);await page.screenshot({path:out+'/landscape.png'});
 assert.ok(await page.getByRole('button',{name:'灯影集',exact:true}).isVisible());
 // Business failures do not silently become empty success or real-looking demo posts.
 failBoard=true;await page.reload({waitUntil:'networkidle'});await page.getByText(/留言加载失败/).waitFor();assert.ok(await page.getByRole('button',{name:'重试',exact:true}).isVisible());
 failBoard=false;emptyBoard=true;await page.getByRole('button',{name:'重试',exact:true}).click();await page.getByText('河上尚无人留灯，愿你是第一位',{exact:true}).waitFor();assert.equal(await page.locator('.rz-lantern').count(),0);
 assert.deepEqual(errors,[]);
 console.log(JSON.stringify({passed:['desktop/portrait/landscape','pointer ripple','public reading','dialog pause/focus/Escape','logged-out gate','failed submit preserves input and retry returns pending','still/reduced-motion/hidden pause and resume','business failure/retry/empty state','no eager assistant','no page errors'],initial},null,2));
 await context.close();
} finally {await browser.close();}
