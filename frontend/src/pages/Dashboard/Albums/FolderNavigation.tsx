import {Button, Dropdown, Tabs} from 'antd'
import type {TabsProps} from 'antd'
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
  const children=(parent:number,path:string[]=[]):NonNullable<TabsProps['items']>=>
    folders.filter(folder=>folder.parentId===parent).flatMap(folder=>{
      const names=[...path,folder.name]
      return [{key:'folder:'+folder.id,
        label:<span className="albumFolderLabel" title={names.join(' / ')}>
          <FolderOutlined aria-hidden/><span>{names.join(' / ')}</span><small>{folder.imageCount}</small>
        </span>},...children(folder.id,names)]
    })
  return <nav className="albumFolderNavigation" aria-label="图库分类">
    <Tabs activeKey={selected===undefined?'all':'folder:'+selected}
      onChange={key=>onSelect(key==='all'?undefined:Number(key.slice(7)))}
      items={[{key:'all',label:'全部图片'},{key:'folder:0',label:'未分类'},...children(0)]}
      tabBarExtraContent={
      <Dropdown trigger={['click']} menu={{items:[{key:'delete',label:'删除文件夹',danger:true,
        disabled:!empty}],onClick:()=>{if(current&&empty)onDelete(current)}}}>
        <Button type="text" size="small" icon={<MoreOutlined/>} aria-label="文件夹操作"
          disabled={!current}/>
      </Dropdown>
      }/>
  </nav>
}
