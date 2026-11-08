import {useEffect,useRef,useState} from 'react'
import {Alert} from 'antd'
import {useDispatch} from 'react-redux'
import {galleryApi} from '../../../apis/galleryApi'
import type {AppDispatch} from '../../../store'

export default function TransferJobs(){
  const [poll,setPoll]=useState(false)
  const {data}=galleryApi.useTransfersQuery(undefined,{pollingInterval:poll?2000:0,skipPollingIfUnfocused:true})
  const previous=useRef(new Map<string,string>())
  const dispatch=useDispatch<AppDispatch>()
  const active=data?.filter(job=>['queued','copying','published'].includes(job.status))??[]
  useEffect(()=>{
    setPoll(!!data?.some(job=>['queued','copying','published'].includes(job.status)))
    let changed=false
    for(const job of data??[]){
      if(['published','complete'].includes(job.status)&&previous.current.get(job.id)!==job.status)changed=true
      previous.current.set(job.id,job.status)
    }
    if(changed)dispatch(galleryApi.util.invalidateTags(['Images','Folders','GenerationJobs']))
  },[data,dispatch])
  if(!active.length)return null
  return <Alert showIcon type="info" message={`正在处理 ${active.length} 项图片传输`} description="可以离开页面；文件保存完成后更新图库，再清理移动操作的源文件。"/>
}
