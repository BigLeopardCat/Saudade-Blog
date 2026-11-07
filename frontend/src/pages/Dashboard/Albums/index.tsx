import AssetImage from '../../../components/AssetImage'
import {useEffect, useMemo, useState} from 'react'
import {useDispatch} from 'react-redux'
import {Alert, Breadcrumb, Button, Card, Checkbox, Empty, Input, Modal, Segmented, Space, Spin, Upload, message} from 'antd'
import type {UploadProps, UploadFile} from 'antd'
import {AppstoreOutlined, FolderAddOutlined, InboxOutlined, StarFilled, UnorderedListOutlined} from '@ant-design/icons'
import {useNavigate} from 'react-router-dom'
import type {AppDispatch} from '../../../store'
import {galleryApi, galleryError, GALLERY_MOVE_LIMIT, type GalleryFolder, type GalleryImage} from '../../../apis/galleryApi'
import {delImages, getR2Usage, uploadImages, type UploadTarget} from '../../../apis/ImageMethods'
import ImageCompression from '../../../apis/ImageCompression'
import type {R2Usage} from '../../../interface/Setting'
import {uploadBlocked, usagePercent} from '../../../utils/r2Quota'
import {assetDisplayName} from '../../../utils/assetName'
import ImageDetail from './ImageDetail'
import ImageGeneration from './ImageGeneration'
import FolderNavigation from './FolderNavigation'
import MoveImages from './MoveImages'
import './index.sass'

