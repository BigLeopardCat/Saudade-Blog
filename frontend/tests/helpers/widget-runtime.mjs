import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM, VirtualConsole } from 'jsdom';
import { transformSync } from 'esbuild';

const root = new URL('../../public/live2d-widgets/', import.meta.url);
export const widgetFile = name => readFileSync(new URL(name, root), 'utf8');

// Linked source maps are shipped and pinned with each generated browser bundle.
export function widgetSource(name) {
    const bundle = widgetFile(name);
    const mapName = /\/\/# sourceMappingURL=([^\s]+)/.exec(bundle)?.[1];
    if (!mapName) return bundle;
    const map = JSON.parse(widgetFile(mapName));
    assert.equal(map.version, 3);
    assert.equal(map.sources.length, map.sourcesContent.length);
    assert.ok(map.sourcesContent.every(source => typeof source === 'string'));
    return map.sourcesContent.join('\n');
}

export const frame = (type, data) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
export const sse = wire => new Response(wire, { headers: { 'content-type': 'text/event-stream' } });
export const flush = () => new Promise(resolve => setTimeout(resolve, 0));

export function runtime({ respond = () => sse(frame('done', {})), clock, steering } = {}) {
    const browserErrors = [];
    const virtualConsole = new VirtualConsole();
    virtualConsole.on('jsdomError', error => browserErrors.push(error));
    const dom = new JSDOM('<div id="waifu"><div id="waifu-tool"><span id="waifu-tool-switch-model"></span><span id="waifu-tool-switch-texture"></span></div></div>',
        { url: 'https://fixture.invalid/article/1', runScripts: 'outside-only', virtualConsole });
    const win = dom.window, doc = win.document;
    Object.assign(win, { TextDecoder, TextEncoder, AbortController });
    if (clock) win.Date = clock;
    const calls = [], broadcasts = [], reports = [], settlements = [];
    win.fetch = async (url, options = {}) => {
        const request = { url, ...options, body: options.body ? JSON.parse(options.body) : undefined };
        calls.push(request);
        return respond(request);
    };
    win.__reportError = value => reports.push(value);
    if (steering) win.__waifuSteering = () => steering;
    win.localStorage.setItem('tokenKey', 'fixture.' + win.btoa(JSON.stringify({ sub: 7 })) + '.signature');
    const ctx = { core: {}, render: {}, dom: {}, state: { conv: 42, items: [], live: {}, remoteRounds: {}, pendingImages: [] }, ui: {} };
    for (const name of ['chat-core.js', 'chat-render.js', 'chat-work.js', 'chat-approval.js', 'chat-protocol.js', 'chat-stream.js'])
        // Convert only module packaging for JSDOM; execute the pinned production code.
        win.eval(transformSync(widgetFile(name), { format: 'iife', loader: 'js' }).code);
    ctx.core = win.__waifuChatCore;
    win.__waifuRender(ctx);
    doc.querySelector('#waifu').insertAdjacentHTML('beforeend', ctx.render.chatHTML);
    const ids = { messages: 'chat-messages', input: 'chat-input', sendBtn: 'chat-send',
        navConfirm: 'chat-nav-confirm', navQuestion: 'nav-question-text', chatPanel: 'waifu-chat',
        askBox: 'chat-ask', askQuestion: 'chat-ask-text', askBtns: 'chat-ask-btns',
        askOther: 'chat-ask-other', askOtherInput: 'chat-ask-other-input', askOtherSend: 'chat-ask-other-send' };
    for (const [name, id] of Object.entries(ids)) ctx.dom[name] = doc.getElementById(id);
    assert.ok(Object.values(ctx.dom).every(Boolean), 'Real template must provide the stream DOM');
    const engine = {
        windowId: 'window', tabId: 'tab', ready: Promise.resolve(),
        ensureConversation: async () => true, scrollToBottom() {},
        broadcast: value => broadcasts.push(value), pullHistory() {}, saveHistory() {},
        appendMsg(item) { const el = doc.createElement('div'); el.dataset.mtype = item.type; el.dataset.mid = item.id; el.textContent = item.text; ctx.dom.messages.appendChild(el); },
        makeLiveBubble(id) { const el = doc.createElement('div'); el.className = 'chat-msg agent'; el.dataset.mid = id;
            const contentSpan = doc.createElement('span'); contentSpan.className = 'msg-text'; el.appendChild(contentSpan); ctx.dom.messages.appendChild(el);
            ctx.state.live[id] = { el, contentSpan }; return { el, contentSpan }; },
        makeProcessBox() { const box = doc.createElement('details'); box.className = 'agent-process'; box.innerHTML = '<summary></summary><div class="agent-process-body"></div>'; return box; },
        appendProcessLine(box, line) { box.querySelector('.agent-process-body').appendChild(line); },
        getCollapsePref: () => false, setCollapsePref() {}, notifyListDirty() {},
        setConvUI(value) { this.hooks = value; },
    };
    const realApproval = win.__waifuApproval;
    let approval;
    win.__waifuApproval = (...args) => {
        approval = realApproval(...args);
        const settle = approval.askSettle;
        approval.askSettle = (...values) => { settlements.push(values); return settle(...values); };
        return approval;
    };
    const stream = win.__waifuStream(ctx, engine);
    assert.ok(stream);
    stream.init();
    return { win, doc, ctx, engine, approval, calls, broadcasts, reports, settlements, browserErrors,
        async send(text = '测试') { ctx.dom.input.value = text; ctx.dom.sendBtn.click(); await this.idle(); },
        async idle() { for (let i = 0; i < 100; i++) { await flush(); if (!ctx.state.isSending && calls.length) return; } throw new Error('Widget did not settle'); },
        async choose(value) { ctx.dom.askBtns.querySelector(`[data-ask-value="${value}"]`).click(); await flush(); },
        close() {
            win.close();
            assert.equal(browserErrors.length, 0, browserErrors.map(error => error.message).join('\n'));
        },
    };
}
