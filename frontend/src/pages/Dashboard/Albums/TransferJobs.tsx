import {useEffect,useRef,useState} from 'react'
import {Alert} from 'antd'
import {useDispatch} from 'react-redux'
import {galleryApi} from '../../../apis/galleryApi'
import {catalogApi} from '../../../store/catalogApi'
import {adminNotesApi} from '../../../apis/adminNotesApi'
import type {AppDispatch} from '../../../store'

export default function TransferJobs(){
  const [poll,setPoll]=useState(false)
  const {data}=galleryApi.useTransfersQuery(undefined,{pollingInterval:poll?2000:0,skipPollingIfUnfocused:true})
  const previous=useRef(new Map<string,string>())
  const observed=useRef(false)
  const dispatch=useDispatch<AppDispatch>()
  const active=data?.filter(job=>['queued','copying','published'].includes(job.status))??[]
  useEffect(()=>{
    setPoll(!!data?.some(job=>['queued','copying','published'].includes(job.status)))
    let changed=false
    let moved=false
    for(const job of data??[]){
      if(observed.current&&['published','complete'].includes(job.status)&&previous.current.get(job.id)!==job.status){
        changed=true
        moved ||= job.result?.mode==='move'
      }
      previous.current.set(job.id,job.status)
    }
    observed.current=true
    if(changed)dispatch(galleryApi.util.invalidateTags(['Images','Folders','GenerationJobs']))
    if(moved){
      dispatch(catalogApi.util.invalidateTags(['Search']))
      dispatch(adminNotesApi.util.invalidateTags(['AdminNotes']))
    }
  },[data,dispatch])
  const failures=data?.filter(job=>job.status==='failed').slice(0,2)??[]
  if(!active.length&&!failures.length)return null
  return <>{!!active.length&&<Alert showIcon type="info" message={`正在处理 ${active.length} 项图片传输`} description="可以离开页面；文件保存完成后更新图库，再清理移动操作的源文件。"/>}
    {failures.map(job=><Alert key={job.id} closable showIcon type="error" message="图片传输未完成" description={job.error||'源文件保留，请检查存储设置后重新准备。'}/>)}
  </>
}
