// Rendering contracts live here; actual hover geometry is checked in article-grid.spec.ts.
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {JSDOM} from 'jsdom';
const frontend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporary = mkdtempSync(path.join(tmpdir(), 'article-card-render-'));
try {
    const outfile = path.join(temporary, 'card.cjs');
    await build({absWorkingDir:frontend, stdin:{contents:`
        import React from 'react';
        import {renderToStaticMarkup} from 'react-dom/server';
        import Card from './src/components/ArticleCard';
        import {CARD_ASPECT,CAROUSEL_ASPECT} from './src/utils/coverCrop';
        export const ratios = [CARD_ASPECT,CAROUSEL_ASPECT];
        export const render = props => renderToStaticMarkup(React.createElement(Card, props));`,resolveDir:frontend,loader:'tsx'},
        outfile, bundle:true, platform:'node',format:'cjs',jsx:'automatic',
        loader:{'.webp':'dataurl'}, define:{'import.meta.env':'{"VITE_HTTP_BASEURL":"/fixture"}','process.env.NODE_ENV':'"production"'},
        plugins:[{name:'omit-style',setup(builder){builder.onLoad({filter:/\.(sass|css|scss)$/},()=>({contents:'',loader:'js'}));}}],logLevel:'error'});
    const {render,ratios} = (await import(pathToFileURL(outfile))).default;
    assert.equal(ratios[0],ratios[1]);
    const item = {key:'7',noteTitle:'完整标题',description:'摘要正文',cover:'/cover.svg',noteTags:[],
        authorName:'文章作者',authorAvatar:'',createTime:'2026-11-01',updateTime:'2026-11-02',views:17,likes:2};
    for (const featured of [false,true]) for (const preview of [false,true]) {
        const document = new JSDOM(render({item,featured,preview,number:featured?3:undefined,crop:{fit:'contain',x:.5,y:.5,z:1}})).window.document;
        assert.equal(document.querySelector('.ArticleTitle').textContent,'完整标题');
        assert.match(document.querySelector('.ArticleFooter').textContent,/文章作者/);
        assert.equal(document.querySelector('.ArticleDescription').textContent,'摘要正文');
        assert.match(document.querySelector('.ArticleStats').textContent,/17/);
        assert.equal(document.querySelector('img').style.objectFit,'contain');
        assert.equal(document.querySelectorAll('a').length,preview?0:1);
        if (!preview) assert.equal(document.querySelector('a').getAttribute('href'),'/article/7');
        if (featured) assert.equal(document.querySelector('.ArticleNumber').textContent,'03');
    }
    console.log('✓ Shared cards preserve article links, authors, metadata and crop behavior in both variants and admin previews');
} finally {rmSync(temporary,{recursive:true,force:true})}
