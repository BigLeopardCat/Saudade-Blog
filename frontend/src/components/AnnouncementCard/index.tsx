import {t as tr, useLocale} from '../../i18n';
import type {AnnouncementItem} from '../../apis/AnnouncementMethods'
import './index.sass'

export function announcementTime(value: string) {
    return value?.replace('T', ' ').slice(0, 16) || '时间未提供'
}
export default function AnnouncementCard({item, number, preview = false, tabIndex, onOpen}: {
    item: AnnouncementItem; number: number; preview?: boolean; tabIndex?: number; onOpen: () => void
}) {
    useLocale();
    return <article className="AnnouncementCard" onClick={() => {if (!preview) onOpen()}}>
        <span className="announcementNumber">{String(number).padStart(2, '0')}</span>
        <div className="announcementMeta"><span>{tr("公告")}</span><time dateTime={item.createdAt.replace(' ', 'T') + (item.createdAt.includes('T') ? '' : '+08:00')}>{announcementTime(item.createdAt)}</time></div>
        <h3>{preview ? item.title : <button type="button" tabIndex={tabIndex}>{item.title}</button>}</h3>
        <p>{item.content}</p>
        <div className="announcementCardFooter">{tr("查看公告")}<span aria-hidden="true">↗</span></div>
    </article>
}
