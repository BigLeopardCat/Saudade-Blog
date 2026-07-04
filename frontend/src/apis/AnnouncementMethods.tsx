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
