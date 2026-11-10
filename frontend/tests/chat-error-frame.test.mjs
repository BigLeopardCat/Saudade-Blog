import assert from 'node:assert/strict';
import { frame, runtime, sse } from './helpers/widget-runtime.mjs';

const SERVER_TEXT = '服务这边出了点问题，这一轮没能生成回复，请再说一次。';
for (const text of [SERVER_TEXT, 'line1\n\nline2 "quoted" \\ tail']) {
    const f = runtime({ respond: () => sse(frame('error', text)) });
    try {
        await f.send();
        assert.equal(f.broadcasts.find(event => event.t === 'error')?.msg, text);
        assert.equal(f.doc.querySelector('.chat-msg-err-note')?.textContent, text);
        assert.equal(f.ctx.state.items.filter(item => item.type === 'agent').length, 0);
        assert.equal(f.ctx.state.isSending, false);
    } finally { f.close(); }
}
for (const response of [
    () => sse('event: error\ndata: unstructured\n\n'),
    () => { throw new Error('pending_confirm'); },
]) {
    const f = runtime({ respond: response });
    try {
        await f.send();
        assert.match(f.doc.querySelector('.chat-msg-err-note').textContent, /^网络错误: /);
        assert.notEqual(f.broadcasts.find(event => event.t === 'error')?.msg, SERVER_TEXT);
    } finally { f.close(); }
}
const used = runtime({ respond: () => Response.json({ error: 'confirm_already_used' }, { status: 409 }) });
try {
    await used.send();
    assert.match(used.doc.querySelector('.chat-msg-err-note').textContent, /^这张确认卡片已经用过一次了/);
    assert.doesNotMatch(used.doc.querySelector('.chat-msg-err-note').textContent, /网络错误/);
} finally { used.close(); }
console.log('Error frames preserve server wording and malformed/network failures remain distinct.');
