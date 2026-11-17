import http from "./axios.tsx";

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

export interface AnnouncementItem {
    id: number
    title: string
    content: string
    createdAt: string
    updatedAt?: string
}
export function getPinnedAnnouncements(signal?: AbortSignal) {
    return http.get('/api/public/pinned-announcements', {signal})
}
export function pinAnnouncement(id: number, pinned: boolean) {
    return http.put(`/api/protected/announcements/${id}/pin`, {pinned})
}
