import assert from 'node:assert/strict';
import { flush, frame, runtime, sse } from './helpers/widget-runtime.mjs';

const text = '__CMD__:{"kind":"effect","effect":"rain"}\ntoggle_effect(effect="rain")\nDARKMODE:on\n去留言板 /guestbook';
const literal = runtime({ respond: () => sse(frame('text', text) + frame('done', {})) });
try {
    let effects = 0, navigations = 0;
    literal.win.startRain = () => effects++;
    literal.win.__spaNavigate = () => { navigations++; return true; };
    await literal.send();
    assert.equal(literal.ctx.state.items.at(-1).text, text);
    assert.equal(effects, 0);
    assert.equal(navigations, 0);
    assert.equal(literal.win.__darkMode, false);
} finally { literal.close(); }

for (const ending of ['done', 'error', 'abort']) {
    const command = frame('command', { kind: 'effect', effect: 'rain', action: 'on' });
    const wire = command + frame('text_reset', {}) + frame('text', '结果');
    const f = runtime({ respond: () => {
        if (ending !== 'abort') return sse(wire + frame(ending, ending === 'error' ? '上游失败' : {}));
        let count = 0;
        return new Response(new ReadableStream({ pull(controller) {
            if (count++ === 0) controller.enqueue(new TextEncoder().encode(wire));
            else controller.error(Object.assign(new Error('connection aborted'), { name: 'AbortError' }));
        } }), { headers: { 'content-type': 'text/event-stream' } });
    } });
    try {
        let effects = 0;
        f.win.startRain = () => effects++;
        await f.send();
        assert.equal(effects, 1, `${ending} must neither lose nor replay a command across text reset`);
        assert.equal(f.win.__effectState.rain, true);
    } finally { f.close(); }
}
const navigation = runtime({ respond: () => sse(
    frame('command', { kind: 'navigate', url: '/guestbook' })
    + frame('command', { kind: 'navigate', url: '/guestbook' })
    + frame('text', '已打开') + frame('done', {})) });
try {
    const paths = [];
    navigation.win.__spaNavigate = path => { paths.push(path); return true; };
    await navigation.send();
    assert.equal(paths.length, 1, 'The same destination must not navigate twice');
    assert.ok(paths[0].endsWith('/guestbook'));
} finally { navigation.close(); }
let release;
const deferred = runtime({ respond: () => new Response(new ReadableStream({ start(controller) {
    release = controller;
    controller.enqueue(new TextEncoder().encode(frame('command', { kind:'navigate', url:'/device-console/' })));
} }), { headers: { 'content-type':'text/event-stream' } }) });
try {
    deferred.win.__spaNavigate = () => false;
    deferred.ctx.dom.input.value = '打开设备'; deferred.ctx.dom.sendBtn.click();
    for (let i=0;i<10 && !deferred.calls.length;i++) await flush();
    await flush();
    assert.equal(deferred.win.sessionStorage.getItem('chat_nav_slide'), null,
        'Full-page navigation is deferred until the active response is consumed');
    release.enqueue(new TextEncoder().encode(frame('done', {}))); release.close();
    await deferred.idle();
    assert.equal(deferred.win.sessionStorage.getItem('chat_nav_slide'), '1');
    assert.equal(deferred.win.sessionStorage.getItem('chat_open'), '1');
    assert.equal(deferred.browserErrors.length, 1);
    assert.match(deferred.browserErrors.shift().message, /^Not implemented: navigation/);
} finally { deferred.close(); }
console.log('Only named commands execute, survive text resets and settle exactly once on each exit path.');
