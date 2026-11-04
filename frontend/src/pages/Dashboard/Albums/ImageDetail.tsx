import {useState} from 'react'
import {Button, Input, Modal, Space, TreeSelect, message} from 'antd'
import {StarFilled, StarOutlined} from '@ant-design/icons'
import {galleryApi, galleryError, type GalleryImage, type GalleryFolder, type GalleryPatch} from '../../../apis/galleryApi'
import {assetDisplayName} from '../../../utils/assetName'
import {resolveApiAssetUrl} from '../../../utils/runtimeApi'

type FolderOption={value:number;title:string;children?:FolderOption[]}

export function folderOptions(folders:GalleryFolder[]) {
  const children=(parent:number):FolderOption[]=>
    folders.filter(f=>f.parentId===parent).map(f=>({value:f.id,title:f.name,children:children(f.id)}))
  return [{value:0,title:'未分类',children:children(0)}]
}

export default function ImageDetail({image,folders,onClose,onDelete}:{
  image:GalleryImage;folders:GalleryFolder[];onClose:()=>void;onDelete:(image:GalleryImage)=>void
}) {
  const [current,setCurrent]=useState(image)
  const [mode,setMode]=useState<'name'|'move'|null>(null)
  const [name,setName]=useState(image.displayName||assetDisplayName(image.imageUrl))
  const [description,setDescription]=useState(image.description)
  const [folder,setFolder]=useState(image.folderId)
  const [update,{isLoading}]=galleryApi.useUpdateImageMutation()
  const save=async(patch:GalleryPatch)=>{
    try {
      const result=await update({id:current.imageKey,version:current.version,patch}).unwrap()
      setCurrent(result.state);setMode(null)
      void message.success('图片信息已保存')
    } catch(error) {void message.error(galleryError(error))}
  }
  return <Modal open title={current.displayName||assetDisplayName(current.imageUrl)} onCancel={onClose}
    width={960} footer={<Space wrap>
      <Button icon={current.isFavorite?<StarFilled/>:<StarOutlined/>} loading={isLoading}
        onClick={()=>void save({isFavorite:!current.isFavorite})}>{current.isFavorite?'取消收藏':'收藏'}</Button>
      <Button onClick={()=>setMode(mode==='name'?null:'name')}>重命名</Button>
      <Button onClick={()=>setMode(mode==='move'?null:'move')}>移动到</Button>
      <Button danger disabled={isLoading} onClick={()=>onDelete(current)}>删除</Button>
      <Button onClick={onClose}>关闭</Button>
    </Space>}>
    <img className="albumDetailImage" src={resolveApiAssetUrl(current.imageUrl)} alt={current.displayName||assetDisplayName(current.imageUrl)}/>
    {mode==='name'&&<div className="albumDetailEdit"><Input aria-label="图片显示名" value={name} maxLength={255}
      onChange={e=>setName(e.target.value)} onPressEnter={()=>void save({displayName:name})}/>
      <Button type="primary" disabled={!name.trim()} loading={isLoading} onClick={()=>void save({displayName:name})}>保存名称</Button></div>}
    {mode==='move'&&<div className="albumDetailEdit"><TreeSelect aria-label="目标文件夹" value={folder} treeDefaultExpandAll
      treeData={folderOptions(folders)} onChange={setFolder}/>
      <Button type="primary" loading={isLoading} onClick={()=>void save({folderId:folder})}>移动</Button></div>}
    <label className="albumDescriptionLabel" htmlFor="gallery-description">图片描述</label>
    <Input.TextArea id="gallery-description" value={description} maxLength={2000} showCount
      placeholder="可填写图片主体、风格、用途等信息，便于查找和助手选图" autoSize={{minRows:2,maxRows:5}}
      onChange={e=>setDescription(e.target.value)}/>
    <Button className="albumDescriptionSave" disabled={description===current.description} loading={isLoading}
      onClick={()=>void save({description})}>保存描述</Button>
  </Modal>
}
