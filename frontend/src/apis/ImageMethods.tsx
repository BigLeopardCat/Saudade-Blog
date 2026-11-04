import http from "./axios.tsx";

const GALLERY_PAGE_SIZE = 60;

/**
 * 图库列表（游标分页）。`before` = 上一页最后一张的 `imageKey`，不传就是第一页。
 *
 * 服务端（`routes/upload.rs::list_images`）认的是 `image_key < before`：排序键是自增
 * 主键、新图插在头部，用 offset 会在"翻页期间有人上传"时重复/漏行，游标不会。
 * 响应形状没变（`data` 仍是数组）——所以老调用方传不传都拿得到一份合法的列表，
 * 差别只在"有多少张"。
 */
function getImageList(before?: number){
    return http({
        url: '/api/protect/images',
        method: 'GET',
        params: { limit: GALLERY_PAGE_SIZE, ...(before != null ? { before } : {}) },
    })
}

function delImages(keysToDelete: string[]){
    return http({
        url: '/api/protect/delImg',
        method: 'DELETE',
        data: keysToDelete
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

export {getImageList, delImages, uploadImages, getR2Usage, GALLERY_PAGE_SIZE};
