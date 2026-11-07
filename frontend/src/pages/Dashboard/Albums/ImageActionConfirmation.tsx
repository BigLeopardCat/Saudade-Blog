import {useState} from 'react'
import {Alert, Button, Modal, TreeSelect, message} from 'antd'
import {galleryApi, galleryError, type GalleryFolder, type GalleryImage, type GalleryImageActionPreview} from '../../../apis/galleryApi'
import {folderOptions} from './ImageDetail'

interface Props {action:'move'|'delete';items:GalleryImage[];folders:GalleryFolder[];onClose:()=>void;onComplete:()=>void}

export default function ImageActionConfirmation({action,items,folders,onClose,onComplete}:Props) {
  const [target,setTarget]=useState<number|undefined>()
  const [preview,setPreview]=useState<GalleryImageActionPreview|null>(null)
  const [error,setError]=useState('')
  const [prepare,{isLoading:preparing}]=galleryApi.usePrepareImageActionMutation()
  const [change,{isLoading:changing}]=galleryApi.useChangeImagesMutation()
  const busy=preparing||changing
  const deleting=action==='delete'
  const label=deleting?'删除':'移动'
  const submit=async()=>{
    if((!deleting&&target===undefined)||busy)return
    setError('')
    try {
      if(!preview){
        const imageIds=items.map(item=>item.imageKey)
        setPreview(await prepare(deleting?{action:'delete',imageIds}:{action:'move',imageIds,folderId:target!}).unwrap())
      }else{
        const result=await change({version:preview.version,expiresAt:preview.expiresAt,intent:preview.intent}).unwrap()
        if(deleting){
          const pending=result.cleanupPendingIds.length
          void message.success(`已从图库移除 ${result.changedIds.length} 张图片`+(pending?`；${pending} 张文件待后台清理`:''))
        }else void message.success(result.changedIds.length?'已移动 '+result.changedIds.length+' 张图片':'图片已在目标文件夹')
        onComplete()
      }
    }catch(failure){setError(galleryError(failure))}
  }
  return <Modal title={label+'图片'} open width={520} closable={!busy} maskClosable={!busy} keyboard={!busy}
    onCancel={()=>{if(!busy)onClose()}} footer={[
      <Button key="cancel" disabled={busy} onClick={onClose}>取消</Button>,
      <Button key="target" disabled={busy||!preview} onClick={()=>{setPreview(null);setError('')}}>{deleting?'重新预览':'修改目标'}</Button>,
      <Button key="confirm" type="primary" aria-label={preview?'确认'+label:'查看预览'} aria-busy={busy} danger={deleting} style={{width:120}} loading={busy} disabled={!deleting&&target===undefined}
        onClick={()=>void submit()}>{preview?'确认'+label:'查看预览'}</Button>,
    ]}>
    <div className="albumActionBody">
      <p>{deleting?`从图库移除所选 ${preview?preview.matchedIds.length:items.length} 张图片，存储文件随后由后台清理。`:
        `将所选 ${preview?preview.matchedIds.length:items.length} 张图片移动到目标文件夹。图片地址、文章引用与收藏保持不变。`}</p>
      {!deleting&&<TreeSelect aria-label="目标文件夹" placeholder="选择目标文件夹" value={target} disabled={busy||!!preview}
        treeData={folderOptions(folders)} treeDefaultExpandAll onChange={setTarget} style={{width:'100%'}}/>}
      {preview&&<section aria-label={label+'预览'}>
        <p>{preview.intent.action==='move'&&<>目标：<strong>{preview.destination?.name||(preview.intent.folderId===0?'未分类':`文件夹 #${preview.intent.folderId}`)}</strong> · </>}共 {preview.matchedIds.length} 张</p>
        <ul>{preview.preview.map(item=><li key={item.imageId}>{item.displayName||`图片 #${item.imageId}`}</li>)}</ul>
        {preview.previewTruncated&&<p>另有 {preview.matchedIds.length-preview.preview.length} 张图片。</p>}
        <p>{deleting?'确认后将从图库移除，不能撤销。':'确认后整批移动；图片或目标目录已变化时，本批操作会取消。'}</p>
      </section>}
    </div>
    <div className="albumActionStatus">{error&&<Alert type="error" showIcon message={error}/>}</div>
  </Modal>
}
