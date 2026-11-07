import {useState} from 'react'
import {Alert,Button,Dropdown,Tooltip,message} from 'antd'
import {LoadingOutlined,MoreOutlined} from '@ant-design/icons'
import {useDispatch} from 'react-redux'
import type {AppDispatch} from '../../../store'
import {imageGenerationApi as api,type GenerationJob,type GenerationJobSummary} from '../../../apis/imageGenerationApi'
import {galleryError} from '../../../apis/galleryApi'

interface Props {
  items:GenerationJobSummary[]
  active:Pick<GenerationJob,'id'|'status'>|null
  detail:GenerationJob|null
  failed:boolean
  statusNames:Record<string,string>
  onSelect:(item:Pick<GenerationJob,'id'|'status'>)=>void
  onNew:()=>void
  onDeleted:(id:string)=>void
  onRetry:(job:GenerationJob)=>Promise<void>
  onRefresh:()=>void
}

export default function GenerationHistory({items,active,detail,failed,statusNames,onSelect,onNew,onDeleted,onRetry,onRefresh}:Props){
  const dispatch=useDispatch<AppDispatch>()
  const [deleteJob]=api.useDeleteGenerationMutation()
  const [retryJob]=api.useRetryGenerationMutation()
  const [working,setWorking]=useState<string|null>(null)
  const act=async(item:GenerationJobSummary,key:string)=>{
    if(working)return
    setWorking(item.id)
    try{
      if(key==='copy'){
        const value=detail?.id===item.id?detail:await dispatch(api.endpoints.generationJob.initiate(item.id,{subscribe:false,forceRefetch:true})).unwrap()
        try{
          await navigator.clipboard.writeText(value.request.prompt)
          void message.success('完整提示词已复制')
        }catch{
          void message.error('复制未完成，请打开该记录手动复制完整提示词')
        }
      }else if(key==='delete'){
        await deleteJob(item.id).unwrap()
        dispatch(api.util.updateQueryData('generationJobs',undefined,rows=>rows.filter(row=>row.id!==item.id)))
        onDeleted(item.id)
        onRefresh()
        void message.success('生图记录已删除')
      }else if(key==='retry'){
        const value=await retryJob(item.id).unwrap()
        if(value.id===item.id||value.status!=='pending')throw new Error('重试未返回新的待审批草稿')
        await onRetry(value)
        onRefresh()
        void message.success('已创建新的待审批草稿，请核对提示词与参考图')
      }
    }catch(error){
      onRefresh()
      void message.error(error instanceof Error?error.message:galleryError(error))
    }
    finally{setWorking(null)}
  }
  return <aside className="generationHistory" aria-label="生图历史">
    <Button block onClick={onNew}>新建图片</Button>
    {failed&&<Alert type="error" message="任务列表加载失败" action={<Button onClick={onRefresh}>重试</Button>}/>}
    {items.map(item=>{
      const status=active?.id===item.id?active.status:item.status
      const running=status==='generating'||status==='saving'
      return <div key={item.id} className="generationHistoryItem" data-job-id={item.id} data-running={running?'true':undefined} data-active={active?.id===item.id?'true':undefined}>
        <Tooltip title={item.title} placement="right">
          <button type="button" className="generationHistorySelect" aria-current={active?.id===item.id?'true':undefined} onClick={()=>onSelect({...item,status})}>
            <span className="generationHistoryStatus">{running&&<LoadingOutlined spin/>}{statusNames[status]||status}</span>
            <span className="generationHistoryTitle">{item.title||'未命名图片'}</span>
          </button>
        </Tooltip>
        <Dropdown autoFocus trigger={['click']} placement="bottomRight" menu={{items:[
          {key:'copy',label:'复制完整提示词'},
          {key:'retry',label:'重试',disabled:running},
          {key:'delete',label:'删除记录',danger:true,disabled:running},
        ],onClick:({key})=>void act(item,key)}}>
          <Button type="text" size="small" className="generationHistoryMore" aria-label={'生图记录操作 '+(item.title||'未命名图片')} icon={<MoreOutlined/>} loading={working===item.id} disabled={!!working}/>
        </Dropdown>
      </div>
    })}
  </aside>
}
