import {useState} from 'react'
import {Alert, Button, Modal, TreeSelect, message} from 'antd'
import {galleryApi, galleryError, type GalleryFolder, type GalleryImage, type GalleryMovePreview} from '../../../apis/galleryApi'
import {folderOptions} from './ImageDetail'

interface Props {items:GalleryImage[];folders:GalleryFolder[];onClose:()=>void;onComplete:()=>void}

export default function MoveImages({items,folders,onClose,onComplete}:Props) {
  const [target,setTarget]=useState<number|undefined>()
  const [preview,setPreview]=useState<GalleryMovePreview|null>(null)
  const [error,setError]=useState('')
  const [prepare,{isLoading:preparing}]=galleryApi.usePrepareMoveMutation()
  const [move,{isLoading:moving}]=galleryApi.useMoveImagesMutation()
  const busy=preparing||moving
  const submit=async()=>{
    if(target===undefined||busy)return
    setError('')
    try {
      if(!preview){
        setPreview(await prepare({action:'move',imageIds:items.map(item=>item.imageKey),folderId:target}).unwrap())
      }else{
        const result=await move({version:preview.version,expiresAt:preview.expiresAt,intent:preview.intent}).unwrap()
        void message.success(result.changedIds.length?'已移动 '+result.changedIds.length+' 张图片':'图片已在目标文件夹')
        onComplete()
      }
    }catch(failure){setError(galleryError(failure))}
  }
  return <Modal title="移动图片" open width={520} closable={!busy} maskClosable={!busy} keyboard={!busy}
    onCancel={()=>{if(!busy)onClose()}} footer={[
      <Button key="cancel" disabled={busy} onClick={onClose}>取消</Button>,
      <Button key="target" disabled={busy||!preview} onClick={()=>{setPreview(null);setError('')}}>修改目标</Button>,
      <Button key="confirm" type="primary" style={{width:120}} loading={busy} disabled={target===undefined}
        onClick={()=>void submit()}>{preview?'确认移动':'查看预览'}</Button>,
    ]}>
    <div className="albumMoveBody">
      <p>将所选 {preview?preview.matchedIds.length:items.length} 张图片移动到目标文件夹。图片地址、文章引用与收藏保持不变。</p>
      <TreeSelect aria-label="目标文件夹" placeholder="选择目标文件夹" value={target} disabled={busy||!!preview}
        treeData={folderOptions(folders)} treeDefaultExpandAll onChange={setTarget} style={{width:'100%'}}/>
      {preview&&<section aria-label="移动预览">
        <p>目标：<strong>{preview.destination?.name||(preview.intent.folderId===0?'未分类':`文件夹 #${preview.intent.folderId}`)}</strong> · 共 {preview.matchedIds.length} 张</p>
        <ul>{preview.preview.map(item=><li key={item.imageId}>{item.displayName||`图片 #${item.imageId}`}</li>)}</ul>
        {preview.previewTruncated&&<p>另有 {preview.matchedIds.length-preview.preview.length} 张图片。</p>}
        <p>确认后整批移动；图片或目标目录已变化时，本批操作会取消。</p>
      </section>}
    </div>
    {error&&<Alert type="error" showIcon message={error}/>}
  </Modal>
}
