import {useState} from 'react'
import {Alert, Button, Modal, Select, TreeSelect, message} from 'antd'
import {galleryApi,galleryError,type GalleryFolder,type GalleryImage,type GalleryImageActionPreview,type GalleryTransferPreview,type StorageKind} from '../../../apis/galleryApi'
import {folderOptions} from './ImageDetail'

interface Props {action:'move'|'copy'|'delete';items:GalleryImage[];folders:GalleryFolder[];r2Available?:boolean;onClose:()=>void;onComplete:()=>void}
export default function ImageActionConfirmation({action,items,folders,r2Available=false,onClose,onComplete}:Props) {
  const [target,setTarget]=useState<number|undefined>()
  const [storage,setStorage]=useState<StorageKind|'keep'>('keep')
  const [preview,setPreview]=useState<GalleryImageActionPreview|null>(null)
  const [transfer,setTransfer]=useState<GalleryTransferPreview|null>(null)
  const [error,setError]=useState('')
  const [prepare,{isLoading:preparing}]=galleryApi.usePrepareImageActionMutation()
  const [change,{isLoading:changing}]=galleryApi.useChangeImagesMutation()
  const [prepareTransfer,{isLoading:preparingTransfer}]=galleryApi.usePrepareTransferMutation()
  const [changeTransfer,{isLoading:changingTransfer}]=galleryApi.useChangeTransferMutation()
  const busy=preparing||changing||preparingTransfer||changingTransfer
  const deleting=action==='delete'
  const label=deleting?'删除':action==='copy'?'复制':'移动'
  const prepared=!!preview||!!transfer
  const transferring=action==='copy'||(!deleting&&storage!=='keep')
  const submit=async()=>{
    if((!deleting&&target===undefined)||busy)return
    setError('')
    try {
      const imageIds=items.map(item=>item.imageKey)
      if(!prepared){
        if(transferring)setTransfer(await prepareTransfer({mode:action as 'move'|'copy',imageIds,folderId:target!,...(storage==='keep'?{}:{storage})}).unwrap())
        else setPreview(await prepare(deleting?{action:'delete',imageIds}:{action:'move',imageIds,folderId:target!}).unwrap())
      }else if(transfer){
        const job=await changeTransfer({version:transfer.version,expiresAt:transfer.expiresAt,intent:transfer.intent}).unwrap()
        if(job.status==='failed')throw new Error(job.error||'传输未完成，请核对图库状态')
        void message.success(['published','complete'].includes(job.status)?'目标状态已核对':'已提交'+label+'任务，可以离开页面')
        onComplete()
      }else if(preview){
        const result=await change({version:preview.version,expiresAt:preview.expiresAt,intent:preview.intent}).unwrap()
        if(deleting)void message.success(`已从图库移除 ${result.changedIds.length} 张图片`+(result.cleanupPendingIds.length?'；文件待后台清理':''))
        else void message.success(result.changedIds.length?'已移动 '+result.changedIds.length+' 张图片':'图片已在目标文件夹')
        onComplete()
      }
    }catch(failure){setError(galleryError(failure))}
  }
  return <Modal title={label+'图片'} open width={520} closable={!busy} maskClosable={!busy} keyboard={!busy}
    onCancel={()=>{if(!busy)onClose()}} footer={[
      <Button key="cancel" disabled={busy} onClick={onClose}>取消</Button>,
      <Button key="target" disabled={busy||!prepared} onClick={()=>{setPreview(null);setTransfer(null);setError('')}}>{deleting?'重新预览':'修改目标'}</Button>,
      <Button key="confirm" type="primary" aria-label={prepared?'确认'+label:'查看预览'} aria-busy={busy} danger={deleting} style={{width:120}} loading={busy} disabled={!deleting&&target===undefined}
        onClick={()=>void submit()}>{prepared?'确认'+label:'查看预览'}</Button>,
    ]}>
    <div className="albumActionBody">
      <p>{deleting?`从图库移除所选 ${items.length} 张图片，存储文件随后由后台清理。`:action==='copy'?`为所选 ${items.length} 张图片建立独立副本，原图和已有引用保持不变。`:`移动所选 ${items.length} 张图片，已发布内容的图片引用会同步更新。`}</p>
      {!deleting&&<>
        <Select aria-label="目标存储" value={storage} disabled={busy||prepared} onChange={setStorage} style={{width:'100%',marginBottom:12}}
          options={[{value:'keep',label:'保持原存储'},{value:'local',label:'本地存储'},{value:'r2',label:'R2 存储',disabled:!r2Available}]}/>
        <TreeSelect aria-label="目标文件夹" placeholder="选择目标文件夹" value={target} disabled={busy||prepared}
          treeData={folderOptions(folders)} treeDefaultExpandAll onChange={setTarget} style={{width:'100%'}}/>
      </>}
      {prepared&&<section role="region" aria-label={label+'预览'}>
        <p>目标：<strong>{transfer?.destinationName||preview?.destination?.name||'未分类'}</strong> · 共 {items.length} 张</p>
        <ul>{items.slice(0,10).map(item=><li key={item.imageKey}>{item.displayName||`图片 #${item.imageKey}`}</li>)}</ul>
        {items.length>10&&<p>另有 {items.length-10} 张图片。</p>}
        <p>{deleting?'确认后将从图库移除，不能撤销。':transferring?'确认后后台传输；源文件会保留到目标保存成功。':'确认后整批移动；图片或目录已变化时，本批操作会取消。'}</p>
      </section>}
    </div>
    <div className="albumActionStatus">{error&&<Alert type="error" showIcon message={error}/>}</div>
  </Modal>
}
