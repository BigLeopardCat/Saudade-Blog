import http from "./axios.tsx";

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

export {uploadImages, getR2Usage};
