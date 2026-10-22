// Controlled promises exercise actual route callbacks, with only the rendering
// and API boundaries stubbed. No browser timing or implementation-copy fixture.
import assert from 'node:assert/strict'
import {build} from 'esbuild'
import {mkdtempSync, readFileSync, rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import path from 'node:path'
import {pathToFileURL, fileURLToPath} from 'node:url'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const tmp = mkdtempSync(path.join(tmpdir(), 'resource-races-'))
const tick = async () => { for (let i = 0; i < 8; i++) await Promise.resolve() }
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => {resolve = a; reject = b}); return {promise, resolve, reject} }
const response = data => ({data: {code: 200, data}})
const requests = [], notices = [], favorites = []
let route = 'A', account = 'account-one', categories = [], currentHost
const enqueue = (kind, args) => { const request = {kind, args, ...deferred()}; requests.push(request); return request.promise }
const jsx = (type, props, key) => ({type, props: props || {}, key})
globalThis.__routeTest = {
    jsx, motion: new Proxy({}, {get: (_, key) => key}), dayjs: () => ({format: () => '2026-10-23'}),
    useState: initial => currentHost.state(initial), useRef: initial => currentHost.ref(initial),
    useEffect: (fn, deps) => currentHost.effect(fn, deps), useParams: () => ({id: route}),
    useSelector: selector => selector({user: {name: 'author', avatar: ''}, categories: {categories}}),
    useLiveRefresh: fn => {currentHost.refresh = fn}, useFavorites: () => ({has: () => false}),
    getToken: () => account, noteAuthor: () => ({name: 'author', avatar: ''}), useIsDarkMode: () => false,
    ok: res => res?.data?.code === 200, errMsg: () => 'failed', applyLocalFavorite: (...args) => favorites.push(args),
    message: {error: value => notices.push(value), warning: value => notices.push(value), success: value => notices.push(value)},
    ...Object.fromEntries(['getNoteById', 'getNoteStats', 'reportNoteView', 'likeNote', 'unlikeNote', 'addFavorite', 'removeFavorite', 'searchNotes'].map(kind => [kind, (...args) => enqueue(kind, args)])),
}
globalThis.cancelAnimationFrame = () => {}
const storage = new Map()
globalThis.localStorage = {getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value)}
globalThis.window = {location: {hash: ''}, matchMedia: () => ({matches: true}), addEventListener() {}, removeEventListener() {}}
globalThis.document = {getElementById: () => null, querySelector: () => null, addEventListener() {}, removeEventListener() {}}
class Host {
    constructor(Component, props = {}) {this.Component = Component; this.props = props; this.slots = []; this.pending = []; this.cleanups = []}
    state(initial) {const i = this.cursor++; if (!(i in this.slots)) this.slots[i] = initial; return [this.slots[i], value => {this.slots[i] = typeof value === 'function' ? value(this.slots[i]) : value}]}
    ref(initial) {const i = this.cursor++; if (!(i in this.slots)) this.slots[i] = {current: initial}; return this.slots[i]}
    effect(fn, deps) {const i = this.cursor++; const old = this.slots[i]; if (!old || deps?.some((v, n) => v !== old[n])) {this.slots[i] = deps; this.pending.push([i, fn])}}
    render() {this.cursor = 0; currentHost = this; this.tree = this.Component(this.props); for (const [i, fn] of this.pending.splice(0)) {this.cleanups[i]?.(); this.cleanups[i] = fn()} return this.tree}
    unmount() {for (const cleanup of this.cleanups) cleanup?.()}
}
function find(tree, predicate) {
    if (!tree || typeof tree !== 'object') return undefined
    if (predicate(tree)) return tree
    for (const child of [tree.props?.children].flat(Infinity)) {const result = find(child, predicate); if (result) return result}
}
const text = tree => typeof tree === 'string' || typeof tree === 'number' ? String(tree) : Array.isArray(tree) ? tree.map(text).join('') : tree?.props ? text(tree.props.children) : ''
const calls = kind => requests.filter(r => r.kind === kind)
const last = kind => calls(kind).at(-1)
async function load(relative) {
    const entry = path.join(root, relative), source = readFileSync(entry, 'utf8'), imports = new Map()
    for (const match of source.matchAll(/import\s+(?:type\s+)?([\s\S]*?)\s+from\s+["']([^"']+)["'];?/g)) {
        const names = [], braces = match[1].match(/\{([\s\S]*?)\}/)
        if (braces) for (const item of braces[1].split(',')) {const name = item.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0]; if (name) names.push(name)}
        imports.set(match[2], names)
    }
    const outfile = path.join(tmp, path.basename(path.dirname(entry)) + '.mjs')
    await build({entryPoints: [entry], outfile, bundle: true, format: 'esm', jsx: 'automatic', logLevel: 'silent', plugins: [{name: 'boundaries', setup(b) {
        b.onResolve({filter: /.*/}, args => {if (args.kind === 'entry-point' || args.path.includes('requestScope')) return; return {path: args.path, namespace: 'stub'}})
        b.onLoad({filter: /.*/, namespace: 'stub'}, args => {
            if (args.path === 'react/jsx-runtime') return {contents: 'export const jsx = globalThis.__routeTest.jsx; export const jsxs = jsx; export const Fragment = "fragment";'}
            const names = imports.get(args.path) || [], fallback = args.path === 'dayjs' ? 'dayjs' : args.path.endsWith('getToken.tsx') ? 'getToken' : ''
            return {contents: `export default ${fallback ? `globalThis.__routeTest.${fallback}` : '(()=>null)'};\n` + names.map(name => `export const ${name} = globalThis.__routeTest.${name} ?? (()=>null);`).join('\n')}
        })
    }}]})
    return (await import(pathToFileURL(outfile))).default
}
function mountRoute(Component, id) {route = id; const outer = new Host(Component); const element = outer.render(); assert.notEqual(element.key, undefined, 'resource boundary must be keyed'); const host = new Host(element.type, element.props); host.render(); return host}
try {
    const Article = await load('src/frontHome/Content/ReadArticle/index.tsx')
    let a = mountRoute(Article, 'A'); const firstA = last('getNoteById'); a.unmount()
    const b = mountRoute(Article, 'B'), firstB = last('getNoteById')
    firstB.resolve(response({noteTitle: '正文 B'})); await tick(); b.render()
    firstA.reject({response: {status: 404}}); await tick(); b.render()
    assert.match(text(b.tree), /正文 B/); assert.doesNotMatch(text(b.tree), /文章不存在/); assert.equal(firstA.args[1].aborted, true)
    const oldStats = last('reportNoteView'); b.unmount(); a = mountRoute(Article, 'A'); const secondA = last('getNoteById')
    oldStats.resolve(response({views: 999, likes: 999, comments: 999, liked: true})); await tick()
    secondA.resolve(response({noteTitle: '新正文 A'})); await tick(); a.render(); assert.match(text(a.tree), /新正文 A/); assert.doesNotMatch(text(a.tree), /999/)
    const initialStats = last('reportNoteView'), like = find(a.tree, n => n.props?.title === '点赞')
    const liking = like.props.onClick(); like.props.onClick(); assert.equal(calls('likeNote').length, 1)
    last('likeNote').resolve(response({likes: 7, liked: true})); await liking; await tick()
    initialStats.resolve(response({views: 1, likes: 0, comments: 0, liked: false})); await tick(); a.render()
    assert.equal(find(a.tree, n => n.props?.title === '取消点赞')?.props['aria-pressed'], true)
    const postLikeStats = last('getNoteStats')
    const background = a.refresh(); last('getNoteById').resolve(response({noteTitle: '新正文 A'})); await background
    assert.equal(postLikeStats.args[1].aborted, false, 'cached live refresh must not cancel pending post-like stats')
    postLikeStats.resolve(response({views: 8, likes: 7, comments: 2, liked: true})); await tick(); a.render(); assert.match(text(a.tree), /8/)
    const favorite = find(a.tree, n => n.props?.className?.includes('readFavBtn')); assert.ok(favorite)
    const saving = favorite.props.onClick(); account = 'account-two'; last('addFavorite').resolve(response({})); await saving; assert.equal(favorites.length, 0)
    const refresh1 = a.refresh(), stale = last('getNoteById'), refresh2 = a.refresh(), latest = last('getNoteById')
    stale.reject({response: {status: 404}}); await refresh1; a.render(); assert.doesNotMatch(text(a.tree), /文章不存在/)
    latest.resolve(response({noteTitle: '最新 A'})); await refresh2; a.render(); assert.match(text(a.tree), /最新 A/)
    const foreground = find(a.tree, n => n.props?.className === 'readContainer')
    assert.ok(foreground)
    const oldA = a.refresh(), lateA = last('getNoteById'); a.unmount()
    const middleB = mountRoute(Article, 'B'); const lateB = last('getNoteById'); middleB.unmount()
    a = mountRoute(Article, 'A'); const newestA = last('getNoteById')
    lateA.resolve(response({noteTitle: '过期同 ID 正文'})); await oldA
    lateB.reject({response: {status: 404}}); await tick(); a.render()
    assert.doesNotMatch(text(a.tree), /过期同 ID 正文|文章不存在/)
    newestA.resolve(response({noteTitle: '第三次 A'})); await tick(); a.render(); assert.match(text(a.tree), /第三次 A/)
    const readBeforeUnmount = a.refresh(), abandoned = last('getNoteById'); a.unmount(); const slots = JSON.stringify(a.slots)
    abandoned.resolve(response({noteTitle: '不应应用'})); await readBeforeUnmount; assert.equal(JSON.stringify(a.slots), slots)
    const broken = mountRoute(Article, 'broken'); last('getNoteById').reject(new Error('offline')); await tick(); broken.render()
    assert.match(text(broken.tree), /文章加载失败/); broken.unmount()
    const Categories = await load('src/frontHome/Content/Categories/index.tsx')
    categories = [{pathName: 'A', categoryTitle: '甲'}, {pathName: 'B', categoryTitle: '乙'}]
    const ca = mountRoute(Categories, 'A'), searchA = last('searchNotes'); ca.unmount()
    const cb = mountRoute(Categories, 'B'), searchB = last('searchNotes')
    searchB.resolve(response([{noteKey: 2, noteTitle: '乙文章'}])); await tick(); cb.render()
    searchA.resolve(response([{noteKey: 1, noteTitle: '甲文章'}])); await tick(); cb.render(); assert.match(text(cb.tree), /乙文章/); assert.doesNotMatch(text(cb.tree), /甲文章/)
    cb.unmount(); const missing = mountRoute(Categories, 'missing'); assert.match(text(missing.tree), /分类不存在/); assert.doesNotMatch(text(missing.tree), /乙文章/); missing.unmount()
    const empty = mountRoute(Categories, 'A'); last('searchNotes').resolve(response([])); await tick(); empty.render(); assert.match(text(empty.tree), /还没有公开文章/)
    const failed = empty.refresh(); last('searchNotes').resolve({data: {code: 500, data: []}}); await failed; empty.render(); assert.match(text(empty.tree), /列表加载失败/); assert.doesNotMatch(text(empty.tree), /共有0篇/); empty.unmount()
    console.log('✓ Actual route callbacks isolate stale body/404/loading/stats/like/favorite responses and unmounts')
} finally {rmSync(tmp, {recursive: true, force: true})}
