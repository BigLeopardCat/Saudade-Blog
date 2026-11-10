import assert from 'node:assert/strict';
import { frame, runtime, sse } from './helpers/widget-runtime.mjs';

const SERVER_TEXT = '服务这边暂时联系不上，这一轮没有生成回复，请稍后再说一次。';
const NOTICE = '尊敬的访客：本站部署的AI虚拟形象Agent仅供技术学习交流…';
for (const [payload, expected] of [
    [{ reply: '', success: false, error: SERVER_TEXT }, SERVER_TEXT],
    [{ reply: NOTICE, success: true }, NOTICE],
]) {
    const f = runtime({ respond: () => Response.json(payload) });
    try {
        await f.send();
        assert.equal(f.doc.querySelector('.chat-msg-err-note')?.textContent, expected);
        assert.equal(f.broadcasts.find(event => event.t === 'error')?.msg, expected);
        assert.equal(f.ctx.state.items.filter(item => item.type === 'agent').length, 0);
    } finally { f.close(); }
}
const html = runtime({ respond: () => new Response('<!DOCTYPE html><html>…</html>', { headers: { 'content-type': 'text/html' } }) });
try {
    await html.send();
    const note = html.doc.querySelector('.chat-msg-err-note').textContent;
    assert.ok(note.length > 0);
    assert.doesNotMatch(note, /网络错误|Unexpected token|<html>/);
} finally { html.close(); }
const valid = runtime({ respond: () => sse(frame('text', '正常流式回复') + frame('done', {})) });
try {
    await valid.send();
    assert.equal(valid.ctx.state.items.at(-1).text, '正常流式回复');
    assert.equal(valid.doc.querySelector('.chat-msg-err-note'), null);
} finally { valid.close(); }
const network = runtime({ respond: () => { throw new Error('boom'); } });
try {
    await network.send();
    assert.equal(network.doc.querySelector('.chat-msg-err-note').textContent, '网络错误: boom');
} finally { network.close(); }
console.log('Non-SSE error/reply/HTML responses fail safely; valid SSE and network errors stay distinct.');
