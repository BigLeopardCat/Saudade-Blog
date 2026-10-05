import http from "./axios.tsx";

function getImageList(){
    return http({
        url: '/api/protect/images',
        method: 'GET'
    })
}

function delImages(keysToDelete: string[]){
    return http({
        url: '/api/protect/delImg',
        method: 'DELETE',
        data: keysToDelete
    })
}

function uploadImages(formData: FormData){
    return http({
        url: "/api/protect/upload",
        data: formData,
        method: 'POST',
    })
}

/** R2 图床的用量读数（20261006）。真值来自 R2 自己的对象列表，不是库里的行 —— 见 src/r2.rs。 */
function getR2Usage(){
    return http({
        url: '/api/protect/images/r2',
        method: 'GET'
    })
}

export {getImageList, delImages, uploadImages, getR2Usage};
