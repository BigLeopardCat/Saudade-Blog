import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest'
import store from '../../src/store'
import {commentAdminApi,type CommentPageArgs,type CommentAdminItem} from '../../src/apis/commentAdminApi'
import {privateApi} from '../../src/apis/privateApi'
import {deferred} from '../helpers/deferred'

const {http}=vi.hoisted(()=>({http:{get:vi.fn(),put:vi.fn(),delete:vi.fn()}}))
vi.mock('../../src/apis/axios',()=>({default:http}))
const token=(id:number,signature='current')=>`header.${btoa(JSON.stringify({sub:id,role:'admin',exp:Math.floor(Date.now()/1000)+3600}))}.${signature}`
const login=(id:number,signature='current')=>{
    localStorage.setItem('tokenKey',token(id,signature));window.dispatchEvent(new Event('auth-change'))
}
const args=(patch:Partial<CommentPageArgs>={}):CommentPageArgs=>({ownerUserId:7,page:1,status:'all',query:'',sort:'desc',...patch})
const item=(id:number):CommentAdminItem=>({id,noteId:4,noteTitle:'Article',content:'Body',userId:1,
    username:'reader',nickname:'Reader',createTime:'2020-01-01 00:00:00',approved:0,isDeleted:0})
const envelope=(data:unknown,total:unknown=1,code=200)=>({status:200,data:{code,data,total}})
function reset(){
    for(const request of store.dispatch(privateApi.util.getRunningQueriesThunk()))request.abort()
    for(const request of store.dispatch(privateApi.util.getRunningMutationsThunk()))request.abort()
    store.dispatch(privateApi.util.resetApiState())
}
beforeEach(()=>{reset();vi.clearAllMocks();login(7)})
afterEach(()=>{reset();localStorage.clear()})

describe('administrator comment query lifecycle',()=>{
    it('deduplicates identical pages and maps active/deleted filters to backend parameters',async()=>{
        const pending=deferred<ReturnType<typeof envelope>>()
        http.get.mockReturnValueOnce(pending.promise)
        const first=store.dispatch(commentAdminApi.endpoints.adminComments.initiate(args({status:'pending'})))
        const second=store.dispatch(commentAdminApi.endpoints.adminComments.initiate(args({status:'pending'})))
        expect(http.get).toHaveBeenCalledTimes(1)
        expect(http.get.mock.calls[0][1]).toMatchObject({params:{page:1,page_size:10,status:'pending',deleted:false,sort:'desc'}})
        pending.resolve(envelope([item(1)]));await Promise.all([first.unwrap(),second.unwrap()])
        http.get.mockResolvedValueOnce(envelope([{...item(1),isDeleted:1}]))
        const deleted=store.dispatch(commentAdminApi.endpoints.adminComments.initiate(args({status:'deleted',page:2,query:'title'})))
        await deleted.unwrap()
        expect(http.get.mock.calls[1][1]).toMatchObject({params:{page:2,q:'title',status:undefined,deleted:true}})
        first.unsubscribe();second.unsubscribe();deleted.unsubscribe()
    })

    it.each([undefined,-1,1.5,0,'1'])('rejects invalid total %s without overwriting confirmed rows',async total=>{
        http.get.mockResolvedValueOnce(envelope([item(1)]))
        const request=store.dispatch(commentAdminApi.endpoints.adminComments.initiate(args()))
        await request.unwrap()
        const response=envelope([item(2)],total)
        if(total===undefined)delete (response.data as {total?:unknown}).total
        http.get.mockResolvedValueOnce(response)
        const failed = request.refetch()
        await expect(failed.unwrap()).rejects.toBeTruthy()
        expect((await failed).data?.items).toEqual([item(1)])
        request.unsubscribe()
    })

    it('ignores a late old-credential response even when the transport ignores abort',async()=>{
        const pending=deferred<ReturnType<typeof envelope>>()
        http.get.mockReturnValueOnce(pending.promise)
        const old=store.dispatch(commentAdminApi.endpoints.adminComments.initiate(args()))
        const signal=http.get.mock.calls[0][1].signal as AbortSignal
        login(8,'rotated')
        expect(signal.aborted).toBe(true)
        http.get.mockResolvedValueOnce(envelope([item(8)]))
        const current=store.dispatch(commentAdminApi.endpoints.adminComments.initiate(args({ownerUserId:8})))
        await current.unwrap()
        pending.resolve(envelope([item(7)]));await old
        expect(Object.values(store.getState().privateApi.queries).some(query => query?.requestId === old.requestId)).toBe(false)
        const cached = store.dispatch(commentAdminApi.endpoints.adminComments.initiate(args({ownerUserId:8}), {subscribe:false}))
        expect((await cached.unwrap()).items[0].id).toBe(8)
        expect(http.get).toHaveBeenCalledTimes(2)
        current.unsubscribe();old.unsubscribe()
    })

    it('invalidates the active page only after a successful mutation and keeps the signed-in owner in its key',async()=>{
        http.get.mockResolvedValue(envelope([item(1)]))
        const request=store.dispatch(commentAdminApi.endpoints.adminComments.initiate(args({page:3})))
        await request.unwrap()
        http.put.mockResolvedValueOnce(envelope(null,undefined,500))
        await expect(store.dispatch(commentAdminApi.endpoints.auditComment.initiate({ownerUserId:7,id:1,approved:0,reason:'reason'})).unwrap()).rejects.toBeTruthy()
        expect(http.get).toHaveBeenCalledTimes(1)
        http.delete.mockResolvedValueOnce(envelope('ok'))
        await store.dispatch(commentAdminApi.endpoints.deleteComment.initiate({ownerUserId:7,id:1})).unwrap()
        await vi.waitFor(()=>expect(http.get).toHaveBeenCalledTimes(2))
        expect(http.get.mock.calls[1][1].params.page).toBe(3)
        expect(JSON.stringify(Object.keys(store.getState().privateApi.queries))).not.toContain(localStorage.getItem('tokenKey'))
        request.unsubscribe()
    })
})
