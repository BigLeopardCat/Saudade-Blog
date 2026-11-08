import {test,expect} from './sandbox'

const picture='<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"><rect width="200" height="100" fill="pink"/></svg>'
const deferred=()=>{
    let release!:()=>void
    const ready=new Promise<void>(resolve=>{release=resolve})
    return {ready,release}
}
test.use({entry:'article-grid'})

for(const width of [375,1280]){
    test(`card cover owns the sweeping state, failure and retry without shifting at ${width}px`,async({page,sandboxURL})=>{
        await page.setViewportSize({width,height:900})
        await page.emulateMedia({reducedMotion:'no-preference'})
        const failed=deferred(),success=deferred(),requests:string[]=[]
        await page.route('**/fixture/card-cover.svg',async route=>{
            requests.push(route.request().url())
            if(requests.length===1){await failed.ready;await route.fulfill({status:404,body:''})}
            else{await success.ready;await route.fulfill({contentType:'image/svg+xml',body:picture})}
        })
        await page.goto(`${sandboxURL}#loading-cover`,{waitUntil:'domcontentloaded'})
        const cover=page.locator('.ArticleCover'),art=cover.locator('.sweep-loading')
        const sprite=art.locator('.sweep-loading__sprite')
        await expect(art).toBeVisible()
        await expect(sprite).toHaveCSS('animation-play-state','running')
        const initial=await cover.boundingBox()
        expect(initial).toBeTruthy()
        const stage=await art.boundingBox()
        expect(stage).toBeTruthy()
        expect(Math.abs(stage!.x+stage!.width/2-(initial!.x+initial!.width/2))).toBeLessThan(1)
        expect(Math.abs(stage!.y+stage!.height/2-(initial!.y+initial!.height/2))).toBeLessThan(1)
        failed.release()
        const retry=cover.getByRole('button',{name:'重新加载图片：短标题'})
        await expect(retry).toBeVisible()
        await expect(art).toHaveCount(0)
        await expect(cover).toContainText('图片加载失败')
        await retry.click()
        await expect(art).toBeVisible()
        expect(page.context().pages()).toHaveLength(1)
        success.release()
        await expect(cover.getByRole('img',{name:'短标题'})).toHaveJSProperty('naturalWidth',200)
        await expect(art).toHaveCount(0)
        const final=await cover.boundingBox()
        expect(Math.abs(final!.height-initial!.height)).toBeLessThan(0.5)
        expect(Math.abs(final!.width-initial!.width)).toBeLessThan(0.5)
        expect(requests).toHaveLength(2)
        expect(requests[0]).toBe(requests[1])
        await expect(cover.locator('.asset-image')).toHaveAttribute('aria-busy','false')
    })
}

test('reduced-motion card covers retain a static first frame only while the image is pending',async({page,sandboxURL})=>{
    await page.setViewportSize({width:390,height:900})
    await page.emulateMedia({reducedMotion:'reduce'})
    const done=deferred()
    await page.route('**/fixture/card-cover.svg',async route=>{
        await done.ready
        await route.fulfill({contentType:'image/svg+xml',body:picture})
    })
    await page.goto(`${sandboxURL}#loading-cover`,{waitUntil:'domcontentloaded'})
    const art=page.locator('.ArticleCover .sweep-loading')
    await expect(art).toBeVisible()
    await expect(art).toHaveAttribute('data-paused','true')
    const sprite=art.locator('.sweep-loading__sprite')
    await expect(sprite).toHaveCSS('animation-name','none')
    await expect(sprite).toHaveCSS('background-position','0px 0px')
    expect(await sprite.evaluate(element=>element.getAnimations().length)).toBe(0)
    done.release()
    await expect(page.locator('.ArticleCover img')).toHaveJSProperty('naturalWidth',200)
    await expect(art).toHaveCount(0)
})
