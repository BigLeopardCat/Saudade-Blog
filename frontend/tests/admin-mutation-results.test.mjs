// Exercise the real page event handlers with controlled API responses and React state.
import assert from 'node:assert/strict'
import {mkdtempSync, rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import path from 'node:path'
import {pathToFileURL} from 'node:url'
import * as esbuild from 'esbuild'
const root = path.resolve(import.meta.dirname, '..')
const temp = mkdtempSync(path.join(tmpdir(), 'admin-mutations-'))
let h
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r }); return {promise, resolve} }
const success = {status: 200, data: {code: 200, data: []}}
const failure = {status: 200, data: {code: 500, message: '数据库暂不可用'}}
const jsx = (type, props) => ({type, props: props || {}})
const mocks = {
    react: `export const useState=(v)=>globalThis.adminHarness.useState(v); export const useRef=(v)=>globalThis.adminHarness.useRef(v); export const useEffect=()=>{}; export default {createElement:(type,props,...children)=>({type,props:{...props,children}})};`,
    'react/jsx-runtime': 'export const jsx=globalThis.adminHarness.jsx; export const jsxs=jsx; export const Fragment="Fragment";',
    antd: `export const Button='Button', Input=Object.assign('Input',{TextArea:'TextArea'}), Modal='Modal', Table='Table', ColorPicker='ColorPicker', Popconfirm='Popconfirm', Space='Space', Tag='Tag'; export const Form=Object.assign(()=>{}, {Item:'Form.Item',useForm:()=>[globalThis.adminHarness.form]}); export const Grid={useBreakpoint:()=>({lg:true})}; export const message={success:(m)=>globalThis.adminHarness.success.push(m),error:(m)=>globalThis.adminHarness.errors.push(m),warning:()=>{}};`,
    'react-redux': 'export const useDispatch=()=>()=>{};',
    '@mui/material': 'export const Fab="Fab";',
    '@ant-design/icons': 'export const FolderOpenOutlined="Folder",QuestionCircleOutlined="Question",ReloadOutlined="Reload";',
}
function setup() {
    h = {states: [], cursor: 0, api: {}, calls: [], success: [], errors: [], events: 0, resets: 0, jsx,
        useState(value) { const i=this.cursor++; if (!(i in this.states)) this.states[i]=value; return [this.states[i], value=>{ this.states[i]=typeof value==='function'?value(this.states[i]):value }] },
        useRef(value) { const [ref]=this.useState({current:value}); return ref },
    }
    h.form = { values: {title:'保留标题', content:'保留正文', categorie:'分类', introduce:'说明', categorie_icon:'fa-book', categorie_color:'#aabbcc', pathName:'category'},
        async validateFields() { return {...this.values} }, resetFields() {h.resets++}, setFieldsValue(values) {Object.assign(this.values, values)} }
    for (const name of ['getAnnouncements','createAnnouncement','updateAnnouncement','deleteAnnouncement','getCategories','addCategory','updateCategory','delCategory','delAllCategory']) {
        h.api[name] = async (...args) => { h.calls.push([name, args]); return success }
    }
    globalThis.adminHarness = h
}
setup()
const pages = {}
try {
    for (const [name, entry] of Object.entries({announcement:'Announcement', category:'Notes/AllCategorize'})) {
        const outfile=path.join(temp,name+'.mjs')
        await esbuild.build({entryPoints:[path.join(root,'src/pages/Dashboard',entry,'index.tsx')],outfile,bundle:true,platform:'node',format:'esm',jsx:'automatic',logLevel:'error',plugins:[{name:'page-stubs',setup(build){
            build.onResolve({filter:/.*/}, args=>{
                if(args.path in mocks || /Methods\.tsx$/.test(args.path) || /pending\.ts$/.test(args.path) || /categories\.tsx$/.test(args.path) || /liveRefresh\.ts$/.test(args.path) || /cjsDefault$/.test(args.path) || /@mui\/icons-material/.test(args.path) || /\.sass$/.test(args.path)) return {path:args.path,namespace:'stub'}
            })
            build.onLoad({filter:/.*/,namespace:'stub'}, args=>{
                let contents=mocks[args.path]
                if(/Methods\.tsx$/.test(args.path)) contents=['getAnnouncements','createAnnouncement','updateAnnouncement','deleteAnnouncement','getCategories','addCategory','updateCategory','delCategory','delAllCategory'].map(n=>`export const ${n}=(...args)=>globalThis.adminHarness.api.${n}(...args);`).join('\n')
                if(/pending/.test(args.path)) contents='export const notifyAnnouncementPublished=()=>globalThis.adminHarness.events++;'
                if(/categories\.tsx/.test(args.path)) contents='export const fetchCategories=()=>({type:"fetch"});'
                if(/liveRefresh/.test(args.path)) contents='export const useLiveRefresh=()=>{};'
                if(/cjsDefault/.test(args.path)) contents='export const cjsDefault=(v)=>v;'
                return {contents:contents || 'export default "Icon";',loader:'js'}
            })
        }}]})
        pages[name]=(await import(pathToFileURL(outfile))).default
    }
    const render = name => {h.cursor=0;return pages[name]()}
    const nodes = (node, type) => {
        if (!node || typeof node!=='object') return []
        if (Array.isArray(node)) return node.flatMap(n=>nodes(n,type))
        return [...(node.type===type?[node]:[]), ...nodes(node.props?.children,type)]
    }
    const modals = name => nodes(render(name),'Modal')
    for (const name of ['announcement','category']) {
        setup()
        if(name==='announcement') nodes(render(name),'Button')[0].props.onClick()
        else nodes(nodes(render(name),'Table')[0].props.title(),'Fab')[0].props.onClick()
        const api=name==='announcement'?'createAnnouncement':'addCategory'
        h.api[api]=async()=>failure
        await modals(name)[0].props.onOk()
        assert.equal(modals(name)[0].props.open,true,`${name}: business failure retains modal`)
        assert.equal(h.resets,name==='announcement'?1:0,'failure never resets form')
        assert.deepEqual(h.success,[])
        assert.deepEqual(h.errors,['数据库暂不可用'])
        h.api[api]=async()=>{throw new Error('offline')}
        await modals(name)[0].props.onOk()
        assert.equal(modals(name)[0].props.open,true,'network failure retains modal')
        const pending=deferred(); let requests=0
        h.api[api]=()=>{requests++;return pending.promise}
        const handler=modals(name)[0].props.onOk
        const first=handler(); const duplicate=handler()
        await Promise.resolve()
        assert.equal(requests,1,'same-frame repeated save creates only one request')
        pending.resolve(success); await Promise.all([first,duplicate])
        assert.equal(modals(name)[0].props.open,false,'confirmed save closes modal')
        assert.equal(h.success.length,1)
        if(name==='announcement') assert.equal(h.events,1,'only confirmed publish notifies')
    }
    // Invalid fields stay in-place without sending a request or a network error toast.
    setup()
    nodes(render('announcement'),'Button')[0].props.onClick()
    h.form.validateFields=async()=>{throw {errorFields:[{name:['title'],errors:['required']}]}}
    await modals('announcement')[0].props.onOk()
    assert.equal(modals('announcement')[0].props.open,true)
    assert.deepEqual(h.calls,[])
    assert.deepEqual(h.errors,[])
    assert.equal(modals('announcement')[0].props.confirmLoading,false)
    setup()
    const announcementTable=nodes(render('announcement'),'Table')[0]
    announcementTable.props.columns.at(-1).render(null,{id:9,title:'原标题',content:'原正文'}).props.onClick()
    h.api.updateAnnouncement=async()=>failure
    await modals('announcement')[0].props.onOk()
    assert.equal(modals('announcement')[0].props.open,true)
    assert.equal(h.form.values.content,'原正文')
    assert.equal(h.events,0)
    // Existing category string color must update without requiring an Ant Design Color object.
    setup()
    let table=nodes(render('category'),'Table')[0]
    const row={key:7,categoryTitle:'旧分类',introduce:'内容',icon:'fa-book',color:'#abcdef',pathName:'old'}
    nodes(table.props.columns.at(-1).render(row),'Fab')[0].props.onClick()
    h.api.updateCategory=async(payload,id)=>{assert.equal(payload.color,'#abcdef');assert.equal(id,7);return failure}
    await modals('category')[0].props.onOk()
    assert.equal(modals('category')[0].props.open,true,'edit failure keeps editor')
    assert.equal(h.resets,0)
    // Failed single deletion keeps the selected record and never reports success.
    setup()
    let singleTable=nodes(render('category'),'Table')[0]
    singleTable.props.rowSelection.onChange([7])
    singleTable=nodes(render('category'),'Table')[0]
    h.api.delCategory=async()=>failure
    await nodes(singleTable.props.columns.at(-1).render(row),'Popconfirm')[0].props.onConfirm()
    assert.deepEqual(nodes(render('category'),'Table')[0].props.rowSelection.selectedRowKeys,[7])
    assert.deepEqual(h.success,[])
    // Failed batch deletion retains both selection and confirmation; retry success clears both.
    setup()
    table=nodes(render('category'),'Table')[0]
    table.props.rowSelection.onChange([7,8])
    table=nodes(render('category'),'Table')[0]
    nodes(table.props.title(),'Fab').at(-1).props.onClick()
    h.api.delAllCategory=async()=>failure
    await modals('category')[1].props.onOk()
    assert.equal(modals('category')[1].props.open,true)
    assert.deepEqual(nodes(render('category'),'Table')[0].props.rowSelection.selectedRowKeys,[7,8])
    h.api.delAllCategory=async()=>success
    await modals('category')[1].props.onOk()
    assert.equal(modals('category')[1].props.open,false)
    assert.deepEqual(nodes(render('category'),'Table')[0].props.rowSelection.selectedRowKeys,[])
    setup()
    table=nodes(render('announcement'),'Table')[0]
    table.props.rowSelection.onChange([1])
    h.api.deleteAnnouncement=async()=>failure
    await nodes(render('announcement'),'Button')[1].props.onClick()
    assert.deepEqual(nodes(render('announcement'),'Table')[0].props.rowSelection.selectedRowKeys,[1])
    assert.deepEqual(h.success,[])
    assert.equal(h.events,0)
    console.log('admin mutation results: passed (business/network failures, input/selection retention, duplicate click, retry and string color)')
} finally {
    delete globalThis.adminHarness
    rmSync(temp,{recursive:true,force:true})
}
