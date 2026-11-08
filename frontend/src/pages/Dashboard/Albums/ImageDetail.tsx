import SweepLoading from '../../../components/SweepLoading'
import {useState} from 'react'
import {Button, Input, Modal, Space, message} from 'antd'
import {StarFilled, StarOutlined} from '@ant-design/icons'
import {galleryApi, galleryError, type GalleryImage, type GalleryFolder, type GalleryPatch} from '../../../apis/galleryApi'
import {assetDisplayName} from '../../../utils/assetName'
import AssetImage from '../../../components/AssetImage'

type FolderOption={value:number;title:string;children?:FolderOption[]}

export function folderOptions(folders:GalleryFolder[]) {
  const children=(parent:number):FolderOption[]=>
    folders.filter(f=>f.parentId===parent).map(f=>({value:f.id,title:f.name,children:children(f.id)}))
  return [{value:0,title:'未分类'},...children(0)]
}

export default function ImageDetail({image,open=true,onClose,onDelete,onCopy,onMove}:{
  image:GalleryImage;open?:boolean;folders:GalleryFolder[];onClose:()=>void;onDelete:(image:GalleryImage)=>void;onCopy:(image:GalleryImage)=>void;onMove:(image:GalleryImage)=>void
}) {
  const [current,setCurrent]=useState(image)
  const [mode,setMode]=useState<'name'|null>(null)
  const [name,setName]=useState(image.displayName||assetDisplayName(image.imageUrl))
  const [description,setDescription]=useState(image.description)
  const [update,{isLoading}]=galleryApi.useUpdateImageMutation()
  const save=async(patch:GalleryPatch)=>{
    try {
      const result=await update({id:current.imageKey,version:current.version,patch}).unwrap()
      setCurrent(result.state);setMode(null)
      void message.success('图片信息已保存')
    } catch(error) {void message.error(galleryError(error))}
  }
  return <Modal open={open} title={current.displayName||assetDisplayName(current.imageUrl)} onCancel={onClose}
    width={960} footer={<Space wrap>
      <Button icon={current.isFavorite?<StarFilled/>:<StarOutlined/>} loading={isLoading}
        onClick={()=>void save({isFavorite:!current.isFavorite})}>{current.isFavorite?'取消收藏':'收藏'}</Button>
      <Button onClick={()=>setMode(mode==='name'?null:'name')}>重命名</Button>
      <Button onClick={()=>onMove(current)}>移动到</Button>
      <Button onClick={()=>onCopy(current)}>复制到</Button>
      <Button danger disabled={isLoading} onClick={()=>onDelete(current)}>删除</Button>
      <Button onClick={onClose}>关闭</Button>
    </Space>}>
    <AssetImage pending={<SweepLoading/>} className="albumDetailImage" loading="eager" src={current.imageUrl} alt={current.displayName||assetDisplayName(current.imageUrl)}/>
    {mode==='name'&&<div className="albumDetailEdit"><Input aria-label="图片显示名" value={name} maxLength={255}
      onChange={e=>setName(e.target.value)} onPressEnter={()=>void save({displayName:name})}/>
      <Button type="primary" disabled={!name.trim()} loading={isLoading} onClick={()=>void save({displayName:name})}>保存名称</Button></div>}
    <label className="albumDescriptionLabel" htmlFor="gallery-description">图片描述</label>
    <Input.TextArea id="gallery-description" value={description} maxLength={2000} showCount
      placeholder="可填写图片主体、风格、用途等信息，便于查找和助手选图" autoSize={{minRows:2,maxRows:5}}
      onChange={e=>setDescription(e.target.value)}/>
    <Button className="albumDescriptionSave" disabled={description===current.description} loading={isLoading}
      onClick={()=>void save({description})}>保存描述</Button>
  </Modal>
}
