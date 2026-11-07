import {Button, Dropdown, Tree} from 'antd'
import type {TreeDataNode} from 'antd'
import {FolderOutlined, MoreOutlined} from '@ant-design/icons'
import type {GalleryFolder} from '../../../apis/galleryApi'

interface Props {
  folders:GalleryFolder[]
  selected?:number
  onSelect:(id:number|undefined)=>void
  onDelete:(folder:GalleryFolder)=>void
}

export default function FolderNavigation({folders,selected,onSelect,onDelete}:Props) {
  const current=folders.find(folder=>folder.id===selected)
  const empty=current&&current.imageCount===0&&!folders.some(folder=>folder.parentId===current.id)
  const children=(parent:number):TreeDataNode[]=>
    folders.filter(folder=>folder.parentId===parent).map(folder=>({
      key:'folder:'+folder.id,
      title:<span className="albumFolderLabel"><span>{folder.name}</span><small>{folder.imageCount}</small></span>,
      children:children(folder.id),
    }))
  return <nav className="albumFolderNavigation" aria-label="图库分类">
    <div className="albumFolderHeading"><strong>文件夹</strong>
      <Dropdown trigger={['click']} menu={{items:[{key:'delete',label:'删除文件夹',danger:true,
        disabled:!empty}],onClick:()=>{if(current&&empty)onDelete(current)}}}>
        <Button type="text" size="small" icon={<MoreOutlined/>} aria-label="文件夹操作"
          disabled={!current}/>
      </Dropdown>
    </div>
    <Tree key={folders.map(folder=>folder.id).join(",")} aria-label="图库文件夹" blockNode showIcon defaultExpandAll
      selectedKeys={[selected===undefined?'all':'folder:'+selected]}
      onSelect={keys=>{if(keys.length)onSelect(keys[0]==='all'?undefined:Number(String(keys[0]).slice(7)))}}
      treeData={[{key:'all',title:'全部图片',icon:<FolderOutlined/>},
        {key:'folder:0',title:'未分类',icon:<FolderOutlined/>},...children(0)]}/>
  </nav>
}
