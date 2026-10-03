import http from "./axios.tsx";

/** `GET /api/public/announcements` 的单行（对应后端 `AnnouncementDto`：四个字符串字段，
 * 时间已是 +08:00 钟面，展示前过一遍 `utils/cnTime.ts`）。
 *
 * 20261004：从 `components/AnnouncementModal/pending.ts` 那份私有定义搬到这里并导出
 * —— 首页公告栏（`ContentHome/AnnounceBoard`）读的是同一个接口。
 * `pending.ts` 自己那份私有副本**保持不动**：它只吃 `list[0]`，语义与列表展示不同。 */
export interface AnnouncementRow {
    id: number
    title: string
    content: string
    createdAt?: string
    updatedAt?: string
}

function getAnnouncements() {
    return http({
        url: '/api/public/announcements',
        method: 'GET'
    })
}

function createAnnouncement(data: { title: string; content: string }) {
    return http({
        url: '/api/protected/announcements',
        method: 'POST',
        data: data
    })
}

function updateAnnouncement(id: number, data: { title: string; content: string }) {
    return http({
        url: `/api/protected/announcements/${id}`,
        method: 'PUT',
        data: data
    })
}

function deleteAnnouncement(ids: number[]) {
    return http({
        url: '/api/protected/announcements',
        method: 'DELETE',
        data: ids
    })
}

export { getAnnouncements, createAnnouncement, updateAnnouncement, deleteAnnouncement }
