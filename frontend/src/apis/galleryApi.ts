import {createApi, fetchBaseQuery, type FetchArgs, type BaseQueryFn} from '@reduxjs/toolkit/query/react'
import {runtimeBaseURL} from '../utils/runtimeApi'
import getToken from './getToken'
import {clearAuthToken} from '../utils/authSession'

export interface GalleryImage {
  imageKey:number; imageUrl:string; displayName:string|null; description:string;
  folderId:number; isFavorite:boolean; version:string; storage?:StorageKind; storagePath?:string
}
export interface GalleryFolder {id:number; parentId:number; name:string; imageCount:number}
export type StorageKind='local'|'r2'
export interface GalleryFilters {folderId?:number; search?:string; favorite?:boolean;storage?:StorageKind}
export interface GalleryTransferIntent {mode:'move'|'copy';imageIds:number[];storage?:StorageKind;folderId:number}
export interface GalleryTransferPreview {version:string;expiresAt:number;intent:GalleryTransferIntent;destinationName:string;images:GalleryImage[]}
export interface GalleryTransferJob {id:string;status:'queued'|'copying'|'published'|'complete'|'failed';result:{mode:'move'|'copy';sourceIds:number[];imageIds:number[]}|null;error:string|null}
export interface GalleryPage {items:GalleryImage[]; nextCursor:number|null}
export const GALLERY_ACTION_LIMIT=100
export type GalleryImageActionIntent={action:'move';imageIds:number[];folderId:number}|{action:'delete';imageIds:number[]}
export interface GalleryImageActionPreview {
  version:string;expiresAt:number;intent:GalleryImageActionIntent;matchedIds:number[]
  preview:{imageId:number;displayName:string|null;folderId:number;isFavorite:boolean}[]
  previewTruncated:boolean;destination:{id:number;name:string;parentId:number}|null
}
export interface GalleryImageActionResult {
  action:'move'|'delete';changed:boolean;beforeVersion:string;matchedIds:number[];changedIds:number[];cleanupPendingIds:number[]
}
export type GalleryPatch = Partial<Pick<GalleryImage,'displayName'|'description'|'folderId'|'isFavorite'>>

const request=fetchBaseQuery({baseUrl:runtimeBaseURL,timeout:15000,prepareHeaders:headers=>{
  const token=getToken()
  if(token) headers.set('Authorization',token.startsWith('Bearer ')?token:`Bearer ${token}`)
  return headers
}})
const baseQuery:BaseQueryFn<string|FetchArgs,unknown,{status:string|number;error:string}>=async(args,api,extra)=>{
  const token=getToken()
  const result=await request(args,api,extra)
  if(result.error?.status===401) clearAuthToken(token)
  if(result.error){
    const failure='data' in result.error?result.error.data as {message?:unknown}:undefined
    return {error:{status:result.error.status,error:typeof failure?.message==='string'?failure.message:'图库请求失败，请稍后重试'}}
  }
  const body=result.data as {code?:number;message?:string;data?:unknown}
  if(body?.code!==200) return {error:{status:body?.code??500,error:body?.message||'图库请求失败'}}
  return {data:body.data}
}

export const galleryApi=createApi({
  reducerPath:'galleryApi',baseQuery,tagTypes:['Images','Folders','GenerationJobs','Transfers'],keepUnusedDataFor:60,
  endpoints:builder=>({
    images:builder.infiniteQuery<GalleryPage,GalleryFilters,number|undefined>({
      infiniteQueryOptions:{initialPageParam:undefined,getNextPageParam:page=>page.nextCursor??undefined},
      query:({queryArg,pageParam})=>({url:'/api/protect/gallery/images',params:{...queryArg,before:pageParam,limit:30}}),
      providesTags:['Images'],
    }),
    transfers:builder.query<GalleryTransferJob[],void>({query:()=>'/api/protect/gallery/transfers',providesTags:['Transfers']}),
    prepareTransfer:builder.mutation<GalleryTransferPreview,GalleryTransferIntent>({
      query:body=>({url:'/api/protect/gallery/transfers/prepare',method:'POST',body}),
    }),
    changeTransfer:builder.mutation<GalleryTransferJob,Pick<GalleryTransferPreview,'version'|'expiresAt'|'intent'>>({
      query:body=>({url:'/api/protect/gallery/transfers',method:'POST',body}),invalidatesTags:['Transfers'],
    }),
    folders:builder.query<GalleryFolder[],void>({query:()=>'/api/protect/gallery/folders',providesTags:['Folders']}),
    updateImage:builder.mutation<{changed:boolean;state:GalleryImage},{id:number;version:string;patch:GalleryPatch}>({
      query:({id,version,patch})=>({url:`/api/protect/gallery/images/${id}`,method:'PUT',body:{version,...patch}}),
      invalidatesTags:['Images','Folders'],
    }),
    prepareImageAction:builder.mutation<GalleryImageActionPreview,GalleryImageActionIntent>({
      query:body=>({url:'/api/protect/gallery/image-actions/prepare',method:'POST',body}),
    }),
    changeImages:builder.mutation<GalleryImageActionResult,Pick<GalleryImageActionPreview,'version'|'expiresAt'|'intent'>>({
      query:body=>({url:'/api/protect/gallery/image-actions',method:'POST',body}),
      invalidatesTags:result=>result?.action==='delete'?['Images','Folders','GenerationJobs']:['Images','Folders'],
    }),
    createFolder:builder.mutation<GalleryFolder,{parentId:number;name:string}>({
      query:body=>({url:'/api/protect/gallery/folders',method:'POST',body}),invalidatesTags:['Folders'],
    }),
    deleteFolder:builder.mutation<boolean,number>({
      query:id=>({url:`/api/protect/gallery/folders/${id}`,method:'DELETE'}),invalidatesTags:['Folders'],
    }),
    resolveImage:builder.query<GalleryImage,string>({
      query:url=>({url:'/api/protect/gallery/images',params:{url,limit:1}}),
      transformResponse:(page:GalleryPage)=>{
        if(!page.items[0]) throw new Error('上传已完成，但未找到图库记录')
        return page.items[0]
      },
    }),
  }),
})

export const galleryError=(error:unknown)=>
  error && typeof error==='object' && 'error' in error ? String(error.error) : '图库操作失败，请刷新后重试'
