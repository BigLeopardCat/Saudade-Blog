import { Avatar } from "antd";
import dayjs from "dayjs";
import type { NoteType } from "../../interface/NoteType";
import { noteAuthor } from "../../utils/noteAuthor";

interface NoteBylineProps {
    item: NoteType
    /** 站点级署名（redux `state.user.name`）——只在文章没有作者记录时用 */
    siteName?: string | null
    /** 站点级头像（redux `state.user.avatar`）——同上 */
    siteAvatar?: string | null
    compact?: boolean
    card?: boolean
}

const NoteByline = ({ item, siteName, siteAvatar, compact = false, card = false }: NoteBylineProps) => {
    const who = noteAuthor(item, { name: siteName, avatar: siteAvatar });

    if (card) return <>
        <span className="noteCardAuthor" title={who.name}><Avatar src={who.avatar || undefined} size={16}/><span>{who.name}</span></span>
        <time className="post-date" dateTime={dayjs(item.createTime).isValid() ? dayjs(item.createTime).toISOString() : undefined}
            title={`更新于 ${dayjs(item.updateTime).format('YYYY-MM-DD')}`}>{dayjs(item.createTime).format('YYYY-MM-DD')}</time>
    </>;
    return (
        <>
            <Avatar src={who.avatar || undefined} size={compact ? 28 : 40} style={{ marginRight: 10 }} />
            <span style={{ fontWeight: 'bold', marginRight: 10, lineHeight: '22px', fontSize: '14px' }}>{who.name}</span>
            <div style={{ position: 'relative', display: 'flex', flexDirection: 'column' }}>
                <span style={{ fontSize: 12, color: '#7f7e7e', lineHeight: '22px' }} className='post-date'>
                    <i className="iconfont icon-naozhong icon" style={{ fontSize: 14, display: 'inline', marginRight: '4px' }}></i>
                    发布于 {dayjs(item.createTime).format('YYYY-MM-DD')}
                </span>
                {!compact && <span style={{ position: 'absolute', top: '100%', marginTop: '6px', left: 0, fontSize: 12, color: '#7f7e7e', lineHeight: '22px', whiteSpace: 'nowrap' }} className='post-date'>
                    <i className="iconfont icon-naozhong icon" style={{ fontSize: 14, display: 'inline', marginRight: '4px' }}></i>
                    更新于 {dayjs(item.updateTime).format('YYYY-MM-DD')}
                </span>}
            </div>
        </>
    )
}

export default NoteByline;
