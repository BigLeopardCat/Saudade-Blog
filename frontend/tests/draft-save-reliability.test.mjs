import assert from 'node:assert/strict';
import {readFileSync, mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {build, transform} from 'esbuild';

const dir = mkdtempSync(path.join(tmpdir(), 'draft-save-'));
try {
    const outfile = path.join(dir, 'transport.mjs');
    await build({entryPoints: ['src/pages/Dashboard/Notes/NewNotes/draftTransport.ts'], bundle: true, platform: 'node', format: 'esm', outfile});
    const {postDraftKeepalive} = await import(pathToFileURL(outfile));
    let calls = [];
    globalThis.fetch = async (url, options) => { calls.push({url, options}); return {status: 200, json: async () => ({code: 200, data: {id: 8}})}; };
    await assert.rejects(postDraftKeepalive({noteContent: '中'.repeat(30000)}, '/backend', 'abc'), /字节限制/);
    assert.equal(calls.length, 0, '中文正文按 UTF-8 字节超限，不发无效 keepalive');
    await assert.rejects(postDraftKeepalive({noteContent: 'x'}, '/backend', null), /登录状态/);
    await postDraftKeepalive({id: 8, noteContent: '正文🌸'}, '/backend', 'abc');
    assert.equal(calls[0].options.keepalive, true);
    assert.equal(calls[0].options.headers.Authorization, 'Bearer abc');

    // 执行组件的真实保存与生命周期函数，用可控网络回执重现竞态，无须浏览器或 React DOM。
    const source = readFileSync('src/pages/Dashboard/Notes/NewNotes/index.tsx', 'utf8');
    const saveSource = source.slice(source.indexOf('    const latestPayload ='), source.indexOf('    // 回填完毕后'));
    const resumeSource = source.slice(source.indexOf('    // bfcache 恢复'), source.indexOf('    // 标签字典'));
    const publishSource = source.slice(source.indexOf('    const onFinish = async'), source.indexOf('    /**\n     * 回列表页'));
    const body = (await transform(`${saveSource}\n${resumeSource}\n${publishSource}\nreturn {flushAutosave, onFinish};`, {loader: 'ts'})).code;
    const ref = current => ({current});
    const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => {resolve=a; reject=b}); return {promise, resolve, reject}; };
    const response = (id, code = 200) => ({status: 200, data: {code, data: {id, updateTime: '2026-10-23 12:00:00'}}});
    function scenario() {
        let payload = {id: null, noteTitle: '标题', noteContent: '旧正文'};
        let token = 'same-account';
        const saves = [], updates = [], states = [], timers = [], events = {};
        const target = {addEventListener: (name, fn) => {events[name] = fn}, removeEventListener: () => {}};
        const refs = {
            hydratedRef: ref(true), stopAutosaveRef: ref(false), publishingRef: ref(false),
            sessionTokenRef: ref(token), mountedRef: ref(true), detachedPayloadRef: ref(null),
            savedIdRef: ref(undefined), lastSavedRef: ref('baseline'), autosaveTimer: ref(null),
            retryRef: ref(0), inFlightRef: ref(null), queuedRef: ref(null), createdHereRef: ref(false),
            buildPayloadRef: ref(() => payload),
        };
        const send = (data, kind) => {const d = deferred(); saves.push({data, kind, ...d}); return d.promise;};
        const env = {
            dayjs: () => ({format: () => '2026-10-23 12:00:00'}),
            noteContent: '旧正文', coverImg: '', coverCrop: {}, cropDirty: {}, coverCropCarousel: {}, aiContent: '',
            buildPayload: () => payload, message: {success: () => {}, error: () => {}},
            updateNote: (id, data) => {updates.push({id, data}); return Promise.resolve(response(Number(id)));},
            dispatch: () => {}, fetchNoteList: () => {}, setOpen: () => {}, goBackToList: () => {}, errMsg: () => '保存失败',
            ...refs, getToken: () => token, setSaveState: v => states.push(v), setSavedAt: () => {}, setIsRevision: () => {},
            autosaveDraft: p => send(p, 'normal'), postDraftKeepalive: p => send(p, 'keepalive'), runtimeBaseURL: '',
            ok: r => r.status === 200 && r.data.code === 200, isBlank: s => !s.trim(),
            setTimeout: (fn, ms) => {const t = {fn, ms}; timers.push(t); return t}, clearTimeout: () => {}, AUTOSAVE_DELAY: 2000,
            useEffect: fn => fn(), window: target, document: {...target, hidden: false},
        };
        const api = new Function(...Object.keys(env), body)(...Object.values(env));
        return {...api, refs, saves, updates, states, timers, events, edit: value => {payload = {...payload, noteContent: value}}, switchAccount: () => {token = 'different-account'}};
    }
    {
        const s = scenario();
        s.flushAutosave();
        s.edit('新正文');
        s.events.pagehide();
        assert.equal(s.saves.length, 1, 'pagehide 不绕过在途首次创建');
        const pending = s.refs.inFlightRef.current;
        s.saves[0].resolve(response(31));
        await pending;
        assert.equal(s.saves.length, 2, '首个回执后尾随最新正文');
        assert.equal(s.saves[1].data.id, 31, '尾随请求采纳已建草稿 id');
        assert.equal(s.saves[1].data.noteContent, '新正文');
        s.saves[1].resolve(response(31));
        await s.refs.inFlightRef.current;
        const n = s.saves.length;
        s.events.pageshow();
        assert.equal(s.saves.length, n, '确认成功后 bfcache 恢复不重复写入');
    }
    for (const outcome of ['business', 'network', 'oversize']) {
        const s = scenario();
        s.events.pagehide();
        assert.equal(s.refs.lastSavedRef.current, 'baseline', '发出 keepalive 不能标记已保存');
        const p = s.refs.inFlightRef.current;
        if (outcome === 'business') s.saves[0].resolve(response(9, 500));
        else s.saves[0].reject(new Error(outcome));
        await p;
        assert.equal(s.refs.lastSavedRef.current, 'baseline', `${outcome} 失败仍保留脏快照`);
        s.events.pageshow();
        assert.equal(s.saves.length, 2, `${outcome} 恢复时普通请求重试`);
        assert.equal(s.saves[1].kind, 'normal');
        s.saves[1].resolve(response(9));
        await s.refs.inFlightRef.current;
    }
    {
        const s = scenario(); s.flushAutosave();
        const p = s.refs.inFlightRef.current;
        s.saves[0].resolve(response(8, 500)); await p;
        assert.equal(s.refs.lastSavedRef.current, 'baseline', '普通请求 HTTP200/code500 也不确认');
        assert.equal(s.states.at(-1), 'error');
        assert.equal(s.timers.at(-1).ms, 5000);
    }
    {
        const s = scenario(); s.flushAutosave(); const p = s.refs.inFlightRef.current;
        s.switchAccount(); s.saves[0].resolve(response(11)); await p;
        s.events.pageshow();
        assert.equal(s.refs.savedIdRef.current, undefined, '旧账号回执不采纳到当前账号');
        assert.equal(s.saves.length, 1, '账号切换后不再将旧草稿发往新账号');
    }
    {
        const s = scenario(); s.flushAutosave();
        s.refs.mountedRef.current = false;
        s.refs.detachedPayloadRef.current = {noteTitle: '旧路由', noteContent: '卸载快照'};
        s.edit('新路由正文'); s.flushAutosave();
        const p = s.refs.inFlightRef.current;
        s.saves[0].resolve(response(22)); await p;
        assert.equal(s.saves[1].data.noteContent, '卸载快照', '卸载后的尾随保存冻结旧会话内容');
        assert.equal(s.saves[1].data.id, 22);
        s.saves[1].resolve(response(22)); await s.refs.inFlightRef.current;
    }
    {
        const s = scenario(); s.flushAutosave();
        const publishing = s.onFinish({noteTitle: '标题', noteCategory: 1, noteTags: [], isTop: false, status: 'public'});
        await s.onFinish({noteTitle: '重复提交', status: 'public'});
        assert.equal(s.saves.length, 1, '提交等待首个自动保存，重复提交也不能再建草稿');
        s.saves[0].resolve(response(45));
        await publishing;
        assert.equal(s.updates.length, 1, '同一提交仅发布一次');
        assert.equal(s.updates[0].id, '45', '发布采用在途首次创建返回的 id');
        assert.equal(s.refs.stopAutosaveRef.current, true);
    }
    console.log('draft-save-reliability: UTF-8、确认回执、单飞、恢复重试、账号与卸载隔离通过');
} finally {
    rmSync(dir, {recursive: true, force: true});
}
