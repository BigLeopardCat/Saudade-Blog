import assert from 'node:assert/strict';
import { flush, frame, runtime, sse } from './helpers/widget-runtime.mjs';

const card = () => ({ id: 'batch', token: 'fixture-only', q: '选择待办', exp: Date.now() / 1000 + 600,
    opts: [{ value: 'yes', label: '确认' }, ...[0, 1, 2].map(i => ({ value: 'pick:' + i, label: '待办 ' + i })),
        { value: 'other', label: '修改' }, { value: 'no', label: '取消' }] });
const show = f => { f.approval.receive(card(), 42, null); f.approval.syncAsk(); };
for (const value of ['yes', 'pick:1']) {
    const f = runtime({ respond: () => sse(frame('text', '执行结果') + frame('done', {})) });
    try {
        show(f);
        if (value === 'pick:1') {
            const inputs = f.ctx.dom.askBtns.querySelectorAll('input[type="checkbox"]');
            inputs[1].click(); inputs[3].click();
        } else {
            // The same approval control also supports a non-batch yes/no proposal.
            f.ctx.state.pendingAsk.opts = card().opts.filter(option => !option.value.startsWith('pick:'));
            f.ctx.dom.askBox.dataset.askState = ''; f.approval.syncAsk();
        }
        const activeSubmit = f.ctx.dom.askBtns.querySelector(`[data-ask-value="${value}"]`);
        assert.ok(activeSubmit);
        activeSubmit.click(); await f.idle();
        assert.equal(f.calls.length, 1);
        assert.equal(f.calls[0].body.message, '');
        assert.equal(f.calls[0].body.confirm_token, 'fixture-only');
        assert.equal(f.calls[0].body.confirm_pick, value === 'yes' ? undefined : value);
        assert.equal(f.ctx.state.items.some(item => item.type === 'user'), false);
        assert.equal(f.settlements[0][0], '确认中…');
        assert.equal(f.settlements.at(-1)[0], '已确认，结果见后续回复');
    } finally { f.close(); }
}
const partial = runtime();
try {
    show(partial);
    const inputs = () => [...partial.ctx.dom.askBtns.querySelectorAll('input[type="checkbox"]')];
    assert.equal(inputs().length, 4);
    inputs()[2].click();
    assert.equal(partial.ctx.dom.askBtns.querySelector('[data-ask-submit]').dataset.askValue, 'pick:0,2');
    partial.ctx.dom.askBox.dataset.askState = ''; partial.approval.syncAsk();
    assert.deepEqual(inputs().slice(1).map(input => input.checked), [true, false, true]);
    inputs()[0].click(); inputs()[0].click();
    assert.equal(partial.ctx.dom.askBtns.querySelector('[data-ask-submit]').disabled, true);
    assert.ok(!partial.win.localStorage.getItem('saudade-chat-approvals:7:42').includes('fixture-only'));
    await partial.choose('other');
    assert.equal(partial.calls.length, 0);
    assert.equal(partial.settlements.length, 0);
    assert.equal(partial.ctx.dom.askOther.classList.contains('active'), true);
    assert.equal(partial.doc.activeElement, partial.ctx.dom.askOtherInput);
    assert.ok(partial.ctx.state.pendingAsk);
} finally { partial.close(); }
for (const accepted of [true, false]) {
    let release;
    const f = runtime({ respond: () => new Promise(resolve => { release = resolve; }) });
    try {
        show(f); await f.choose('no');
        assert.equal(f.calls[0].url, '/api/chat/confirmation/cancel');
        assert.equal(f.calls[0].body.token, 'fixture-only');
        assert.equal(f.settlements.at(-1)[0], '撤销中…');
        assert.equal(f.settlements.some(values => values[0].includes('已撤销')), false);
        release(Response.json({ cancelled: accepted })); await flush(); await flush();
        if (accepted) assert.equal(f.settlements.at(-1)[0], '已撤销，未执行改动');
        else assert.ok(f.ctx.state.pendingAsk, 'Unverified cancellation must restore the card');
        assert.equal(f.calls.length, 1, 'Cancellation must never enter confirmation execution');
    } finally { f.close(); }
}
const ordinary = runtime();
try {
    await ordinary.send('普通发言');
    assert.equal(ordinary.calls[0].body.confirm_token, undefined);
    assert.equal(ordinary.calls[0].body.confirm_pick, undefined);
} finally { ordinary.close(); }
console.log('Confirmation selections, hidden approvals, amendment and acknowledged cancellation stay distinct.');
