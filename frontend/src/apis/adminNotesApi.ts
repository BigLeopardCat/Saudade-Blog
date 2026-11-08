import {privateApi} from './privateApi'
import http from './axios'
import {normalizeNoteRows} from '../utils/noteRows'
import type {NoteType} from '../interface/NoteType'

export interface AdminNoteQuery {
  page:number; page_size:number; status?:'all'|'public'|'private'|'draft';
  keyword?:string; title?:string; categories?:string; is_top?:number;
  start_date?:string; end_date?:string; tags?:string
}
export interface AdminNotePage {items:NoteType[]; total:number; page:number; pageSize:number}

export const adminNotesApi=privateApi.enhanceEndpoints({addTagTypes:['AdminNotes','AdminNoteCount']})
  .injectEndpoints({endpoints:builder=>({
    adminNotes:builder.query<AdminNotePage,AdminNoteQuery>({
      async queryFn(query,{signal}){
        try{
          const response=await http({url:'/api/protected/notes',params:query,signal})
          const page=response.data?.data
          if(response.status!==200||response.data?.code!==200||!page||!Array.isArray(page.items)
            ||!Number.isSafeInteger(page.total)||page.total<0||!Number.isSafeInteger(page.page)||page.page<1
            ||page.pageSize!==query.page_size||page.items.length>query.page_size)throw new Error('Invalid article page')
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
