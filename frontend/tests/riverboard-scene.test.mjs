import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { rm } from 'node:fs/promises';
import { mkdtempSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL, fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = mkdtempSync(path.join(tmpdir(), 'river-scene-'));
try {
    const outfile = path.join(dir, 'budget.mjs');
    await build({ entryPoints: [path.join(root, 'src/pages/RiverBoard/sceneBudget.ts')], outfile, bundle: true, platform: 'node', format: 'esm' });
    const { sceneBudget, coverCrop, createSceneLoop, WATER_TOP } = await import(pathToFileURL(outfile));
    for (const [w,h] of [[390,844],[1440,900],[1920,1080],[3840,2160]]) {
        const b = sceneBudget(w,h,'cinematic');
        assert.ok(b.width <= 1600 && b.width*b.height <= 1600*900, '4K/retina cannot expand backing store without bounds');
        assert.equal(b.fps,45);
        assert.equal(WATER_TOP,.54,'dynamic water starts below the shoreline, leaving mountains untouched');
        assert.equal(b.width,Math.min(w,1600),'native resolution until the bounded wide-screen limit');
        assert.equal(b.height,Math.round(h*.46*Math.min(1,1600/w)),'water backing geometry matches the 54% top / 46% surface');
        assert.equal(sceneBudget(w,h,'still').fps,0);
        assert.equal(sceneBudget(w,h,'still').width,b.width,'reduced motion preserves surface detail');
        const crop = coverCrop(1672,941,w,h);
        assert.ok(crop.x >= 0 && crop.y >= 0);
        assert.ok(crop.x+crop.width <= 1672.001 && crop.y+crop.height <= 941.001);
        assert.ok(Math.abs(crop.width/crop.height-w/h) < 1e-8, 'water and background use identical cover geometry');
    }
    let time=0, id=0; const pending=new Map(); const deltas=[];
    const host={ now:()=>time, request:fn=>{pending.set(++id,{at:time+1000/144, fn});return id}, cancel:i=>pending.delete(i), delay:(fn,ms)=>{pending.set(++id,{at:time+ms,fn});return id}, clearDelay:i=>pending.delete(i) };
    const advance=ms=>{const end=time+ms;while(pending.size){const [key,event]=[...pending].sort((a,b)=>a[1].at-b[1].at)[0];if(event.at>end)break;time=event.at;pending.delete(key);event.fn(time)}time=end};
    const loop=createSceneLoop(host,dt=>deltas.push(dt));
    loop.setRunning(true,45);advance(1000);
    assert.ok(deltas.length>=44 && deltas.length<=46, '144Hz host does not draw 144 times a second');
    assert.equal(pending.size,1,'single timer/rAF chain');
    const frames=deltas.length;loop.setRunning(false,45);assert.equal(pending.size,0);advance(60000);assert.equal(deltas.length,frames,'hidden/dialog pause draws nothing');
    loop.setRunning(true,45);advance(30);assert.ok(deltas.at(-1)<0.05,'resume does not integrate a minute of hidden time');
    loop.setRunning(true,0);assert.equal(pending.size,0,'still quality has no timer');
    loop.setRunning(true,45);loop.setRunning(true,45);assert.equal(pending.size,1,'repeated start cannot double the loop');
    loop.dispose();assert.equal(pending.size,0,'unmount cancels all pending work');
    const disposedFrames=deltas.length;advance(60000);assert.equal(deltas.length,disposedFrames,'disposed renderer never restarts itself');
    console.log('riverboard scene: geometry, pixel budgets, 144Hz pacing, pause/resume, still mode and disposal passed');
} finally { await rm(dir,{recursive:true,force:true}); }
