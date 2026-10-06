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

/**
 * 这次上传落到哪儿（20261006，用户第 1 条）。**服务端只认这两个字面量**
 * （`src/routes/upload.rs::UploadTarget::parse`，认不出的值会明确报错而不是按缺省处理）。
 */
export type UploadTarget = 'local' | 'r2';

/**
 * 上传一张/一批图片。
 *
 * `target` 不给 = **跟面板开关走**（面板说存 R2 就存 R2）—— 编辑器插图、文章封面、
 * bytemd 的拖拽粘贴都走这条，行为与从前逐字节相同。
 * 图库页那两颗按钮分别传 `'local'` / `'r2'`：`local` 是"即使 R2 开着也存本机盘"
 * 的那条路（在 20261006 之前，这条路**根本没有入口**）。
 *
 * 字段名只在这一处拼 —— 调用方不写字符串字面量，改契约时只改这里。
 * 注意是 `append` 在文件之后：multipart 各段的顺序由客户端定，服务端那头已经
 * 改成"先收完字段再处理"，所以顺序不影响结果。
 */
function uploadImages(formData: FormData, target?: UploadTarget){
    if (target) formData.append('target', target);
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
