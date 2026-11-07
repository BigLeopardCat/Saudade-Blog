import http from "./axios.tsx";

const GALLERY_PAGE_SIZE = 60;

/** Read the next image page using its last imageKey cursor. */
function getImageList(before?: number){
    return http({
        url: '/api/protect/images',
        method: 'GET',
        params: { limit: GALLERY_PAGE_SIZE, ...(before != null ? { before } : {}) },
    })
}

export type UploadTarget = 'local' | 'r2';

function uploadImages(formData: FormData, target?: UploadTarget){
    if (target) formData.append('target', target);
    return http({
        url: "/api/protect/upload",
        data: formData,
        method: 'POST',
    })
}

function getR2Usage(){
    return http({
        url: '/api/protect/images/r2',
        method: 'GET'
    })
}

export {getImageList, uploadImages, getR2Usage, GALLERY_PAGE_SIZE};
