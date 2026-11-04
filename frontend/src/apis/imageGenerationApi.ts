import {galleryApi} from './galleryApi'

export interface GenerationDraft {prompt:string; model:string; size:string; quality:string; referenceIds:number[]}
export interface GenerationReference {imageId:number; name:string; digest:string; previewUrl:string}
export interface GenerationJob {
  id:string;request:{prompt:string; model:string; size:string; quality:string;references:GenerationReference[]};
  requestHash:string;status:string;previewUrl:string|null;outputHash:string|null;imageId:number|null;
  error:string|null;usage:Record<string,unknown>|null;createdAt:string
}
export const imageGenerationApi=galleryApi.injectEndpoints({endpoints:builder=>({
  generationOptions:builder.query<{configured:boolean;models:string[];defaultModel:string},void>({
    query:()=>'/api/protect/image-generation/options',
  }),
  generationJobs:builder.query<GenerationJob[],void>({query:()=>'/api/protect/image-generation/jobs'}),
  generationJob:builder.query<GenerationJob,string>({query:id=>`/api/protect/image-generation/jobs/${id}`}),
  createGeneration:builder.mutation<GenerationJob,GenerationDraft>({
    query:body=>({url:'/api/protect/image-generation/jobs',method:'POST',body}),
  }),
  approveGeneration:builder.mutation<GenerationJob,{id:string;version:string}>({
    query:({id,version})=>({url:`/api/protect/image-generation/jobs/${id}/approve`,method:'POST',body:{version}}),
  }),
  acceptGeneration:builder.mutation<GenerationJob,{id:string;version:string}>({
    query:({id,version})=>({url:`/api/protect/image-generation/jobs/${id}/accept`,method:'POST',body:{version}}),
    invalidatesTags:['Images','Folders'],
  }),
  rejectGeneration:builder.mutation<GenerationJob,string>({
    query:id=>({url:`/api/protect/image-generation/jobs/${id}/reject`,method:'POST'}),
  }),
  generationArticle:builder.query<{title:string;description:string;content:string},number>({
    query:id=>`/api/protect/image-generation/articles/${id}`,
  }),
})})
