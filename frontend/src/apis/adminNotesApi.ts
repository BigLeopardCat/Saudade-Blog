import {privateApi} from './privateApi'
import http from './axios'
import type {ListQuery} from '../pages/Dashboard/Notes/AllNotes/listState'
import {listRequest, normalizeNoteRows} from '../pages/Dashboard/Notes/AllNotes/listState'
import type {NoteType} from '../interface/NoteType'

export interface AdminNotePage {items:NoteType[]; total:number; page:number; pageSize:number}

export const adminNotesApi=privateApi.enhanceEndpoints({addTagTypes:['AdminNotes','AdminNoteCount']})
  .injectEndpoints({endpoints:builder=>({
    adminNotes:builder.query<AdminNotePage,ListQuery>({
      async queryFn(query,{signal}){
        try{
          const response=await http({url:'/api/protected/notes',params:listRequest(query),signal})
          const page=response.data?.data
          if(response.status!==200||response.data?.code!==200||!page||!Array.isArray(page.items)
            ||!Number.isSafeInteger(page.total)||page.total<0||!Number.isSafeInteger(page.page)||page.page<1
            ||page.pageSize!==query.size||page.items.length>query.size)throw new Error('Invalid article page')
          return {data:{...page,items:normalizeNoteRows(page.items)}}
        }catch{
          return {error:{message:'文章列表加载失败，请重试'}}
        }
      },
      providesTags:['AdminNotes'],
    }),
    adminNoteCount:builder.query<number,void>({
      async queryFn(_,{signal}){
        try{
          const response=await http({url:'/api/protected/notes/count',signal})
          const total=response.data?.data
          if(response.status!==200||response.data?.code!==200||!Number.isSafeInteger(total)||total<0)
            throw new Error('Invalid article count')
          return {data:total}
        }catch{
          return {error:{message:'文章数量加载失败，请重试'}}
        }
      },
      providesTags:['AdminNoteCount'],
    }),
  })})