export default function Albums() {
  const [generation,setGeneration]=useState(false)
  const dispatch=useDispatch<AppDispatch>()
  const navigate=useNavigate()
  const [folderId,setFolderId]=useState<number|undefined>()
  const [search,setSearch]=useState('')
  const [favorite,setFavorite]=useState(false)
  const [view,setView]=useState<'grid'|'list'>(()=>{
    try {return localStorage.getItem('albumViewMode')==='list'?'list':'grid'} catch {return 'grid'}
  })
  const [selected,setSelected]=useState<Set<number>>(new Set())
  const [detail,setDetail]=useState<GalleryImage|null>(null)
  const [deleteItems,setDeleteItems]=useState<GalleryImage[]>([])
  const [deleting,setDeleting]=useState(false)
  const [moveItems,setMoveItems]=useState<GalleryImage[]>([])
  const [deleteFolderTarget,setDeleteFolderTarget]=useState<GalleryFolder|null>(null)
  const [removingFolder,setRemovingFolder]=useState(false)
  const [newFolder,setNewFolder]=useState(false)
  const [folderName,setFolderName]=useState('')
  const [uploadTarget,setUploadTarget]=useState<UploadTarget|null>(null)
  const [uploadedFiles,setUploadedFiles]=useState<UploadFile[]>([])
  const [r2,setR2]=useState<R2Usage|null>(null)
  const query=galleryApi.useImagesInfiniteQuery({folderId,search:search||undefined,favorite:favorite||undefined})
  const foldersQuery=galleryApi.useFoldersQuery()
  const folders=foldersQuery.data??[]
  const [createFolder,{isLoading:creating}]=galleryApi.useCreateFolderMutation()
  const [deleteFolder]=galleryApi.useDeleteFolderMutation()
  const [updateImage]=galleryApi.useUpdateImageMutation()
  const images=useMemo(()=>query.data?.pages.flatMap(page=>page.items)??[],[query.data])
  const paths=useMemo(()=>{
    const result=[]; let current=folders.find(f=>f.id===folderId)
    while(current){result.unshift(current);current=folders.find(f=>f.id===current?.parentId)}
    return result
  },[folders,folderId])
  useEffect(()=>{setSelected(new Set())},[folderId,search,favorite])
  const loadR2=()=>getR2Usage().then(res=>{if(res.data?.code===200)setR2(res.data.data)}).catch(()=>{})
  useEffect(()=>{void loadR2()},[])
  const blocked=uploadBlocked(r2)
  const canUploadR2=!!r2?.configured&&!blocked.blocked
  const chooseView=(value:'grid'|'list')=>{
    setView(value);try {localStorage.setItem('albumViewMode',value)} catch { /* Optional preference. */ }
  }
  const toggle=(id:number,checked:boolean)=>setSelected(before=>{
    const next=new Set(before);if(checked)next.add(id);else next.delete(id);return next
  })
  const chooseFolder=(id:number|undefined)=>{setSelected(new Set());setFolderId(id)}
  const beginMove=()=>{
    const items=images.filter(image=>selected.has(image.imageKey))
    if(items.length!==selected.size){void message.warning('所选图片已变化，请重新选择');return}
    setMoveItems(items)
  }
  const remove=async()=>{
    setDeleting(true)
    try {
      const res=await delImages(deleteItems.map(image=>image.imageUrl))
      if(res.data?.code!==200) throw new Error(res.data?.message||'删除失败')
      if(deleteItems.some(item=>item.imageKey===detail?.imageKey))setDetail(null)
      setDeleteItems([]);setSelected(new Set())
      dispatch(galleryApi.util.invalidateTags(['Images','Folders']))
      void loadR2();void message.success('图片已删除')
    } catch(error){void message.error(error instanceof Error?error.message:'删除失败')}
    finally {setDeleting(false)}
  }
  const addFolder=async()=>{
    try {
      await createFolder({parentId:folderId??0,name:folderName}).unwrap()
      setNewFolder(false);setFolderName('');void message.success('文件夹已创建')
    } catch(error){void message.error(galleryError(error))}
  }
  const removeFolder=async()=>{
    if(!deleteFolderTarget)return
    setRemovingFolder(true)
    try {
      await deleteFolder(deleteFolderTarget.id).unwrap()
      if(folderId===deleteFolderTarget.id)chooseFolder(deleteFolderTarget.parentId||undefined)
      setDeleteFolderTarget(null)
    }catch(error){void message.error(galleryError(error))}
    finally{setRemovingFolder(false)}
  }
  const upload:UploadProps={multiple:true,fileList:uploadedFiles,onChange:info=>setUploadedFiles(info.fileList),
    customRequest:async req=>{
      try {
        if(!uploadTarget) throw new Error('请选择上传目标')
        const file=await ImageCompression(req.file as UploadFile)
        const formData=new FormData();formData.append('file',file)
        const response=await uploadImages(formData, uploadTarget)
        if(response.data?.code!==200||typeof response.data.data!=='string')throw new Error(response.data?.message||'上传失败')
        if(folderId!==undefined||favorite){
          const image=await dispatch(galleryApi.endpoints.resolveImage.initiate(response.data.data,{subscribe:false,forceRefetch:true})).unwrap()
          await updateImage({id:image.imageKey,version:image.version,patch:{
            ...(folderId!==undefined?{folderId}:{}),...(favorite?{isFavorite:true}:{})}}).unwrap()
        }
        req.onSuccess?.(response.data);dispatch(galleryApi.util.invalidateTags(['Images','Folders']))
        void loadR2()
      } catch(error){req.onError?.(error instanceof Error?error:new Error(galleryError(error)));void message.error(galleryError(error))}
    }}

  return <section className="albumLibrary" aria-label="图库">
    <div className="albumToolbar">
      <h2>图库</h2>
      <Space wrap>
        <Button onClick={()=>setGeneration(true)}>AI 生图</Button>
        <Button onClick={()=>setUploadTarget('local')}>传到本站</Button>
        <Button disabled={!canUploadR2} title={!r2?.configured?'请先配置 R2 存储':blocked.reason}
          onClick={()=>setUploadTarget('r2')}>传到 R2</Button>
        <Button onClick={()=>setNewFolder(true)} icon={<FolderAddOutlined/>}>新建文件夹</Button>
      </Space>
    </div>
    <div className="albumFilters">
      <Input.Search aria-label="搜索图库" placeholder="搜索文件名或描述" allowClear onSearch={setSearch}/>
      <Checkbox checked={favorite} onChange={e=>setFavorite(e.target.checked)}>只看收藏</Checkbox>
      <Segmented value={view} onChange={value=>chooseView(value as 'grid'|'list')}
        options={[{value:'grid',label:'平铺',icon:<AppstoreOutlined/>},{value:'list',label:'列表',icon:<UnorderedListOutlined/>}]}/>
      <Button onClick={()=>navigate('/dashboard/usercontrol',{state:{tab:'4'}})}>
        {r2&&!r2.listError?'R2 存储 · '+usagePercent(r2.usedBytes,r2.limitBytes)+'%':'R2 存储'}
      </Button>
    </div>
    <div className="albumWorkspace">
    <FolderNavigation folders={folders} selected={folderId} onSelect={chooseFolder}
      onDelete={setDeleteFolderTarget}/>
    <div className="albumContents">
    <Breadcrumb items={[{title:<button type="button" onClick={()=>chooseFolder(undefined)}>全部图片</button>},
      ...(folderId===0?[{title:'未分类'}]:paths.map(folder=>({title:<button type="button" onClick={()=>chooseFolder(folder.id)}>{folder.name}</button>})))]}/>
    <div className="albumBatchActions">
      <span aria-live="polite">已选 {selected.size} 张</span>
      <Button disabled={!selected.size||selected.size>GALLERY_MOVE_LIMIT}
        title={selected.size>GALLERY_MOVE_LIMIT?`每批最多移动 ${GALLERY_MOVE_LIMIT} 张图片`:undefined} onClick={beginMove}>移动选中</Button>
      <Button danger disabled={!selected.size} onClick={()=>setDeleteItems(images.filter(i=>selected.has(i.imageKey)))}>删除选中</Button>
      <Button type="text" disabled={!selected.size} onClick={()=>setSelected(new Set())}>清除选择</Button>
    </div>
    {(query.isError||foldersQuery.isError)&&<Alert type="error" showIcon message={galleryError(query.error||foldersQuery.error)}
      action={<Button onClick={()=>{void query.refetch();void foldersQuery.refetch()}}>重试</Button>}/>}
    {query.isLoading?<Spin/>:!images.length?<Empty description="这里还没有图片"/>:
      <div className={view==='list'?'albumList':'albumGrid'}>
        {images.map(image=>{
          const name=image.displayName||assetDisplayName(image.imageUrl)
          return <Card key={image.imageKey} size="small" className={'albumTile '+(selected.has(image.imageKey)?'is-checked':'')}>
            <div className="albumOpen">
              <AssetImage className="albumThumb" src={image.imageUrl} alt={name} onClick={()=>setDetail(image)}/>
              <button type="button" className="albumText albumTextOpen" aria-label={'查看图片 '+name} onClick={()=>setDetail(image)}><span className="albumName">{image.isFavorite&&<StarFilled/>}{name}</span>
                {image.description&&<span className="albumCaption">{image.description}</span>}</button>
            </div>
            <Checkbox aria-label={'选择图片 '+name} checked={selected.has(image.imageKey)} onChange={e=>toggle(image.imageKey,e.target.checked)}/>
          </Card>
        })}
      </div>}
    {query.hasNextPage&&<div className="albumMore"><Button loading={query.isFetchingNextPage} onClick={()=>void query.fetchNextPage()}>加载更多</Button></div>}
    </div></div>
    {generation&&<ImageGeneration onClose={()=>setGeneration(false)}/>}
    {detail&&<ImageDetail key={detail.imageKey} image={detail} folders={folders} onClose={()=>setDetail(null)} onDelete={image=>setDeleteItems([image])}/>}
    <Modal title="删除图片" open={!!deleteItems.length} confirmLoading={deleting} okButtonProps={{danger:true,style:{width:100}}}
      cancelButtonProps={{disabled:deleting}} closable={!deleting} maskClosable={!deleting} keyboard={!deleting} okText="删除" cancelText="取消"
      onOk={()=>void remove()} onCancel={()=>{if(!deleting)setDeleteItems([])}}>
      确认删除这 {deleteItems.length} 张图片？如有图片仍被文章使用，本次删除将全部取消。
    </Modal>
    {!!moveItems.length&&<MoveImages items={moveItems} folders={folders} onClose={()=>setMoveItems([])}
      onComplete={()=>{setMoveItems([]);setSelected(new Set())}}/>}
    <Modal title="删除文件夹" open={!!deleteFolderTarget} confirmLoading={removingFolder}
      okText="删除文件夹" cancelText="取消" okButtonProps={{danger:true,style:{width:120}}}
      cancelButtonProps={{disabled:removingFolder}} closable={!removingFolder} maskClosable={!removingFolder} keyboard={!removingFolder}
      onOk={()=>void removeFolder()} onCancel={()=>{if(!removingFolder)setDeleteFolderTarget(null)}}>
      确认删除空文件夹「{deleteFolderTarget?.name}」？
    </Modal>
    <Modal title="新建文件夹" open={newFolder} onOk={()=>void addFolder()} confirmLoading={creating}
      okButtonProps={{disabled:!folderName.trim()}} onCancel={()=>setNewFolder(false)} okText="创建" cancelText="取消">
      <Input aria-label="文件夹名称" value={folderName} maxLength={80} onChange={e=>setFolderName(e.target.value)} onPressEnter={()=>void addFolder()}/>
    </Modal>
    <Modal title={uploadTarget==='r2'?'上传到 R2 图床':'上传到本站服务器'} open={!!uploadTarget} footer={<Button onClick={()=>setUploadTarget(null)}>完成</Button>}
      onCancel={()=>setUploadTarget(null)}>
      <Upload.Dragger {...upload}><p><InboxOutlined/></p><p>点击或拖动图片上传</p><p>图片会加入当前文件夹</p></Upload.Dragger>
    </Modal>
  </section>
}
